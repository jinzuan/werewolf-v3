import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SERVER_AI_DEFAULTS, type ServerAIConfig } from '../ai/config';
import { dispatch, createPlayers, initializeSession } from './fixtures';
import { projectAIContext } from '../ai/contextProjector';
import { loadExperienceLibrary } from '../ai/experienceLibrary';
import { HttpAIProvider } from '../ai/httpProvider';
import { AIOrchestrator } from '../ai/orchestrator';
import type { AIRequestContext } from '../ai/types';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';

const providerConfig = (): ServerAIConfig => {
  const config = structuredClone(SERVER_AI_DEFAULTS);
  config.apiType = 'local';
  config.local = {
    ...config.local,
    apiUrl: 'https://provider.test/v1/chat/completions',
    apiKey: 'unit-test-key',
    model: 'unit-test-model',
  };
  return config;
};

const guardianContext = (): AIRequestContext => {
  const players = createPlayers();
  const guardian = players.find((player) => player.role === 'guardian')!;
  return {
    roomId: 'room-1',
    gameId: 'game-1',
    playerId: guardian.id,
    role: 'guardian',
    phase: 'night',
    stage: 'guard_seer',
    stageRevision: 1,
    callId: 'call-1',
    players,
    allowedActions: ['guard', 'skip_night'],
    allowedCommandTypes: ['game.night_action', 'game.skip_night'],
  };
};

const guardResponse = (targetId: string): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              command: {
                type: 'game.night_action',
                payload: {
                  playerId: guardianContext().playerId,
                  action: 'guard',
                  targetId,
                },
              },
              reason: 'test response',
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const createGuardianSession = async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  return { players, session, guardian };
};

const orchestratorContext = (
  session: GameSession,
  players: ReturnType<typeof createPlayers>,
  playerId: string,
): Omit<AIRequestContext, 'callId'> => ({
  roomId: 'room-1',
  gameId: session.gameId,
  playerId,
  role: 'guardian',
  phase: 'night',
  stage: 'guard_seer',
  stageRevision: session.stageRevision,
  players,
  allowedActions: ['guard'],
  allowedCommandTypes: ['game.night_action'],
});

test('429 honors Retry-After before succeeding', async () => {
  const calls: number[] = [];
  const sleeps: number[] = [];
  const players = createPlayers();
  const other = players.find((player) => player.role !== 'guardian')!;
  const provider = new HttpAIProvider(providerConfig(), {
    fetch: async () => {
      calls.push(1);
      return calls.length === 1
        ? new Response('', {
            status: 429,
            headers: { 'Retry-After': '2' },
          })
        : guardResponse(other.id);
    },
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    baseDelayMs: 100,
  });

  const result = await provider.suggest(guardianContext());

  assert.equal(result.command.type, 'game.night_action');
  assert.equal(result.providerMeta?.retryCount, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test('429 exhaustion uses one deterministic fallback and keeps the stage moving', async () => {
  const calls: number[] = [];
  const { players, session, guardian } = await createGuardianSession();
  const provider = new HttpAIProvider(providerConfig(), {
    fetch: async () => {
      calls.push(1);
      return new Response('', {
        status: 429,
        headers: { 'Retry-After': '0' },
      });
    },
    sleep: async () => {},
    baseDelayMs: 0,
  });
  const orchestrator = new AIOrchestrator(provider, Date.now, {
    timeoutMs: 100,
  });

  const result = await orchestrator.act(
    session,
    orchestratorContext(session, players, guardian.id),
  );

  const telemetry = orchestrator.telemetry().at(-1)!;
  assert.equal(result.accepted, true);
  assert.equal(calls.length, 3);
  assert.equal(telemetry.status, 'fallback');
  assert.equal(telemetry.retryCount, 2);
  assert.equal(telemetry.errorClass, 'rate_limited');
  assert.equal(
    Object.keys(session.serialize().state.processedCommands).length,
    13,
  );
});

test('provider timeout falls back without retrying or blocking the stage', async () => {
  const { players, session, guardian } = await createGuardianSession();
  let calls = 0;
  const provider = new HttpAIProvider(providerConfig(), {
    fetch: async (_input, init) => {
      calls += 1;
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
      throw new Error('unreachable');
    },
    timeoutMs: 10,
    sleep: async () => {},
  });
  const orchestrator = new AIOrchestrator(provider, Date.now, {
    timeoutMs: 100,
  });

  const result = await orchestrator.act(
    session,
    orchestratorContext(session, players, guardian.id),
  );
  const telemetry = orchestrator.telemetry().at(-1)!;

  assert.equal(result.accepted, true);
  assert.equal(calls, 1);
  assert.equal(telemetry.status, 'fallback');
  assert.equal(telemetry.retryCount, 0);
  assert.equal(telemetry.errorClass, 'timeout');
});

test('illegal provider output falls back without dispatching the illegal command', async () => {
  const { players, session, guardian } = await createGuardianSession();
  const provider = new HttpAIProvider(providerConfig(), {
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"command":{"type":"bad"}}' } }],
        }),
        { status: 200 },
      ),
    sleep: async () => {},
  });
  const orchestrator = new AIOrchestrator(provider);

  const result = await orchestrator.act(
    session,
    orchestratorContext(session, players, guardian.id),
  );
  const telemetry = orchestrator.telemetry().at(-1)!;

  assert.equal(result.accepted, true);
  assert.equal(telemetry.status, 'fallback');
  assert.equal(telemetry.errorClass, 'invalid_output');
  assert.equal(
    session.serialize().state.night.actions.guardTargetId !== null,
    true,
  );
});

test('role projection keeps private facts scoped and excludes omniscient secrets', async () => {
  const players = createPlayers();
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolf = players.find((player) => player.role === 'wolf')!;
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  await dispatch(session, guardian.id, {
    type: 'game.night_action',
    payload: {
      playerId: guardian.id,
      action: 'guard',
      targetId: guardian.id,
    },
  });
  await dispatch(session, seer.id, {
    type: 'game.night_action',
    payload: {
      playerId: seer.id,
      action: 'check',
      targetId: wolf.id,
    },
  });

  const guardianProjection = await projectAIContext(session, {
    playerId: guardian.id,
    role: 'guardian',
    stageRevision: session.stageRevision,
    allowedActions: ['guard'],
  });
  const seerProjection = await projectAIContext(session, {
    playerId: seer.id,
    role: 'seer',
    stageRevision: session.stageRevision,
    allowedActions: ['check'],
  });

  assert.ok(
    guardianProjection.publicEvents.some(
      (event) => event.eventType === 'game.started',
    ),
  );
  assert.ok(
    guardianProjection.privateEvents.some(
      (event) => event.eventType === 'guardian.completed',
    ),
  );
  assert.equal(
    guardianProjection.privateEvents.some(
      (event) => event.eventType === 'seer.result',
    ),
    false,
  );
  assert.ok(
    seerProjection.privateEvents.some(
      (event) => event.eventType === 'seer.result',
    ),
  );
  assert.equal(
    guardianProjection.snapshot.players.find((player) => player.id === wolf.id)
      ?.role,
    null,
  );
  assert.equal(
    guardianProjection.snapshot.players.find(
      (player) => player.id === guardian.id,
    )?.role,
    'guardian',
  );
  assert.equal(
    JSON.stringify(guardianProjection).includes('omniscient'),
    false,
  );
  assert.equal(JSON.stringify(guardianProjection).includes('apiKey'), false);
  assert.equal(
    guardianProjection.rules.values['flow.night_stages'] !== undefined,
    true,
  );
});

test('experience manifest contains all 33 source files with matching bytes and hashes', () => {
  const library = loadExperienceLibrary();
  const sourceRoot = path.resolve('src', 'data', 'experience_library');
  const targetRoot = path.resolve('server', 'data', 'experience_library');

  assert.equal(library.manifest.count, 33);
  assert.equal(library.assets.length, 33);
  for (const asset of library.assets) {
    const source = readFileSync(path.join(sourceRoot, asset.path));
    const target = readFileSync(path.join(targetRoot, asset.path));
    assert.deepEqual(
      target.subarray(target.length - source.length),
      source,
      `${asset.path}: original source bytes must be preserved as the suffix`,
    );
    assert.equal(target.length, asset.bytes, asset.path);
    assert.equal(
      createHash('sha256').update(target).digest('hex'),
      asset.sha256,
      asset.path,
    );
  }
});
