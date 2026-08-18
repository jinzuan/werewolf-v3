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
