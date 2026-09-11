import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { createRequest, startRoom } from './fixtures';

const serialized = (value: unknown) => JSON.stringify(value);

test('room service exposes only RoomView and scoped credentials', async () => {
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore());
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'flow-create', 'V3 smoke room', {
      allowPublicSpectators: true,
      visibility: 'listed',
    }),
  });

  assert.equal(created.room.members.length, 1);
  assert.equal(created.room.status, 'ready_check');
  assert.ok(created.room.viewer.allowedRoomActions.includes('set_ready'));
  assert.equal(created.room.viewer.allowedRoomActions.includes('begin_ready_check'), false);
  assert.ok(created.credentials.joinToken);
  assert.ok(created.credentials.resumeToken);
  assert.doesNotMatch(serialized(created.room), /joinToken|omniscientToken|resumeToken|session/);

  const joined = await rooms.join({
    actorId: 'guest',
    name: 'Guest',
    roomCode: created.room.code,
    joinToken: created.credentials.joinToken,
  });
  assert.equal(joined.room.members.length, 2);
  assert.equal(joined.credentials.joinToken, undefined);
  assert.notEqual(joined.credentials.resumeToken, created.credentials.resumeToken);

  const hostIdentity = await rooms.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  const guestIdentity = await rooms.identity(
    created.room.code,
    'guest',
    joined.credentials.resumeToken,
  );
  const current = await rooms.get(created.room.code, 'host');
  const checking = current.status === 'ready_check'
    ? current
    : await rooms.beginReadyCheck(hostIdentity, current.roomRevision, 'flow-ready-check');
  const hostReady = await rooms.setReady(hostIdentity, true, checking.roomRevision, 'flow-host-ready');
  const guestReady = await rooms.setReady(guestIdentity, true, hostReady.roomRevision, 'flow-guest-ready');
  const started = await rooms.startGame(hostIdentity, {
    commandId: 'flow-start',
    expectedRoomRevision: guestReady.roomRevision,
  });
  assert.equal(started.status, 'playing');
  assert.ok(started.gameId);
  assert.doesNotMatch(serialized(started), /joinToken|omniscientToken|resumeToken|session/);

  const resumed = await rooms.resume(
    created.room.code,
    'guest',
    joined.credentials.resumeToken,
  );
  assert.equal(
    resumed.room.members.find((member) => member.id === 'guest')?.connected,
    true,
  );
  const summaries = await rooms.list();
  assert.deepEqual(summaries.map((room) => room.roomCode), [created.room.code]);
});

test('human seats are randomly assigned by the server and never requested by the joiner', async () => {
  const picks = [7, 0, 0];
  const randomBounds = [12, 11, 10];
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
    {
      seatRandomIndex: (maxExclusive) => {
        assert.equal(maxExclusive, randomBounds.shift());
        return picks.shift() ?? 0;
      },
    },
  );
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'random-seat-create', '随机座位房'),
  });
  await rooms.join({
    actorId: 'guest-1',
    name: 'Guest 1',
    roomCode: created.room.code,
    joinToken: created.credentials.joinToken,
  });
  await rooms.join({
    actorId: 'guest-2',
    name: 'Guest 2',
    roomCode: created.room.code,
    joinToken: created.credentials.joinToken,
  });

  const record = await rooms.getRecord(created.room.code);
  const seats = record?.members
    .filter((member) => member.kind === 'player')
    .map((member) => member.seatIndex);
  assert.deepEqual(seats, [7, 0, 1]);
  assert.equal(new Set(seats).size, seats?.length);
  await rooms.close();
});

test('room recovery rebuilds active sessions from persisted snapshots', async () => {
  const repository = new InMemoryRoomRepository();
  const eventStore = new InMemoryEventStore();
  const first = new RoomService(repository, eventStore);
  const created = await first.create({
    ...createRequest(first, 'host', 'recovery-create', 'V3 smoke room'),
  });
  const identity = await first.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  const started = await startRoom(first, identity, 'recovery');
  await first.close();

  const restored = new RoomService(repository, eventStore);
  assert.equal(await restored.restore(), 1);
  const restoredIdentity = await restored.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  const snapshot = await restored.snapshot(restoredIdentity);
  assert.equal(snapshot.roomId, created.room.id);
  assert.equal(snapshot.gameId, started.gameId);
  assert.ok(snapshot.gameState.stageRevision);
  assert.equal(
    (snapshot.gameState as typeof snapshot.gameState & {
      deadlineTs?: number | null;
    }).deadlineTs,
    null,
  );
  assert.ok(snapshot.lastSequence >= 2);
  await restored.close();
});

test('multiple rooms remain isolated', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
  );
  const first = await rooms.create({
    ...createRequest(rooms, 'host-a', 'isolation-create-a', 'A'),
  });
  const second = await rooms.create({
    ...createRequest(rooms, 'host-b', 'isolation-create-b', 'B'),
  });
  await rooms.join({
    actorId: 'guest-a',
    name: 'Guest A',
    roomCode: first.room.code,
    joinToken: first.credentials.joinToken,
  });

  assert.equal((await rooms.getRecord(first.room.code))?.players.length, 2);
  assert.equal((await rooms.getRecord(second.room.code))?.players.length, 1);
  assert.notEqual(first.room.id, second.room.id);
  assert.notEqual(first.credentials.joinToken, second.credentials.joinToken);
});

test('host computer-player settings stay private while the room keeps them for its AI runner', async () => {
  const rooms = new RoomService(
    new InMemoryRoomRepository(),
    new InMemoryEventStore(),
  );
  const created = await rooms.create({
    ...createRequest(rooms, 'ai-host', 'ai-settings-create', '电脑玩家配置房', {
      mode: 'mixed',
      minHumanPlayers: 1,
      computerSeats: 11,
      aiFillPolicy: 'fixed',
      reviewEnabled: true,
      aiConfig: {
        provider: 'custom',
        model: 'local-test-model',
        apiKey: 'secret-key',
        token: 'secret-token',
        endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
        temperature: .7,
        maxTokens: 512,
        behavior: 'random',
      },
    }),
  });

  const record = await rooms.getRecord(created.room.code);
  assert.equal(record?.config?.aiProviderConfig?.model, 'local-test-model');
  assert.doesNotMatch(serialized(created.room), /aiConfig|secret-key|secret-token/);
  await rooms.close();
});
