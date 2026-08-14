import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';
import type {
  GameCommandAck,
  GameEventsMessage,
  JoinRoomAck,
  ResumeRoomAck,
  RoomAccessAck,
  RoomViewAck,
  SnapshotAck,
  V3Command,
} from '../shared/protocol';
import { InMemoryEventStore } from '../server/events/store';
import { InMemoryRoomRepository } from '../server/rooms/repository';
import { RoomService } from '../server/rooms/roomService';
import { bindSocketTransport } from '../server/transport/socketTransport';

const emitAck = <TAck>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<TAck> =>
  new Promise((resolve) => {
    socket.emit(event, payload, (response: TAck) => resolve(response));
  });

const connect = (
  url: string,
  auth: Record<string, string> = {},
): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createClient(url, {
      auth,
      transports: ['websocket'],
      reconnection: false,
      timeout: 5_000,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

const meta = (actorId: string, roomId?: string) => ({
  commandId: crypto.randomUUID(),
  actorId,
  sentAt: Date.now(),
  roomId,
});

const roomCommand = (
  actorId: string,
  actorName: string,
  command: V3Command['command'],
  roomId?: string,
) => ({
  meta: meta(actorId, roomId),
  command,
  actorName,
});

const noSensitiveKeys = (value: unknown): boolean =>
  !/joinToken|resumeToken|omniscientToken|session/.test(
    JSON.stringify(value),
  );

const waitForSnapshot = (socket: Socket): Promise<SnapshotAck['snapshot']> =>
  new Promise((resolve) => {
    socket.once(
      'v3:snapshot',
      (message: {
        type: 'game.snapshot';
        snapshot: SnapshotAck['snapshot'];
      }) => {
        assert.equal(message.type, 'game.snapshot');
        resolve(message.snapshot);
      },
    );
  });

async function main() {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    { autoDrive: false },
  );
  bindSocketTransport(io, rooms);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const sockets: Socket[] = [];

  try {
    const host = await connect(url);
    sockets.push(host);
    const created = await emitAck<RoomAccessAck>(
      host,
      'v3:command',
      roomCommand('host', 'Host', {
        type: 'room.create',
        payload: {
          roomName: 'W2 authoritative room',
          maxPlayers: 12,
          aiCount: 0,
          name: 'Host',
        },
      }),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.ok(created.credentials.resumeToken);
    assert.ok(created.credentials.joinToken);
    assert.equal(noSensitiveKeys(created.room), true);

    const guest = await connect(url);
    sockets.push(guest);
    const joined = await emitAck<JoinRoomAck>(
      guest,
      'v3:command',
      roomCommand('guest', 'Guest', {
        type: 'room.join',
        payload: {
          roomCode: created.room.code,
          joinToken: created.credentials.joinToken,
        },
      }),
    );
    assert.equal(joined.ok, true);
    if (!joined.ok) return;
    assert.ok(joined.credentials.resumeToken);
    assert.equal(joined.credentials.joinToken, undefined);
    assert.notEqual(
      joined.credentials.resumeToken,
      created.credentials.resumeToken,
    );
    assert.equal(noSensitiveKeys(joined.room), true);

    const hostSnapshotPush = waitForSnapshot(host);
    const started = await emitAck<RoomViewAck>(
      host,
      'v3:command',
      roomCommand(
        'host',
        'Host',
        { type: 'room.start_game', payload: {} },
        created.room.id,
      ),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const pushedSnapshot = await hostSnapshotPush;
    assert.equal(pushedSnapshot.roomId, created.room.id);
    assert.equal(pushedSnapshot.gameId, started.room.gameId);

    const guestSnapshot = await emitAck<SnapshotAck>(
      guest,
      'v3:snapshot',
      { roomCode: created.room.code, actorId: 'guest' },
    );
    assert.equal(guestSnapshot.ok, true);
    if (!guestSnapshot.ok) return;
    assert.equal(noSensitiveKeys(guestSnapshot.snapshot), true);
    assert.ok(
      guestSnapshot.snapshot.players.every(
        (player) =>
          player.id === 'guest' ||
          player.role === null ||
          (
            guestSnapshot.snapshot.viewer.kind === 'player' &&
            guestSnapshot.snapshot.viewer.role === 'wolf' &&
            player.role === 'wolf'
          ),
      ),
    );

    const spectator = await connect(url, {
      joinToken: created.credentials.joinToken,
    });
    sockets.push(spectator);
    const spectated = await emitAck<JoinRoomAck>(
      spectator,
      'v3:command',
      roomCommand('spectator', 'Spectator', {
        type: 'spectator.join',
        payload: { roomCode: created.room.code },
      }),
    );
    assert.equal(spectated.ok, true);
    if (!spectated.ok) return;
    const publicSnapshot = await emitAck<SnapshotAck>(
      spectator,
      'v3:snapshot',
      { roomCode: created.room.code, actorId: 'spectator' },
    );
    assert.equal(publicSnapshot.ok, true);
    if (!publicSnapshot.ok) return;
    assert.deepEqual(publicSnapshot.snapshot.viewer, {
      kind: 'spectator',
      spectatorId: 'spectator',
      omniscient: false,
    });
    assert.ok(
      publicSnapshot.snapshot.players.every(
        (player) => player.role === null,
      ),
    );
    assert.equal(
      publicSnapshot.snapshot.gameState.allowedActions?.length ?? 0,
      0,
    );

    host.disconnect();
    const resumedHost = await connect(url, {
      resumeToken: created.credentials.resumeToken,
    });
    sockets.push(resumedHost);
    const resumed = await emitAck<ResumeRoomAck>(
      resumedHost,
      'v3:command',
      roomCommand(
        'host',
        'Host',
        {
          type: 'spectator.resume',
          payload: {
            roomCode: created.room.code,
            afterSequence: 0,
          },
        },
        created.room.id,
      ),
    );
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.room.viewer.actorId, 'host');
    assert.ok((resumed.events?.length ?? 0) > 0);
    assert.ok(
      resumed.events?.every(
        (event) =>
          event.roomId === created.room.id &&
          event.gameId === started.room.gameId,
      ),
    );

    const invalidResume = await connect(url, {
      resumeToken: created.credentials.joinToken,
    });
    sockets.push(invalidResume);
    const invalid = await emitAck<ResumeRoomAck>(
      invalidResume,
      'v3:command',
      roomCommand(
        'host',
        'Host',
        {
          type: 'spectator.resume',
          payload: {
            roomCode: created.room.code,
            afterSequence: 0,
          },
        },
        created.room.id,
      ),
    );
    assert.equal(invalid.ok, false);
    if (invalid.ok === false) assert.equal(invalid.code, 'UNAUTHENTICATED');

    const stale = await emitAck<GameCommandAck>(
      resumedHost,
      'v3:command',
      {
        meta: {
          ...meta('host', created.room.id),
          roomId: created.room.id,
          gameId: started.room.gameId!,
          expectedStageRevision: Math.max(
            0,
            (pushedSnapshot.gameState.stageRevision ?? 1) - 1,
          ),
        },
        command: {
          type: 'game.wolf_speak',
          payload: { content: 'stale command' },
        },
      },
    );
    assert.equal(stale.ok, false);
    if (stale.ok === false) {
      assert.equal(stale.code, 'STALE_STAGE_REVISION');
    }

    const secondHost = await connect(url);
    sockets.push(secondHost);
    const secondRoom = await emitAck<RoomAccessAck>(
      secondHost,
      'v3:command',
      roomCommand('host-2', 'Host 2', {
        type: 'room.create',
        payload: {
          roomName: 'Isolation room',
          maxPlayers: 12,
          aiCount: 0,
          name: 'Host 2',
        },
      }),
    );
    assert.equal(secondRoom.ok, true);
    if (!secondRoom.ok) return;

    const crossRoom = await emitAck<RoomViewAck>(
      resumedHost,
      'v3:command',
      roomCommand(
        'host',
        'Host',
        { type: 'room.start_game', payload: {} },
        secondRoom.room.id,
      ),
    );
    assert.equal(crossRoom.ok, false);
    if (crossRoom.ok === false) {
      assert.equal(crossRoom.code, 'ROOM_MISMATCH');
    }

    const session = rooms.session(created.room.code)!;
    const guardian = session.players.find(
      (player) => player.role === 'guardian',
    )!;
    const seer = session.players.find(
      (player) => player.role === 'seer',
    )!;
    await session.dispatch(
      {
        commandId: 'socket-setup-guardian',
        actorId: guardian.id,
        sentAt: Date.now(),
        roomId: created.room.id,
        gameId: started.room.gameId!,
        expectedStageRevision: session.stageRevision,
      },
      {
        type: 'game.skip_night',
        payload: { action: 'guard' },
      },
    );
    await session.dispatch(
      {
        commandId: 'socket-setup-seer',
        actorId: seer.id,
        sentAt: Date.now(),
        roomId: created.room.id,
        gameId: started.room.gameId!,
        expectedStageRevision: session.stageRevision,
      },
      {
        type: 'game.skip_night',
        payload: { action: 'check' },
      },
    );
    const actionable = await emitAck<SnapshotAck>(
      resumedHost,
      'v3:snapshot',
      { roomCode: created.room.code, actorId: 'host' },
    );
    assert.equal(actionable.ok, true);
    if (!actionable.ok) return;

    const pushedEventsPromise = new Promise<GameEventsMessage>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('EVENT_PUSH_TIMEOUT')),
          2_000,
        );
        guest.once(
          'v3:events',
          (message: GameEventsMessage) => {
            clearTimeout(timeout);
            resolve(message);
          },
        );
      },
    );
    const spoken = await emitAck<GameCommandAck>(
      resumedHost,
      'v3:command',
      {
        meta: {
          ...meta('host', created.room.id),
          roomId: created.room.id,
          gameId: started.room.gameId!,
          expectedStageRevision:
            actionable.snapshot.gameState.stageRevision ?? 0,
        },
        command: {
          type: 'game.wolf_speak',
          payload: { content: 'authoritative socket event' },
        },
      },
    );
    assert.equal(spoken.ok, true);
    const pushedEvents = await pushedEventsPromise;
    assert.ok(pushedEvents.events.length > 0);
    assert.equal(pushedEvents.type, 'game.events');
    assert.ok(
      pushedEvents.events.every(
        (event) =>
          event.roomId === created.room.id &&
          event.gameId === started.room.gameId,
      ),
    );
    assert.ok(
      pushedEvents.afterSequence >=
        pushedEvents.events.at(-1)!.sequence,
    );
    assert.equal(noSensitiveKeys(pushedEvents), true);
    assert.equal(pushedEvents.roomId, created.room.id);
    assert.equal(pushedEvents.gameId, started.room.gameId);

    console.log(
      'W2 socket verification passed: create/join/resume/cross-room/stale-revision/privacy.',
    );
  } finally {
    for (const socket of sockets) socket.disconnect();
    await rooms.close();
    await new Promise<void>((resolve, reject) => {
      io.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

await main();
