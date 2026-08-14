import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameCommand, GameCommandMeta } from '../../shared/protocol';
import type { Player } from '../../shared/types';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import type { SessionSnapshot } from '../session/types';
import { createPlayers } from './fixtures';
import { FakeClock } from './fakeClock';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const commandMeta = (
  session: GameSession,
  actorId: string,
  commandId: string,
  sentAt: number,
): GameCommandMeta => ({
  commandId,
  actorId,
  sentAt,
  roomId: session.serialize().state.roomId,
  gameId: session.gameId,
  expectedStageRevision: session.stageRevision,
});

const configureSpeech = (snapshot: SessionSnapshot, players: Player[]) => {
  const speechQueue = players.map((player) => player.id);
  snapshot.state.gameState.phase = 'day';
  snapshot.state.gameState.dayStage = 'speech';
  snapshot.state.gameState.nightStage = 'resolve';
  snapshot.state.gameState.stageRevision = 10;
  snapshot.state.gameState.currentSpeaker = speechQueue[0];
  snapshot.state.gameState.speakerOrder = speechQueue;
  snapshot.state.dayFlow = {
    stage: 'speech',
    voteRound: 1,
    voteCandidates: [],
    votes: {},
    speechQueue,
    lastWordsPlayerId: null,
    lastWordsRemaining: 0,
    pendingHunterId: null,
  };
};

const configureVoting = (snapshot: SessionSnapshot, _players: Player[]) => {
  snapshot.state.gameState.phase = 'voting';
  snapshot.state.gameState.dayStage = 'voting';
  snapshot.state.gameState.nightStage = 'resolve';
  snapshot.state.gameState.stageRevision = 20;
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
};

const createTimedSession = async (
  configure?: (snapshot: SessionSnapshot, players: Player[]) => void,
) => {
  const players = createPlayers();
  let snapshot: SessionSnapshot | undefined;
  if (configure) {
    const seed = new GameSession(
      'room-1',
      players,
      new InMemoryEventStore(),
    );
    snapshot = seed.serialize();
    configure(snapshot, players);
  }

  const clock = new FakeClock();
  const changeGates: Array<{
    entered: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  }> = [];
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
    snapshot,
    {
      now: clock.now,
      scheduler: clock,
      stageDurationMs: 100,
      onChanged: async () => {
        const gate = changeGates.shift();
        if (!gate) return;
        gate.entered.resolve();
        await gate.release.promise;
      },
    },
  );
  await session.initialize();

  return {
    clock,
    players,
    session,
    gateNextChange: () => {
      const gate = { entered: deferred(), release: deferred() };
      changeGates.push(gate);
      return {
        entered: gate.entered.promise,
        release: gate.release.resolve,
      };
    },
  };
};

test('deadline fires once and stale expired commands cannot mutate state', async () => {
  const clock = new FakeClock();
  const store = new InMemoryEventStore();
  const players = createPlayers();
  const session = new GameSession('room-1', players, store, undefined, {
    now: clock.now,
    scheduler: clock,
    stageDurationMs: 100,
  });
  await session.initialize();
  const initialRevision = session.stageRevision;
  const initialDeadline = session.deadlineTs;
  assert.equal(initialDeadline, 1_100);
  assert.equal(clock.activeCount(), 1);

  await clock.advance(101);
  assert.ok(session.stageRevision > initialRevision);
  assert.equal(clock.activeCount(), 1);
  const sequenceAfterTimeout = session.serialize().state.sequence;
  await clock.advance(0);
  assert.equal(session.serialize().state.sequence, sequenceAfterTimeout);

  const guardian = players.find((player) => player.role === 'guardian')!;
  const result = await session.dispatch(
    {
      commandId: 'late',
      actorId: guardian.id,
      sentAt: clock.now(),
      roomId: 'room-1',
      gameId: session.gameId,
      expectedStageRevision: initialRevision,
    },
    {
      type: 'game.skip_night',
      payload: { action: 'guard' },
    },
  );
  assert.equal(result.code, 'STALE_STAGE_REVISION');
});

test('recovery schedules only the persisted unfinished revision', async () => {
  const firstClock = new FakeClock();
  const store = new InMemoryEventStore();
  const players = createPlayers();
  const first = new GameSession('room-1', players, store, undefined, {
    now: firstClock.now,
    scheduler: firstClock,
    stageDurationMs: 100,
  });
  await first.initialize();
  const persisted = first.serialize();
  first.dispose();

  const secondClock = new FakeClock();
  const restored = new GameSession('room-1', players, store, persisted, {
    now: secondClock.now,
    scheduler: secondClock,
    stageDurationMs: 100,
  });
  restored.restoreScheduling();
  assert.equal(secondClock.activeCount(), 1);
  await secondClock.advance(101);
  assert.ok(restored.stageRevision > persisted.state.gameState.stageRevision!);
  assert.equal(secondClock.activeCount(), 1);
});

test('night action queued before deadline remains valid after processing crosses deadline', async () => {
  const { clock, gateNextChange, players, session } =
    await createTimedSession();
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const gate = gateNextChange();
  const first = session.dispatch(
    commandMeta(session, guardian.id, 'night-blocker', clock.now()),
    {
      type: 'game.skip_night',
      payload: { action: 'guard' },
    },
  );
  await gate.entered;

  const queued = session.dispatch(
    commandMeta(
      session,
      seer.id,
      'night-before-deadline',
      Number.MAX_SAFE_INTEGER,
    ),
    {
      type: 'game.skip_night',
      payload: { action: 'check' },
    },
  );
  await clock.advance(101);
  gate.release();

  await first;
  const result = await queued;
  assert.equal(result.ok, true);
  assert.notEqual(result.code, 'EXPIRED_COMMAND');
  session.dispose();
});

test('speech queued before deadline remains valid after processing crosses deadline', async () => {
  const { clock, gateNextChange, players, session } =
    await createTimedSession(configureSpeech);
  const gate = gateNextChange();
  const first = session.dispatch(
    commandMeta(session, players[0].id, 'speech-blocker', clock.now()),
    {
      type: 'game.skip_speech',
      payload: {},
    },
  );
  await gate.entered;

  const currentSpeaker = session.serialize().state.gameState.currentSpeaker!;
  const queued = session.dispatch(
    commandMeta(
      session,
      currentSpeaker,
      'speech-before-deadline',
      Number.MAX_SAFE_INTEGER,
    ),
    {
      type: 'game.speak',
      payload: { content: 'queued before the deadline' },
    },
  );
  await clock.advance(101);
  gate.release();

  await first;
  const result = await queued;
  assert.equal(result.ok, true);
  assert.notEqual(result.code, 'EXPIRED_COMMAND');
  session.dispose();
});

test('vote queued before deadline remains valid after processing crosses deadline', async () => {
  const { clock, gateNextChange, players, session } =
    await createTimedSession(configureVoting);
  const target = players[1];
  const gate = gateNextChange();
  const first = session.dispatch(
    commandMeta(session, players[0].id, 'vote-blocker', clock.now()),
    {
      type: 'game.vote',
      payload: { targetId: target.id },
    },
  );
  await gate.entered;

  const queued = session.dispatch(
    commandMeta(
      session,
      players[2].id,
      'vote-before-deadline',
      Number.MAX_SAFE_INTEGER,
    ),
    {
      type: 'game.vote',
      payload: { targetId: target.id },
    },
  );
  await clock.advance(101);
  gate.release();

  await first;
  const result = await queued;
  assert.equal(result.ok, true);
  assert.notEqual(result.code, 'EXPIRED_COMMAND');
  session.dispose();
});

test('night actions, speeches, and votes arriving after deadline are rejected', async () => {
  const cases: Array<{
    name: string;
    configure?: (snapshot: SessionSnapshot, players: Player[]) => void;
    command: (players: Player[]) => {
      actorId: string;
      command: GameCommand;
    };
  }> = [
    {
      name: 'night action',
      command: (players) => ({
        actorId: players.find((player) => player.role === 'guardian')!.id,
        command: {
          type: 'game.skip_night',
          payload: { action: 'guard' },
        },
      }),
    },
    {
      name: 'speech',
      configure: configureSpeech,
      command: (players) => ({
        actorId: players[0].id,
        command: {
          type: 'game.speak',
          payload: { content: 'arrived late' },
        },
      }),
    },
    {
      name: 'vote',
      configure: configureVoting,
      command: (players) => ({
        actorId: players[0].id,
        command: {
          type: 'game.vote',
          payload: { targetId: players[1].id },
        },
      }),
    },
  ];

  for (const scenario of cases) {
    const { clock, players, session } = await createTimedSession(
      scenario.configure,
    );
    clock.elapseWithoutRunningTasks(101);
    const { actorId, command } = scenario.command(players);
    const result = await session.dispatch(
      commandMeta(session, actorId, `late-${scenario.name}`, 0),
      command,
    );
    assert.equal(result.code, 'EXPIRED_COMMAND', scenario.name);
    session.dispose();
  }
});
