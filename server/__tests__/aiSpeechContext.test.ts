import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent, EventVisibility } from '../../shared/events';
import type { Player } from '../../shared/types';
import { buildAIPrompt } from '../ai/promptBuilder';
import { projectAIContext } from '../ai/contextProjector';
import { buildAIRuntimeContext } from '../ai/runtimeContext';
import type { AIActorStatus, AIRequestContext } from '../ai/types';
import { VisibilityProjector } from '../events/projector';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';

const speechEvent = (
  sequence: number,
  day: number,
  stage: 'speech' | 'discussion',
  actorId: string,
  content: string,
  round = 1,
): DomainEvent => ({
  eventId: `speech-${sequence}`,
  roomId: 'room-speech-status',
  gameId: 'game-speech-status',
  sequence,
  occurredAt: sequence,
  phase: 'day',
  stage,
  actorId,
  eventType: 'day.speech',
  payload: {
    actorId,
    day,
    round,
    discussion: stage === 'discussion',
    ...(stage === 'discussion' ? { discussionRound: round } : {}),
    content,
  },
  visibility: 'public_timeline',
  correlationId: `speech-${sequence}`,
  schemaVersion: 1,
});

const players: Player[] = [
  {
    id: 'dead-villager',
    roomId: 'room-speech-status',
    name: '赵六',
    isAI: true,
    role: 'villager',
    isAlive: false,
    isHost: false,
    order: 1,
  },
  {
    id: 'alive-villager',
    roomId: 'room-speech-status',
    name: '好运来',
    isAI: false,
    role: 'villager',
    isAlive: true,
    isHost: false,
    order: 2,
  },
];

const context = (
  actorStatus: AIActorStatus,
  allowedActions: AIRequestContext['allowedActions'],
  allowedCommandTypes: AIRequestContext['allowedCommandTypes'],
): AIRequestContext => ({
  roomId: 'room-speech-status',
  gameId: 'game-speech-status',
  playerId: 'dead-villager',
  role: 'villager',
  phase: actorStatus.turnKind === 'hunter_shoot' ? 'day' : 'lastWords',
  stage: actorStatus.turnKind === 'hunter_shoot' ? 'hunter' : 'last_words',
  stageRevision: 7,
  callId: 'speech-status-test',
  players,
  actorStatus,
  allowedActions,
  allowedCommandTypes,
  promptContext: buildAIRuntimeContext({
    actorId: 'dead-villager',
    role: 'villager',
    phase: actorStatus.turnKind === 'hunter_shoot' ? 'day' : 'lastWords',
    stage: actorStatus.turnKind === 'hunter_shoot' ? 'hunter' : 'last_words',
    dayNumber: 3,
    roundNumber: 1,
    players,
    visibleEvents: [],
    allowedActions: allowedActions ?? [],
    actorStatus,
  }),
});

test('dead last-words context is hard-stated in system and user prompts', () => {
  const prompt = buildAIPrompt(context(
    { isAlive: false, deathStatus: 'dead_last_words', turnKind: 'last_words' },
    ['speak'],
    ['game.speak'],
  ));

  for (const text of [prompt.system, prompt.user]) {
    assert.match(text, /isAlive=false（已出局）/);
    assert.match(text, /正在说出局后的遗言/);
    assert.match(text, /未来只能给存活玩家建议/);
    assert.match(text, /下一轮我会.*投票、查验、守护、用药或狼刀/);
  }
});

test('dead hunter action is a distinct server-authorized turn', () => {
  const prompt = buildAIPrompt(context(
    { isAlive: false, deathStatus: 'dead_hunter_action', turnKind: 'hunter_shoot' },
    ['hunter_shoot', 'skip_hunter_shot'],
    ['game.hunter_shoot'],
  ));

  assert.match(prompt.system, /独立猎人开枪阶段/);
  assert.match(prompt.user, /独立猎人开枪阶段/);
  assert.doesNotMatch(prompt.user, /普通白天回合/);
});

test('regular speech prompt permits independent judgment, positive interaction, and intentional silence', () => {
  const prompt = buildAIPrompt({
    ...context(
      { isAlive: true, deathStatus: 'alive', turnKind: 'regular_speech' },
      ['speak', 'skip_speech'],
      ['game.speak', 'game.skip_speech'],
    ),
    phase: 'day',
    stage: 'speech',
  });

  assert.match(prompt.system, /公共发言决策上下文/);
  assert.match(prompt.system, /报告信息.*认可具体判断.*保留观察/u);
  assert.match(prompt.system, /不要求每次形成怀疑对象/u);
  assert.match(prompt.system, /没有点名不能被自动视为无效发言/u);
  assert.match(prompt.system, /不要求回应上一位/u);
  assert.match(
    prompt.system,
    /只有在没有新证据[\s\S]*且没有人点名、追问或反驳你时，才能在规则允许时跳过发言/u,
  );
  assert.match(prompt.system, /“加分”表示某个明确的公开事实/u);
  assert.match(prompt.user, /本轮可选主动作：[\s\S]*认可一个具体判断/u);
  assert.match(prompt.user, /“指认一个人”不是必填项/u);
  assert.match(
    prompt.user,
    /轮到你时先推进一件有价值的事：探查、追问、回应、暂时站边或信息交换均可；不强迫指认/u,
  );
});

test('speech continuity guidance is not injected into a non-speech action', () => {
  const prompt = buildAIPrompt({
    ...context(
      { isAlive: true, deathStatus: 'alive', turnKind: 'regular_action' },
      ['vote'],
      ['game.vote'],
    ),
    phase: 'voting',
    stage: 'voting',
    promptContext: {
      legalActions: ['vote'],
      legalTargets: [{ id: 'villager-10', name: '玩家10' }],
    },
  });

  assert.doesNotMatch(prompt.system, /你不是发言接力员/);
  assert.match(prompt.user, /合法目标/);
});

test('last-words prompt keeps its dedicated response and supplement guidance', () => {
  const prompt = buildAIPrompt(context(
    { isAlive: false, deathStatus: 'dead_last_words', turnKind: 'last_words' },
    ['speak'],
    ['game.speak'],
  ));

  assert.doesNotMatch(prompt.system, /你不是发言接力员/);
  assert.match(prompt.user, /只补遗漏、回应新增信息或给最终行动建议/);
});

test('current round speeches are bounded by day, stage, and discussion round', () => {
  const visibleEvents = [
    speechEvent(1, 1, 'speech', 'alive-villager', '前一天旧发言'),
    speechEvent(2, 2, 'speech', 'dead-villager', '今天首轮发言'),
    speechEvent(3, 2, 'discussion', 'alive-villager', '今天讨论首轮'),
    speechEvent(4, 2, 'discussion', 'alive-villager', '今天讨论第二轮', 2),
  ];
  const runtime = buildAIRuntimeContext({
    actorId: 'dead-villager',
    role: 'villager',
    phase: 'day',
    stage: 'discussion',
    dayNumber: 2,
    roundNumber: 1,
    players,
    visibleEvents,
    allowedActions: ['speak'],
  });

  assert.deepEqual(runtime.currentRoundSpeeches, [
    '好运来：今天讨论首轮',
  ]);
  assert.doesNotMatch(runtime.currentRoundSpeeches?.[0] ?? '', /【第|discussion|speech/);
  assert.match(runtime.publicSpeeches?.[0] ?? '', /好运来：前一天旧发言/);
  assert.match(runtime.publicSpeeches?.[3] ?? '', /好运来：今天讨论第二轮/);
  assert.deepEqual(runtime.ownPreviousSpeeches, [
    '赵六：今天首轮发言',
  ]);
});

const privateEvent = (
  sequence: number,
  eventType: 'seer.result' | 'wolf.message',
  visibility: EventVisibility,
): DomainEvent => ({
  eventId: `private-${sequence}`,
  roomId: 'room-speech-status',
  gameId: 'game-speech-status',
  sequence,
  occurredAt: sequence,
  phase: 'night',
  stage: 'guard_seer',
  actorId: 'dead-villager',
  eventType,
  payload: eventType === 'seer.result'
    ? { targetId: 'alive-villager', alignment: 'good' }
    : { actorId: 'dead-villager', content: '死前狼聊' },
  visibility,
  audienceIds: ['dead-villager'],
  correlationId: `private-${sequence}`,
  schemaVersion: 1,
});

test('dead AI projection keeps pre-death knowledge and cuts off later private events', () => {
  const projector = new VisibilityProjector();
  const viewer = {
    kind: 'player' as const,
    playerId: 'dead-villager',
    role: 'seer' as const,
    isAlive: false,
    deathCutoffSequence: 3,
  };
  const death: DomainEvent = {
    eventId: 'death-3',
    roomId: 'room-speech-status',
    gameId: 'game-speech-status',
    sequence: 3,
    occurredAt: 3,
    phase: 'day',
    stage: 'last_words',
    eventType: 'day.exiled',
    payload: { day: 2, playerId: 'dead-villager' },
    visibility: 'public_timeline',
    correlationId: 'death-3',
    schemaVersion: 1,
  };

  assert.ok(projector.projectEvent(privateEvent(1, 'seer.result', 'role_private'), viewer));
  assert.ok(projector.projectEvent(death, viewer));
  assert.equal(projector.projectEvent(privateEvent(4, 'seer.result', 'role_private'), viewer), undefined);
  assert.equal(projector.projectEvent(privateEvent(5, 'wolf.message', 'wolf_private'), viewer), undefined);
});

test('AI context projection carries the authoritative alive flag into its viewer', async () => {
  const session = new GameSession(
    'room-speech-status',
    players,
    new InMemoryEventStore(),
  );
  await session.initialize();
  const projection = await projectAIContext(session, {
    playerId: 'dead-villager',
    role: 'villager',
    stageRevision: session.stageRevision,
    allowedActions: [],
  });

  assert.equal(projection.viewer.isAlive, false);
  assert.equal(projection.actorStatus?.isAlive, false);
});
