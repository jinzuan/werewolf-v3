import assert from 'node:assert/strict';
import test from 'node:test';
import type { Player } from '../../shared/types';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import type { SessionSnapshot } from '../session/types';
import { createPlayers, dispatch } from './fixtures';
import { FakeClock } from './fakeClock';

const createSpeechSession = async (): Promise<{
  session: GameSession;
  players: Player[];
  clock: FakeClock;
  store: InMemoryEventStore;
}> => {
  const players = createPlayers().slice(0, 4);
  const order = players.map((player) => player.id);
  const seed = new GameSession('room-1', players, new InMemoryEventStore());
  const snapshot = seed.serialize();
  snapshot.state.gameState.phase = 'day';
  snapshot.state.gameState.dayStage = 'speech';
  snapshot.state.gameState.nightStage = 'resolve';
  snapshot.state.gameState.stageRevision = 10;
  snapshot.state.gameState.currentSpeaker = order[0];
  snapshot.state.gameState.speakerOrder = order;
  snapshot.state.dayFlow = {
    stage: 'speech',
    voteRound: 1,
    voteCandidates: [],
    votes: {},
    voteReasons: {},
    speechQueue: order,
    speechDirection: 'clockwise',
    speechStartPlayerId: order[0],
    discussionMode: 'first_report',
    discussionQueue: [],
    discussionMentionCounts: {},
    discussionMentionOrder: [],
    discussionSpokenPlayerIds: [],
    discussionRequestSequence: 0,
    discussionRequestReasons: {},
    lastWordsPlayerId: null,
    lastWordsRemaining: 0,
    pendingHunterId: null,
    pendingExile: null,
  };
  const store = new InMemoryEventStore();
  const clock = new FakeClock();
  const session = new GameSession('room-1', players, store, snapshot, {
    now: clock.now,
    scheduler: clock,
    stageDurationMs: 100_000,
  });
  await session.initialize();
  return { session, players, clock, store };
};

const completeFirstReport = async (
  session: GameSession,
  players: readonly Player[],
  contentFor: (index: number) => string = () => '先过。',
): Promise<void> => {
  for (const [index, player] of players.entries()) {
    const result = await dispatch(session, player.id, {
      type: 'game.speak',
      payload: { content: contentFor(index) },
    });
    assert.equal(result.ok, true);
  }
};

const completeFreeDiscussion = async (
  session: GameSession,
  content: string | null = null,
): Promise<void> => {
  for (let turn = 0; turn < 40; turn += 1) {
    const state = session.serialize().state;
    if (state.dayFlow.stage === 'voting') return;
    assert.equal(state.dayFlow.stage, 'discussion');
    assert.ok(state.gameState.currentSpeaker);
    const result = await dispatch(
      session,
      state.gameState.currentSpeaker,
      content
        ? { type: 'game.speak', payload: { content } }
        : { type: 'game.skip_speech', payload: {} },
    );
    assert.equal(result.ok, true);
  }
  assert.fail('free discussion did not advance to voting');
};

test('first report follows seat order and starts the configured full discussion cycles', async () => {
  const { session, players } = await createSpeechSession();
  await completeFirstReport(session, players, (index) =>
    index === 0 ? '@seer-2 先听他。' : index === 1 ? '@wolf-3 你回应一下。' : '先过。',
  );

  const speeches = (await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'spec-1',
    omniscient: true,
  })).filter((event) => event.eventType === 'day.speech');
  assert.deepEqual(
    speeches.slice(-4).map((event) => event.payload.actorId),
    players.map((player) => player.id),
  );
  const state = session.serialize().state;
  assert.equal(state.dayFlow.stage, 'discussion');
  assert.equal(state.dayFlow.discussionMode, 'free_discussion');
  assert.equal(state.dayFlow.discussionCycle, 1);
  assert.equal(state.dayFlow.discussionCyclesRequired, 2);
  assert.deepEqual(new Set(state.dayFlow.speechQueue), new Set(players.map((player) => player.id)));
  assert.equal(state.dayFlow.speechQueue.length, players.length);
  assert.ok(state.gameState.discussionQueue?.some((entry) => entry.source === 'mention'));
});

test('free discussion gives every living seat two complete cycles before voting', async () => {
  const { session, players } = await createSpeechSession();
  await completeFirstReport(session, players);
  assert.equal(session.serialize().state.dayFlow.stage, 'discussion');
  await completeFreeDiscussion(session);
  assert.equal(session.serialize().state.dayFlow.stage, 'voting');

  const skipped = (await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'metrics',
    omniscient: true,
  })).filter((event) =>
    event.eventType === 'day.speech_skipped' && event.payload.discussion === true,
  );
  assert.equal(skipped.length, players.length * 2);
  assert.deepEqual(
    [...new Set(skipped.map((event) => event.payload.discussionRound))],
    [1, 2],
  );
});

test('mention counts are capped and insert requests share the same queue', async () => {
  const { session, players, clock, store } = await createSpeechSession();
  await completeFirstReport(session, players, () => '@seer-2 请回应。');
  const state = session.serialize().state;
  assert.equal(state.dayFlow.discussionMentionCounts?.['seer-2'], 3);
  assert.equal(state.dayFlow.discussionQueue?.[0]?.mentionCount, 3);

  // Reconstructing from the committed state keeps the same public queue.
  const recovered = new GameSession(
    'room-1',
    players,
    store,
    session.serialize() as SessionSnapshot,
    { now: clock.now, scheduler: clock, stageDurationMs: 100_000 },
  );
  await recovered.initialize();
  const recoveredProjection = await recovered.snapshotFor({
    kind: 'spectator',
    spectatorId: 'spec-2',
    omniscient: true,
  });
  assert.deepEqual(
    recoveredProjection.gameState.discussionQueue,
    session.serialize().state.gameState.discussionQueue,
  );

  const empty = await createSpeechSession();
  await completeFirstReport(empty.session, empty.players, (index) =>
    index === 0 ? '@seer-2 请回应。' : '先过。',
  );
  const current = empty.session.serialize().state.gameState.currentSpeaker;
  const requesters = empty.players.filter((player) => player.id !== current).slice(0, 3);
  const first = await dispatch(empty.session, requesters[0].id, {
    type: 'game.request_speech',
    payload: {},
  });
  assert.equal(first.ok, true);
  const second = await dispatch(empty.session, requesters[1].id, {
    type: 'game.request_speech',
    payload: {},
  });
  const third = await dispatch(empty.session, requesters[2].id, {
    type: 'game.request_speech',
    payload: {},
  });
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  assert.equal(empty.session.serialize().state.dayFlow.speechQueue[0], current);
  assert.deepEqual(
    empty.session.serialize().state.dayFlow.discussionQueue
      ?.filter((entry) => entry.source === 'insert')
      .map((entry) => entry.playerId),
    requesters.map((player) => player.id),
  );
  await clock.advance(15_001);
});

test('waiting queue entries gain deterministic timeout priority and voting overwrites one ballot', async () => {
  const { session, players, clock } = await createSpeechSession();
  await completeFirstReport(session, players, (index) =>
    index === 0 ? '@seer-2 请回应。' : '先过。',
  );
  const current = session.serialize().state.gameState.currentSpeaker;
  const requesters = players.filter((player) => player.id !== current).slice(0, 2);
  await dispatch(session, requesters[0].id, { type: 'game.request_speech', payload: {} });
  await dispatch(session, requesters[1].id, { type: 'game.request_speech', payload: {} });
  clock.elapseWithoutRunningTasks(15_001);
  await dispatch(session, current!, { type: 'game.skip_speech', payload: {} });
  assert.equal(session.serialize().state.dayFlow.discussionQueue?.[0]?.source, 'wait_timeout');

  // The voting assertion uses a fresh compact session so discussion choices
  // cannot accidentally satisfy the vote stage.
  const voting = await createSpeechSession();
  const votingState = voting.session.serialize();
  votingState.state.gameState.dayStage = 'voting';
  votingState.state.dayFlow.stage = 'voting';
  votingState.state.dayFlow.speechQueue = [];
  votingState.state.gameState.currentSpeaker = null;
  votingState.state.dayFlow.discussionMode = null;
  votingState.state.streamVersion = 0;
  votingState.state.sequence = 0;
  votingState.state.processedCommands = {};
  const voteStore = new InMemoryEventStore();
  const voteSession = new GameSession(
    'room-1',
    voting.players,
    voteStore,
    votingState,
    { now: voting.clock.now, scheduler: voting.clock, stageDurationMs: 100_000 },
  );
  await voteSession.initialize();
  const targetA = voting.players[1].id;
  const targetB = voting.players[2].id;
  const first = await dispatch(voteSession, voting.players[0].id, {
    type: 'game.vote',
    payload: { targetId: targetA },
  });
  const ownVoteSnapshot = await voteSession.snapshotFor({
    kind: 'player',
    playerId: voting.players[0].id,
    role: voting.players[0].role!,
    isAlive: true,
  });
  const otherVoteSnapshot = await voteSession.snapshotFor({
    kind: 'player',
    playerId: voting.players[1].id,
    role: voting.players[1].role!,
    isAlive: true,
  });
  assert.deepEqual(ownVoteSnapshot.gameState.voteSubmission, {
    submitted: true,
    targetId: targetA,
    submittedCount: 1,
    totalVoters: voting.players.length,
    waitingFor: voting.players.length - 1,
  });
  assert.deepEqual(otherVoteSnapshot.gameState.voteSubmission, {
    submitted: false,
    targetId: null,
    submittedCount: 1,
    totalVoters: voting.players.length,
    waitingFor: voting.players.length - 1,
  });
  const changed = await dispatch(voteSession, voting.players[0].id, {
    type: 'game.vote',
    payload: { targetId: targetB },
  });
  assert.equal(first.ok, true, first.ok ? '' : first.code);
  assert.equal(changed.ok, true, changed.ok ? '' : changed.code);
  assert.equal(changed.events[0]?.payload.changed, true);
  assert.equal(voteSession.serialize().state.dayFlow.votes[voting.players[0].id], targetB);
});
