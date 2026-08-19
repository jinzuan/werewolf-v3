import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoomConfigView } from '../../shared/roomContract';
import { RULESET } from '../../src/core/rules';
import {
  allocateSeats,
  inspectSeatLayout,
  nextSeatIndex,
  randomFreeSeatIndex,
  SeatAllocationError,
} from '../rooms/seatAllocator';
import {
  evaluateStartCheck,
  RoomPolicy,
} from '../rooms/roomPolicy';
import {
  assertIdentityRoom,
  RoomProjectionError,
  RoomProjector,
} from '../rooms/roomProjector';
import type { RoomMember, RoomRecord, SocketIdentity } from '../rooms/types';

const config = (overrides: Partial<RoomConfigView> = {}): RoomConfigView => ({
  catalogVersion: 'v31-rulesets-3.0.0-stage1',
  mode: 'mixed',
  visibility: 'invite_only',
  maxPlayers: 12,
  minHumanPlayers: 2,
  computerSeats: 0,
  aiFillPolicy: 'fill_to_max',
  roleSetup: { ...RULESET.values['game.role_setup'] },
  rulesetId: RULESET.id,
  rulesetVersion: RULESET.rulesetVersion,
  readyPolicy: 'all_connected_humans',
  allowPublicSpectators: true,
  reviewEnabled: false,
  ...overrides,
});

const member = (
  id: string,
  overrides: Partial<RoomMember> = {},
): RoomMember => ({
  id,
  name: id,
  kind: 'player',
  connected: true,
  omniscient: false,
  resumeToken: `${id}-resume`,
  seatIndex: 0,
  isAI: false,
  ready: true,
  avatarId: 'moon',
  ...overrides,
});

const room = (overrides: Partial<RoomRecord> = {}): RoomRecord => ({
  id: 'room-1',
  code: 'ROOM01',
  name: '月影村',
  joinToken: 'join-secret',
  omniscientToken: 'monitor-secret',
  hostId: 'host',
  maxPlayers: 12,
  status: 'ready_check',
  auto: false,
  debugMode: false,
  config: config(),
  configLocked: true,
  roomRevision: 4,
  configRevision: 2,
  members: [
    member('host', { seatIndex: 0 }),
    member('guest', { seatIndex: 1 }),
  ],
  players: [],
  createdAt: 100,
  ...overrides,
});

test('RoomPolicy returns structured start failures and affected members', () => {
  const current = room({
    config: config({ minHumanPlayers: 3 }),
    members: [
      member('host', { seatIndex: 0, ready: true }),
      member('offline', { seatIndex: 1, connected: false, ready: false }),
    ],
  });
  const check = evaluateStartCheck(current);

  assert.equal(check.items.map((item) => item.key).join(','), 'config_valid,role_count,minimum_humans,all_humans_online,all_humans_ready,ai_fill,ruleset_available');
  assert.equal(check.passed, false);
  assert.equal(check.items.find((item) => item.key === 'minimum_humans')?.passed, false);
  assert.deepEqual(
    check.items.find((item) => item.key === 'all_humans_online')?.affectedMemberIds,
    ['offline'],
  );
  assert.deepEqual(
    check.items.find((item) => item.key === 'all_humans_ready')?.affectedMemberIds,
    ['offline'],
  );
  assert.equal(check.items.find((item) => item.key === 'minimum_humans')?.params?.required, 3);
});

test('RoomPolicy authorizes only server-computed room actions', () => {
  const current = room({
    members: room().members.map((item) =>
      item.id === 'guest' ? { ...item, ready: false } : item,
    ),
  });
  const policy = new RoomPolicy();
  assert.deepEqual(policy.allowedRoomActions(current, 'guest'), ['set_ready', 'leave', 'become_spectator', 'request_seat']);
  assert.deepEqual(policy.allowedRoomActions(current, 'host'), ['update_ai_config', 'cancel_ready_check', 'set_ready', 'leave', 'invite', 'transfer_host', 'dissolve', 'add_ai', 'kick_player', 'respond_seat_request']);
  assert.equal(policy.canStart(current, 'host'), false);

  const ready = room({
    members: room().members.map((item) => ({ ...item, ready: true })),
  });
  assert.equal(policy.canStart(ready, 'host'), true);
  assert.ok(policy.allowedRoomActions(ready, 'host').includes('start_game'));
  assert.throws(
    () => policy.assertAllowed(current, 'guest', 'start_game'),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'HOST_REQUIRED',
  );
});

test('seat allocation preserves assigned seats and rejects duplicate persisted seats', () => {
  const members = [
    member('a', { seatIndex: 1 }),
    member('watcher', { kind: 'spectator', seatIndex: null, ready: null }),
    member('b', { seatIndex: undefined }),
  ];
  assert.equal(nextSeatIndex(members, 4), 0);
  assert.deepEqual(
    allocateSeats(members, 4).map((item) => item.seatIndex),
    [1, null, 0],
  );
  assert.deepEqual(inspectSeatLayout(members, 4), {
    valid: true,
    occupied: [1],
    issues: [],
  });
  assert.equal(
    inspectSeatLayout([member('a', { seatIndex: 1 }), member('b', { seatIndex: 1 })], 4).valid,
    false,
  );
  assert.throws(
    () => nextSeatIndex([member('a', { seatIndex: 0 })], 1),
    (error: unknown) => error instanceof SeatAllocationError && error.code === 'ROOM_FULL',
  );
});

test('random seat allocation only chooses an unoccupied player seat', () => {
  const members = [
    member('a', { seatIndex: 1 }),
    member('watcher', { kind: 'spectator', seatIndex: null, ready: null }),
  ];
  assert.equal(randomFreeSeatIndex(members, 4, () => 0), 0);
  assert.equal(randomFreeSeatIndex(members, 4, () => 1), 2);
  assert.throws(
    () => randomFreeSeatIndex(members, 4, () => 4),
    (error: unknown) => error instanceof SeatAllocationError && error.code === 'INVALID_SEAT_INDEX',
  );
});

test('RoomProjector emits a safe viewer-specific RoomView', () => {
  const current = room({
    status: 'playing',
    members: [
      member('host', { seatIndex: 0 }),
      member('spectator', {
        kind: 'spectator',
        seatIndex: null,
        ready: null,
        omniscient: true,
      }),
    ],
    gameId: 'game-1',
    session: {
      state: { gameId: 'game-1' },
    } as RoomRecord['session'],
  });
  const projector = new RoomProjector();
  const view = projector.project(current, 'host');
  assert.equal(view.viewer.kind, 'player');
  assert.equal(view.members[1].seatIndex, null);
  assert.equal(view.members[1].ready, null);
  assert.equal(view.gameId, 'game-1');
  assert.doesNotMatch(
    JSON.stringify(view),
    /join-secret|monitor-secret|resume|session|players|role"\s*:/,
  );
  assert.deepEqual(view.config.roleSetup, RULESET.values['game.role_setup']);

  const identity: SocketIdentity = {
    actorId: 'spectator',
    roomCode: 'ROOM01',
    roomId: 'room-1',
    kind: 'spectator',
    omniscient: true,
    resumeToken: 'spectator-resume',
    gameId: 'game-1',
  };
  assert.equal(projector.project(current, identity).viewer.omniscient, true);
  assert.equal(
    projector.project(current, {
      actorId: 'host',
      kind: 'player',
      omniscient: false,
      allowedRoomActions: [],
    }).viewer.actorId,
    'host',
  );
  assert.throws(
    () => projector.project(current, {
      actorId: 'host',
      kind: 'spectator',
      omniscient: true,
      allowedRoomActions: [],
    }),
    (error: unknown) => error instanceof RoomProjectionError && error.code === 'IDENTITY_MISMATCH',
  );
  assert.throws(
    () => assertIdentityRoom({ ...identity, omniscient: false }, current),
    (error: unknown) => error instanceof RoomProjectionError && error.code === 'IDENTITY_MISMATCH',
  );
  assert.throws(
    () => projector.project(current, { ...identity, roomId: 'other-room' }),
    (error: unknown) => error instanceof RoomProjectionError && error.code === 'ROOM_MISMATCH',
  );
});
