import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore } from '../events/store';
import { GameSession } from '../session/gameSession';
import { createPlayers, dispatch, initializeSession } from './fixtures';

const serialized = (value: unknown) => JSON.stringify(value);

test('private night facts never leak to villagers or public spectators', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolf = players.find((player) => player.role === 'wolf')!;
  const villager = players.find((player) => player.role === 'villager')!;

  await dispatch(session, guardian.id, {
    type: 'game.night_action',
    payload: {
      playerId: guardian.id,
      action: 'guard',
      targetId: villager.id,
    },
  });
  await dispatch(session, seer.id, {
    type: 'game.night_action',
    payload: {
      playerId: seer.id,
      action: 'check',
      targetId: wolf.id,
    },
  });
  await dispatch(session, wolf.id, {
    type: 'game.wolf_speak',
    payload: { content: 'SECRET_WOLF_CHAT' },
  });

  const villagerView = {
    kind: 'player' as const,
    playerId: villager.id,
    role: 'villager' as const,
  };
  const publicSpectator = {
    kind: 'spectator' as const,
    spectatorId: 'public',
    omniscient: false,
  };
  const omniscient = {
    kind: 'spectator' as const,
    spectatorId: 'admin',
    omniscient: true,
  };

  const villagerPayload = serialized({
    events: await session.eventsFor(villagerView),
    snapshot: await session.snapshotFor(villagerView),
  });
  const publicPayload = serialized({
    events: await session.eventsFor(publicSpectator),
    snapshot: await session.snapshotFor(publicSpectator),
  });
  const omniscientPayload = serialized({
    events: await session.eventsFor(omniscient),
    snapshot: await session.snapshotFor(omniscient),
  });
  const seerPayload = serialized(
    await session.eventsFor({
      kind: 'player',
      playerId: seer.id,
      role: 'seer',
    }),
  );

  for (const payload of [villagerPayload, publicPayload]) {
    assert.doesNotMatch(payload, /SECRET_WOLF_CHAT/);
    assert.doesNotMatch(payload, /guardian\.completed/);
    assert.doesNotMatch(payload, /seer\.result/);
    assert.doesNotMatch(payload, /"role":"wolf"/);
    assert.doesNotMatch(payload, /"nightActions":\[\{/);
    assert.doesNotMatch(payload, /"votes":\{/);
    assert.doesNotMatch(payload, new RegExp(`"playerId":"${guardian.id}"`));
    assert.doesNotMatch(payload, new RegExp(`"playerId":"${seer.id}"`));
  }

  assert.match(seerPayload, /seer\.result/);
  assert.match(seerPayload, new RegExp(`"targetId":"${wolf.id}"`));
  assert.match(seerPayload, /"alignment":"wolf"/);

  assert.match(omniscientPayload, /SECRET_WOLF_CHAT/);
  assert.match(omniscientPayload, /guardian\.completed/);
  assert.match(omniscientPayload, /seer\.result/);
  assert.match(omniscientPayload, /"role":"wolf"/);
});

test('wolves see teammate roles and wolf events but not role-private events', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  const wolf = players.find((player) => player.role === 'wolf')!;
  const villager = players.find((player) => player.role === 'villager')!;

  await dispatch(session, guardian.id, {
    type: 'game.night_action',
    payload: {
      playerId: guardian.id,
      action: 'guard',
      targetId: villager.id,
    },
  });
  const payload = serialized({
    events: await session.eventsFor({
      kind: 'player',
      playerId: wolf.id,
      role: 'wolf',
    }),
    snapshot: await session.snapshotFor({
      kind: 'player',
      playerId: wolf.id,
      role: 'wolf',
    }),
  });

  assert.match(payload, /"role":"wolf"/);
  assert.doesNotMatch(payload, /guardian\.completed/);
  assert.doesNotMatch(payload, new RegExp(`"targetId":"${villager.id}"`));
});

test('every living wolf receives every night chat message in speaker order', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolves = players.filter((player) => player.role === 'wolf');
  const villager = players.find((player) => player.role === 'villager')!;

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
      type: 'game.wolf_speak',
      payload: { content: `狼聊-${index + 1}` },
    });
    assert.equal(result.ok, true);
    const message = result.events.find((event) => event.eventType === 'wolf.message');
    assert.deepEqual(message?.audienceIds, wolves.map((player) => player.id));
  }

  for (const wolf of wolves) {
    const messages = (await session.eventsFor({
      kind: 'player',
      playerId: wolf.id,
      role: 'wolf',
    }))
      .filter((event) => event.eventType === 'wolf.message')
      .map((event) => (event.payload as { content: string }).content);
    assert.deepEqual(messages, ['狼聊-1', '狼聊-2', '狼聊-3', '狼聊-4']);
  }

  const villagerMessages = (await session.eventsFor({
    kind: 'player',
    playerId: villager.id,
    role: 'villager',
  })).filter((event) => event.eventType === 'wolf.message');
  assert.equal(villagerMessages.length, 0);
});

test('dead wolves do not receive new wolf-private events', async () => {
  const players = createPlayers();
  const deadWolf = players.find((player) => player.role === 'wolf')!;
  deadWolf.isAlive = false;
  const livingWolf = players.find(
    (player) => player.role === 'wolf' && player.id !== deadWolf.id,
  )!;
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);

  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  await dispatch(session, guardian.id, {
    type: 'game.skip_night',
    payload: { action: 'guard' },
  });
  await dispatch(session, seer.id, {
    type: 'game.skip_night',
    payload: { action: 'check' },
  });
  await dispatch(session, livingWolf.id, {
    type: 'game.wolf_speak',
    payload: { content: 'LIVING_WOLVES_ONLY' },
  });

  const payload = serialized(
    await session.eventsFor({
      kind: 'player',
      playerId: deadWolf.id,
      role: 'wolf',
    }),
  );
  assert.doesNotMatch(payload, /LIVING_WOLVES_ONLY/);
});

test('eliminated players are reduced to the public spectator boundary', async () => {
  const players = createPlayers();
  const session = new GameSession(
    'room-1',
    players,
    new InMemoryEventStore(),
  );
  await initializeSession(session, players);
  const guardian = players.find((player) => player.role === 'guardian')!;
  const seer = players.find((player) => player.role === 'seer')!;
  const wolf = players.find((player) => player.role === 'wolf')!;

  await dispatch(session, guardian.id, {
    type: 'game.skip_night',
    payload: { action: 'guard' },
  });
  await dispatch(session, seer.id, {
    type: 'game.night_action',
    payload: {
      playerId: seer.id,
      action: 'check',
      targetId: wolf.id,
    },
  });

  const viewer = {
    kind: 'player' as const,
    playerId: seer.id,
    role: 'seer' as const,
    isAlive: false,
  };
  const payload = serialized({
    events: await session.eventsFor(viewer),
    snapshot: await session.snapshotFor(viewer),
  });

  assert.doesNotMatch(payload, /seer\.result/);
  assert.doesNotMatch(payload, /"nightActions":\[\{/);
  assert.match(payload, /"role":"seer"/);
});
