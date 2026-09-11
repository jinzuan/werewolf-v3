import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { RoomService, RoomServiceError } from '../rooms/roomService';
import { InMemoryRoomRepository } from '../rooms/repository';
import type { RoomRecord } from '../rooms/types';

const raceRoom = (): RoomRecord => ({
  id: 'race-room',
  code: 'RACE01',
  name: 'race',
  joinToken: 'join-secret',
  omniscientToken: 'monitor-secret',
  hostId: 'host',
  maxPlayers: 3,
  status: 'ready_check',
  auto: false,
  debugMode: false,
  configLocked: true,
  roomRevision: 1,
  rosterRevision: 1,
  configRevision: 1,
  config: {
    mode: 'mixed',
    visibility: 'invite_only',
    maxPlayers: 3,
    minHumanPlayers: 1,
    aiFillPolicy: 'fill_to_max',
    computerSeats: 0,
    roleSetup: { wolf: 1, seer: 1, witch: 0, hunter: 0, guardian: 0, villager: 1 },
    rulesetId: 'werewolf.v3.default-12p',
    rulesetVersion: '3.0.0-stage1',
    catalogVersion: 'v31-test',
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    rulesetAvailable: true,
  },
  members: [
    {
      id: 'host', name: 'Host', kind: 'player', connected: true,
      omniscient: false, resumeToken: 'host-resume', seatIndex: 0,
      isAI: false, ready: true, avatarId: 'avatar-player',
    },
    {
      id: 'guest-1', name: 'Guest 1', kind: 'player', connected: true,
      omniscient: false, resumeToken: 'guest-resume', seatIndex: 1,
      isAI: false, ready: true, avatarId: 'avatar-player',
    },
  ],
  players: [],
  createdAt: 1,
  updatedAt: 1,
});

test('join/start race has one serialized roster outcome', async () => {
  const repository = new InMemoryRoomRepository([raceRoom()]);
  const rooms = new RoomService(repository, new InMemoryEventStore(), { autoDrive: false });
  const host = await rooms.identity('RACE01', 'host', 'host-resume');

  const [joinResult, startResult] = await Promise.allSettled([
    rooms.join({
      actorId: 'guest-2', name: 'Guest 2', roomCode: 'RACE01', joinToken: 'join-secret',
    }),
    rooms.startGame(host, { commandId: 'race-start', expectedRoomRevision: 1 }),
  ]);

  if (startResult.status === 'fulfilled') {
    const record = await rooms.getRecord('RACE01');
    assert.equal(record?.status, 'playing');
    assert.equal(record?.members.filter((member) => member.kind === 'player').length, 3);
    assert.equal(record?.players.length, 3);
    assert.deepEqual(
      new Set(record?.players.map((player) => player.id)),
      new Set(record?.members.filter((member) => member.kind === 'player').map((member) => member.id)),
    );
    if (joinResult.status === 'rejected') {
      assert.ok(joinResult.reason instanceof RoomServiceError);
      assert.equal(joinResult.reason.code, 'GAME_ALREADY_STARTED');
    }
  } else {
    // If the join claims the waiting record first, the stale start command is
    // retried against the new revision and must include that same member.
    assert.ok(joinResult.status === 'fulfilled');
    let current = await rooms.get('RACE01', 'host');
    await repository.mutate('RACE01', current.roomRevision, (room) => {
      room.members.find((member) => member.id === 'guest-2')!.ready = true;
    });
    current = await rooms.get('RACE01', 'host');
    const retried = await rooms.startGame(host, {
      commandId: 'race-start-retry',
      expectedRoomRevision: current.roomRevision,
    });
    const record = await rooms.getRecord('RACE01');
    assert.equal(retried.status, 'playing');
    assert.equal(record?.players.length, 3);
    assert.ok(record?.players.some((player) => player.id === 'guest-2'));
  }
  await rooms.close();
});
