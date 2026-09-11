import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryInsightStore } from '../review/insightStore';
import { InMemoryReviewRepository } from '../review/reviewRepository';
import { ReviewPipeline, RulesReviewGenerator, type ReviewGenerator } from '../review/reviewPipeline';
import type { DomainEvent } from '../../shared/events';

const stream = (gameId: string): DomainEvent[] => [
  {
    eventId: `${gameId}-started`, roomId: 'room-1', gameId, sequence: 1, occurredAt: 1,
    phase: 'night', stage: 'guard_seer', eventType: 'game.started', payload: { day: 1 },
    visibility: 'public_timeline', correlationId: 'start', schemaVersion: 1,
  },
  {
    eventId: `${gameId}-state`, roomId: 'room-1', gameId, sequence: 2, occurredAt: 2,
    phase: 'ended', stage: null, eventType: 'game.state_updated', payload: {
      gameState: { day: 1 },
      players: [{ id: 'p1', name: '甲', role: 'villager', isAI: true, isAlive: true, order: 1 }],
    }, visibility: 'spectator_omniscient', correlationId: 'end', schemaVersion: 1,
  },
  {
    eventId: `${gameId}-ended`, roomId: 'room-1', gameId, sequence: 3, occurredAt: 3,
    phase: 'ended', stage: null, eventType: 'game.ended', payload: { winner: 'good', reason: 'test' },
    visibility: 'public_timeline', correlationId: 'end', schemaVersion: 1,
  },
];

test('review generation mode selects the configured generator and persists its mode', async () => {
  const eventStore = new InMemoryEventStore();
  for (const gameId of ['game-rules', 'game-ai']) {
    await eventStore.append({ streamId: `game:${gameId}`, expectedVersion: 0, events: stream(gameId) });
  }
  let rulesCalls = 0;
  let aiCalls = 0;
  const rules: ReviewGenerator = { generate: async () => { rulesCalls += 1; return { messages: [], insights: [] }; } };
  const ai: ReviewGenerator = { generate: async ({ archive }) => {
    aiCalls += 1;
    const ended = archive.events.find(({ event }) => event.eventType === 'game.ended');
    return {
      messages: ended ? [{ text: 'AI 复盘', audience: 'public', evidenceEventIds: [ended.event.eventId] }] : [],
      insights: [],
    };
  } };
  const pipeline = new ReviewPipeline(eventStore, new InMemoryReviewRepository(), {
    insightStore: new InMemoryInsightStore(),
    generator: new RulesReviewGenerator(),
    rulesGenerator: rules,
    aiGenerator: ai,
    defaultGenerationMode: 'rules',
  });
  try {
    await pipeline.enqueue({ gameId: 'game-rules', roomId: 'room-1', reviewEnabled: true, generationMode: 'rules' });
    await pipeline.enqueue({ gameId: 'game-ai', roomId: 'room-1', reviewEnabled: true, generationMode: 'ai' });
    const deadline = Date.now() + 1_000;
    let rulesJob = await pipeline.get('game-rules');
    let aiJob = await pipeline.get('game-ai');
    while ((rulesJob?.status !== 'completed' || aiJob?.status !== 'completed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      rulesJob = await pipeline.get('game-rules');
      aiJob = await pipeline.get('game-ai');
    }
    assert.equal(rulesJob?.generationMode, 'rules');
    assert.equal(aiJob?.generationMode, 'ai');
    assert.equal(rulesJob?.status, 'completed');
    assert.equal(aiJob?.status, 'completed');
    assert.equal(rulesCalls, 1);
    assert.equal(aiCalls, 1);
    assert.equal(aiJob?.messages[0]?.text, 'AI 复盘');
  } finally {
    await pipeline.close();
  }
});
