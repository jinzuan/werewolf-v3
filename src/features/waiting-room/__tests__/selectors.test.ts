import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoomViewV31 } from '../../../../shared/roomContract';
import {
  isActionAllowed,
  selectPlayerSeats,
  selectSpectators,
  selectUnassignedPlayers,
  startCheckCopy,
  startCheckReason,
} from '../selectors';

const room = (members: RoomViewV31['members']): RoomViewV31 => ({
  id: 'room-1',
  code: 'MOON01',
  name: '月影村',
  roomRevision: 4,
  status: 'ready_check',
  config: {
    catalogVersion: 'catalog-1',
    mode: 'human',
    visibility: 'invite_only',
    maxPlayers: 4,
    minHumanPlayers: 2,
    computerSeats: 0,
    aiFillPolicy: 'none',
    roleSetup: {
      wolf: 1,
      seer: 1,
      witch: 0,
      hunter: 0,
      guardian: 0,
      villager: 2,
    },
    rulesetId: 'werewolf.v3',
    rulesetVersion: '3.1.0',
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: true,
    reviewEnabled: true,
  },
  configRevision: 2,
  configLocked: true,
  members,
  counts: {
    playerSeats: 4,
    humanPlayers: members.filter((member) => member.kind === 'player').length,
    onlineHumanPlayers: 1,
    readyHumanPlayers: 1,
    spectators: members.filter((member) => member.kind === 'spectator').length,
  },
  startCheck: { passed: false, items: [] },
  viewer: {
    actorId: 'p1',
    kind: 'player',
    omniscient: false,
    allowedRoomActions: ['set_ready', 'invite'],
  },
  createdAt: 1,
});

test('等待房席位由 seatIndex 投影，空席不生成成员', () => {
  const projection = room([
    {
      id: 'p1',
      name: '阿岚',
      kind: 'player',
      seatIndex: 2,
      isAI: false,
      isHost: true,
      connected: true,
      ready: true,
      avatarId: 'avatar-player',
    },
    {
      id: 's1',
      name: '云朵',
      kind: 'spectator',
      seatIndex: null,
      isAI: false,
      isHost: false,
      connected: true,
      ready: null,
      avatarId: 'avatar-spectator',
    },
  ]);

  const seats = selectPlayerSeats(projection);
  assert.equal(seats.length, 4);
  assert.equal(seats[0].member, null);
  assert.equal(seats[2].member?.name, '阿岚');
  assert.equal(seats.some((seat) => seat.member?.name === '玩家 01'), false);
  assert.deepEqual(selectSpectators(projection).map((member) => member.name), ['云朵']);
});

test('没有席位号的真实玩家不会被伪造成空席成员', () => {
  const projection = room([
    {
      id: 'p1',
      name: '待安排的客人',
      kind: 'player',
      seatIndex: null,
      isAI: false,
      isHost: false,
      connected: true,
      ready: false,
      avatarId: 'avatar-player',
    },
  ]);

  assert.deepEqual(
    selectUnassignedPlayers(projection).map((member) => member.name),
    ['待安排的客人'],
  );
  assert.equal(selectPlayerSeats(projection).every((seat) => seat.member === null), true);
});

test('等待房动作和开局检查都消费服务端事实', () => {
  const projection = room([]);
  assert.equal(isActionAllowed(projection, 'set_ready'), true);
  assert.equal(isActionAllowed(projection, 'start_game'), false);

  const copy = startCheckCopy({
    key: 'minimum_humans',
    passed: false,
    messageKey: 'room.start.minimum_humans',
    params: { required: 2, actual: 1 },
  });
  assert.equal(copy.reason, '还需要 1 名真人加入。');
  assert.equal(copy.remedyAction, 'invite');
  assert.doesNotMatch(copy.reason, /minimum_humans|room\.start/);
  assert.equal(startCheckReason({
    key: 'all_humans_ready',
    passed: false,
    messageKey: 'room.start.all_humans_ready',
    params: { total: 8, actual: 7 },
  }), '真人玩家全部准备：还有 1 名真人玩家未准备。');
});
