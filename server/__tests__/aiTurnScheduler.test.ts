import assert from 'node:assert/strict';
import test from 'node:test';
import { AITurnScheduler, aiTurnTaskKey, type AITurnTask } from '../ai/aiTurnScheduler';

const task = (actorId: string, revision = 1): AITurnTask => ({
  roomCode: 'room-a',
  gameId: 'game-a',
  stageRevision: revision,
  actorId,
  actionClass: 'speak',
});

test('AI scheduler is idempotent by committed room/game/stage/actor/action key', async () => {
  const calls: string[] = [];
  const scheduler = new AITurnScheduler(async (input) => {
    calls.push(aiTurnTaskKey(input));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const first = scheduler.schedule(task('actor-1'));
  const second = scheduler.schedule(task('actor-1'));
  assert.strictEqual(first, second);
  await Promise.all([first, second]);
  assert.deepEqual(calls, [aiTurnTaskKey(task('actor-1'))]);
  await scheduler.close();
});

test('a room has one active action and keeps only the newest committed follow-up', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new AITurnScheduler(async (input) => {
    calls.push(aiTurnTaskKey(input));
    if (calls.length === 1) await hold;
  });
  const first = scheduler.schedule(task('actor-1', 1));
  const queuedOld = scheduler.schedule(task('actor-2', 1));
  const queuedNewest = scheduler.schedule(task('actor-3', 2));
  assert.strictEqual(queuedOld, queuedNewest);
  release();
  await first;
  while (calls.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  while (scheduler.pending().length > 0) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(calls, [
    aiTurnTaskKey(task('actor-1', 1)),
    aiTurnTaskKey(task('actor-3', 2)),
  ]);
  await scheduler.close();
});

test('close aborts active work and clears queued tasks', async () => {
  let observedAbort = false;
  const scheduler = new AITurnScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        observedAbort = true;
        resolve();
        return;
      }
      signal.addEventListener('abort', () => {
        observedAbort = true;
        resolve();
      }, { once: true });
    });
  });
  const running = scheduler.schedule(task('actor-1'));
  scheduler.schedule(task('actor-2'));
  await scheduler.close();
  await running;
  assert.equal(observedAbort, true);
  assert.deepEqual(scheduler.pending(), []);
});
