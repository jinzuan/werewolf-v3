import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';

const createOptions = {
  roomName: 'V3 smoke room',
  maxPlayers: 12,
  aiCount: 0,
  name: 'Host',
};

const serialized = (value: unknown) => JSON.stringify(value);

test('room service exposes only RoomView and scoped credentials', async () => {
  const repository = new InMemoryRoomRepository();
  const rooms = new RoomService(repository, new InMemoryEventStore());
  const created = await rooms.create({
    actorId: 'host',
    options: createOptions,
  });

  assert.equal(created.room.members.length, 1);
  assert.ok(created.credentials.joinToken);
  assert.ok(created.credentials.resumeToken);
  assert.doesNotMatch(serialized(created.room), /joinToken|omniscientToken|resumeToken|session|role/);

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
  const started = await rooms.startGame(hostIdentity);
  assert.equal(started.status, 'playing');
  assert.ok(started.gameId);
  assert.doesNotMatch(serialized(started), /joinToken|omniscientToken|resumeToken|session|role/);

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

test('room recovery rebuilds active sessions from persisted snapshots', async () => {
  const repository = new InMemoryRoomRepository();
  const eventStore = new InMemoryEventStore();
  const first = new RoomService(repository, eventStore);
  const created = await first.create({
    actorId: 'host',
    options: createOptions,
  });
  const identity = await first.identity(
    created.room.code,
    'host',
    created.credentials.resumeToken,
  );
  const started = await first.startGame(identity);
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
  assert.ok(
    (snapshot.gameState as typeof snapshot.gameState & {
      deadlineTs?: number | null;
    }).deadlineTs,
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
    actorId: 'host-a',
    options: { ...createOptions, roomName: 'A' },
  });
  const second = await rooms.create({
    actorId: 'host-b',
    options: { ...createOptions, roomName: 'B' },
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
