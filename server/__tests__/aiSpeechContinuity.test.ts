import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerAIConfig } from '../ai/config';
import { SERVER_AI_DEFAULTS } from '../ai/config';
import { AIOrchestrator } from '../ai/orchestrator';
import { PromptContextCache } from '../ai/promptContextCache';
import { AICircuitBreaker } from '../ai/providerQueue';
import { HttpAIProvider } from '../ai/httpProvider';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers } from './fixtures';

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

test('a later AI speech prompt includes the earlier AI speech after it commits', async () => {
  const players = createPlayers();
  const first = players[0];
  const second = players[1];
  const seed = new GameSession('room-speech-chain', players, new InMemoryEventStore());
  const snapshot = seed.serialize();
  snapshot.state.gameState.phase = 'day';
  snapshot.state.gameState.nightStage = 'resolve';
  snapshot.state.gameState.dayStage = 'speech';
  snapshot.state.gameState.stageRevision = 10;
  snapshot.state.gameState.currentSpeaker = first.id;
  snapshot.state.gameState.deadlineTs = Date.now() + 30_000;
  snapshot.state.dayFlow = {
    stage: 'speech',
    voteRound: 1,
    voteCandidates: [],
    votes: {},
    voteReasons: {},
    speechQueue: [first.id, second.id],
    speechDirection: 'clockwise',
    speechStartPlayerId: first.id,
    lastWordsPlayerId: null,
    lastWordsRemaining: 0,
    pendingHunterId: null,
    pendingExile: null,
  };
  const eventStore = new InMemoryEventStore();
  const session = new GameSession('room-speech-chain', players, eventStore, snapshot);
  await session.initialize();

  const requests: Array<{ system: string; user: string }> = [];
  const firstSpeech = '我先回应前面的改票争议：这条时间线需要摸鱼王解释。';
  const provider = new HttpAIProvider(providerConfig(), {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      requests.push({
        system: body.messages.find((message) => message.role === 'system')?.content ?? '',
        user: body.messages.find((message) => message.role === 'user')?.content ?? '',
      });
      const content = requests.length === 1
        ? JSON.stringify({ action: 'speak', content: firstSpeech })
        : JSON.stringify({ action: 'speak', content: '我补充一个新的票型核对点。' });
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    maxRetries: 0,
    circuitBreaker: new AICircuitBreaker(),
  });
  const orchestrator = new AIOrchestrator(provider, Date.now, {
    contextCache: new PromptContextCache(),
    timeoutMs: 5_000,
  });
  const contextFor = (actor: typeof first) => ({
    roomId: 'room-speech-chain',
    gameId: session.gameId,
    playerId: actor.id,
    role: actor.role!,
    phase: 'day' as const,
    stage: 'speech',
    stageRevision: session.stageRevision,
    players,
    allowedActions: ['speak' as const],
    allowedCommandTypes: ['game.speak' as const],
  });

  const firstResult = await orchestrator.act(session, contextFor(first));
  assert.equal(firstResult.accepted, true);
  assert.equal(session.serialize().state.gameState.currentSpeaker, second.id);
  assert.equal(session.serialize().state.dayFlow.stage, 'speech');

  const secondResult = await orchestrator.act(session, contextFor(second));
  assert.equal(secondResult.accepted, true);
  assert.equal(requests.length, 2);
  assert.match(
    `${requests[1].system}\n${requests[1].user}`,
    new RegExp(firstSpeech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );

  session.dispose();
});
