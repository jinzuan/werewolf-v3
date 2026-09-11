import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers, dispatch } from './fixtures';
import { FakeClock } from './fakeClock';

test('a zero-human computer room advances dawn immediately after the final night action', async () => {
  const players = createPlayers('room-full-ai-dawn');
  players.forEach((player) => { player.isAI = true; });
  const clock = new FakeClock();
  const session = new GameSession(
    'room-full-ai-dawn',
    players,
    new InMemoryEventStore(),
    undefined,
    { now: clock.now, scheduler: clock, stageDurationMs: 100, rng: () => 0 },
  );
  await session.initialize();

  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const witch = players.find((player) => player.role === 'witch')!;
  const wolves = players.filter((player) => player.role === 'wolf');
  const target = players.find((player) => player.role === 'villager')!;

  await dispatch(session, guardian.id, {
    type: 'game.night_action',
    payload: { playerId: guardian.id, action: 'guard', targetId: guardian.id },
  });
  await dispatch(session, seer.id, {
    type: 'game.night_action',
    payload: { playerId: seer.id, action: 'check', targetId: wolves[0].id },
  });
  for (let round = 1; round <= 2; round += 1) {
    for (const wolf of wolves) {
      const result = await dispatch(session, wolf.id, {
        type: 'game.wolf_speak',
        payload: { content: round === 1 ? `先看${target.name}。` : `定${target.name}。` },
      });
      assert.equal(result.ok, true);
    }
  }
  for (const wolf of wolves) {
    const result = await dispatch(session, wolf.id, {
      type: 'game.wolf_vote',
      payload: { targetId: target.id },
    });
    assert.equal(result.ok, true);
  }
  const witchResult = await dispatch(session, witch.id, {
    type: 'game.skip_night',
    payload: { action: 'heal' },
  });
  assert.equal(witchResult.ok, true);
  assert.equal(session.serialize().state.dayFlow.stage, 'dawn');

  await clock.advance(0);
  const state = session.serialize().state;
  assert.equal(state.dayFlow.stage, 'speech');
  assert.equal(state.gameState.currentSpeaker, state.dayFlow.speechQueue[0]);
  session.dispose();
});
