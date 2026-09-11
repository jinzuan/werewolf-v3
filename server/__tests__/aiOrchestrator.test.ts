import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider } from '../ai/types';
import { AIOrchestrator } from '../ai/orchestrator';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers, dispatch, initializeSession } from './fixtures';

const createSpeechSession = async () => {
  const players = createPlayers().slice(0, 4);
  const seed = new GameSession('room-speech-failure', players, new InMemoryEventStore());
  const snapshot = seed.serialize();
  snapshot.state.gameState.phase = 'day';
  snapshot.state.gameState.dayStage = 'speech';
  snapshot.state.gameState.nightStage = 'resolve';
  snapshot.state.gameState.stageRevision = 10;
  snapshot.state.gameState.currentSpeaker = players[0].id;
  snapshot.state.gameState.speakerOrder = players.map((player) => player.id);
  snapshot.state.dayFlow = {
    stage: 'speech',
    voteRound: 1,
    voteCandidates: [],
    votes: {},
    voteReasons: {},
    speechQueue: players.map((player) => player.id),
    speechDirection: 'clockwise',
    speechStartPlayerId: players[0].id,
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
  const session = new GameSession(
    'room-speech-failure',
    players,
    new InMemoryEventStore(),
    snapshot,
    { stageDurationMs: 100_000 },
  );
  await session.initialize();
  return { session, players };
};

test('invalid AI suggestions use a deterministic validated fallback', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  const invalidProvider: AIProvider = {
    mode: 'rules-degraded',
    async suggest() {
      return {
        command: {
          type: 'game.night_action',
          payload: {
            playerId: guardian.id,
            action: 'guard',
            targetId: 'missing-player',
          },
        },
        reason: 'intentionally invalid target',
      };
    },
  };
  const orchestrator = new AIOrchestrator(invalidProvider);
  const result = await orchestrator.act(session, {
    roomId: 'room-1',
    gameId: session.gameId,
    playerId: guardian.id,
    role: 'guardian',
    phase: 'night',
    stage: 'guard_seer',
    stageRevision: session.stageRevision,
    players,
    allowedCommandTypes: ['game.night_action'],
  });

  assert.equal(result.accepted, true);
  assert.ok(session.serialize().state.night.actions.guardTargetId);
  assert.deepEqual(
    orchestrator.telemetry().map((entry) => entry.status),
    ['started', 'fallback'],
  );
});

test('failed real AI uses a legal speech skip and never emits free text', async () => {
  const { session, players } = await createSpeechSession();
  const actor = players[0];
  const failedProvider: AIProvider = {
    mode: 'real_ai',
    async suggest() {
      throw new Error('provider unavailable');
    },
  };
  const orchestrator = new AIOrchestrator(failedProvider);

  const result = await orchestrator.act(session, {
    roomId: 'room-speech-failure',
    gameId: session.gameId,
    playerId: actor.id,
    role: actor.role!,
    phase: 'day',
    stage: 'speech',
    stageRevision: session.stageRevision,
    players,
    allowedActions: ['speak', 'skip_speech'],
    allowedCommandTypes: ['game.speak', 'game.skip_speech'],
    promptContext: {
      legalActions: ['speak', 'skip_speech'],
      newInformationSinceLastTurn: ['新的公开票型'],
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.suggestion.command.type, 'game.skip_speech');
  const events = await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'monitor',
    omniscient: true,
  });
  assert.equal(events.some((event) => event.eventType === 'day.speech'), false);
  assert.equal(events.some((event) => event.eventType === 'day.speech_skipped'), true);
  session.dispose();
});

test('legacy provider without mode fails closed when no safe speech control exists', async () => {
  const { session, players } = await createSpeechSession();
  const actor = players[0];
  const orchestrator = new AIOrchestrator({
    async suggest() {
      throw new Error('provider unavailable');
    },
  });

  const result = await orchestrator.act(session, {
    roomId: 'room-speech-failure',
    gameId: session.gameId,
    playerId: actor.id,
    role: actor.role!,
    phase: 'day',
    stage: 'speech',
    stageRevision: session.stageRevision,
    players,
    allowedActions: ['speak'],
    allowedCommandTypes: ['game.speak'],
  });

  assert.equal(result.accepted, false);
  assert.equal(result.suggestion, null);
  const events = await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'monitor',
    omniscient: true,
  });
  assert.equal(events.some((event) => event.eventType === 'day.speech'), false);
  session.dispose();
});

test('rejected real AI text falls back through the same safe provenance gate', async () => {
  const { session, players } = await createSpeechSession();
  const actor = players[0];
  const orchestrator = new AIOrchestrator({
    mode: 'real_ai',
    async suggest() {
      return {
        command: { type: 'game.speak', payload: { content: '超'.repeat(1_000) } },
        reason: 'invalid oversized model output',
      };
    },
  });

  const result = await orchestrator.act(session, {
    roomId: 'room-speech-failure',
    gameId: session.gameId,
    playerId: actor.id,
    role: actor.role!,
    phase: 'day',
    stage: 'speech',
    stageRevision: session.stageRevision,
    players,
    allowedActions: ['speak', 'skip_speech'],
    allowedCommandTypes: ['game.speak', 'game.skip_speech'],
  });

  assert.equal(result.accepted, true);
  assert.equal(result.suggestion?.command.type, 'game.skip_speech');
  assert.equal(result.suggestion?.provenance.origin, 'orchestrator-fallback');
  const events = await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'monitor',
    omniscient: true,
  });
  assert.equal(events.some((event) => event.eventType === 'day.speech'), false);
  session.dispose();
});

test('failed real AI wolf turn skips without emitting wolf.message', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-wolf-failure',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolves = players.filter((player) => player.role === 'wolf');
  await dispatch(session, guardian.id, {
    type: 'game.night_action',
    payload: { playerId: guardian.id, action: 'guard', targetId: guardian.id },
  });
  await dispatch(session, seer.id, {
    type: 'game.night_action',
    payload: { playerId: seer.id, action: 'check', targetId: wolves[0].id },
  });
  const actor = wolves[0];
  const orchestrator = new AIOrchestrator({
    mode: 'real_ai',
    async suggest() {
      throw new Error('model unavailable');
    },
  });

  const result = await orchestrator.act(session, {
    roomId: 'room-wolf-failure',
    gameId: session.gameId,
    playerId: actor.id,
    role: 'wolf',
    phase: 'night',
    stage: 'wolf_discussion',
    stageRevision: session.stageRevision,
    players,
    allowedActions: ['wolf_speak', 'skip_speech'],
    allowedCommandTypes: ['game.wolf_speak', 'game.skip_speech'],
    promptContext: { newInformationSinceLastTurn: ['新的狼人分歧'] },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.suggestion?.command.type, 'game.skip_speech');
  const events = await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'monitor',
    omniscient: true,
  });
  assert.equal(events.some((event) => event.eventType === 'wolf.message'), false);
  session.dispose();
});

test('rules-degraded failure may retain deterministic speech text', async () => {
  const { session, players } = await createSpeechSession();
  const actor = players[0];
  const orchestrator = new AIOrchestrator({
    mode: 'rules-degraded',
    async suggest() {
      throw new Error('degraded provider trigger');
    },
  });

  const result = await orchestrator.act(session, {
    roomId: 'room-speech-failure',
    gameId: session.gameId,
    playerId: actor.id,
    role: actor.role!,
    phase: 'day',
    stage: 'speech',
    stageRevision: session.stageRevision,
    players,
    allowedActions: ['speak'],
    allowedCommandTypes: ['game.speak'],
  });

  assert.equal(result.accepted, true);
  assert.equal(result.suggestion?.command.type, 'game.speak');
  assert.equal(result.suggestion?.provenance.providerMode, 'rules-degraded');
  const events = await session.eventsFor({
    kind: 'spectator',
    spectatorId: 'monitor',
    omniscient: true,
  });
  assert.equal(events.some((event) => event.eventType === 'day.speech'), true);
  session.dispose();
});
