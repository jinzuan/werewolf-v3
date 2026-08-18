import assert from 'node:assert/strict';
import test from 'node:test';
import type { Player } from '../../shared/types';
import { buildAIPrompt } from '../ai/promptBuilder';
import { buildAIRuntimeContext } from '../ai/runtimeContext';
import type { AIActorStatus, AIRequestContext } from '../ai/types';

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
