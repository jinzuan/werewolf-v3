import {
  ROOM_STATUSES,
  type RoomConfigView,
  type RoomMemberViewV31,
  type RoomAIConfigStatus,
  type RoomSeatRequestView,
  type RoomViewV31,
  type RoomViewerViewV31,
} from '../../shared/roomContract';
import type { RoomView } from '../../shared/protocol';
import { migrateRoomRecord } from './roomMigration';
import { RoomPolicy, roomCounts, type RoomPolicyOptions } from './roomPolicy';
import type { RoomMember, RoomRecord, SocketIdentity } from './types';

export type RoomProjectorActor =
  | string
  | SocketIdentity
  | RoomViewerViewV31;

export class RoomProjectionError extends Error {
  constructor(
    public readonly code:
      | 'UNAUTHENTICATED'
      | 'IDENTITY_MISMATCH'
      | 'ROOM_MISMATCH'
      | 'INVALID_ROOM_CONFIG',
    message = code,
  ) {
    super(message);
    this.name = 'RoomProjectionError';
  }
}

const actorIdOf = (actor: RoomProjectorActor): string =>
  typeof actor === 'string' ? actor : actor.actorId;

const isSocketIdentity = (actor: RoomProjectorActor): actor is SocketIdentity =>
  typeof actor !== 'string' &&
  'roomId' in actor &&
  'roomCode' in actor &&
  'resumeToken' in actor;

const memberFor = (room: RoomRecord, actor: RoomProjectorActor): RoomMember => {
  const member = room.members.find((candidate) => candidate.id === actorIdOf(actor));
  if (!member) throw new RoomProjectionError('UNAUTHENTICATED');
  return member;
};

const assertViewerClaims = (
  actor: RoomProjectorActor,
  member: RoomMember,
): void => {
  if (
    typeof actor !== 'string' &&
    !isSocketIdentity(actor) &&
    (actor.kind !== member.kind ||
      Boolean(actor.omniscient) !== Boolean(member.omniscient))
  ) {
    throw new RoomProjectionError('IDENTITY_MISMATCH');
  }
};

/**
 * Authenticate the complete socket identity at the projection boundary.
 * In particular, an identity cannot claim omniscient access independently of
 * the private member record (FINDINGS #19).
 */
export const assertIdentityRoom = (
  identity: SocketIdentity,
  room: RoomRecord,
): RoomMember => {
  if (
    identity.roomId !== room.id ||
    identity.roomCode.toUpperCase() !== room.code.toUpperCase()
  ) {
    throw new RoomProjectionError('ROOM_MISMATCH');
  }
  const member = room.members.find(
    (candidate) => candidate.id === identity.actorId,
  );
  if (!member || member.resumeToken !== identity.resumeToken) {
    throw new RoomProjectionError('UNAUTHENTICATED');
  }
  if (
    member.kind !== identity.kind ||
    Boolean(member.omniscient) !== Boolean(identity.omniscient)
  ) {
    throw new RoomProjectionError('IDENTITY_MISMATCH');
  }
  return member;
};

const roleSetupOf = (config: NonNullable<RoomRecord['config']>): RoomConfigView['roleSetup'] => ({
  wolf: Number(config.roleSetup?.wolf ?? 0),
  seer: Number(config.roleSetup?.seer ?? 0),
  witch: Number(config.roleSetup?.witch ?? 0),
  hunter: Number(config.roleSetup?.hunter ?? 0),
  guardian: Number(config.roleSetup?.guardian ?? 0),
  villager: Number(config.roleSetup?.villager ?? 0),
});

/** Select the public config fields; arbitrary private record extensions stay private. */
const projectConfig = (room: RoomRecord): RoomConfigView => {
  const config = room.config;
  if (!config) throw new RoomProjectionError('INVALID_ROOM_CONFIG');
  if (!ROOM_STATUSES.includes(room.status as (typeof ROOM_STATUSES)[number])) {
    throw new RoomProjectionError('INVALID_ROOM_CONFIG');
  }
  return {
    catalogVersion: String(config.catalogVersion ?? ''),
    mode: config.mode,
    visibility: config.visibility,
    maxPlayers: config.maxPlayers,
    minHumanPlayers: config.minHumanPlayers,
    computerSeats: config.computerSeats,
    aiFillPolicy: config.aiFillPolicy,
    roleSetup: roleSetupOf(config),
    ...(typeof config.rolePresetId === 'string'
      ? { rolePresetId: config.rolePresetId }
      : {}),
    rulesetId: config.rulesetId,
    rulesetVersion: config.rulesetVersion,
    readyPolicy: config.readyPolicy,
    allowPublicSpectators: Boolean(config.allowPublicSpectators),
    reviewEnabled: Boolean(config.reviewEnabled),
    ...(config.reviewMode === 'ai' ? { reviewMode: 'ai' as const } : {}),
  };
};

const projectMember = (
  room: RoomRecord,
  member: RoomMember,
  isConnected?: (roomCode: string, memberId: string) => boolean,
): RoomMemberViewV31 => {
  const isPlayer = member.kind === 'player';
  const isAI = isPlayer && Boolean(member.isAI);
  return {
    id: member.id,
    name: member.name,
    kind: member.kind,
    seatIndex: isPlayer && typeof member.seatIndex === 'number'
      ? member.seatIndex
      : null,
    isAI,
    isHost: member.id === room.hostId,
    connected: isConnected
      ? isConnected(room.code, member.id)
      : member.connected !== false,
    ready: isPlayer && !isAI && typeof member.ready === 'boolean'
      ? member.ready
      : null,
    avatarId: typeof member.avatarId === 'string' ? member.avatarId : '',
  };

};

const projectAIConfigStatus = (room: RoomRecord): RoomAIConfigStatus => {
  const config = room.config?.aiProviderConfig;
  if (!config) return 'not_configured';
  if (room.config?.credentialSchemaAmbiguous || room.config?.credentialRotationRequired) return 'invalid';
  const validShape =
    ['siliconflow', 'deepseek', 'local', 'custom'].includes(config.provider) &&
    typeof config.model === 'string' && config.model.trim().length > 0 &&
    typeof config.endpoint === 'string' && config.endpoint.trim().length > 0 &&
    Number.isFinite(config.temperature) &&
    Number.isSafeInteger(config.maxTokens) &&
    ['aggressive', 'conservative', 'random'].includes(config.behavior);
  if (!validShape) return 'invalid';
  if ((config.provider === 'siliconflow' || config.provider === 'deepseek') && !room.config?.credentialRef) {
    return 'invalid';
  }
  return 'ready';
};

const projectSeatRequests = (
  room: RoomRecord,
  actorId: string,
): RoomSeatRequestView[] | undefined => {
  const member = room.members.find((candidate) => candidate.id === actorId);
  if (!member) return undefined;
  const isHost = member.id === room.hostId;
  const visible = (room.seatRequests ?? []).filter(
    (request) => isHost || request.requesterId === actorId,
  );
  return visible.length > 0 ? visible.map((request) => ({ ...request })) : undefined;
};

export interface RoomProjectorOptions extends RoomPolicyOptions {
  policy?: RoomPolicy;
}

export class RoomProjector {
  readonly policy: RoomPolicy;

  constructor(options: RoomProjectorOptions = {}) {
    this.policy = options.policy ?? new RoomPolicy(options);
  }

  project(room: RoomRecord, actor: RoomProjectorActor): RoomViewV31 {
    const normalized = migrateRoomRecord(room);
    if (isSocketIdentity(actor)) {
      assertIdentityRoom(actor, normalized);
    }
    const member = memberFor(normalized, actor);
    assertViewerClaims(actor, member);
    const config = projectConfig(normalized);
    const gameId =
      ['starting', 'playing', 'ended'].includes(normalized.status)
        ? normalized.gameId ?? normalized.session?.state.gameId
        : undefined;
    return {
      id: normalized.id,
      code: normalized.code,
      name: normalized.name,
      roomRevision: normalized.roomRevision ?? 1,
      status: normalized.status,
      config,
      configRevision: normalized.configRevision ?? 1,
      configLocked: Boolean(normalized.configLocked),
      members: normalized.members.map((candidate) => projectMember(normalized, candidate, this.policy.options.isConnected)),
      counts: roomCounts(normalized, this.policy.options.isConnected),
      computerPlayerStatus: projectAIConfigStatus(normalized),
      startCheck: this.policy.evaluateStartCheck(normalized),
      ...(projectSeatRequests(normalized, member.id)
        ? { seatRequests: projectSeatRequests(normalized, member.id) }
        : {}),
      viewer: {
        actorId: member.id,
        kind: member.kind,
        omniscient: Boolean(member.omniscient),
        allowedRoomActions: this.policy.allowedRoomActions(normalized, member.id),
      },
      ...(gameId ? { gameId } : {}),
      createdAt: normalized.createdAt,
    };
  }

  projectRoom(room: RoomRecord, actor: RoomProjectorActor): RoomView {
    return this.project(room, actor);
  }

  /** Named seam for transports that validate an identity before projecting. */
  assertIdentityRoom(identity: SocketIdentity, room: RoomRecord): RoomMember {
    return assertIdentityRoom(identity, room);
  }
}

export const projectRoom = (
  room: RoomRecord,
  actor: RoomProjectorActor,
  options: RoomProjectorOptions = {},
): RoomView => new RoomProjector(options).project(room, actor);

export const projectRoomView = projectRoom;
