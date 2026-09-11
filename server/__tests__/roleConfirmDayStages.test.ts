import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers, dispatch } from './fixtures';
import { FakeClock } from './fakeClock';

const createRoleSession = async () => {
  const players = createPlayers();
  const clock = new FakeClock();
  const session = new GameSession('room-1', players, new InMemoryEventStore(), undefined, {
    now: clock.now,
    scheduler: clock,
    stageDurationMs: 100,
  });
  await session.initialize();
  return { session, players, clock };
};

const createDawnSession = async () => {
  const players = createPlayers();
  const seed = new GameSession('room-1', players, new InMemoryEventStore());
  const snapshot = seed.serialize();
  const playerIds = players.map((player) => player.id);
  snapshot.state.gameState.phase = 'day';
  snapshot.state.gameState.dayStage = 'dawn';
  snapshot.state.gameState.nightStage = 'resolve';
  snapshot.state.gameState.stageRevision = 10;
  snapshot.state.gameState.currentSpeaker = null;
  snapshot.state.dayFlow = {
    stage: 'dawn',
    voteRound: 1,
    voteCandidates: [],
    votes: {},
    voteReasons: {},
    speechQueue: playerIds,
    speechDirection: 'clockwise',
    speechStartPlayerId: playerIds[0],
    lastWordsPlayerId: null,
    lastWordsRemaining: 0,
    pendingHunterId: null,
    pendingExile: null,
  };
  const clock = new FakeClock();
  const session = new GameSession('room-1', players, new InMemoryEventStore(), snapshot, {
    now: clock.now,
    scheduler: clock,
    stageDurationMs: 100,
    rng: () => 0,
  });
  await session.initialize();
  return { session, players, clock };
};

test('role confirmation gates night actions and timeout enters the first night', async () => {
  const { session, players, clock } = await createRoleSession();
  const guardian = players.find((player) => player.role === 'guardian')!;

  assert.equal(session.serialize().state.gameState.phase, 'role_confirm');
  assert.deepEqual(session.serialize().state.gameState.allowedActors?.[0], {
    playerId: players[0].id,
    actions: ['confirm_role'],
  });
  const blocked = await dispatch(session, guardian.id, {
    type: 'game.skip_night',
    payload: { action: 'guard' },
  });
  assert.equal(blocked.code, 'ACTION_NOT_ALLOWED');

  await clock.advance(100);
  const state = session.serialize().state;
  assert.equal(state.gameState.phase, 'night');
  assert.equal(state.night.stage, 'guard_seer');
  assert.ok(Object.values(state.roleConfirmations).every(Boolean));
  const events = await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'public',
    omniscient: false,
  });
  assert.ok(events.some((event) => event.eventType === 'role.confirmation_completed'));
  assert.ok(events.some((event) => event.eventType === 'stage.timed_out'));
});

test('all role confirmations enter night immediately without waiting for timeout', async () => {
  const { session, players } = await createRoleSession();
  for (const player of players) {
    const result = await dispatch(session, player.id, {
      type: 'game.confirm_role',
      payload: {},
    });
    assert.equal(result.ok, true);
  }
  const state = session.serialize().state;
  assert.equal(state.gameState.phase, 'night');
  assert.equal(state.night.stage, 'guard_seer');
  assert.deepEqual(state.gameState.allowedActors?.map((entry) => entry.actions[0]).sort(), [
    'check',
    'guard',
  ]);
});

test('day checkpoints are durable, private before lock, and retain vote reasons', async () => {
  const { session, players, clock } = await createDawnSession();

  await clock.advance(100);
  assert.equal(session.serialize().state.dayFlow.stage, 'speech');
  const overlong = await dispatch(session, players[0].id, {
    type: 'game.speak',
    payload: { content: '😀'.repeat(101) },
  });
  assert.equal(overlong.code, 'CONTENT_TOO_LONG');

  while (
    session.serialize().state.dayFlow.stage === 'speech' ||
    session.serialize().state.dayFlow.stage === 'discussion'
  ) {
    const state = session.serialize().state;
    if (state.gameState.currentSpeaker === null) {
      // Free discussion is quota/mention driven; with no new queue entry the
      // documented idle deadline advances the table to voting.
      await clock.advance(30_001);
      continue;
    }
    const actorId = state.gameState.currentSpeaker;
    const result = await dispatch(session, actorId, {
      type: 'game.speak',
      payload: { content: '公开发言' },
    });
    assert.equal(result.ok, true);
  }
  assert.equal(session.serialize().state.dayFlow.stage, 'voting');

  const target = players[0];
  const alternate = players[1];
  for (const voter of players) {
    const result = await dispatch(session, voter.id, {
      type: 'game.vote',
      payload: {
        targetId: voter.id === target.id ? alternate.id : target.id,
        reason: '票型判断',
      },
    });
    assert.equal(result.ok, true);
  }

  let state = session.serialize().state;
  assert.equal(state.gameState.phase, 'day');
  assert.equal(state.gameState.dayStage, 'exile_result');
  assert.equal(state.dayFlow.stage, 'exile_result');
  assert.ok(state.dayFlow.pendingExile?.ballots.every((ballot) => ballot.reason === '票型判断'));

  const publicEvents = await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'public',
    omniscient: false,
  });
  assert.equal(publicEvents.some((event) => event.eventType === 'day.vote_cast'), false);

  await clock.advance(100);
  state = session.serialize().state;
  assert.equal(state.dayFlow.stage, 'last_words');
  for (let round = 0; round < 2; round += 1) {
    const result = await dispatch(session, target.id, {
      type: 'game.skip_speech',
      payload: { reason: '没有新的信息' },
    });
    assert.equal(result.ok, true);
  }
  assert.equal(session.serialize().state.dayFlow.stage, 'day_end');
  await clock.advance(100);
  assert.equal(session.serialize().state.gameState.phase, 'night');

  const events = await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'public',
    omniscient: false,
  });
  const eventTypes = events.map((event) => event.eventType);
  assert.ok(eventTypes.includes('day.started'));
  assert.ok(eventTypes.includes('day.discussion_started'));
  assert.ok(eventTypes.includes('day.voting_started'));
  const exile = events.find((event) => event.eventType === 'day.exile_result');
  assert.equal((exile?.payload.voteHistory as Array<{ reason?: string }>)[0]?.reason, '票型判断');
  assert.ok(eventTypes.includes('day.ended'));
});
