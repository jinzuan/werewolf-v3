import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { InMemoryInsightStore } from '../review/insightStore';
import { ReviewPipeline } from '../review/reviewPipeline';
import { InMemoryReviewRepository } from '../review/reviewRepository';

test('pending and stale running jobs resume idempotently after restart', async () => {
  const events = new InMemoryEventStore();
  const ended = {
    eventId: 'ended', roomId: 'room-recovery', gameId: 'game-recovery', sequence: 1,
    occurredAt: 1, phase: 'ended' as const, stage: null, eventType: 'game.ended' as const,
    payload: { winner: 'draw' }, visibility: 'public_timeline' as const,
    correlationId: 'recovery', schemaVersion: 1 as const,
  };
  await events.append({ streamId: 'game:game-recovery', expectedVersion: 0, events: [ended] });
  const repository = new InMemoryReviewRepository();
  const pipeline = new ReviewPipeline(events, repository, { insightStore: new InMemoryInsightStore() });
  await pipeline.enqueue({ gameId: 'game-recovery', roomId: 'room-recovery', reviewEnabled: false });
  const pending = await repository.get('game-recovery');
  assert.ok(pending);
  await repository.save({ ...pending, status: 'running', runningSince: 0 });

  const restarted = new ReviewPipeline(events, repository, {
    now: () => 100_000,
    runningTimeoutMs: 10,
    insightStore: new InMemoryInsightStore(),
  });
  await restarted.restore();
  assert.equal((await repository.get('game-recovery'))?.status, 'disabled');
  await restarted.process('game-recovery');
  assert.equal((await repository.list()).length, 1);
});
