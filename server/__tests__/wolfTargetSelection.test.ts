import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayers } from './fixtures';
import { buildAIPrompt } from '../ai/promptBuilder';
import { legalTargetsForAI } from '../ai/runtimeContext';
import { randomElement } from '../ai/randomSelection';

test('wolf legal targets are shuffled instead of being seat ordered', () => {
  const players = createPlayers();
  const wolf = players.find((player) => player.role === 'wolf')!;
  const targets = legalTargetsForAI(
    players,
    wolf.id,
    ['wolf_vote'],
    [],
    undefined,
    () => 0,
  );

  assert.notDeepEqual(
    targets.map((target) => target.id),
    players.filter((player) => player.isAlive).map((player) => player.id),
  );
  assert.equal(targets.length, players.length);
});

test('wolf fallback selection has an injectable secure-random seam', () => {
  assert.equal(randomElement(['seat-1', 'seat-2', 'seat-3'], () => 2), 'seat-3');
});

test('wolf prompt forbids mechanical first-seat target selection', () => {
  const players = createPlayers();
  const wolf = players.find((player) => player.role === 'wolf')!;
  const prompt = buildAIPrompt({
    roomId: 'room-1',
    gameId: 'game-1',
    playerId: wolf.id,
    role: 'wolf',
    phase: 'night',
    stage: 'wolf_vote',
    stageRevision: 1,
    callId: 'wolf-target-prompt',
    players,
    allowedActions: ['wolf_vote'],
    allowedCommandTypes: ['game.wolf_vote'],
    promptContext: {
      legalActions: ['wolf_vote'],
      legalTargets: players.map((player) => ({ id: player.id, name: player.name })),
    },
  });

  assert.match(prompt.user, /不按座位号或合法名单首项机械选择/u);
});

test('wolf discussion prompts distinguish the second confirmation round from a vote tie', () => {
  const players = createPlayers();
  const wolf = players.find((player) => player.role === 'wolf')!;
  const prompt = buildAIPrompt({
    roomId: 'room-1',
    gameId: 'game-1',
    playerId: wolf.id,
    role: 'wolf',
    phase: 'night',
    stage: 'wolf_discussion',
    stageRevision: 2,
    callId: 'wolf-discussion-round-two',
    players,
    allowedActions: ['wolf_speak'],
    allowedCommandTypes: ['game.wolf_speak'],
    promptContext: {
      wolfDiscussionRound: 2,
      legalActions: ['wolf_speak'],
    },
  });

  assert.match(prompt.user, /第二轮讨论/u);
  assert.match(prompt.user, /确认、修正或否决首选目标/u);
  assert.doesNotMatch(prompt.user, /首次狼刀票已平/u);
});
