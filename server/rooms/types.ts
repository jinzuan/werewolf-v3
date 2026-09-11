import type {
  CommandReceipt,
  CreateRoomOptionsV31,
  IdentityCredentials,
  RoomAccess,
  RoomView,
} from '../../shared/protocol';
import type { RoomAIProviderConfig, RoomReviewMode, RoomSeatRequestStatus } from '../../shared/roomContract';
import type { Player, Role } from '../../shared/types';
import type { SessionSnapshot } from '../session/types';
import type { RuntimeEnvironment } from '../runtimeConfig';

/**
 * The first persisted V3.1 shape.  Keep this value in the private room layer:
 * it is a storage schema version, not a public protocol version.
 */
export const ROOM_RECORD_SCHEMA_VERSION = 1;
export const CURRENT_ROOM_SCHEMA_VERSION = ROOM_RECORD_SCHEMA_VERSION;

export type RoomStatus =
  | 'waiting'
  | 'ready_check'
  | 'starting'
  | 'playing'
  | 'ended';

export type RoomMode = 'human' | 'mixed' | 'quick_computer';
export type AIFillPolicy = 'none' | 'fixed' | 'fill_to_max';

export type RoleSetup = Record<Role, number>;

export interface RoomConfigRecord {
  mode: RoomMode;
  visibility: 'invite_only' | 'listed';
  maxPlayers: number;
  minHumanPlayers: number;
  aiFillPolicy: AIFillPolicy;
  computerSeats: number;
  roleSetup: RoleSetup;
  rolePresetId?: string;
  rulesetId: string;
  rulesetVersion: string;
  catalogVersion: string;
  readyPolicy: 'all_connected_humans';
  allowPublicSpectators: boolean;
  /** Old waiting rooms cannot always prove which RuleSet created them. */
  rulesetAvailable?: boolean;
  /** Useful to policy/diagnostic code without exposing storage provenance. */
  migratedFrom?: number;
  reviewEnabled?: boolean;
  reviewMode?: RoomReviewMode;
  /** Non-sensitive provider tuning; credential values live in SecretStore. */
  aiProviderConfig?: RoomAIProviderConfig;
  /** Random reference into the room-scoped SecretStore. */
  credentialRef?: string;
  /** Legacy migration could not prove which bearer value was intended. */
  credentialSchemaAmbiguous?: boolean;
  /** A legacy plaintext copy existed; the owner must rotate before AI calls resume. */
  credentialRotationRequired?: boolean;
  [key: string]: unknown;
}

export interface RoomMember {
  id: string;
  name: string;
  kind: 'player' | 'spectator';
  /** @deprecated Online state is projected from ConnectionRegistry. */
  connected?: boolean;
  omniscient: boolean;
  resumeToken: string;
  /** V3.1 seat data. Spectators have no seat. */
  seatIndex?: number | null;
  isAI?: boolean;
  ready?: boolean | null;
  avatarId?: string;
}

export interface RoomSeatRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  status: RoomSeatRequestStatus;
  createdAt: number;
}

export interface RoomCommandIdempotency {
  commandId: string;
  roomRevision: number;
  createdAt: number;
  /** A cached command outcome is intentionally opaque to this storage layer. */
  result?: unknown;
  response?: unknown;
}

export type IdempotencyRecord = RoomCommandIdempotency;

/** Durable claim for a pre-auth join, so an ACK loss cannot create a second member. */
export interface RoomJoinClaim {
  joinRequestId: string;
  actorId: string;
  fingerprint: string;
  resumeToken: string;
  createdAt: number;
}

export interface RoomStartFailure {
  code: string;
  messageKey?: string;
  affectedMemberIds?: string[];
  occurredAt: number;
  details?: Record<string, unknown>;
}

/**
 * RoomRecord is private persistence data.  New fields are optional at the
 * boundary so old callers can still be compiled during the M0-M5 migration;
 * every repository read/write returns the normalized V3.1 shape at runtime.
 */
export interface RoomRecord {
  id: string;
  code: string;
  name: string;
  joinToken: string;
  omniscientToken: string;
  hostId: string;
  maxPlayers: number;
  /** Runtime values include ready_check/starting; kept broad for legacy DTOs. */
  status: RoomStatus;
  auto: boolean;
  debugMode: boolean;
  members: RoomMember[];
  seatRequests?: RoomSeatRequest[];

  /**
   * Legacy GameSession storage.  During the M2-only migration this remains so
   * the existing service can restore active games; waiting-room truth is the
   * member/seat data above.
   */
  players: Player[];
  session?: SessionSnapshot;

  schemaVersion?: number;
  roomRevision?: number;
  /** Repository-owned revision of members/seats, independent of leases. */
  rosterRevision?: number;
  configRevision?: number;
  configLocked?: boolean;
  config?: RoomConfigRecord;
  gameId?: string;
  recentRoomCommands?: IdempotencyRecord[];
  /** Compact room mutation receipts retained for command reconciliation. */
  commandReceipts?: CommandReceipt[];
  /** Bounded pre-auth join claims retained for transport retry idempotency. */
  joinClaims?: RoomJoinClaim[];
  /** Durable create claim. The request id is never generated again on retry. */
  createRequestId?: string;
  createActorId?: string;
  createFingerprint?: string;
  /** Durable start transaction lease used to recover a crashed starter. */
  startOwner?: string;
  startLeaseUntil?: number;
  startedAt?: number;
  startAddedAIIds?: string[];
  /** Frozen roster revision used by the start/session commit. */
  startRosterRevision?: number;
  lastStartFailure?: RoomStartFailure;
  closedAt?: number;
  closeReason?: 'dissolved';
  /** Storage provenance; records from another deployment are never listed. */
  environment?: RuntimeEnvironment;
  deploymentNamespace?: string;
  /** Activity/retention facts used by the repository lifecycle sweep. */
  lastActivityAt?: number;
  lastSeenAt?: number;
  expiresAt?: number;
  /** Terminal cleanup remains auditable until every side effect has settled. */
  lifecycleTombstone?: RoomLifecycleTombstone;
  createdAt: number;
  updatedAt?: number;
}

export interface RoomLifecycleTombstone {
  schemaVersion: number;
  environment: RuntimeEnvironment;
  deploymentNamespace: string;
  operationId: string;
  roomCode: string;
  roomId: string;
  kind: string;
  closedAt: number;
  credentialRef?: string;
}

export interface CreateRoomRequest {
  actorId: string;
  options: CreateRoomOptionsV31;
  createRequestId: string;
}

export interface JoinRoomRequest {
  actorId: string;
  name: string;
  avatarId?: string;
  roomCode: string;
  joinToken?: string;
  /** Stable across an ACK timeout/retry; never contains an invite secret. */
  joinRequestId?: string;
  spectator?: boolean;
  omniscientToken?: string;
}

export type { IdentityCredentials, RoomAccess, RoomView };

export interface SocketIdentity {
  actorId: string;
  roomCode: string;
  roomId: string;
  kind: RoomMember['kind'];
  omniscient: boolean;
  resumeToken: string;
  gameId?: string;
}
