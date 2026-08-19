import assert from 'node:assert/strict';
import test from 'node:test';
import { AICircuitBreaker, AIQueueError, ProviderQueue } from '../ai/providerQueue';
import { AITelemetry } from '../ai/aiTelemetry';
import { AIOrchestrator } from '../ai/orchestrator';
import { HttpAIProvider } from '../ai/httpProvider';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers, initializeSession } from './fixtures';
import type { ServerAIConfig } from '../ai/config';

const config = (): ServerAIConfig => ({
  apiType: 'local',
  siliconflow: { apiKey: '', model: 'model', temperature: 0.2, maxTokens: 128 },
  deepseek: { apiKey: '', model: 'model', temperature: 0.2, maxTokens: 128 },
  local: {
    apiKey: '', model: 'model', temperature: 0.2, maxTokens: 128,
    apiUrl: 'http://127.0.0.1:1234/v1/chat/completions',
  },
  defaultBehavior: 'random',
});

test('provider queue bounds waiting work and removes cancelled stages', async () => {
  const queue = new ProviderQueue({
    concurrency: 1,
    maxQueued: 1,
    maxQueuedPerKey: 1,
    enqueueTimeoutMs: 1_000,
  });
  let release!: () => void;
  const first = queue.run('endpoint:model', () => new Promise<void>((resolve) => {
    release = resolve;
  }));
  const cancelled = new AbortController();
  const second = queue.run('endpoint:model', async () => undefined, { signal: cancelled.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(queue.stats(), {
    active: 1,
    queued: 1,
    capacity: 1,
    activeByKey: { 'endpoint:model': 1 },
    queuedByKey: { 'endpoint:model': 1 },
  });
  await assert.rejects(
    queue.run('endpoint:model', async () => undefined),
    (error: unknown) => error instanceof AIQueueError && error.code === 'AI_QUEUE_FULL',
  );
  cancelled.abort();
  await assert.rejects(second, (error: unknown) => error instanceof AIQueueError && error.code === 'AI_CANCELLED');
  assert.equal(queue.stats().queued, 0);
  release();
  await first;
  assert.equal(queue.stats().active, 0);
});

test('provider queue and circuit breaker release unique-key state', async () => {
  const queue = new ProviderQueue({ concurrency: 1 });
  for (let index = 0; index < 32; index += 1) {
    await queue.run(`endpoint-${index}:model`, async () => undefined);
  }
  assert.equal(
    (queue as unknown as { buckets: Map<string, unknown> }).buckets.size,
    0,
  );

  const breaker = new AICircuitBreaker({ maxEntries: 8 });
  for (let index = 0; index < 32; index += 1) {
    breaker.recordFailure(`provider-${index}`);
  }
  assert.equal(
    (breaker as unknown as { entries: Map<string, unknown> }).entries.size,
    8,
  );
});

test('an active HTTP request receives orchestrator cancellation', async () => {
  const players = createPlayers();
  const guardian = players.find((player) => player.role === 'guardian')!;
  const session = new GameSession('room-1', players, new InMemoryEventStore());
  await initializeSession(session, players);
  let aborted = false;
  const provider = new HttpAIProvider(config(), {
    timeoutMs: 30_000,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const telemetry = new AITelemetry();
  const orchestrator = new AIOrchestrator(provider, Date.now, {
    timeoutMs: 10,
    telemetry,
  });

  const result = await orchestrator.act(session, {
    roomId: 'room-1',
    gameId: session.gameId,
    playerId: guardian.id,
    role: 'guardian',
    phase: 'night',
    stage: 'guard_seer',
    stageRevision: session.stageRevision,
    players,
    allowedCommandTypes: ['game.night_action'],
    allowedActions: ['guard'],
  });

  assert.equal(result.accepted, true);
  assert.equal(aborted, true);
  assert.equal(telemetry.snapshot().active, 0);
  assert.ok(telemetry.snapshot().timeout >= 1);
});

test('circuit breaker opens after provider failures and permits one half-open probe', () => {
  let now = 0;
  const breaker = new AICircuitBreaker({ failureThreshold: 2, openMs: 100, now: () => now });
  assert.equal(breaker.allow('provider'), true);
  breaker.recordFailure('provider');
  breaker.recordFailure('provider');
  assert.equal(breaker.state('provider'), 'open');
  assert.equal(breaker.allow('provider'), false);
  now = 101;
  assert.equal(breaker.allow('provider'), true);
  assert.equal(breaker.allow('provider'), false);
  breaker.recordSuccess('provider');
  assert.equal(breaker.state('provider'), 'closed');
});

test('fallback telemetry is aggregate and excludes room/provider labels', () => {
  const telemetry = new AITelemetry();
  telemetry.start();
  telemetry.recordRetry(2);
  telemetry.recordCancelled();
  telemetry.finish('fallback', 12);
  const snapshot = telemetry.snapshot();
  assert.deepEqual(snapshot, {
    active: 0,
    queued: 0,
    cancelled: 1,
    timeout: 0,
    retry: 2,
    fallback: 1,
    completed: 0,
    failed: 0,
    total: 1,
    latencyMs: 12,
  });
  assert.equal('roomId' in snapshot, false);
  assert.equal('prompt' in snapshot, false);
  assert.equal('credential' in snapshot, false);
});
