import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent, StoredEvent } from '../../shared/events';
import type { ReviewArchivePlayer } from '../../shared/reviewContract';
import { InMemoryEventStore } from '../events/store';
import { InMemoryInsightStore } from '../review/insightStore';
import {
  ReviewPipeline,
  type ReviewGeneration,
} from '../review/reviewPipeline';
import { InMemoryReviewRepository } from '../review/reviewRepository';

const players: ReviewArchivePlayer[] = [
  { id: 'wolf-1', name: '狼人一号', role: 'wolf', isAI: true, isAlive: true, order: 1 },
  { id: 'seer-1', name: '预言家一号', role: 'seer', isAI: false, isAlive: false, order: 2 },
  { id: 'villager-1', name: '平民一号', role: 'villager', isAI: false, isAlive: true, order: 3 },
];

const event = (
  sequence: number,
  eventType: DomainEvent['eventType'],
  payload: Record<string, unknown>,
  visibility: DomainEvent['visibility'] = 'public_timeline',
  audienceIds?: string[],
): StoredEvent => ({
  streamId: 'game:game-1',
  streamVersion: sequence,
  event: {
    eventId: `event-${sequence}`,
    roomId: 'room-1',
    gameId: 'game-1',
    sequence,
    occurredAt: sequence * 100,
    phase: 'ended',
    stage: null,
    eventType,
    payload,
    visibility,
    ...(audienceIds ? { audienceIds } : {}),
    correlationId: `test-${sequence}`,
    schemaVersion: 1,
  },
});

const seedEndedGame = async (store: InMemoryEventStore): Promise<void> => {
  await store.append({
    streamId: 'game:game-1',
    expectedVersion: 0,
    events: [
      event(1, 'game.started', { day: 1 }).event,
      event(2, 'seer.result', { targetId: 'wolf-1', alignment: 'wolf' }, 'role_private', ['seer-1']).event,
      event(3, 'wolf.kill_locked', { targetId: 'seer-1' }, 'wolf_private', ['wolf-1']).event,
      event(4, 'day.exiled', { playerId: 'seer-1', day: 1 }).event,
      event(5, 'game.ended', { winner: 'wolf', reason: 'test' }).event,
      event(6, 'game.state_updated', { gameState: { day: 1 }, players }).event,
    ],
  });
};

test('production V3 review uses the complete event stream and writes server insights', async () => {
  const events = new InMemoryEventStore();
  await seedEndedGame(events);
  const repository = new InMemoryReviewRepository();
  const insights = new InMemoryInsightStore();
  let calls = 0;
  const generator = {
    async generate(): Promise<ReviewGeneration> {
      calls += 1;
      return {
        messages: [{
          text: '公开投票结果改变了本局走势。',
          audience: 'public',
          evidenceEventIds: ['event-4'],
        }],
        insights: [
          { role: 'wolf', text: '第1天公开投票后应重新核对狼刀与票型。', evidenceEventIds: ['event-4'] },
          { role: 'seer', text: '查验到狼人后应及时把结果与公开票型对齐。', evidenceEventIds: ['event-2'] },
          { role: 'villager', text: '狼人一号的发言说明很好。', evidenceEventIds: ['event-4'] },
          { role: 'villager', text: '虚构的心得', evidenceEventIds: ['missing-event'] },
        ],
      };
    },
  };
  const pipeline = new ReviewPipeline(events, repository, { generator, insightStore: insights });
  await pipeline.enqueue({ gameId: 'game-1', roomId: 'room-1', reviewEnabled: true });
  await pipeline.process('game-1');

  const job = await pipeline.get('game-1');
  assert.equal(job?.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(job?.archive.sourceEventIds.length, 6);
  assert.deepEqual((await insights.list()).map((item) => item.role), ['wolf', 'seer']);

  const villagerView = await pipeline.view('game-1', {
    kind: 'player', playerId: 'villager-1', role: 'villager',
  });
  assert.ok(villagerView);
  assert.equal(villagerView.insights.length, 0);
  assert.doesNotMatch(JSON.stringify(villagerView), /狼人一号|预言家一号|missing-event/);

  const seerView = await pipeline.view('game-1', {
    kind: 'player', playerId: 'seer-1', role: 'seer',
  });
  assert.ok(seerView?.insights.some((item) => item.role === 'seer'));
  assert.ok(seerView?.timeline.some((item) => item.eventType === 'seer.result'));
  assert.ok(!seerView?.timeline.some((item) => item.eventType === 'wolf.kill_locked'));

  const godView = await pipeline.view('game-1', {
    kind: 'spectator', spectatorId: 'monitor', omniscient: true,
  });
  assert.ok(godView?.timeline.some((item) => item.eventType === 'wolf.kill_locked'));
});

test('reviewEnabled false finalizes the canonical archive without invoking review AI or insights', async () => {
  const events = new InMemoryEventStore();
  await seedEndedGame(events);
  const repository = new InMemoryReviewRepository();
  const insights = new InMemoryInsightStore();
  let calls = 0;
  const pipeline = new ReviewPipeline(events, repository, {
    insightStore: insights,
    generator: { async generate() { calls += 1; throw new Error('must not run'); } },
  });
  await pipeline.enqueue({ gameId: 'game-1', roomId: 'room-1', reviewEnabled: false });
  await pipeline.process('game-1');
  const job = await pipeline.get('game-1');
  assert.equal(job?.status, 'disabled');
  assert.equal(job?.archive.events.length, 6);
  assert.equal(calls, 0);
  assert.deepEqual(await insights.list(), []);
});
