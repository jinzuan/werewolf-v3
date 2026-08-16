import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { io as createClient, type Socket } from 'socket.io-client';
import { Server } from 'socket.io';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { bindSocketTransport } from '../transport/socketTransport';
import type { V3Command } from '../../shared/protocol';

type SocketAck = {
  ok: boolean;
  room: { code: string; id: string; roomRevision: number };
  credentials: { joinToken?: string };
};
type ClosedMessage = { type: 'room.closed'; roomCode: string; roomId: string; reason: 'dissolved'; causeCommandId?: string };

const waitForConnect = (socket: Socket): Promise<void> => new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});

test('dissolve emits a closed tombstone to every bound socket', async () => {
  const httpServer = createHttpServer();
  const io = new Server(httpServer, { cors: { origin: true } });
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore(), { autoDrive: false });
  bindSocketTransport(io, rooms);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const host = createClient(url, { transports: ['websocket'], reconnection: false });
  const guest = createClient(url, { transports: ['websocket'], reconnection: false });
  try {
    await Promise.all([waitForConnect(host), waitForConnect(guest)]);
    const catalog = rooms.getCatalog();
    const preset = catalog.rolePresets.find((item) => item.enabled)!;
    const options = {
      catalogVersion: catalog.catalogVersion,
      roomName: 'dissolve room',
      creator: { name: 'Host', avatarId: 'avatar-player' },
      mode: 'human' as const,
      visibility: 'invite_only' as const,
      maxPlayers: preset.playerCount,
      minHumanPlayers: preset.playerCount,
      computerSeats: 0,
      aiFillPolicy: 'none' as const,
      roleSetup: { ...preset.roleSetup },
      rolePresetId: preset.id,
      rulesetId: preset.rulesetId,
      rulesetVersion: preset.rulesetVersion,
      readyPolicy: 'all_connected_humans' as const,
      allowPublicSpectators: false,
      reviewEnabled: true,
    };
    const created = await new Promise<SocketAck>((resolve) => host.emit('v3:command', {
      meta: { commandId: 'create-command', actorId: 'host', sentAt: Date.now() },
      actorName: 'Host',
      command: { type: 'room.create', payload: { createRequestId: 'dissolve-create', options } },
    }, resolve));
    assert.equal(created.ok, true);
    const joined = await new Promise<SocketAck>((resolve) => guest.emit('v3:command', {
      meta: { commandId: 'join-command', actorId: 'guest', sentAt: Date.now() },
      actorName: 'Guest',
      command: { type: 'room.join', payload: { roomCode: created.room.code, joinToken: created.credentials.joinToken } },
    }, resolve));
    assert.equal(joined.ok, true);
    const closed = new Promise<ClosedMessage>((resolve) => guest.once('v3:room.closed', resolve));
    const dissolve: V3Command = {
      meta: { commandId: 'dissolve-command', actorId: 'host', sentAt: Date.now(), roomId: created.room.id, expectedRoomRevision: joined.room.roomRevision },
      command: { type: 'room.dissolve', payload: { confirm: true } },
    };
    const ack = await new Promise<SocketAck>((resolve) => host.emit('v3:command', dissolve, resolve));
    assert.equal(ack.ok, true);
    assert.deepEqual(await closed, {
      type: 'room.closed', roomCode: created.room.code, roomId: created.room.id, reason: 'dissolved', causeCommandId: 'dissolve-command',
    });
    assert.equal(await rooms.getRecord(created.room.code), undefined);
  } finally {
    host.disconnect();
    guest.disconnect();
    await rooms.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
