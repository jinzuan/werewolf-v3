import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { io as createClient, type Socket } from 'socket.io-client';
import { Server } from 'socket.io';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemoryEventStore } from '../events/store';
import { FileEventStore } from '../events/fileStore';
import { FileRoomRepository } from '../rooms/fileRepository';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { bindSocketTransport } from '../transport/socketTransport';

type SocketAck = {
  ok: boolean;
  room: { code: string; id: string; roomRevision: number };
  credentials: { joinToken?: string };
};

const optionsFor = (rooms: RoomService, roomName = 'idempotent room') => {
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  return {
    catalogVersion: catalog.catalogVersion,
    roomName,
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
};

test('create request is durable and returns the same access after an ACK-loss retry', async () => {
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore(), { autoDrive: false });
  const options = optionsFor(rooms);
  const first = await rooms.create({
    actorId: 'host',
    createRequestId: 'create-request-1',
    options,
  });
  const retried = await rooms.create({
    actorId: 'host',
    createRequestId: 'create-request-1',
    options: structuredClone(options),
  });

  assert.equal(retried.room.code, first.room.code);
  assert.equal(retried.credentials.resumeToken, first.credentials.resumeToken);
  assert.equal((await repository.list()).length, 1);

  await assert.rejects(
    rooms.create({
      actorId: 'host',
      createRequestId: 'create-request-1',
      options: optionsFor(rooms, 'different room'),
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === 'IDEMPOTENCY_KEY_REUSED',
  );
  await rooms.close();
});

test('quick computer create retries the existing workflow instead of minting a second code', async () => {
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore(), { autoDrive: false });
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled)!;
  const options = {
    ...optionsFor(rooms, 'quick idempotent'),
    mode: 'quick_computer' as const,
    minHumanPlayers: 0,
    aiFillPolicy: 'fill_to_max' as const,
  };
  const first = await rooms.create({ actorId: 'monitor', createRequestId: 'quick-1', options });
  const second = await rooms.create({ actorId: 'monitor', createRequestId: 'quick-1', options });
  assert.equal(second.room.code, first.room.code);
  assert.equal((await repository.list()).length, 1);
  assert.equal((await repository.get(first.room.code))?.status, 'playing');
  await rooms.close();
  void preset;
});

test('file repository keeps the create claim across a service restart', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ww-v3-idempotency-'));
  const roomPath = path.join(dataDir, 'rooms.json');
  try {
    const firstService = new RoomService(
      new FileRoomRepository(roomPath),
      new FileEventStore(path.join(dataDir, 'events.json')),
      { autoDrive: false },
    );
    const options = optionsFor(firstService, 'file idempotent');
    const first = await firstService.create({
      actorId: 'host', createRequestId: 'file-request-1', options,
    });
    await firstService.close();

    const secondService = new RoomService(
      new FileRoomRepository(roomPath),
      new FileEventStore(path.join(dataDir, 'events.json')),
      { autoDrive: false },
    );
    const second = await secondService.create({
      actorId: 'host', createRequestId: 'file-request-1', options,
    });
    assert.equal(second.room.code, first.room.code);
    assert.equal(second.credentials.resumeToken, first.credentials.resumeToken);
    assert.equal((await secondService.getRecord(first.room.code))?.createRequestId, 'file-request-1');
    await secondService.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('test-only create ACK fault injection is recoverable on a fresh socket', async () => {
  const previousEnvironment = process.env.WW_ENV;
  process.env.WW_ENV = 'test';
  const httpServer = createHttpServer();
  const io = new Server(httpServer, { cors: { origin: true } });
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore(), { autoDrive: false });
  bindSocketTransport(io, rooms, { dropCreateAckOnce: true });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const options = optionsFor(rooms, 'dropped ACK room');
  const firstSocket = createClient(url, { transports: ['websocket'], reconnection: false });
  const waitForConnect = (socket: Socket): Promise<void> => new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  try {
    await waitForConnect(firstSocket);
    const firstRequest = {
      meta: { commandId: 'create-command-1', actorId: 'host', sentAt: Date.now() },
      actorName: 'Host',
      command: { type: 'room.create', payload: { createRequestId: 'dropped-1', options } },
    };
    const dropped = new Promise<unknown>((resolve) => firstSocket.emit('v3:command', firstRequest, resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await Promise.race([dropped, Promise.resolve('ack-not-received')]), 'ack-not-received');
    firstSocket.disconnect();

    const retrySocket = createClient(url, { transports: ['websocket'], reconnection: false });
    try {
      await waitForConnect(retrySocket);
      const retried = await new Promise<SocketAck>((resolve) => retrySocket.emit('v3:command', {
        ...firstRequest,
        meta: { ...firstRequest.meta, commandId: 'create-command-2' },
      }, resolve));
      assert.equal(retried.ok, true);
      assert.equal((await repository.list()).length, 1);
    } finally {
      retrySocket.disconnect();
    }
  } finally {
    firstSocket.disconnect();
    await rooms.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (previousEnvironment === undefined) delete process.env.WW_ENV;
    else process.env.WW_ENV = previousEnvironment;
  }
});
