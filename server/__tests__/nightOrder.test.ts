import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMAIN_EVENT_SCHEMA_VERSION } from '../../shared/events';
import { buildAIPrompt, buildAIRuntimeContext, projectAIContext } from '../ai';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers, dispatch } from './fixtures';

test('night order is guard_seer then wolf discussion/vote then witch then resolve', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await session.initialize();

  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolves = players.filter((player) => player.role === 'wolf');
  const witch = players.find((player) => player.role === 'witch')!;
  const villager = players.find((player) => player.role === 'villager')!;

  const earlyWolfVote = await dispatch(session, wolves[0].id, {
    type: 'game.wolf_vote',
    payload: { targetId: villager.id },
  });
  assert.equal(earlyWolfVote.ok, false);
  assert.equal(session.serialize().state.night.stage, 'guard_seer');

  assert.equal(
    (
      await dispatch(session, guardian.id, {
        type: 'game.night_action',
        payload: {
          playerId: guardian.id,
          action: 'guard',
          targetId: guardian.id,
        },
      })
    ).ok,
    true,
  );
  assert.equal(session.serialize().state.night.stage, 'guard_seer');

  assert.equal(
    (
      await dispatch(session, seer.id, {
        type: 'game.night_action',
        payload: {
          playerId: seer.id,
          action: 'check',
          targetId: wolves[0].id,
        },
      })
    ).ok,
    true,
  );
  assert.equal(session.serialize().state.night.stage, 'wolf_discussion');

  const wolfSpeech = await dispatch(session, wolves[0].id, {
    type: 'game.wolf_speak',
    payload: { content: '先看票型，今晚统一刀口。' },
  });
  assert.equal(wolfSpeech.ok, true);
  assert.equal(wolfSpeech.events[0]?.eventType, 'wolf.message');
  assert.equal(
    (wolfSpeech.events[0]?.payload as { content: string }).content,
    '先看票型，今晚统一刀口。',
  );

  for (const wolf of wolves) {
    const result = await dispatch(session, wolf.id, {
      type: 'game.wolf_vote',
      payload: { targetId: villager.id },
    });
    assert.equal(result.ok, true);
  }
  assert.equal(session.serialize().state.night.stage, 'witch');
  const wolfEvents = await session.eventsFor({
    kind: 'player',
    playerId: wolves[0].id,
    role: 'wolf',
  });
  assert.ok(wolfEvents.some((event) => event.eventType === 'wolf.message'));
  assert.ok(wolfEvents.some((event) => event.eventType === 'wolf.vote_cast'));
  const killLocked = wolfEvents.find((event) => event.eventType === 'wolf.kill_locked');
  assert.equal(
    (killLocked?.payload as { targetId: string }).targetId,
    villager.id,
  );

  const witchResult = await dispatch(session, witch.id, {
    type: 'game.skip_night',
    payload: { action: 'heal' },
  });
  assert.equal(witchResult.ok, true);
  assert.equal(session.serialize().state.gameState.phase, 'day');
  assert.equal(session.serialize().state.night.stage, 'resolve');
  assert.equal(
    session.players.find((player) => player.id === villager.id)?.isAlive,
    false,
  );

  const resolved = witchResult.events.find(
    (event) => event.eventType === 'night.resolved',
  );
  assert.ok(resolved);
  assert.deepEqual(
    (resolved.payload as { deaths: string[] }).deaths,
    [villager.id],
  );

  const aiProjection = await projectAIContext(session, {
    playerId: guardian.id,
    role: 'guardian',
    stageRevision: session.stageRevision,
    allowedActions: [],
  });
  const projectedResolved = aiProjection.publicEvents.find(
    (event) => event.eventType === 'night.resolved',
  );
  assert.ok(projectedResolved);
  assert.deepEqual(
    (projectedResolved.payload as { deaths: string[] }).deaths,
    [villager.id],
  );
});

test('real session event projection feeds death, action, and vote history into final words', async () => {
  const players = createPlayers('room-final-words');
  const session = new GameSession(
    'room-final-words',
    players,
    new InMemoryEventStore(),
  );
  await session.initialize();
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolves = players.filter((player) => player.role === 'wolf');
  const witch = players.find((player) => player.role === 'witch')!;
  const villager = players.find((player) => player.role === 'villager')!;

  await dispatch(session, guardian.id, {
    type: 'game.skip_night',
    payload: { action: 'guard' },
  });
  await dispatch(session, seer.id, {
    type: 'game.night_action',
    payload: { playerId: seer.id, action: 'check', targetId: wolves[0].id },
  });
  for (const wolf of wolves) {
    await dispatch(session, wolf.id, {
      type: 'game.wolf_vote',
      payload: { targetId: villager.id },
    });
  }
  await dispatch(session, witch.id, {
    type: 'game.skip_night',
    payload: { action: 'heal' },
  });

  while (session.serialize().state.dayFlow.stage === 'speech') {
    const speaker = session.serialize().state.gameState.currentSpeaker!;
    await dispatch(session, speaker, {
      type: 'game.skip_speech',
      payload: {},
    });
  }
  for (const voter of session.players.filter((player) => player.isAlive)) {
    await dispatch(session, voter.id, {
      type: 'game.vote',
      payload: { targetId: voter.id === seer.id ? wolves[0].id : seer.id },
    });
  }
  assert.equal(session.serialize().state.dayFlow.stage, 'last_words');

  const viewer = { kind: 'player' as const, playerId: seer.id, role: 'seer' as const };
  const snapshot = await session.snapshotFor(viewer);
  const visibleEvents = await session.eventsFor(viewer);
  const runtime = buildAIRuntimeContext({
    actorId: seer.id,
    role: 'seer',
    phase: 'lastWords',
    stage: 'last_words',
    dayNumber: snapshot.gameState.day,
    roundNumber: 1,
    players: snapshot.players,
    visibleEvents,
    allowedActions: ['speak'],
    lastWordsRound: 1,
    lastWordsRoundsRemaining: 2,
  });
  const prompt = buildAIPrompt({
    roomId: 'room-final-words',
    gameId: snapshot.gameId,
    playerId: seer.id,
    role: 'seer',
    phase: 'lastWords',
    stage: 'last_words',
    stageRevision: session.stageRevision,
    callId: 'final-words-test',
    players: snapshot.players,
    allowedActions: ['speak'],
    allowedCommandTypes: ['game.speak'],
    promptContext: runtime,
  });

  assert.match(prompt.user, new RegExp('第1晚你的查验：' + wolves[0].name + '，结果狼人'));
  assert.match(prompt.user, new RegExp('第1晚公开死亡：' + villager.name));
  assert.match(prompt.user, new RegExp('第1天已公开票型：.*投票给 ' + seer.name));
  assert.doesNotMatch(prompt.user, /选择弃票/);
  assert.doesNotMatch(prompt.user, /昨晚.*平安夜/);
});

test('command ids and stage revisions are enforced', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await session.initialize();
  const guardian = players.find((player) => player.role === 'guardian')!;
  const command = {
    type: 'game.skip_night' as const,
    payload: { action: 'guard' as const },
  };
  const baseMeta = {
    commandId: 'same-id',
    actorId: guardian.id,
    sentAt: Date.now(),
    roomId: 'room-1',
    gameId: session.gameId,
    expectedStageRevision: session.stageRevision,
  };

  const firstResult = await session.dispatch(baseMeta, command);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.events.length > 0, true);
  for (const event of firstResult.events) {
    assert.equal(event.actorId, guardian.id);
    assert.equal(event.correlationId, baseMeta.commandId);
    assert.equal(event.schemaVersion, DOMAIN_EVENT_SCHEMA_VERSION);
    assert.equal(event.phase, 'night');
    assert.equal(event.stage, 'guard_seer');
  }
  const beforeRetry = session.serialize().state.sequence;
  const retry = await session.dispatch(baseMeta, command);
  assert.equal(retry.ok, true);
  assert.equal(session.serialize().state.sequence, beforeRetry);
  assert.equal(
    (
      await session.dispatch(
        { ...baseMeta, commandId: 'stale-id', expectedStageRevision: 0 },
        command,
      )
    ).code,
    'STALE_STAGE_REVISION',
  );
});

test('wolf vote tie randomly kills a tied target without revote or empty kill', async () => {
  const killedTargets = new Set<string>();

  for (const [run, randomValue] of [0, 0.999999].entries()) {
    const players = createPlayers(`room-tie-${run}`);
    const session = new GameSession(
      `room-tie-${run}`,
      players,
      new InMemoryEventStore(),
      undefined,
      { rng: () => randomValue },
    );
    await session.initialize();
    const guardian = players.find((player) => player.role === 'guardian')!;
    const seer = players.find((player) => player.role === 'seer')!;
    const wolves = players.filter((player) => player.role === 'wolf');
    const witch = players.find((player) => player.role === 'witch')!;
    const tiedTargets = players
      .filter((player) => player.role === 'villager')
      .slice(0, 2);

    await dispatch(session, guardian.id, {
      type: 'game.skip_night',
      payload: { action: 'guard' },
    });
    await dispatch(session, seer.id, {
      type: 'game.skip_night',
      payload: { action: 'check' },
    });

    for (const [index, wolf] of wolves.entries()) {
      const result = await dispatch(session, wolf.id, {
        type: 'game.wolf_vote',
        payload: { targetId: tiedTargets[index % 2].id },
      });
      assert.equal(result.ok, true);
    }

    const lockedTarget = session.serialize().state.night.actions.wolfKillTargetId;
    assert.equal(session.serialize().state.night.stage, 'witch');
    assert.notEqual(lockedTarget, null);
    assert.equal(
      tiedTargets.some((player) => player.id === lockedTarget),
      true,
    );

    const witchResult = await dispatch(session, witch.id, {
      type: 'game.skip_night',
      payload: { action: 'heal' },
    });
    assert.equal(witchResult.ok, true);
    assert.equal(session.serialize().state.gameState.phase, 'day');
    assert.deepEqual(
      session.players.filter((player) => !player.isAlive).map((player) => player.id),
      [lockedTarget],
    );
    killedTargets.add(lockedTarget!);
  }

  assert.deepEqual(
    [...killedTargets].sort(),
    createPlayers('room-reference')
      .filter((player) => player.role === 'villager')
      .slice(0, 2)
      .map((player) => player.id)
      .sort(),
  );
});
