import type {
  CreateRoomOptionsV31,
  IdentityCredentials,
  RoomAccess,
  RoomView,
} from '../../shared/protocol';
import type { RoomAIProviderConfig } from '../../shared/roomContract';
import type { Player, Role } from '../../shared/types';
import type { SessionSnapshot } from '../session/types';

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
  /** Non-sensitive provider tuning; credential values live in SecretStore. */
  aiProviderConfig?: RoomAIProviderConfig;
  /** Random reference into the room-scoped SecretStore. */
  credentialRef?: string;
  [key: string]: unknown;
}

export interface RoomMember {
  id: string;
  name: string;
  kind: 'player' | 'spectator';
  connected: boolean;
  omniscient: boolean;
  resumeToken: string;
  /** V3.1 seat data. Spectators have no seat. */
  seatIndex?: number | null;
  isAI?: boolean;
  ready?: boolean | null;
  avatarId?: string;
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

  /**
   * Legacy GameSession storage.  During the M2-only migration this remains so
   * the existing service can restore active games; waiting-room truth is the
   * member/seat data above.
   */
  players: Player[];
  session?: SessionSnapshot;

  schemaVersion?: number;
  roomRevision?: number;
  configRevision?: number;
  configLocked?: boolean;
  config?: RoomConfigRecord;
  gameId?: string;
  recentRoomCommands?: IdempotencyRecord[];
  /** Durable create claim. The request id is never generated again on retry. */
  createRequestId?: string;
  createActorId?: string;
  createFingerprint?: string;
  /** Durable start transaction lease used to recover a crashed starter. */
  startOwner?: string;
  startLeaseUntil?: number;
  startedAt?: number;
  startAddedAIIds?: string[];
  lastStartFailure?: RoomStartFailure;
  closedAt?: number;
  closeReason?: 'dissolved';
  createdAt: number;
  updatedAt?: number;
}

export interface CreateRoomRequest {
  actorId: string;
  options: CreateRoomOptionsV31;
  createRequestId?: string;
}

export interface JoinRoomRequest {
  actorId: string;
  name: string;
  avatarId?: string;
  roomCode: string;
  joinToken?: string;
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

/**
 * Legacy export kept until the M4 starter switches to persisted roleSetup.
 * It is not used by the M2 repository or migration code.
 */
export const ROLE_DECK: readonly Role[] = [
  'wolf',
  'wolf',
  'wolf',
  'wolf',
  'seer',
  'witch',
  'hunter',
  'guardian',
  'villager',
  'villager',
  'villager',
  'villager',
];
