import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMAIN_EVENT_SCHEMA_VERSION, type DomainEvent } from '../../shared/events';
import { AI_DEFAULTS } from '../../shared/config/aiDefaults';
import { HttpAIProvider } from '../ai/httpProvider';
import type { AIRequestContext } from '../ai/types';

const event: DomainEvent = {
  eventId: 'event-1',
  roomId: 'room-1',
  gameId: 'game-1',
  sequence: 1,
  occurredAt: 1,
  phase: 'day',
  stage: 'speech',
  eventType: 'night.resolved',
  payload: { day: 1, peacefulNight: true, deaths: [] },
  visibility: 'public_timeline',
  correlationId: 'command-1',
  schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
};

const context = (): AIRequestContext => ({
  roomId: 'room-1',
  gameId: 'game-1',
  playerId: 'p1',
  role: 'villager',
  phase: 'day',
  stage: 'speech',
  stageRevision: 2,
  callId: 'call-1',
  players: [
    { id: 'p1', roomId: 'room-1', name: '甲', isAI: true, role: 'villager', isAlive: true, isHost: false, order: 1 },
    { id: 'p2', roomId: 'room-1', name: '乙', isAI: true, role: null, isAlive: true, isHost: false, order: 2 },
  ],
  allowedCommandTypes: ['game.speak'],
  allowedActions: ['speak'],
  promptContext: {
    dayNumber: 2,
    roundNumber: 1,
    experience: '经验锚点：核对平安夜后第一轮票型。',
    requiredNovelty: 'RepeatPolicy：必须提出尚未使用的新证据。',
    publicEvents: ['平安夜已由服务端确认。'],
    publicSpeeches: ['乙：我会重新核对时间线。'],
    legalActions: ['speak'],
    legalTargets: [],
    abstainAllowed: false,
    ruleset: { id: 'ruleset-test', version: 'v1', values: { peacefulNight: true } },
  },
  projectedContext: {
    viewer: { kind: 'player', playerId: 'p1', role: 'villager' },
    snapshot: {
      roomId: 'room-1',
      gameId: 'game-1',
      viewer: { kind: 'player', playerId: 'p1', role: 'villager' },
      gameState: { day: 2 } as never,
      players: [],
      serverTime: 1,
      lastSequence: 1,
    },
    publicEvents: [event],
    privateEvents: [],
    rules: { id: 'ruleset-projected', version: 'v1', values: { authority: 'server' } },
    experience: '投影经验：先区分事实和猜测。',
    allowedActions: ['speak'],
  },
});

test('production HTTP provider sends one prompt containing projection, rules, experience, and repeat policy', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new HttpAIProvider(
    {
      ...AI_DEFAULTS,
      local: { ...AI_DEFAULTS.local, apiUrl: 'http://127.0.0.1:1234/v1/chat/completions' },
    },
    {
      endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            command: { type: 'game.speak', payload: { content: '我会核对新的票型证据。' } },
            reason: 'new evidence',
          }) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      maxRetries: 0,
      timeoutMs: 200,
      promptMaxChars: 12_000,
    },
  );
  await provider.suggest(context());
  const messages = requestBody?.messages as Array<{ role: string; content: string }>;
  const prompt = messages.map((message) => message.content).join('\n');
  assert.match(prompt, /ruleset-projected/);
  assert.match(prompt, /平安夜/);
  // The coordinator's fixed per-AI assignment wins over the projector's
  // rotating legacy reference; duplicating both made the model copy boilerplate.
  assert.match(prompt, /经验锚点/);
  assert.doesNotMatch(prompt, /投影经验/);
  assert.match(prompt, /RepeatPolicy/);
  assert.ok(!prompt.includes('apiKey'));
});
