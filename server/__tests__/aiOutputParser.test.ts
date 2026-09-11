import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayers } from './fixtures';
import { PromptAIProvider } from '../ai/promptProvider';
import { parseAIOutput } from '../ai/outputParser';
import type { AIRequestContext } from '../ai/types';

const players = createPlayers();
const context = (): AIRequestContext => ({
  roomId: 'room-1',
  gameId: 'game-1',
  playerId: players[0].id,
  role: 'villager',
  phase: 'day',
  stage: 'speech',
  stageRevision: 1,
  callId: 'ai-output-test',
  players,
  allowedActions: ['speak'],
  allowedCommandTypes: ['game.speak'],
  promptContext: {
    legalActions: ['speak'],
  },
});

test('INVALID_CONTEXT is rejected before it can become speech text', () => {
  const parseContext = {
    allowedCommandTypes: ['game.speak'] as const,
    players,
    playerId: players[0].id,
    role: 'villager' as const,
    phase: 'day',
    stage: 'speech',
    promptContext: { legalActions: ['speak' as const] },
  };

  for (const output of [
    'INVALID_CONTEXT',
    '今天吃啥：INVALID_CONTEXT',
    '{"action":"speak","content":"INVALID_CONTEXT"}',
  ]) {
    const result = parseAIOutput(output, parseContext);
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.code, 'INVALID_CONTEXT');
  }
});

test('unresolved prompt placeholders are rejected before they can become speech text', () => {
  const parseContext = {
    allowedCommandTypes: ['game.speak'] as const,
    players,
    playerId: players[0].id,
    role: 'villager' as const,
    phase: 'lastWords',
    stage: 'last_words',
    promptContext: { legalActions: ['speak' as const] },
  };
  const result = parseAIOutput(
    '{"action":"speak","content":"{{last_words_round_task}}"}',
    parseContext,
  );
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.code, 'INVALID_CONTEXT');
});

test('prompt provider retries an invalid-context response and returns the valid retry', async () => {
  const outputs = [
    'INVALID_CONTEXT',
    '{"action":"speak","content":"我会核对最新票型。"}',
  ];
  let calls = 0;
  const provider = new PromptAIProvider({
    complete: async () => {
      calls += 1;
      return outputs.shift() ?? '';
    },
  });

  const result = await provider.suggest(context());

  assert.equal(calls, 2);
  assert.deepEqual(result.command, {
    type: 'game.speak',
    payload: { content: '我会核对最新票型。' },
  });
});

test('speech queue requests are parsed only when the server grants that action', () => {
  const parseContext = {
    allowedCommandTypes: ['game.request_speech'] as const,
    players,
    playerId: players[0].id,
    role: 'villager' as const,
    phase: 'day',
    stage: 'discussion',
    promptContext: { legalActions: ['request_speech' as const] },
  };
  const accepted = parseAIOutput(
    '{"action":"request_speech","reason":"回应刚才的点名"}',
    parseContext,
  );
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.command.type, 'game.request_speech');

  const rejected = parseAIOutput(
    '{"action":"request_speech"}',
    { ...parseContext, allowedCommandTypes: ['game.speak'] as const },
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'ACTION_NOT_ALLOWED');
});

test('a premature wolf vote during discussion is preserved as a proposal instead of discarded', () => {
  const wolf = players.find((player) => player.role === 'wolf')!;
  const target = players.find((player) => player.role !== 'wolf')!;
  const parseContext = {
    allowedCommandTypes: ['game.wolf_speak', 'game.skip_speech'] as const,
    players,
    playerId: wolf.id,
    role: 'wolf' as const,
    phase: 'night',
    stage: 'wolf_discussion',
    promptContext: {
      legalActions: ['wolf_speak', 'skip_speech'] as const,
      legalTargets: [{ id: target.id, name: target.name }],
    },
  };

  for (const output of [
    JSON.stringify({ action: 'wolf_vote', target: target.name, reason: '他是当前信息位' }),
    JSON.stringify({ command: { type: 'game.wolf_vote', payload: { targetId: target.id } } }),
  ]) {
    const parsed = parseAIOutput(output, parseContext);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    assert.equal(parsed.command.type, 'game.wolf_speak');
    if (parsed.command.type === 'game.wolf_speak') {
      assert.match(parsed.command.payload.content, new RegExp(target.name, 'u'));
    }
  }
});

test('wolf discussion skip is accepted whenever the authoritative action list grants it', () => {
  const wolf = players.find((player) => player.role === 'wolf')!;
  const parsed = parseAIOutput(
    JSON.stringify({ action: 'skip_speech' }),
    {
      allowedCommandTypes: ['game.wolf_speak', 'game.skip_speech'],
      players,
      playerId: wolf.id,
      role: 'wolf',
      phase: 'night',
      stage: 'wolf_discussion',
      promptContext: {
        legalActions: ['wolf_speak', 'skip_speech'],
        currentRoundSpeeches: [],
        newInformationSinceLastTurn: [],
      },
    },
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.command.type, 'game.skip_speech');
});
