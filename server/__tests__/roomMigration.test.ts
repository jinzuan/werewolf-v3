import assert from 'node:assert/strict';
import test from 'node:test';
import type { Player } from '../../shared/types';
import {
  DEFAULT_ROLE_SETUP,
  migrateRoomRecord,
  needsRoomMigration,
  roleSetupTotal,
} from '../rooms/roomMigration';
import type { RoomRecord } from '../rooms/types';

const legacyPlayer = (
  id: string,
  order: number,
  role: Player['role'] = null,
  isAI = false,
): Player => ({
  id,
  roomId: 'room-legacy',
  name: id,
  isAI,
  role,
  isAlive: true,
  isHost: order === 1,
  order,
  isReady: false,
});

const legacyRoom = (overrides: Partial<RoomRecord> = {}): RoomRecord => ({
  id: 'room-legacy',
  code: 'legacy1',
  name: 'Legacy room',
  joinToken: 'join-token',
  omniscientToken: 'omniscient-token',
  hostId: 'host',
  maxPlayers: 12,
  status: 'waiting',
  auto: false,
  debugMode: false,
  members: [
    {
      id: 'host',
      name: 'Host',
      kind: 'player',
      connected: true,
      omniscient: false,
      resumeToken: 'host-resume',
    },
    {
      id: 'spectator',
      name: 'Spectator',
      kind: 'spectator',
      connected: true,
      omniscient: false,
      resumeToken: 'spectator-resume',
    },
  ],
  players: [legacyPlayer('host', 1)],
  createdAt: 100,
  ...overrides,
});

test('legacy waiting room migrates seats, ready values, revisions and config', () => {
  const room = migrateRoomRecord(legacyRoom());

  assert.equal(room.schemaVersion, 1);
  assert.equal(room.roomRevision, 1);
  assert.equal(room.configRevision, 1);
  assert.equal(room.configLocked, false);
  assert.equal(room.config?.rulesetAvailable, false);
  assert.deepEqual(room.config?.roleSetup, DEFAULT_ROLE_SETUP);
  assert.equal(roleSetupTotal(room.config!.roleSetup), room.maxPlayers);
  assert.deepEqual(room.members[0], {
    id: 'host',
    name: 'Host',
    kind: 'player',
    connected: true,
    omniscient: false,
    resumeToken: 'host-resume',
    isAI: false,
    seatIndex: 0,
    ready: false,
    avatarId: '',
  });
  assert.equal(room.members[1].seatIndex, null);
  assert.equal(room.members[1].ready, null);
  assert.equal(needsRoomMigration(room), false);
});

test('active legacy room keeps the exact session and assigned roles', () => {
  const players = [
    legacyPlayer('host', 1, 'wolf'),
    legacyPlayer('seer', 2, 'seer'),
  ];
  const session = {
    state: {
      gameId: 'game-kept',
      players,
    },
  } as RoomRecord['session'];
  const legacy = legacyRoom({
    status: 'playing',
    players,
    session,
  });

  const migrated = migrateRoomRecord(legacy);

  assert.deepEqual(migrated.session, session);
  assert.deepEqual(migrated.players, players);
  assert.equal(migrated.gameId, 'game-kept');
  assert.deepEqual(migrated.config?.roleSetup, { wolf: 1, seer: 1, witch: 0, hunter: 0, guardian: 0, villager: 0 });
  assert.equal(migrated.configLocked, true);
});
