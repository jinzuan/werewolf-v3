import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { io as createClient, type Socket } from 'socket.io-client';
import { Server } from 'socket.io';
import type { DomainEvent } from '../../shared/events';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { bindSocketTransport } from '../transport/socketTransport';
import { createRequest, startRoom } from './fixtures';

type SocketAck = {
  ok: boolean;
  room: { code: string; id: string; roomRevision: number };
  credentials: { joinToken?: string; resumeToken: string };
};

const waitForConnect = (socket: Socket): Promise<void> => new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});

const waitFor = async (
  predicate: () => boolean,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const emitCommand = <T>(socket: Socket, request: unknown): Promise<T> =>
  new Promise((resolve) => socket.emit('v3:command', request, resolve));

const emitEvents = <T>(socket: Socket, request: unknown): Promise<T> =>
  new Promise((resolve) => socket.emit('v3:events', request, resolve));

test('socket reconnection can resume the same seat repeatedly after a five-minute gap', async () => {
  let now = 0;
  const httpServer = createHttpServer();
  const io = new Server(httpServer, { cors: { origin: true } });
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore(), {
    clock: () => now,
    roomSweepIntervalMs: 0,
  });
  bindSocketTransport(io, rooms);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const host = createClient(url, { transports: ['websocket'], reconnection: false });

  try {
    await waitForConnect(host);
    const catalog = rooms.getCatalog();
    const preset = catalog.rolePresets.find((item) => item.enabled)!;
    const options = {
      catalogVersion: catalog.catalogVersion,
      roomName: 'reconnect room',
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
    const created = await emitCommand<SocketAck>(host, {
      meta: { commandId: 'reconnect-create-command', actorId: 'host', sentAt: 0 },
      actorName: 'Host',
      command: {
        type: 'room.create',
        payload: { createRequestId: 'reconnect-create', options },
      },
    });
    assert.equal(created.ok, true);
    host.disconnect();
    await waitFor(
      () => rooms.connectionRegistry.isConnected(created.room.code, 'host') === false,
      'the original socket did not release its lease',
    );

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      now += 5 * 60 * 1000;
      assert.deepEqual(await rooms.sweepExpiredRooms(), []);

      const resumedSocket = createClient(url, {
        auth: { resumeToken: created.credentials.resumeToken },
        transports: ['websocket'],
        reconnection: false,
      });
      try {
        await waitForConnect(resumedSocket);
        const resumed = await emitCommand<SocketAck>(resumedSocket, {
          meta: { commandId: `reconnect-resume-${attempt}`, actorId: 'host', sentAt: now },
          actorName: 'Host',
          command: { type: 'room.resume', payload: { roomCode: created.room.code } },
        });
        assert.equal(resumed.ok, true);
        assert.equal(resumed.room.code, created.room.code);
        assert.equal(
          (await rooms.get(created.room.code, 'host')).members.find((member) => member.id === 'host')?.connected,
          true,
        );
      } finally {
        resumedSocket.disconnect();
        await waitFor(
          () => rooms.connectionRegistry.isConnected(created.room.code, 'host') === false,
          `resume attempt ${attempt} did not release its lease`,
        );
      }
    }
  } finally {
    host.disconnect();
    await rooms.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test('long reconnect replays every event after the persisted watermark across pages', async () => {
  const eventStore = new InMemoryEventStore();
  const rooms = new RoomService(new InMemoryRoomRepository(), eventStore, {
    roomSweepIntervalMs: 0,
  });
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'long-reconnect-create', 'long reconnect room'),
  });
  const httpServer = createHttpServer();
  const io = new Server(httpServer, { cors: { origin: true } });
  bindSocketTransport(io, rooms);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const host = createClient(url, {
    auth: { resumeToken: created.credentials.resumeToken },
    transports: ['websocket'],
    reconnection: false,
  });

  try {
    const identity = await rooms.identity(
      created.room.code,
      'host',
      created.credentials.resumeToken,
    );
    await startRoom(rooms, identity, 'long-reconnect');
    const session = rooms.session(created.room.code);
    assert.ok(session);
    const initial = session.serialize();
    const gameId = session.gameId;
    const history = Array.from({ length: 250 }, (_, index): DomainEvent => {
      const sequence = initial.state.sequence + index + 1;
      return {
        eventId: `offline-${sequence}`,
        roomId: created.room.id,
        gameId,
        sequence,
        occurredAt: sequence,
        phase: 'day',
        stage: 'speech',
        actorId: 'host',
        eventType: 'day.speech',
        payload: { content: `离线期间事件-${sequence}` },
        visibility: 'public_timeline',
        correlationId: `offline-command-${sequence}`,
        schemaVersion: 1,
      };
    });
    await eventStore.append({
      streamId: `game:${gameId}`,
      expectedVersion: initial.state.streamVersion,
      events: history,
    });

    await waitForConnect(host);
    const resumed = await emitCommand<SocketAck>(host, {
      meta: {
        commandId: 'long-reconnect-resume',
        actorId: 'host',
        sentAt: Date.now(),
      },
      actorName: 'Host',
      command: {
        type: 'room.resume',
        payload: {
          roomCode: created.room.code,
          afterSequence: initial.state.sequence,
        },
      },
    });
    assert.equal(resumed.ok, true);

    type EventsAck = {
      ok: boolean;
      afterSequence: number;
      lastSequence: number;
      events: DomainEvent[];
      hasMore: boolean;
      nextAfterSequence: number | null;
    };
    const received: DomainEvent[] = [];
    let afterSequence = initial.state.sequence;
    for (;;) {
      const page = await emitEvents<EventsAck>(host, {
        roomCode: created.room.code,
        actorId: 'host',
        afterSequence,
        limit: 200,
      });
      assert.equal(page.ok, true);
      received.push(...page.events);
      if (!page.hasMore) break;
      assert.ok(page.nextAfterSequence !== null);
      assert.ok(page.nextAfterSequence > afterSequence);
      afterSequence = page.nextAfterSequence;
    }

    assert.deepEqual(
      received.map((event) => event.sequence),
      history.map((event) => event.sequence),
    );
  } finally {
    host.disconnect();
    await rooms.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
