import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent, StoredEvent } from '../../shared/events';
import type { ReviewArchivePlayer } from '../../shared/reviewContract';
import { AIReviewGenerator } from '../review/aiReviewGenerator';
import { InMemoryInsightStore } from '../review/insightStore';
import type { ReviewGeneratorInput } from '../review/reviewPipeline';

const players: ReviewArchivePlayer[] = [
  { id: 'ai-wolf-1', name: '小周', role: 'wolf', isAI: true, isAlive: true, order: 1, experienceInstanceId: 'exp-1', experienceAssetId: 'wolf_1.md', experienceText: '旧经验一' },
  { id: 'ai-wolf-2', name: '五月', role: 'wolf', isAI: true, isAlive: true, order: 2, experienceInstanceId: 'exp-2', experienceAssetId: 'wolf_2.md', experienceText: '旧经验二' },
  { id: 'human-1', name: '玩家', role: 'villager', isAI: false, isAlive: true, order: 3 },
];

const event = (sequence: number, eventType: DomainEvent['eventType'], visibility: DomainEvent['visibility'] = 'public_timeline', audienceIds?: string[]): StoredEvent => ({
  streamId: 'game:review-three-rounds', streamVersion: sequence,
  event: { eventId: `event-${sequence}`, roomId: 'room-1', gameId: 'review-three-rounds', sequence, occurredAt: sequence * 100, phase: 'ended', stage: null, eventType, payload: { day: 1, content: '某位玩家的公开发言' }, visibility, ...(audienceIds ? { audienceIds } : {}), correlationId: `test-${sequence}`, schemaVersion: 1 },
});

const events = [event(1, 'game.started'), event(2, 'day.speech'), event(3, 'wolf.message', 'wolf_private', ['ai-wolf-1', 'ai-wolf-2']), event(4, 'game.ended')];
const input: ReviewGeneratorInput = {
  archive: { gameId: 'review-three-rounds', roomId: 'room-1', operationId: 'review:review-three-rounds:ai', startedAt: 0, endedAt: 1_000, winner: 'good', players, events, sourceEventIds: events.map(({ event: item }) => item.eventId) },
  events,
};

test('AI review runs team, global, and one isolated self pass per AI', async () => {
  const systems: string[] = [];
  const generator = new AIReviewGenerator({
    async complete(prompt) {
      systems.push(prompt.system);
      return JSON.stringify({ messages: [{ text: '基于具体事件做了一次短复盘。', audience: 'public', evidenceEventIds: ['event-2'] }], insights: [{ role: 'wolf', text: '第1天公开发言后应核对行动结果。', evidenceEventIds: ['event-2'], experienceUpdate: '第1天公开发言后先核对结果。' }] });
    },
  });
  const result = await generator.generate(input);
  assert.equal(systems.length, 5);
  assert.equal(systems.filter((system) => system.includes('阵营团队复盘')).length, 2);
  assert.equal(systems.filter((system) => system.includes('全局公开复盘')).length, 1);
  assert.equal(systems.filter((system) => system.includes('AI 个体自我复盘')).length, 2);
  assert.equal(result.insights.filter((item) => item.round === 'self').length, 2);
  assert.deepEqual(result.insights.filter((item) => item.round === 'self').map((item) => item.playerId), ['ai-wolf-1', 'ai-wolf-2']);
});

test('agent experience updates are isolated by player and experience instance', async () => {
  const store = new InMemoryInsightStore();
  await store.add({ id: 'one', role: 'wolf', text: '第1天公开投票后先核对结果。', evidenceEventIds: ['event-2'], gameId: 'game-1', createdAt: 1, schemaVersion: 2, scope: 'agent', playerId: 'ai-wolf-1', experienceInstanceId: 'exp-1' });
  await store.add({ id: 'two', role: 'wolf', text: '第1天公开投票后先核对替代目标。', evidenceEventIds: ['event-2'], gameId: 'game-1', createdAt: 1, schemaVersion: 2, scope: 'agent', playerId: 'ai-wolf-2', experienceInstanceId: 'exp-2' });
  const one = await store.getPromptReference('wolf', 'ai-wolf-1', 'exp-1');
  const two = await store.getPromptReference('wolf', 'ai-wolf-2', 'exp-2');
  assert.match(one, /结果。/);
  assert.doesNotMatch(one, /替代目标/);
  assert.match(two, /替代目标/);
  assert.doesNotMatch(two, /结果。/);
});
