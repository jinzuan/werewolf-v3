import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NIGHT_STAGES,
  type GameState,
  type ProjectedAuthorityFields,
  type ProjectedGameState,
} from '../shared/types';
import {
  PROTOCOL_ERROR_CODES,
  STABLE_COMMAND_ERROR_CODES,
  type CreateRoomAck,
  type GameCommandMeta,
  type GameSnapshotMessage,
  type JoinRoomAck,
  type RoomCreationCatalogAck,
  type RoomDTO,
  type RoomMutationMeta,
  type RoomSnapshotMessage,
  type SkillTargetValidationRequest,
  type SkillTargetValidationResult,
} from '../shared/protocol';
import {
  DOMAIN_EVENT_SCHEMA_VERSION,
  DOMAIN_EVENT_TYPES,
  type DomainEvent,
  type EventProjector,
  type EventStore,
  type StoredEvent,
  type ViewerContext,
} from '../shared/events';
import {
  RULE_CODE_REFERENCES,
  RULE_KEYS,
} from '../shared/rulesetContract';

function projectEvent(
  event: DomainEvent,
  viewer: ViewerContext,
): DomainEvent | undefined {
  if (event.visibility === 'public_timeline') return event;
  if (viewer.kind === 'spectator' && viewer.omniscient) return event;
  if (event.visibility === 'spectator_omniscient') return undefined;
  if (
    event.visibility === 'wolf_private' &&
    viewer.kind === 'player' &&
    viewer.role === 'wolf'
  ) {
    return event;
  }
  if (
    event.visibility === 'role_private' &&
    viewer.kind === 'player' &&
    event.audienceIds?.includes(viewer.playerId)
  ) {
    return event;
  }
  return undefined;
}

test('夜间阶段契约固定为 guard/seer 到原子结算的五阶段', () => {
  assert.deepEqual(NIGHT_STAGES, [
    'guard_seer',
    'wolf_discussion',
    'wolf_vote',
    'witch',
    'resolve',
  ]);
});

test('GameState 暴露阶段修订与面向当前视角的权威投影字段', () => {
  const state = {
    nightStage: 'wolf_vote',
    stageRevision: 7,
    allowedActors: [{ playerId: 'w1', actions: ['wolf_vote'] }],
    allowedActions: ['wolf_vote'],
    deadlineTs: 1_786_620_030_000,
  } satisfies Pick<
    GameState,
    | 'nightStage'
    | 'stageRevision'
    | 'allowedActors'
    | 'allowedActions'
    | 'deadlineTs'
  >;
  const projection: ProjectedAuthorityFields = {
    allowedActors: state.allowedActors,
    allowedActions: state.allowedActions,
    deadlineTs: state.deadlineTs,
    stageStartedAt: 1_786_620_000_000,
  };
  const projectedState = state as ProjectedGameState;

  assert.equal(state.nightStage, 'wolf_vote');
  assert.deepEqual(projection.allowedActors[0], {
    playerId: 'w1',
    actions: ['wolf_vote'],
  });
  assert.equal(projection.deadlineTs, 1_786_620_030_000);
  assert.deepEqual(projectedState.allowedActions, ['wolf_vote']);
});

test('V3.1 房间目录、创建配置与版本化 RoomView 形状固定', () => {
  const roleSetup = {
    wolf: 4,
    seer: 1,
    witch: 1,
    hunter: 1,
    guardian: 1,
    villager: 4,
  } as const;
  const createOptions = {
    catalogVersion: 'catalog-v31-1',
    roomName: '契约房',
    creator: { name: '房主', avatarId: 'moon-1' },
    mode: 'human',
    visibility: 'invite_only',
    maxPlayers: 12,
    minHumanPlayers: 4,
    computerSeats: 0,
    aiFillPolicy: 'none',
    roleSetup,
    rolePresetId: 'werewolf.v3.default-12p',
    rulesetId: 'werewolf.v3',
    rulesetVersion: '3.1.0',
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    reviewEnabled: true,
  } as const;
  const catalog: RoomCreationCatalogAck = {
    ok: true,
    catalog: {
      catalogVersion: createOptions.catalogVersion,
      playerCounts: [12],
      rolePresets: [{
        id: 'werewolf.v3.default-12p',
        name: '标准十二人局',
        playerCount: 12,
        roleSetup: { ...roleSetup },
        rulesetId: createOptions.rulesetId,
        rulesetVersion: createOptions.rulesetVersion,
        enabled: true,
      }],
      roleLimits: {},
      limits: {
        roomNameMax: 32,
        displayNameMax: 16,
        maxSpectators: 8,
      },
    },
  };
  const mutation: RoomMutationMeta = {
    commandId: 'room-cmd-1',
    actorId: 'p1',
    roomId: 'room-1',
    expectedRoomRevision: 3,
    sentAt: 1_786_620_000_000,
  };
  const meta: GameCommandMeta = {
    commandId: 'cmd-1',
    roomId: 'room-1',
    gameId: 'game-1',
    actorId: 'p1',
    expectedStageRevision: 4,
    sentAt: 1_786_620_000_000,
  };
  const room: RoomDTO = {
    id: 'room-1',
    code: 'ABC123',
    name: '契约房',
    roomRevision: 3,
    status: 'waiting',
    config: {
      catalogVersion: createOptions.catalogVersion,
      mode: createOptions.mode,
      visibility: createOptions.visibility,
      maxPlayers: createOptions.maxPlayers,
      minHumanPlayers: createOptions.minHumanPlayers,
      computerSeats: createOptions.computerSeats,
      aiFillPolicy: createOptions.aiFillPolicy,
      roleSetup: { ...createOptions.roleSetup },
      rolePresetId: createOptions.rolePresetId,
      rulesetId: createOptions.rulesetId,
      rulesetVersion: createOptions.rulesetVersion,
      readyPolicy: createOptions.readyPolicy,
      allowPublicSpectators: createOptions.allowPublicSpectators,
      reviewEnabled: createOptions.reviewEnabled,
    },
    configRevision: 1,
    configLocked: false,
    members: [{
      id: 'p1',
      name: '房主',
      kind: 'player',
      seatIndex: 0,
      isAI: false,
      isHost: true,
      connected: true,
      ready: false,
      avatarId: 'moon-1',
    }],
    counts: {
      playerSeats: 12,
      humanPlayers: 1,
      onlineHumanPlayers: 1,
      readyHumanPlayers: 0,
      spectators: 0,
    },
    startCheck: {
      passed: false,
      items: [{
        key: 'minimum_humans',
        passed: false,
        messageKey: 'room.start.minimum_humans',
        params: { required: 4, actual: 1 },
        affectedMemberIds: ['p1'],
      }],
    },
    viewer: {
      actorId: 'p1',
      kind: 'player',
      omniscient: false,
      allowedRoomActions: ['update_config', 'begin_ready_check', 'leave'],
    },
    createdAt: 1_786_620_000_000,
  };
  const ack: CreateRoomAck = {
    ok: true,
    room,
    credentials: {
      resumeToken: 'member-resume-token',
      joinToken: 'invite-token',
    },
  };
  const joined: JoinRoomAck = {
    ok: true,
    room: {
      ...room,
      viewer: {
        ...room.viewer,
        actorId: 'p2',
      },
    },
    credentials: {
      resumeToken: 'second-member-resume-token',
    },
  };

  assert.equal(catalog.ok, true);
  assert.equal(createOptions.roleSetup.wolf, 4);
  assert.equal(mutation.expectedRoomRevision, 3);
  assert.equal(meta.commandId, 'cmd-1');
  assert.equal(meta.expectedStageRevision, 4);
  assert.equal(ack.credentials.resumeToken, 'member-resume-token');
  assert.notEqual(
    ack.credentials.resumeToken,
    joined.credentials.resumeToken,
  );
  assert.doesNotMatch(
    JSON.stringify(ack.room),
    /joinToken|omniscientToken|resumeToken|session|players/,
  );
  assert.equal('canStart' in ack.room.viewer, false);
  assert.equal('allowedRoomActions' in ack.room.viewer, true);
  assert.deepEqual(STABLE_COMMAND_ERROR_CODES, [
    'UNAUTHENTICATED',
    'IDENTITY_MISMATCH',
    'ROOM_MISMATCH',
    'GAME_MISMATCH',
    'SPECTATOR_READ_ONLY',
    'DUPLICATE_COMMAND',
    'STALE_STAGE_REVISION',
    'EXPIRED_COMMAND',
    'ACTION_NOT_ALLOWED',
    'INVALID_TARGET',
  ]);
  assert.ok(PROTOCOL_ERROR_CODES.includes('ROOM_TOKEN_INVALID'));
  assert.ok(PROTOCOL_ERROR_CODES.includes('ROOM_REVISION_CONFLICT'));
  assert.ok(PROTOCOL_ERROR_CODES.includes('ROLE_COUNT_MISMATCH'));

  const roomMessage: RoomSnapshotMessage = {
    type: 'room.snapshot',
    room,
    reason: 'created',
  };
  const gameMessage: GameSnapshotMessage = {
    type: 'game.snapshot',
    snapshot: {
      roomId: room.id,
      gameId: 'game-1',
      viewer: { kind: 'spectator', spectatorId: 's1', omniscient: false },
      gameState: {} as ProjectedGameState,
      players: [],
      serverTime: 1_786_620_000_000,
      lastSequence: 0,
    },
  };
  assert.equal(roomMessage.type, 'room.snapshot');
  assert.equal(gameMessage.type, 'game.snapshot');
  assert.ok('room' in roomMessage);
  assert.ok(!('snapshot' in roomMessage));
});

test('公共时间线事件对普通玩家与公开观战者可见', () => {
  const event: DomainEvent<'day.started'> = {
    eventId: 'e1',
    roomId: 'r1',
    gameId: 'g1',
    sequence: 1,
    occurredAt: 1,
    phase: 'day',
    stage: 'speech',
    actorId: undefined,
    eventType: 'day.started',
    payload: { roundNumber: 1 },
    visibility: 'public_timeline',
    correlationId: 'system:day-start',
    schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
  };

  assert.ok(DOMAIN_EVENT_TYPES.includes(event.eventType));
  assert.ok(Object.hasOwn(event, 'actorId'));
  assert.ok(projectEvent(event, { kind: 'player', playerId: 'p1', role: 'villager' }));
  assert.ok(projectEvent(event, {
    kind: 'spectator',
    spectatorId: 's1',
    omniscient: false,
  }));
});

test('角色私有事件只投影给指定玩家与全知观战', () => {
  const event: DomainEvent = {
    eventId: 'e2',
    roomId: 'r1',
    gameId: 'g1',
    sequence: 2,
    occurredAt: 2,
    phase: 'night',
    stage: 'guard_seer',
    actorId: 'seer-1',
    eventType: 'seer.result',
    payload: { targetId: 'p2', alignment: 'wolf' },
    visibility: 'role_private',
    audienceIds: ['seer-1'],
    correlationId: 'cmd-seer-1',
    schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
  };

  assert.equal(
    projectEvent(event, { kind: 'player', playerId: 'p1', role: 'villager' }),
    undefined,
  );
  assert.ok(projectEvent(event, {
    kind: 'player',
    playerId: 'seer-1',
    role: 'seer',
  }));
  assert.ok(projectEvent(event, {
    kind: 'spectator',
    spectatorId: 's1',
    omniscient: true,
  }));
});

test('狼人私有事件不进入普通玩家或公开观战载荷', () => {
  const event: DomainEvent = {
    eventId: 'e3',
    roomId: 'r1',
    gameId: 'g1',
    sequence: 3,
    occurredAt: 3,
    phase: 'night',
    stage: 'wolf_discussion',
    actorId: 'w1',
    eventType: 'wolf.message',
    payload: { text: '今晚重投' },
    visibility: 'wolf_private',
    correlationId: 'cmd-wolf-1',
    schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
  };

  assert.equal(
    projectEvent(event, { kind: 'player', playerId: 'p1', role: 'villager' }),
    undefined,
  );
  assert.equal(projectEvent(event, {
    kind: 'spectator',
    spectatorId: 's1',
    omniscient: false,
  }), undefined);
  assert.ok(projectEvent(event, {
    kind: 'player',
    playerId: 'w1',
    role: 'wolf',
  }));
});

test('事件存储、投影器与技能目标校验接口可由适配器实现', () => {
  const store: EventStore = {
    async append() {
      return [];
    },
    async read() {
      return [];
    },
  };
  const storedEvents: StoredEvent[] = [];
  const projector: Pick<EventProjector, 'projectEvent'> = { projectEvent };
  const request = {
    actorId: 'witch-1',
    action: 'heal',
    targetId: 'witch-1',
  } as SkillTargetValidationRequest;
  const result: SkillTargetValidationResult = {
    valid: true,
    code: 'VALID',
    normalizedTargetId: request.targetId,
  };

  assert.equal(typeof store.append, 'function');
  assert.deepEqual(storedEvents, []);
  assert.ok(projector.projectEvent);
  assert.equal(result.normalizedTargetId, 'witch-1');
});

test('10 条金钻规则键均有唯一代码引用', () => {
  const keys = Object.values(RULE_KEYS);
  const references = Object.values(RULE_CODE_REFERENCES);

  assert.equal(keys.length, 10);
  assert.equal(new Set(keys).size, 10);
  assert.equal(references.length, 10);
  assert.equal(new Set(references).size, 10);
  assert.deepEqual(Object.keys(RULE_CODE_REFERENCES).sort(), [...keys].sort());
});
