import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryInsightStore } from '../review/insightStore';
import { ReviewPipeline } from '../review/reviewPipeline';
import { InMemoryReviewRepository } from '../review/reviewRepository';

test('ordinary spectators receive only public review messages and timeline entries', async () => {
  const events = new InMemoryEventStore();
  const make = (sequence: number, eventType: 'game.ended' | 'seer.result', visibility: 'public_timeline' | 'role_private') => ({
    eventId: `projection-${sequence}`,
    roomId: 'room-projection', gameId: 'game-projection', sequence,
    occurredAt: sequence, phase: 'ended' as const, stage: null,
    eventType, payload: { winner: 'good', alignment: 'wolf' }, visibility,
    ...(visibility === 'role_private' ? { audienceIds: ['seer'] } : {}),
    correlationId: `projection-${sequence}`, schemaVersion: 1 as const,
  });
  await events.append({
    streamId: 'game:game-projection', expectedVersion: 0,
    events: [
      make(1, 'seer.result', 'role_private'),
      make(2, 'game.ended', 'public_timeline'),
      {
        ...make(3, 'game.ended', 'public_timeline'),
        eventType: 'game.state_updated',
        payload: { players: [{ id: 'seer', name: '预言家', role: 'seer', isAI: false, isAlive: true, order: 1 }] },
      },
    ],
  });
  const pipeline = new ReviewPipeline(events, new InMemoryReviewRepository(), {
    insightStore: new InMemoryInsightStore(),
    generator: {
      async generate() {
        return {
          messages: [
            { text: '公开结论', audience: 'public' as const, evidenceEventIds: ['projection-2'] },
            { text: '预言家私有结论', audience: 'role' as const, role: 'seer' as const, evidenceEventIds: ['projection-1'] },
          ],
          insights: [],
        };
      },
    },
  });
  await pipeline.enqueue({ gameId: 'game-projection', roomId: 'room-projection', reviewEnabled: true });
  await pipeline.process('game-projection');
  const spectator = await pipeline.view('game-projection', {
    kind: 'spectator', spectatorId: 'spectator', omniscient: false,
  });
  assert.equal(spectator?.messages.length, 1);
  assert.ok(spectator?.messages[0].text === '公开结论');
  assert.ok(!spectator?.timeline.some((item) => item.eventType === 'seer.result'));
});
