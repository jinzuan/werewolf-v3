import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryRoomRepository } from '../rooms/repository';
import { RoomService } from '../rooms/roomService';
import { createRequest } from './fixtures';

test('restart discards persisted online bits and startup grace permits resume', async () => {
  let now = 0;
  const repository = new InMemoryRoomRepository();
  const first = new RoomService(repository, new InMemoryEventStore(), {
    environment: 'test',
    deploymentNamespace: 'restart-test',
    clock: () => now,
    waitingRoomTtlMs: 100,
    startupGraceMs: 50,
    roomSweepIntervalMs: 0,
  });
  const created = await first.create({
    ...createRequest(first, 'host', 'restart-create', 'restart'),
  });
  const stored = await repository.get(created.room.code);
  assert.equal('connected' in stored!.members[0], false);
  await first.close();

  now = 1_000;
  const second = new RoomService(repository, new InMemoryEventStore(), {
    environment: 'test',
    deploymentNamespace: 'restart-test',
    clock: () => now,
    waitingRoomTtlMs: 100,
    startupGraceMs: 50,
    roomSweepIntervalMs: 0,
  });
  await second.restore();
  const cold = await second.get(created.room.code, 'host');
  assert.equal(cold.members[0].connected, false);

  now = 1_051;
  const removed = await second.sweepExpiredRooms();
  assert.deepEqual(removed.map((entry) => entry.roomCode), [created.room.code]);
  await second.close();
});

test('connection registry keeps a member online until the final tab closes', async () => {
  const rooms = new RoomService(new InMemoryRoomRepository(), new InMemoryEventStore());
  const created = await rooms.create({
    ...createRequest(rooms, 'host', 'tabs-create', 'tabs'),
  });
  const identity = await rooms.identity(created.room.code, 'host', created.credentials.resumeToken);
  await rooms.bindConnection(identity, 'tab-a');
  await rooms.bindConnection(identity, 'tab-b');
  await rooms.disconnect(identity, 'tab-a');
  assert.equal((await rooms.get(created.room.code, 'host')).members[0].connected, true);
  await rooms.disconnect(identity, 'tab-b');
  assert.equal((await rooms.get(created.room.code, 'host')).members[0].connected, false);
  await rooms.close();
});
