import assert from 'node:assert/strict';
import test from 'node:test';
import type { Player } from '../../shared/types';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import type { SessionSnapshot } from '../session/types';
import { createPlayers, dispatch } from './fixtures';

const createDaySession = async (
  configure: (snapshot: SessionSnapshot, players: Player[]) => void,
) => {
  const players = createPlayers();
  const seed = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  const snapshot = seed.serialize();
  snapshot.state.gameState.phase = 'voting';
  snapshot.state.gameState.dayStage = 'voting';
  snapshot.state.gameState.nightStage = 'resolve';
  snapshot.state.gameState.stageRevision = 10;
  snapshot.state.gameState.currentSpeaker = null;
  snapshot.state.dayFlow = {
    stage: 'voting',
    voteRound: 1,
    voteCandidates: [],
    votes: {},
    speechQueue: [],
    lastWordsPlayerId: null,
    lastWordsRemaining: 0,
    pendingHunterId: null,
  };
  configure(snapshot, players);
  const store = new InMemoryEventStore();
  const session = new GameSession('room-1', players, store, snapshot);
  await session.initialize();
  return { session, players };
};

test('day vote ties once, revotes without abstention, then advances with no exile', async () => {
  const { session, players } = await createDaySession(() => undefined);
  const alive = players.filter((player) => player.isAlive);
  const first = alive[0];
  const second = alive[1];
  for (const [index, voter] of alive.entries()) {
    const targetId =
      index === 0
        ? second.id
        : index === 1
          ? first.id
          : index % 2 === 0
            ? first.id
            : second.id;
    await dispatch(session, voter.id, {
      type: 'game.vote',
      payload: { targetId },
    });
  }
  assert.equal(session.serialize().state.dayFlow.voteRound, 2);
  assert.deepEqual(
    session.serialize().state.dayFlow.voteCandidates.sort(),
    [first.id, second.id].sort(),
  );

  const eligible = alive.filter(
    (player) => player.id !== first.id && player.id !== second.id,
  );
  const abstain = await dispatch(session, eligible[0].id, {
    type: 'game.vote',
    payload: { targetId: null },
  });
  assert.equal(abstain.ok, false);
  for (const [index, voter] of eligible.entries()) {
    await dispatch(session, voter.id, {
      type: 'game.vote',
      payload: { targetId: index % 2 === 0 ? first.id : second.id },
    });
  }
  const state = session.serialize().state;
  assert.equal(state.gameState.phase, 'night');
  assert.equal(state.gameState.day, 2);
  assert.ok(state.players.every((player) => player.isAlive));
});

test('exiled hunter gets two last words rounds and one validated shot', async () => {
  const { session, players } = await createDaySession(() => undefined);
  const hunter = players.find((player) => player.role === 'hunter')!;
  const wolf = players.find((player) => player.role === 'wolf')!;
  for (const voter of players.filter((player) => player.id !== hunter.id)) {
    await dispatch(session, voter.id, {
      type: 'game.vote',
      payload: { targetId: hunter.id },
    });
  }
  await dispatch(session, hunter.id, {
    type: 'game.vote',
    payload: { targetId: wolf.id },
  });
  assert.equal(session.serialize().state.dayFlow.stage, 'last_words');
  assert.equal(session.serialize().state.dayFlow.lastWordsRemaining, 2);

  for (let round = 0; round < 2; round += 1) {
    const result = await dispatch(session, hunter.id, {
      type: 'game.skip_speech',
      payload: {},
    });
    assert.equal(result.ok, true);
  }
  assert.equal(session.serialize().state.dayFlow.stage, 'hunter');
  const shot = await dispatch(session, hunter.id, {
    type: 'game.hunter_shoot',
    payload: { targetId: wolf.id },
  });
  assert.equal(shot.ok, true);
  assert.equal(
    session.players.find((player) => player.id === wolf.id)?.isAlive,
    false,
  );
  assert.equal(shot.events.some((event) => event.eventType === 'hunter.shot'), true);
  assert.equal(session.serialize().state.gameState.phase, 'night');

  const skippedCase = await createDaySession(() => undefined);
  const skippedHunter = skippedCase.players.find((player) => player.role === 'hunter')!;
  const skippedWolf = skippedCase.players.find((player) => player.role === 'wolf')!;
  for (const voter of skippedCase.players.filter((player) => player.id !== skippedHunter.id)) {
    await dispatch(skippedCase.session, voter.id, {
      type: 'game.vote',
      payload: { targetId: skippedHunter.id },
    });
  }
  await dispatch(skippedCase.session, skippedHunter.id, {
    type: 'game.vote',
    payload: { targetId: skippedWolf.id },
  });
  await dispatch(skippedCase.session, skippedHunter.id, { type: 'game.skip_speech', payload: {} });
  await dispatch(skippedCase.session, skippedHunter.id, { type: 'game.skip_speech', payload: {} });
  const skipped = await dispatch(skippedCase.session, skippedHunter.id, {
    type: 'game.hunter_shoot',
    payload: { targetId: null },
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.events.some((event) => event.eventType === 'hunter.shot_skipped'), true);
});

test('atomic exile victory ends the game before the next night', async () => {
  const { session } = await createDaySession((snapshot, allPlayers) => {
    const wolf = allPlayers.find((player) => player.role === 'wolf')!;
    for (const player of snapshot.state.players) {
      if (player.role === 'wolf' && player.id !== wolf.id) player.isAlive = false;
    }
  });
  const wolf = session.players.find(
    (player) => player.role === 'wolf' && player.isAlive,
  )!;
  const voters = session.players.filter((player) => player.isAlive);
  for (const voter of voters) {
    await dispatch(session, voter.id, {
      type: 'game.vote',
      payload: {
        targetId:
          voter.id === wolf.id
            ? voters.find((player) => player.id !== wolf.id)!.id
            : wolf.id,
      },
    });
  }
  for (let round = 0; round < 2; round += 1) {
    const lastWords = await dispatch(session, wolf.id, {
      type: 'game.skip_speech',
      payload: {},
    });
    assert.equal(
      lastWords.events.some(
        (event) =>
          event.eventType === 'day.speech_skipped' &&
          (event.payload as { lastWords?: boolean }).lastWords === true,
      ),
      true,
    );
  }
  assert.equal(session.serialize().state.gameState.phase, 'ended');
  assert.equal(session.serialize().state.gameState.winner, 'good');
});
