import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOMAIN_EVENT_SCHEMA_VERSION,
  type DomainEvent,
  type ProjectedSnapshot,
  type ViewerContext,
} from '../../../shared/events';
import type {
  GameEventsMessage,
  IdentityCredentials,
  RoomView,
} from '../../../shared/protocol';
import {
  GAME_ACTIONS,
  type GameAction,
  type GameState,
  type Player,
  type ProjectedGameState,
  type Role,
} from '../../../shared/types';
import {
  buildGameCommand,
  currentVoteRoundProjection,
  eligibleTargets,
  healTargetId,
  orderedAllowedActions,
} from '../actions';
import { mergeEventEnvelope } from '../eventStream';
import {
  V3_SESSION_KEY,
  V3_SESSION_VERSION,
  containsSensitiveKeys,
  createEmptyAuthorityState,
  createV3Session,
  isPublicRoomViewSafe,
  isSnapshotSafeForViewer,
  readV3Session,
  viewerPlayerId,
  writeV3Session,
} from '../session';
import {
  projectWaitingRoomSummary,
  waitingRoomNeedsRefresh,
} from '../waitingRoom';

const roomView = (
  actorId = 'p1',
  kind: RoomView['viewer']['kind'] = 'player',
): RoomView => ({
  id: 'room-1',
  code: 'ABC123',
  name: 'Authority room',
  roomRevision: 1,
  status: 'playing',
  config: {
    catalogVersion: 'catalog-v31-1',
    mode: 'human',
    visibility: 'invite_only',
    maxPlayers: 12,
    minHumanPlayers: 12,
    computerSeats: 0,
    aiFillPolicy: 'none',
    roleSetup: {
      wolf: 4,
      seer: 1,
      witch: 1,
      hunter: 1,
      guardian: 1,
      villager: 4,
    },
    rolePresetId: 'werewolf.v3.default-12p',
    rulesetId: 'werewolf.v3',
    rulesetVersion: '3.1.0',
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    reviewEnabled: true,
  },
  configRevision: 1,
  configLocked: true,
  members: [
    {
      id: actorId,
      name: 'Viewer',
      kind,
      seatIndex: kind === 'player' ? 0 : null,
      isAI: false,
      connected: true,
      isHost: actorId === 'p1',
      ready: kind === 'player' ? true : null,
      avatarId: 'avatar-player',
    },
  ],
  counts: {
    playerSeats: kind === 'player' ? 1 : 0,
    humanPlayers: kind === 'player' ? 1 : 0,
    onlineHumanPlayers: kind === 'player' ? 1 : 0,
    readyHumanPlayers: kind === 'player' ? 1 : 0,
    spectators: kind === 'spectator' ? 1 : 0,
  },
  startCheck: { passed: true, items: [] },
  viewer: {
    actorId,
    kind,
    omniscient: false,
    allowedRoomActions: [],
  },
  gameId: 'game-1',
  createdAt: 1,
});

const player = (
  id: string,
  role: Role | null,
  order: number,
  alive = true,
): Player => ({
  id,
  roomId: 'room-1',
  name: id,
  isAI: false,
  role,
  isAlive: alive,
  isHost: order === 1,
  order,
});

const gameState = (
  overrides: Partial<GameState> = {},
): ProjectedGameState => ({
  roomId: 'room-1',
  phase: 'night',
  nightStage: 'guard_seer',
  stageRevision: 1,
  allowedActors: [],
  allowedActions: [],
  deadlineTs: null,
  day: 1,
  turn: 1,
  votes: {},
  nightActions: [],
  winner: null,
  currentSpeaker: null,
  speakerOrder: [],
  actionDone: {},
  speechTimeLeft: 0,
  actionTimeLeft: 0,
  wolfVotes: {},
  wolfSpeakerOrder: [],
  wolfCurrentSpeaker: null,
  wolfDiscussionRound: 1,
  wolfVoteComplete: false,
  guardianLastTarget: null,
  guardianActionComplete: false,
  witchHasHealPotion: true,
  witchHasPoisonPotion: true,
  witchActionComplete: false,
  lastWordsPlayer: null,
  hunterShootTarget: null,
  witchAntidoteUsed: false,
  stageStartedAt: null,
  ...overrides,
});

const snapshot = (
  viewer: ViewerContext,
  overrides: Partial<ProjectedSnapshot> = {},
): ProjectedSnapshot => ({
  roomId: 'room-1',
  gameId: 'game-1',
  viewer,
  gameState: gameState(),
  players: [
    player('p1', viewer.kind === 'player' ? viewer.role : null, 1),
    player('p2', null, 2),
    player('p3', null, 3),
  ],
  serverTime: 1,
  lastSequence: 0,
  ...overrides,
});

const publicSpectatorSnapshot = (
  overrides: Partial<ProjectedSnapshot> = {},
): ProjectedSnapshot => {
  const projectedState = structuredClone(gameState()) as ProjectedGameState &
    Record<string, unknown>;
  for (const key of [
    'nightActions',
    'actionDone',
    'votes',
    'wolfVotes',
    'wolfSpeakerOrder',
    'wolfCurrentSpeaker',
    'wolfDiscussionRound',
    'wolfVoteComplete',
    'guardianLastTarget',
    'guardianActionComplete',
    'witchHasHealPotion',
    'witchHasPoisonPotion',
    'witchActionComplete',
    'witchAntidoteUsed',
  ]) {
    delete projectedState[key];
  }
  return snapshot(
    {
      kind: 'spectator',
      spectatorId: 's1',
      omniscient: false,
    },
    {
      gameState: projectedState,
      ...overrides,
    },
  );
};

test('spectator identity never resolves to a player identity', () => {
  assert.equal(viewerPlayerId({
    actorId: 'spectator-1',
    kind: 'spectator',
    omniscient: false,
    allowedRoomActions: [],
  }), null);
  assert.equal(viewerPlayerId({
    actorId: 'player-1',
    kind: 'player',
    omniscient: false,
    allowedRoomActions: [],
  }), 'player-1');
  assert.equal(viewerPlayerId({
    kind: 'spectator',
    spectatorId: 'player-1',
    omniscient: false,
  }), null);
});

const domainEvent = (
  sequence: number,
  eventType: DomainEvent['eventType'],
  visibility: DomainEvent['visibility'] = 'public_timeline',
  payload: Record<string, unknown> = {},
  audienceIds?: string[],
): DomainEvent => ({
  eventId: `event-${sequence}-${eventType}`,
  roomId: 'room-1',
  gameId: 'game-1',
  sequence,
  occurredAt: sequence,
  phase: 'night',
  stage: 'guard_seer',
  eventType,
  payload,
  visibility,
  audienceIds,
  correlationId: `correlation-${sequence}`,
  schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
});

class MemoryStorage implements Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
> {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('session persists scoped credentials and resumes with the member token', () => {
  const credentials: IdentityCredentials = {
    resumeToken: 'member-resume',
    joinToken: 'invite-only',
  };
  const session = createV3Session(
    roomView(),
    credentials,
    'Viewer',
  );
  const storage = new MemoryStorage();
  writeV3Session(storage, session);
  const restored = readV3Session(storage);

  assert.equal(restored?.version, V3_SESSION_VERSION);
  assert.equal(restored?.credentials.resumeToken, 'member-resume');
  assert.equal(restored?.credentials.joinToken, 'invite-only');
  assert.equal(restored?.lastSeenSeq, 0);
  assert.equal(isPublicRoomViewSafe(roomView()), true);
  assert.equal(containsSensitiveKeys(roomView()), false);
  assert.equal(
    isPublicRoomViewSafe({
      ...roomView(),
      players: [player('p1', 'wolf', 1)],
    } as RoomView),
    false,
  );
});

test('legacy join-token session shapes are rejected', () => {
  const storage = new MemoryStorage();
  storage.setItem(
    V3_SESSION_KEY,
    JSON.stringify({
      actorId: 'p1',
      roomId: 'room-1',
      roomCode: 'ABC123',
      joinToken: 'legacy-room-token',
    }),
  );
  assert.equal(readV3Session(storage), null);
});

test('the shared sensitive-key scanner catches nested and suffix aliases', () => {
  assert.equal(containsSensitiveKeys({ nested: { apiKey: 'canary' } }), true);
  assert.equal(containsSensitiveKeys({ nested: { credentialRef: 'canary' } }), true);
  assert.equal(containsSensitiveKeys({ nested: { 'access-token': 'canary' } }), true);
  assert.equal(containsSensitiveKeys({ nested: { providerApiKey: 'canary' } }), true);
});

test('authority reset clears room, identity, snapshot, and events atomically', () => {
  assert.deepEqual(createEmptyAuthorityState(), {
    room: null,
    session: null,
    snapshot: null,
    events: [],
  });
});

test('waiting room summaries detect joins, disconnects, and spectator changes', () => {
  const waitingRoom: RoomView = {
    ...roomView(),
    status: 'waiting',
    gameId: undefined,
    members: [
      {
        id: 'p1',
        name: 'Host',
        kind: 'player',
        seatIndex: 0,
        isAI: false,
        connected: true,
        isHost: true,
        ready: false,
        avatarId: 'avatar-player',
      },
      {
        id: 'p2',
        name: 'Guest',
        kind: 'player',
        seatIndex: 1,
        isAI: false,
        connected: true,
        isHost: false,
        ready: false,
        avatarId: 'avatar-player',
      },
      {
        id: 's1',
        name: 'Watcher',
        kind: 'spectator',
        seatIndex: null,
        isAI: false,
        connected: true,
        isHost: false,
        ready: null,
        avatarId: 'avatar-spectator',
      },
    ],
  };
  const matchingSummary = {
    roomCode: waitingRoom.code,
    roomName: waitingRoom.name,
    status: 'waiting' as const,
    mode: 'human' as const,
    minHumanPlayers: 12,
    playerCount: 2,
    maxPlayers: waitingRoom.config.maxPlayers,
    onlinePlayers: 2,
    onlineCount: 2,
    readyCount: 0,
    spectatorCount: 1,
  };

  assert.equal(
    waitingRoomNeedsRefresh(waitingRoom, matchingSummary),
    false,
  );
  assert.equal(
    waitingRoomNeedsRefresh(waitingRoom, {
      ...matchingSummary,
      playerCount: 3,
      onlinePlayers: 3,
    }),
    true,
  );
  assert.equal(
    waitingRoomNeedsRefresh(waitingRoom, {
      ...matchingSummary,
      onlinePlayers: 1,
    }),
    true,
  );
  assert.equal(
    waitingRoomNeedsRefresh(waitingRoom, {
      ...matchingSummary,
      spectatorCount: 2,
    }),
    true,
  );
  assert.equal(waitingRoomNeedsRefresh(waitingRoom, undefined), true);
  assert.equal(
    waitingRoomNeedsRefresh(waitingRoom, {
      ...matchingSummary,
      status: 'playing',
    }),
    true,
  );

  const joinedProjection = projectWaitingRoomSummary(waitingRoom, {
    ...matchingSummary,
    playerCount: 2,
    onlinePlayers: 2,
  });
  assert.equal(
    joinedProjection.members.filter((member) => member.kind === 'player')
      .length,
    2,
  );
  assert.equal(
    joinedProjection.members.find(
      (member) => member.id === 'p2',
    )?.connected,
    true,
  );

  const disconnectedProjection = projectWaitingRoomSummary(
    joinedProjection,
    {
      ...matchingSummary,
      playerCount: 2,
      onlinePlayers: 1,
    },
  );
  assert.equal(
    disconnectedProjection.members.find(
      (member) => member.id === 'p2',
    )?.connected,
    true,
  );
});

test('matching event envelopes advance a monotonic cursor and deduplicate', () => {
  const viewer: ViewerContext = {
    kind: 'player',
    playerId: 'p1',
    role: 'villager',
  };
  const first = domainEvent(1, 'game.started');
  const second = domainEvent(2, 'day.started');
  const envelope: GameEventsMessage = {
    type: 'game.events',
    roomId: 'room-1',
    gameId: 'game-1',
    afterSequence: 0,
    events: [first, second, second],
  };
  const merged = mergeEventEnvelope(
    {
      roomId: 'room-1',
      gameId: 'game-1',
      lastSeenSeq: 0,
      events: [],
    },
    envelope,
    viewer,
  );

  assert.equal(merged.accepted, true);
  assert.equal(merged.lastSeenSeq, 2);
  assert.deepEqual(
    merged.events.map((event) => event.sequence),
    [1, 2],
  );
});

test('cross-room, cross-game, and sensitive envelopes are isolated', () => {
  const viewer: ViewerContext = {
    kind: 'spectator',
    spectatorId: 's1',
    omniscient: false,
  };
  const state = {
    roomId: 'room-1',
    gameId: 'game-1',
    lastSeenSeq: 5,
    events: [],
  };
  const variants: GameEventsMessage[] = [
    {
      type: 'game.events',
      roomId: 'room-2',
      gameId: 'game-1',
      afterSequence: 6,
      events: [],
    },
    {
      type: 'game.events',
      roomId: 'room-1',
      gameId: 'game-2',
      afterSequence: 6,
      events: [],
    },
    {
      type: 'game.events',
      roomId: 'room-1',
      gameId: 'game-1',
      afterSequence: 6,
      events: [
        domainEvent(6, 'day.started', 'public_timeline', {
          resumeToken: 'leak',
        }),
      ],
    },
  ];

  for (const envelope of variants) {
    assert.equal(
      mergeEventEnvelope(state, envelope, viewer).accepted,
      false,
    );
  }
});

test('out-of-order automatic-turn pushes retain newer public content', () => {
  const state = {
    roomId: 'room-1',
    gameId: 'game-1',
    lastSeenSeq: 5,
    events: [],
  };
  const result = mergeEventEnvelope(
    state,
    {
      type: 'game.events',
      roomId: 'room-1',
      gameId: 'game-1',
      // This envelope started from an older socket cursor, but carries newer
      // committed events from the same authoritative stream.
      afterSequence: 4,
      events: [
        domainEvent(6, 'day.speech', 'public_timeline', {
          actorId: 'p1',
          content: '白天公开发言内容',
        }),
        domainEvent(7, 'night.resolved', 'public_timeline', {
          deaths: ['p2'],
          peacefulNight: false,
        }),
      ],
    },
    { kind: 'spectator', spectatorId: 's1', omniscient: false },
  );

  assert.equal(result.accepted, true);
  assert.deepEqual(result.events.map((event) => event.sequence), [6, 7]);
  assert.equal(result.events[0].payload.content, '白天公开发言内容');
  assert.deepEqual(result.events[1].payload.deaths, ['p2']);
  assert.equal(result.lastSeenSeq, 7);
});

test('public spectator snapshots expose roles but not private data', () => {
  const viewer: ViewerContext = {
    kind: 'spectator',
    spectatorId: 's1',
    omniscient: false,
  };
  const safe = publicSpectatorSnapshot({
    players: [player('p1', 'wolf', 1), player('p2', 'seer', 2)],
  });
  const privateState = publicSpectatorSnapshot({
    gameState: gameState({
      wolfVotes: { wolf: 'p2' },
    }),
  });
  const envelope: GameEventsMessage = {
    type: 'game.events',
    roomId: 'room-1',
    gameId: 'game-1',
    afterSequence: 3,
    events: [
      domainEvent(1, 'day.started'),
      domainEvent(
        2,
        'wolf.message',
        'wolf_private',
        { content: 'private' },
        ['wolf-1'],
      ),
      domainEvent(3, 'seer.result', 'role_private', {}, ['seer-1']),
    ],
  };
  const merged = mergeEventEnvelope(
    {
      roomId: 'room-1',
      gameId: 'game-1',
      lastSeenSeq: 0,
      events: [],
    },
    envelope,
    viewer,
  );

  assert.equal(isSnapshotSafeForViewer(safe), true);
  assert.equal(isSnapshotSafeForViewer(privateState), false);
  assert.deepEqual(
    merged.events.map((event) => event.eventType),
    ['day.started'],
  );
});

test('seer result visibility requires the seer role as well as its audience id', () => {
  const seerEvent: DomainEvent = domainEvent(
    4,
    'seer.result',
    'role_private',
    { targetId: 'p2', alignment: 'wolf' },
    ['p1', 'p2'],
  );
  const envelope: GameEventsMessage = {
    type: 'game.events',
    roomId: 'room-1',
    gameId: 'game-1',
    afterSequence: 0,
    events: [seerEvent],
  };

  assert.equal(
    mergeEventEnvelope(
      { roomId: 'room-1', gameId: 'game-1', lastSeenSeq: 0, events: [] },
      envelope,
      { kind: 'player', playerId: 'p1', role: 'seer' },
    ).events.length,
    1,
  );
  assert.equal(
    mergeEventEnvelope(
      { roomId: 'room-1', gameId: 'game-1', lastSeenSeq: 0, events: [] },
      envelope,
      { kind: 'player', playerId: 'p2', role: 'villager' },
    ).events.length,
    0,
  );
});

test('all shared allowed actions render in stable order and build commands', () => {
  assert.deepEqual(orderedAllowedActions([...GAME_ACTIONS].reverse()), [
    ...GAME_ACTIONS,
  ]);

  const commands = new Map<GameAction, ReturnType<typeof buildGameCommand>>();
  for (const action of GAME_ACTIONS) {
    commands.set(
      action,
      buildGameCommand({
        actorId: 'p1',
        actorRole:
          action === 'skip_night' ? 'guardian' : 'villager',
        action,
        allowedActions: [...GAME_ACTIONS],
        targetId:
          action === 'wolf_vote' ? null : action === 'heal' ? 'p2' : 'p3',
        content: 'authoritative message',
      }),
    );
  }

  assert.equal(commands.size, GAME_ACTIONS.length);
  assert.ok([...commands.values()].every((command) => command !== null));
  assert.equal(commands.get('abstain')?.type, 'game.vote');
  assert.equal(
    commands.get('skip_hunter_shot')?.type,
    'game.hunter_shoot',
  );
});

test('target matrix follows action rules and current-stage event boundaries', () => {
  const viewer: ViewerContext = {
    kind: 'player',
    playerId: 'p1',
    role: 'guardian',
  };
  const current = snapshot(viewer, {
    gameState: gameState({
      guardianLastTarget: 'p2',
      allowedActions: ['vote', 'abstain'],
    }),
  });
  assert.deepEqual(
    eligibleTargets('guard', current, []).map((item) => item.id),
    ['p1', 'p3'],
  );
  assert.deepEqual(
    eligibleTargets('check', current, []).map((item) => item.id),
    ['p2', 'p3'],
  );
  assert.deepEqual(
    eligibleTargets('wolf_vote', current, []).map((item) => item.id),
    ['p1', 'p2', 'p3'],
  );

  const voteEvents = [
    domainEvent(
      3,
      'day.revote_required',
      'public_timeline',
      { candidates: ['p2'] },
    ),
    domainEvent(4, 'day.voting_started'),
  ];
  assert.deepEqual(
    eligibleTargets('vote', current, voteEvents).map((item) => item.id),
    ['p2', 'p3'],
  );

  const witchEvents = [
    domainEvent(
      5,
      'witch.kill_notice',
      'role_private',
      { killTargetId: 'p2' },
      ['p1'],
    ),
    domainEvent(6, 'night.started'),
  ];
  assert.equal(healTargetId(witchEvents), null);
  assert.equal(
    healTargetId([
      domainEvent(6, 'night.started'),
      domainEvent(
        7,
        'witch.kill_notice',
        'role_private',
        { killTargetId: 'p2' },
        ['p1'],
      ),
    ]),
    'p2',
  );
});

test('day 2 ordinary vote rebuilds living targets after a day 1 revote', () => {
  const viewer: ViewerContext = {
    kind: 'player',
    playerId: 'p1',
    role: 'villager',
  };
  const players = Array.from({ length: 10 }, (_, index) =>
    player(`p${index + 1}`, index === 0 ? 'villager' : null, index + 1),
  );
  const dayTwoVote = snapshot(viewer, {
    gameState: gameState({
      phase: 'voting',
      day: 2,
      stageRevision: 22,
      allowedActions: ['vote', 'abstain'],
    }),
    players,
    lastSequence: 50,
  });
  const accumulatedEvents = [
    domainEvent(10, 'day.started', 'public_timeline', { day: 1 }),
    domainEvent(20, 'day.voting_started', 'public_timeline', { round: 1 }),
    domainEvent(
      30,
      'day.revote_required',
      'public_timeline',
      { candidates: ['p9'] },
    ),
    domainEvent(40, 'night.started', 'public_timeline', { day: 2 }),
    domainEvent(50, 'day.started', 'public_timeline', { day: 2 }),
  ];

  const projection = currentVoteRoundProjection(
    dayTwoVote,
    accumulatedEvents,
    ['vote', 'abstain'],
  );

  assert.equal(projection.kind, 'ordinary');
  assert.equal(projection.abstainAllowed, true);
  assert.deepEqual(
    projection.candidates.map((item) => item.id),
    ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'],
  );
});

test('current-day revote narrows candidates after the ordinary vote boundary', () => {
  const viewer: ViewerContext = {
    kind: 'player',
    playerId: 'p1',
    role: 'villager',
  };
  const currentRevote = snapshot(viewer, {
    gameState: gameState({
      phase: 'voting',
      day: 2,
      stageRevision: 23,
      allowedActions: ['vote'],
    }),
    players: [
      player('p1', 'villager', 1),
      player('p2', null, 2),
      player('p3', null, 3),
      player('p9', null, 9),
    ],
    lastSequence: 60,
  });
  const events = [
    domainEvent(40, 'night.started', 'public_timeline', { day: 2 }),
    domainEvent(50, 'day.started', 'public_timeline', { day: 2 }),
    domainEvent(55, 'day.voting_started', 'public_timeline', { round: 1 }),
    domainEvent(
      60,
      'day.revote_required',
      'public_timeline',
      { candidates: ['p3', 'p9'] },
    ),
  ];

  const projection = currentVoteRoundProjection(
    currentRevote,
    events,
    ['vote'],
  );

  assert.equal(projection.kind, 'revote');
  assert.equal(projection.abstainAllowed, false);
  assert.deepEqual(
    projection.candidates.map((item) => item.id),
    ['p3', 'p9'],
  );
});
