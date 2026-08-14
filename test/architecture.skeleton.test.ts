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
  type JoinRoomAck,
  type RoomDTO,
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

test('命令元数据、公开房间 DTO、成员凭据与标准 ACK 形状固定', () => {
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
    hostId: 'p1',
    maxPlayers: 12,
    status: 'waiting',
    auto: false,
    debugMode: false,
    members: [{
      id: 'p1',
      name: '房主',
      kind: 'player',
      connected: true,
      isHost: true,
    }],
    viewer: {
      actorId: 'p1',
      kind: 'player',
      omniscient: false,
      canStart: true,
      canSubmitGameCommands: false,
      allowedActions: [],
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
        canStart: false,
      },
    },
    credentials: {
      resumeToken: 'second-member-resume-token',
    },
  };

  assert.equal(meta.commandId, 'cmd-1');
  assert.equal(meta.expectedStageRevision, 4);
  assert.equal(ack.credentials.resumeToken, 'member-resume-token');
  assert.notEqual(
    ack.credentials.resumeToken,
    joined.credentials.resumeToken,
  );
  assert.doesNotMatch(
    JSON.stringify(ack.room),
    /joinToken|omniscientToken|resumeToken|session|players|role/,
  );
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
