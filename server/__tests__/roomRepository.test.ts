import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryRoomRepository,
  RoomRevisionConflictError,
} from '../rooms/repository';
import type { RoomRecord } from '../rooms/types';

const roomRecord = (): RoomRecord => ({
  id: 'room-atomic',
  code: 'ATOMIC1',
  name: 'Atomic room',
  joinToken: 'join',
  omniscientToken: 'omniscient',
  hostId: 'host',
  maxPlayers: 12,
  status: 'waiting',
  auto: false,
  debugMode: false,
  members: [],
  players: [],
  createdAt: 1,
});

test('atomic mutate serializes concurrent room changes without lost revisions', async () => {
  const repository = new InMemoryRoomRepository();
  await repository.create(roomRecord());

  await Promise.all(
    Array.from({ length: 40 }, () =>
      repository.mutate('atomic1', (room) => {
        room.name += '!';
      }),
    ),
  );

  const room = await repository.get('ATOMIC1');
  assert.equal(room?.roomRevision, 41);
  assert.equal(room?.name, `Atomic room${'!'.repeat(40)}`);
});

test('CAS rejects stale mutations and no-op mutations do not advance revision', async () => {
  const repository = new InMemoryRoomRepository();
  await repository.create(roomRecord());
  const initial = await repository.get('ATOMIC1');

  await repository.compareAndSet('ATOMIC1', initial!.roomRevision!, (room) => {
    room.configLocked = true;
  });
  const changed = await repository.get('ATOMIC1');
  assert.equal(changed?.roomRevision, 2);

  await repository.mutate('ATOMIC1', () => undefined);
  const unchanged = await repository.get('ATOMIC1');
  assert.equal(unchanged?.roomRevision, 2);

  await assert.rejects(
    () => repository.cas('ATOMIC1', 1, (room) => { room.name = 'stale'; }),
    (error: unknown) =>
      error instanceof RoomRevisionConflictError &&
      error.code === 'ROOM_REVISION_CONFLICT' &&
      error.actualRevision === 2,
  );
  assert.equal((await repository.get('ATOMIC1'))?.name, 'Atomic room');
});

test('config mutation advances configRevision independently from room revision', async () => {
  const repository = new InMemoryRoomRepository();
  await repository.create(roomRecord());
  await repository.mutate('ATOMIC1', (room) => {
    room.config = {
      mode: 'human',
      maxPlayers: 12,
      minHumanPlayers: 1,
      aiFillPolicy: 'none',
      computerSeats: 0,
      roleSetup: { wolf: 4, seer: 1, witch: 1, hunter: 1, guardian: 1, villager: 4 },
      rulesetId: 'werewolf.v3.default-12p',
      rulesetVersion: '3.0.0-stage1',
      catalogVersion: 'v3.1',
    };
  });
  const room = await repository.get('ATOMIC1');
  assert.equal(room?.roomRevision, 2);
  assert.equal(room?.configRevision, 2);
});
