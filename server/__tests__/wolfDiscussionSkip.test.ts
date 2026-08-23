import assert from 'node:assert/strict';
import test from 'node:test';
import { RepeatPolicy } from '../ai/repeatPolicy';
import { buildSpeechDecisionContext } from '../ai/speechDecisionContext';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers, dispatch, initializeSession } from './fixtures';

test('wolf boilerplate repetition is rejected as a skip candidate', () => {
  const policy = new RepeatPolicy();
  const scene = { gameId: 'g1', playerId: 'wolf-1', phase: 'night', stage: 'wolf_discussion' as const, channel: 'wolf_private' as const };
  policy.record(scene, '公开信息和票型都为零，首夜猜测，优先围绕神职边，不空刀。');
  const result = policy.inspect(
    { ...scene, playerId: 'wolf-2' },
    '当前公开信息和票型为零，只能首夜盲刀，先压神职信息位，不空刀，村口老张作备选。',
  );
  assert.equal(result.repeated, true);
  assert.match(result.guidance, /skip_speech/u);
});

test('a wolf with no new disagreement can skip after a teammate spoke', () => {
  const decision = buildSpeechDecisionContext(
    {
      playerId: 'wolf-2',
      players: [
        { id: 'wolf-1', roomId: 'r1', name: '好运来', role: 'wolf', isAlive: true, isAI: true, isHost: false, order: 1 },
        { id: 'wolf-2', roomId: 'r1', name: '小雨', role: 'wolf', isAlive: true, isAI: true, isHost: false, order: 2 },
      ],
      allowedCommandTypes: ['game.wolf_speak', 'game.skip_speech'],
      allowedActions: ['wolf_speak', 'skip_speech'],
      promptContext: {
        legalActions: ['wolf_speak', 'skip_speech'],
        currentRoundSpeeches: ['好运来：不空刀，先看神职边。'],
        newInformationSinceLastTurn: [],
      },
    },
    { legalActions: ['wolf_speak', 'skip_speech'], currentRoundSpeeches: ['好运来：不空刀，先看神职边.'] },
  );
  assert.equal(decision.canSkip, true);
  assert.equal(decision.preferNoContentExit, true);
  assert.ok(decision.allowedMoves.includes('跳过发言'));
});

test('wolf skip advances the private discussion without creating filler chat', async () => {
  const players = createPlayers();
  const session = new GameSession('room-wolf-skip', players, new InMemoryEventStore());
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolves = players.filter((player) => player.role === 'wolf');
  await dispatch(session, guardian.id, { type: 'game.night_action', payload: { playerId: guardian.id, action: 'guard', targetId: guardian.id } });
  await dispatch(session, seer.id, { type: 'game.night_action', payload: { playerId: seer.id, action: 'check', targetId: wolves[0].id } });
  const skipped = await dispatch(session, wolves[0].id, { type: 'game.skip_speech', payload: {} });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.events.some((event) => event.eventType === 'wolf.message'), false);
  assert.equal(session.serialize().state.gameState.wolfCurrentSpeaker, wolves[1].id);
  session.dispose();
});

test('leaving an active game records a public exit and marks the player dead', async () => {
  const players = createPlayers();
  const session = new GameSession('room-exit', players, new InMemoryEventStore());
  await initializeSession(session, players);
  const target = players.find((player) => player.role === 'villager')!;
  assert.equal(await session.markPlayerExited(target.id, 'exit-test'), true);
  const state = session.serialize().state;
  assert.equal(state.players.find((player) => player.id === target.id)?.isAlive, false);
  const events = await session.eventsFor({ kind: 'spectator', spectatorId: 'monitor', omniscient: true });
  assert.ok(events.some((event) => event.eventType === 'player.exited'));
  session.dispose();
});
