import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMAIN_EVENT_SCHEMA_VERSION, type DomainEvent } from '../../shared/events';
import { buildPromptPipeline } from '../ai/promptPipeline';
import type { AIRequestContext } from '../ai/types';

test('long event histories are bounded before the provider request', () => {
  const events: DomainEvent[] = Array.from({ length: 1_000 }, (_, index) => ({
    eventId: `event-${index}`,
    roomId: 'room-1',
    gameId: 'game-1',
    sequence: index + 1,
    occurredAt: index,
    phase: 'day',
    stage: 'speech',
    eventType: 'day.speech',
    payload: { actorId: 'p1', content: `第${index}条历史信息 ${'x'.repeat(30)}` },
    visibility: 'public_timeline',
    actorId: 'p1',
    correlationId: `command-${index}`,
    schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
  }));
  const context: AIRequestContext = {
    roomId: 'room-1',
    gameId: 'game-1',
    playerId: 'p1',
    role: 'villager',
    phase: 'day',
    stage: 'speech',
    stageRevision: 10,
    callId: 'call-1',
    players: [{ id: 'p1', roomId: 'room-1', name: '甲', isAI: true, role: 'villager', isAlive: true, isHost: false, order: 1 }],
    allowedCommandTypes: ['game.speak'],
    allowedActions: ['speak'],
    projectedContext: {
      viewer: { kind: 'player', playerId: 'p1', role: 'villager' },
      snapshot: {
        roomId: 'room-1',
        gameId: 'game-1',
        viewer: { kind: 'player', playerId: 'p1', role: 'villager' },
        gameState: { day: 1 } as never,
        players: [],
        serverTime: 1,
        lastSequence: 1_000,
      },
      publicEvents: events,
      privateEvents: [],
      rules: { id: 'ruleset-test', version: 'v1', values: { authority: 'server' } },
      experience: '静态经验',
      allowedActions: ['speak'],
    },
  };
  const result = buildPromptPipeline(context, { maxChars: 4_500, maxEvents: 40 });
  assert.ok(result.budget.droppedEvents >= 960);
  assert.ok(result.prompt.system.length + result.prompt.user.length <= 4_500);
  assert.match(`${result.prompt.system}\n${result.prompt.user}`, /ruleset-test/);
  assert.match(`${result.prompt.system}\n${result.prompt.user}`, /静态经验/);
});
