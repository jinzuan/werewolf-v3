import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOMAIN_EVENT_MESSAGES,
  DOMAIN_EVENT_MESSAGE_KEYS,
  UNKNOWN_EVENT_MESSAGE,
  describeEvent,
} from '../eventMessages';
import {
  ACTION_LABELS,
  EVENT_VISIBILITY_LABELS,
  NIGHT_STAGE_LABELS,
  ROLE_LABELS,
  ROOM_ACTION_LABELS,
  ROOM_MODE_LABELS,
  ROOM_STATUS_LABELS,
  WIZARD_STATUS_LABELS,
} from '../domainLabels';
import {
  PROTOCOL_ERROR_MESSAGES,
  getErrorMessage,
  getErrorPresentation,
} from '../errorMessages';
import { formatEventTime, phaseLabel } from '../messageFormatter';
import { scanI18nText } from '../i18nScan';
import { createPlayerNameResolver, displayPlayerName } from '../playerNames';
import { DOMAIN_EVENT_TYPES } from '../../../../shared/events';
import { PROTOCOL_ERROR_CODES } from '../../../../shared/protocol';
import { GAME_ACTIONS, NIGHT_STAGES } from '../../../../shared/types';

const event = (eventType: string, payload: Record<string, unknown> = {}) => ({
  eventId: 'event-1',
  roomId: 'room-1',
  gameId: 'game-1',
  sequence: 1,
  occurredAt: 0,
  phase: 'night' as const,
  stage: 'resolve' as const,
  eventType,
  payload,
  visibility: 'public_timeline' as const,
  correlationId: 'test',
  schemaVersion: 1 as const,
}) as Parameters<typeof describeEvent>[0];

test('领域枚举均有中文展示值', () => {
  for (const value of Object.values(ROLE_LABELS)) assert.match(value, /[\u4e00-\u9fff]/);
  for (const value of Object.values(ROOM_STATUS_LABELS)) assert.match(value, /[\u4e00-\u9fff]/);
  for (const value of Object.values(WIZARD_STATUS_LABELS)) assert.match(value, /[\u4e00-\u9fff]/);
  for (const value of Object.values(ROOM_MODE_LABELS)) assert.match(value, /[\u4e00-\u9fff]/);
  for (const value of Object.values(ROOM_ACTION_LABELS)) assert.match(value, /[\u4e00-\u9fff]/);
  for (const value of Object.values(ACTION_LABELS)) assert.match(value, /[\u4e00-\u9fff]/);
  for (const value of Object.values(NIGHT_STAGE_LABELS)) assert.match(value, /[\u4e00-\u9fff]/);
  for (const value of Object.values(EVENT_VISIBILITY_LABELS)) assert.match(value, /[\u4e00-\u9fff]/);

  assert.deepEqual(Object.keys(ACTION_LABELS).sort(), [...GAME_ACTIONS].sort());
  assert.deepEqual(Object.keys(NIGHT_STAGE_LABELS).sort(), [...NIGHT_STAGES].sort());
});

test('当前事件和协议错误均有穷举 presentation', () => {
  for (const type of DOMAIN_EVENT_TYPES) {
    assert.ok(DOMAIN_EVENT_MESSAGE_KEYS[type]);
    assert.ok(DOMAIN_EVENT_MESSAGES[type]);
  }
  for (const code of PROTOCOL_ERROR_CODES) {
    assert.ok(PROTOCOL_ERROR_MESSAGES[code]);
    assert.notEqual(getErrorMessage(code), code);
  }
});

test('白天阶段标签明确提示何时进入放逐投票', () => {
  assert.equal(
    phaseLabel({ phase: 'day', day: 2, dayStage: 'discussion' } as never),
    '第 2 天 · 白天讨论',
  );
  assert.equal(
    phaseLabel({ phase: 'day', day: 2, dayStage: 'voting' } as never),
    '第 2 天 · 放逐投票',
  );
});

test('事件模板只显示安全中文，未知事件不回显原始值', () => {
  const playerName = (id: string | null) => id === 'p1' ? '一号玩家' : '未知目标';
  assert.equal(
    describeEvent(event('game.started', { day: 2 }), playerName),
    '对局开始，进入第 2 夜。',
  );
  assert.equal(
    describeEvent(event('night.resolved', { peacefulNight: true }), playerName),
    '天亮了，昨夜是平安夜。',
  );
  assert.equal(
    describeEvent(event('day.speech', { actorId: 'p1', content: '我昨晚认真盘了票型。' }), playerName),
    '一号玩家：我昨晚认真盘了票型。',
  );
  assert.equal(
    describeEvent(event('night.resolved', { deaths: ['p1'], peacefulNight: false }), playerName),
    '天亮了，昨夜出局：一号玩家。',
  );
  assert.equal(
    describeEvent(event('future.internal_event'), playerName),
    UNKNOWN_EVENT_MESSAGE,
  );
  assert.equal(
    describeEvent(event('night.resolution_detail'), playerName),
    UNKNOWN_EVENT_MESSAGE,
  );
  assert.match(
    describeEvent(event('night.resolution_detail'), playerName, { advanced: true }),
    /夜间结算明细/,
  );
});

test('全知观战将玩家视角的第一人称事件还原为真实席位名', () => {
  const playerName = (id: string | null) => id === 'p1' ? '一号玩家' : '未知目标';
  const monitor = {
    kind: 'spectator' as const,
    spectatorId: 'monitor-1',
    omniscient: true,
  };
  assert.equal(
    describeEvent({
      ...event('role.confirmed', { confirmed: true }),
      actorId: 'p1',
      visibility: 'role_private',
    }, playerName, { viewer: monitor }),
    '一号玩家已确认身份。',
  );
  assert.equal(
    describeEvent({
      ...event('role.confirmed', { confirmed: true }),
      actorId: 'p1',
      visibility: 'role_private',
    }, playerName),
    '你已确认身份。',
  );
});

test('公开观战不会把其他席位的行动主体显示成你', () => {
  const playerName = (id: string | null) => id === 'p1' ? '一号玩家' : '未知目标';
  const spectator = {
    kind: 'spectator' as const,
    spectatorId: 'watcher-1',
    omniscient: false,
  };
  assert.equal(
    describeEvent({
      ...event('role.confirmed', { confirmed: true }),
      actorId: 'p1',
      visibility: 'public_timeline',
    }, playerName, { viewer: spectator }),
    '一号玩家已确认身份。',
  );
  assert.doesNotMatch(
    describeEvent({
      ...event('night.skipped', { actorId: 'p1' }),
      visibility: 'public_timeline',
    }, playerName, { viewer: spectator }),
    /^你/,
  );
});

test('狼人时间线展示逐狼投票目标，普通视角只看到安全提示', () => {
  const playerName = (id: string | null) => id === 'p1' ? '一号玩家' : id === 'p2' ? '二号玩家' : '未知目标';
  const vote = event('wolf.vote_cast', { actorId: 'p1', targetId: 'p2' });
  assert.equal(
    describeEvent(vote, playerName, {
      viewer: { kind: 'player', playerId: 'p1', role: 'wolf' },
    }),
    '一号玩家已投向二号玩家。',
  );
  assert.equal(
    describeEvent(vote, playerName, {
      viewer: { kind: 'player', playerId: 'p2', role: 'villager' },
    }),
    '一号玩家已提交狼人投票。',
  );
});

test('狼人能看到狼队最终锁定的袭击目标，其他玩家只能看到安全提示', () => {
  const playerName = (id: string | null) => id === 'p2' ? '二号玩家' : '未知目标';
  const kill = event('wolf.kill_locked', { targetId: 'p2' });
  assert.equal(
    describeEvent(kill, playerName, {
      viewer: { kind: 'player', playerId: 'p1', role: 'wolf' },
    }),
    '狼人已决定今晚的目标：二号玩家。',
  );
  assert.equal(
    describeEvent(kill, playerName, {
      viewer: { kind: 'player', playerId: 'p2', role: 'villager' },
    }),
    '狼人已决定今晚的目标。',
  );
});

test('公开放逐结果展示 AI 投票理由，投票前事件不展示票型', () => {
  const playerName = (id: string | null) =>
    id === 'p1' ? '一号玩家' : id === 'p2' ? '二号玩家' : '未知目标';
  const history = [
    { voterId: 'p1', targetId: 'p2', reason: '票型判断' },
    { voterId: 'p2', targetId: null, reason: '暂不确定' },
  ];
  const spectator = {
    kind: 'spectator' as const,
    spectatorId: 'watcher-1',
    omniscient: false,
  };

  assert.equal(
    describeEvent(event('day.exile_result', { voteHistory: history }), playerName, {
      viewer: spectator,
    }),
    '放逐投票已锁定，结果待结算。 投票明细：一号玩家投票给二号玩家（理由：票型判断）；二号玩家弃票（理由：暂不确定）',
  );
  assert.equal(
    describeEvent({
      ...event('day.exile_result', { voteHistory: history }),
      visibility: 'role_private',
    }, playerName, { viewer: spectator }),
    '放逐投票已锁定，结果待结算。',
  );
});

test('未知错误码使用安全兜底并提供恢复意图', () => {
  assert.equal(getErrorMessage('not-a-protocol-code'), '请求未完成，请稍后重试。');
  assert.equal(getErrorMessage('__proto__'), '请求未完成，请稍后重试。');
  assert.deepEqual(getErrorPresentation('ROOM_REVISION_CONFLICT'), {
    message: '房间设置刚刚发生变化，请确认最新内容。',
    recovery: 'refresh_room',
  });
});

test('时间和阶段格式化不暴露内部值', () => {
  assert.equal(formatEventTime(Number.NaN), '时间未知');
  assert.match(formatEventTime(0), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(phaseLabel(null), '等待数据');
  assert.equal(phaseLabel({ phase: 'night', day: 2 } as never), '第 2 夜');
});

test('汉化扫描能拦截原始枚举和技术词', () => {
  assert.deepEqual(scanI18nText('当前页面显示 alive、snapshot 和 ViewerContext'), [
    { value: 'alive', index: 7 },
    { value: 'snapshot', index: 13 },
    { value: 'ViewerContext', index: 24 },
  ]);
  assert.deepEqual(scanI18nText('当前页面显示：已准备、对局中。'), []);
});

test('AI 展示名优先使用开局快照，并修复遗留电脑占位名', () => {
  const playerName = createPlayerNameResolver([
    { id: 'ai-1', name: '电脑 01', isAI: true, order: 1 },
    { id: 'ai-2', name: '小雅', isAI: true, order: 2 },
    { id: 'human', name: '云朵', isAI: false, order: 3 },
  ], [{ id: 'ai-1', name: '电脑 01' }]);

  assert.equal(playerName('ai-1'), '小雨');
  assert.equal(playerName('ai-2'), '小雅');
  assert.equal(playerName('human'), '云朵');
  assert.equal(displayPlayerName(
    { id: 'ai-3', name: '电脑1', isAI: true, order: 3 },
    'AI 03',
  ), '小雅');
});
