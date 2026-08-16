import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { io as createClient, type Socket } from 'socket.io-client';
import { Server } from 'socket.io';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { bindSocketTransport } from '../transport/socketTransport';

type JoinAck = {
  ok: boolean;
  code?: string;
  credentials?: { joinToken?: string };
  room?: { code: string };
};

const waitForConnect = (socket: Socket): Promise<void> => new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});

const emitJoin = (
  socket: Socket,
  actorId: string,
  roomCode: string,
  joinToken: string,
): Promise<JoinAck> => new Promise((resolve) => {
  socket.emit('v3:command', {
    meta: { commandId: `join-${actorId}`, actorId, sentAt: Date.now() },
    actorName: actorId,
    command: { type: 'room.join', payload: { roomCode, joinToken } },
  }, resolve);
});

test('room join keeps the concrete rejection reason for recovery and re-entry', async () => {
  const httpServer = createHttpServer();
  const io = new Server(httpServer, { cors: { origin: true } });
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore(), { autoDrive: false });
  bindSocketTransport(io, rooms);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const socket = createClient(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    reconnection: false,
  });
  const joinSocket = createClient(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    reconnection: false,
  });

  try {
    await Promise.all([waitForConnect(socket), waitForConnect(joinSocket)]);
    const catalog = rooms.getCatalog();
    const preset = catalog.rolePresets.find((item) => item.enabled)!;
    const created = await new Promise<JoinAck>((resolve) => socket.emit('v3:command', {
      meta: { commandId: 'create-join-rejection', actorId: 'host', sentAt: Date.now() },
      actorName: 'Host',
      command: {
        type: 'room.create',
        payload: {
          createRequestId: 'create-join-rejection',
          options: {
            catalogVersion: catalog.catalogVersion,
            roomName: 'join rejection room',
            creator: { name: 'Host', avatarId: 'avatar-player' },
            mode: 'human',
            visibility: 'invite_only',
            maxPlayers: preset.playerCount,
            minHumanPlayers: preset.playerCount,
            computerSeats: 0,
            aiFillPolicy: 'none',
            roleSetup: { ...preset.roleSetup },
            rolePresetId: preset.id,
            rulesetId: preset.rulesetId,
            rulesetVersion: preset.rulesetVersion,
            readyPolicy: 'all_connected_humans',
            allowPublicSpectators: false,
            reviewEnabled: true,
          },
        },
      },
    }, resolve));
    assert.equal(created.ok, true);
    assert.ok(created.room?.code);
    assert.ok(created.credentials?.joinToken);

    const invalidToken = await emitJoin(joinSocket, 'guest-invalid-token', created.room!.code, 'wrong-token');
    assert.equal(invalidToken.ok, false);
    assert.equal(invalidToken.code, 'ROOM_TOKEN_INVALID');

    const missingRoom = await emitJoin(joinSocket, 'guest-missing-room', 'MISSING', 'wrong-token');
    assert.equal(missingRoom.ok, false);
    assert.equal(missingRoom.code, 'ROOM_NOT_FOUND');
  } finally {
    socket.disconnect();
    joinSocket.disconnect();
    await rooms.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
