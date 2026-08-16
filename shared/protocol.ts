import type {
  GameAction,
  GameState,
  NightAction,
  Player,
  Role,
} from './types';
import type {
  DomainEvent,
  EventVisibility,
  ProjectedSnapshot,
  ViewerContext,
} from './events';
import type {
  RoomCommand as RoomCommandV31,
  RoomConfigIssue,
  RoomSnapshotMessage as RoomSnapshotMessageV31,
  RoomSummaryV31,
  RoomViewV31,
  RoomMutationCommand,
  RoomReadCommand,
} from './roomContract';
import type { RoomAIConfigSummary } from './aiRoomConfigContract';
import type { PostGameReviewView } from './reviewContract';
export type {
  PostGameReviewView,
  ReviewEvidenceRef,
  ReviewInsight,
  ReviewJobStatus,
  ReviewMessage,
} from './reviewContract';

export * from './roomContract';

/**
 * protocol.ts — 联机模式（B批）socket.io 协议：客户端↔服务端共享的类型定义。
 * 服务端和客户端共同复用本文件，保证 V3 两端的命令与投影契约一致。
 */

export type {
  AllowedRoomAction,
  AIFillPolicy,
  CreateRoomOptionsV31,
  ReadyPolicy,
  RoleSetup,
  RoomConfigView,
  RoomMemberKind,
  RoomMemberViewV31,
  RoomMode,
  RoomSnapshotReason,
  RoomStatus,
  RoomSummaryV31,
  RoomViewV31,
  RoomViewerViewV31,
} from './roomContract';

export type RoomSummary = RoomSummaryV31;
export type RoomMemberView = import('./roomContract').RoomMemberViewV31;
export type RoomViewerView = import('./roomContract').RoomViewerViewV31;

export const ROOM_LIST_DEFAULT_LIMIT = 50;
export const ROOM_LIST_MAX_LIMIT = 100;

export interface RoomListQuery {
  /** Opaque cursor returned by the previous page. */
  cursor?: string;
  limit?: number;
}

export interface RoomListPage {
  rooms: RoomSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export const EVENT_HISTORY_DEFAULT_LIMIT = 100;
export const EVENT_HISTORY_MAX_LIMIT = 200;

export interface EventHistoryQuery {
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
}

export interface EventHistoryPage {
  afterSequence: number;
  beforeSequence?: number;
  events: DomainEvent[];
  limit: number;
  hasMore: boolean;
  nextAfterSequence: number | null;
  nextBeforeSequence: number | null;
}

/** Public room projection. Credentials and authoritative session state are excluded. */
export type RoomView = RoomViewV31;

/** Transport-facing alias for consumers that call public projections DTOs. */
export type RoomDTO = RoomView;

/** Credentials belong to the current member and must never be embedded in RoomView. */
export interface IdentityCredentials {
  resumeToken: string;
  joinToken?: string;
  omniscientToken?: string;
}

export interface RoomAccess {
  room: RoomView;
  credentials: IdentityCredentials;
}

/** Durable answer for a room mutation. The client derives unknown/not_sent
 * from transport evidence; the server persists committed/rejected only. */
export type CommandReceiptStatus = 'committed' | 'rejected';
export type CommandOutcomeStatus =
  | CommandReceiptStatus
  | 'unknown'
  | 'not_sent';

export interface CommandReceipt {
  schemaVersion: 1;
  environment: string;
  deploymentNamespace: string;
  revision: number;
  commandId: string;
  commandType: string;
  actorId: string;
  roomId: string;
  roomCode: string;
  status: CommandReceiptStatus;
  createdAt: number;
  roomRevision?: number;
  errorCode?: ProtocolErrorCode;
  messageKey?: string;
  /** Small replay payloads only; never credentials or private room state. */
  result?: Record<string, unknown>;
}

export const STABLE_COMMAND_ERROR_CODES = [
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
  'CONTENT_TOO_LONG',
] as const;

export const PROTOCOL_ERROR_CODES = [
  ...STABLE_COMMAND_ERROR_CODES,
  'ACTOR_NOT_FOUND',
  'ACTOR_DEAD',
  'INVALID_COMMAND',
  'UNSUPPORTED_PROTOCOL_VERSION',
  'INVALID_GAME_META',
  'IDENTITY_ALREADY_BOUND',
  'IDENTITY_ALREADY_EXISTS',
  'ROOM_TOKEN_INVALID',
  'ROOM_JOIN_DENIED',
  'ROOM_FULL',
  'ROOM_NOT_FOUND',
  'HOST_REQUIRED',
  'GAME_ALREADY_STARTED',
  'GAME_NOT_STARTED',
  'MEMBER_NOT_FOUND',
  'ROLE_NOT_ASSIGNED',
  'COMMAND_NOT_IMPLEMENTED',
  'PUSH_FAILED',
  'ROOM_REVISION_CONFLICT',
  'INVALID_ROOM_CONFIG',
  'ROLE_COUNT_MISMATCH',
  'RULESET_UNAVAILABLE',
  'MIN_PLAYERS_NOT_MET',
  'HUMAN_PLAYERS_NOT_READY',
  'MEMBER_OFFLINE',
  'CONFIG_LOCKED',
  'GAME_START_IN_PROGRESS',
  'GAME_START_FAILED',
  'INVALID_ROLE_SETUP',
  'IDEMPOTENCY_KEY_REUSED',
  'AI_ENDPOINT_NOT_ALLOWED',
  'AI_PROVIDER_REQUIRED',
  'INSECURE_TRANSPORT',
  'SECRET_STORE_UNAVAILABLE',
  'CREDENTIAL_SCHEMA_AMBIGUOUS',
  'LEGACY_SECRET_DATA',
  'PERSISTENCE_UNAVAILABLE',
  'GAME_RESOURCE_LIMIT',
  'UNKNOWN_ERROR',
] as const;

export type StableCommandErrorCode =
  (typeof STABLE_COMMAND_ERROR_CODES)[number];
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export interface ProtocolAckError {
  ok: false;
  code: ProtocolErrorCode;
  /** Server-only diagnostic text; UI maps code/messageKey to Chinese copy. */
  message?: string;
  messageKey?: string;
  params?: Record<string, string | number>;
  issues?: RoomConfigIssue[];
  /** Present on ROOM_REVISION_CONFLICT so clients can converge immediately. */
  room?: RoomView;
  retryable?: boolean;
  retryAfterMs?: number;
  /** Present when the server durably recorded a rejected mutation. */
  receipt?: CommandReceipt;
  /** Present when the server durably recorded a rejected mutation. */
}

export type ProtocolAckSuccess<
  TPayload extends object = Record<string, never>,
> = { ok: true } & TPayload;

export type ProtocolAck<TPayload extends object = Record<string, never>> =
  | ProtocolAckSuccess<TPayload>
  | ProtocolAckError;

/** Create, join, and resume all return the same public room and member credentials. */
export type RoomAccessAck = ProtocolAck<RoomAccess>;
export type CreateRoomAck = RoomAccessAck;
export type JoinRoomAck = RoomAccessAck;
export type ResumeRoomAck = RoomAccessAck;
export type RoomCreationCatalogAck = ProtocolAck<{
  catalog: import('./roomContract').RoomCreationCatalog;
}>;
export type RoomViewAck = ProtocolAck<{ room: RoomView }>;
export type GameCommandAck = ProtocolAck<{ events: DomainEvent[] }>;
/** Initial/recovery event reads use the same projected stream as live pushes. */
export type GameEventsAck = ProtocolAck<{
  roomId: string;
  gameId: string;
  afterSequence: number;
  lastSequence: number;
  events: DomainEvent[];
  /** Optional paging metadata; older recovery responses remain valid. */
  beforeSequence?: number;
  limit?: number;
  hasMore?: boolean;
  nextAfterSequence?: number | null;
  nextBeforeSequence?: number | null;
}>;
export type RoomListAck = ProtocolAck<RoomListPage>;
export type SnapshotAck = ProtocolAck<{ snapshot: ProjectedSnapshot }>;
export type ReviewViewAck = ProtocolAck<{ review: PostGameReviewView }>;
export interface ReviewInsightSummary {
  id: string;
  role: Role;
  text: string;
  evidenceEventIds: string[];
  gameId: string;
  createdAt: number;
}
export type ReviewInsightsAck = ProtocolAck<{ insights: ReviewInsightSummary[] }>;
export type RoomAIConfigAck = ProtocolAck<{
  summary: RoomAIConfigSummary | null;
}>;
export type RoomAIConfigUpdateAck = ProtocolAck<{
  summary: RoomAIConfigSummary | null;
  roomRevision: number;
}>;
export type RoomMutationAck = ProtocolAck<{
  room?: RoomView;
  receipt: CommandReceipt;
  summary?: RoomAIConfigSummary | null;
  roomRevision?: number;
}>;
export type CommandReceiptAck = ProtocolAck<{
  receipt: CommandReceipt | null;
}>;

export type { RoomAIConfigPatch, RoomAIConfigSummary } from './aiRoomConfigContract';

export interface BaseCommandMeta {
  commandId: string;
  actorId: string;
  sentAt: number;
}

export interface RoomCommandMeta extends BaseCommandMeta {
  roomId?: string;
}

export interface RoomMutationMeta extends RoomCommandMeta {
  expectedRoomRevision: number;
}

export interface GameCommandMeta extends BaseCommandMeta {
  roomId: string;
  gameId: string;
  expectedStageRevision: number;
}

export interface SpectatorCommandMeta extends BaseCommandMeta {
  roomId: string;
}

export type RoomCommand = RoomCommandV31;

export type GameCommand =
  | { type: 'game.confirm_role'; payload: Record<string, never> }
  | { type: 'game.speak'; payload: { content: string } }
  /** Daytime skips may omit a reason; last-words skips are validated server-side as reason-required. */
  | { type: 'game.skip_speech'; payload: { reason?: string } }
  | { type: 'game.vote'; payload: { targetId: string | null; reason?: string } }
  | { type: 'game.wolf_speak'; payload: { content: string } }
  | { type: 'game.wolf_vote'; payload: { targetId: string | null } }
  | { type: 'game.night_action'; payload: NightAction }
  | { type: 'game.skip_night'; payload: { action: GameAction } }
  | { type: 'game.hunter_shoot'; payload: { targetId: string | null } };

export type SpectatorCommand =
  | {
      type: 'spectator.join';
      payload: { roomCode: string; omniscientToken?: string };
    }
  | {
      type: 'spectator.resume';
      payload: { roomCode: string; afterSequence: number };
    }
  | { type: 'spectator.leave'; payload: { roomCode: string } };

export type V3Command =
  | { meta: RoomCommandMeta; command: RoomReadCommand }
  | { meta: RoomMutationMeta; command: RoomMutationCommand }
  | { meta: GameCommandMeta; command: GameCommand }
  | { meta: SpectatorCommandMeta; command: SpectatorCommand };

export type SkillTargetValidationCode =
  | 'VALID'
  | 'ACTOR_NOT_FOUND'
  | 'ACTOR_DEAD'
  | 'ROLE_MISMATCH'
  | 'ACTION_NOT_ALLOWED'
  | 'TARGET_REQUIRED'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_DEAD'
  | 'SELF_TARGET_FORBIDDEN'
  | 'CONSECUTIVE_TARGET_FORBIDDEN'
  | 'POTION_UNAVAILABLE'
  | 'BOTH_POTIONS_SAME_NIGHT_FORBIDDEN';

export interface SkillTargetValidationRequest {
  state: GameState;
  players: readonly Player[];
  actorId: string;
  action: NightAction['action'];
  targetId: string | null;
}

export type SkillTargetValidationResult =
  | { valid: true; code: 'VALID'; normalizedTargetId: string | null }
  | {
      valid: false;
      code: Exclude<SkillTargetValidationCode, 'VALID'>;
      ruleKey?: string;
    };

export interface SkillTargetValidator {
  validate(
    request: SkillTargetValidationRequest,
  ): SkillTargetValidationResult;
}

export type RoomSnapshotMessage = RoomSnapshotMessageV31;

export interface GameSnapshotMessage {
  type: 'game.snapshot';
  snapshot: ProjectedSnapshot;
}

export interface GameEventsMessage {
  type: 'game.events';
  roomId: string;
  gameId: string;
  afterSequence: number;
  /** Latest authoritative stream cursor, including events hidden by projection. */
  lastSequence?: number;
  events: DomainEvent[];
  /** History page metadata. Older clients may ignore these optional fields. */
  beforeSequence?: number;
  limit?: number;
  hasMore?: boolean;
  nextAfterSequence?: number | null;
  nextBeforeSequence?: number | null;
}

export interface RoomClosedMessage {
  type: 'room.closed';
  roomCode: string;
  roomId: string;
  reason: 'dissolved';
  causeCommandId?: string;
}

export interface SpectatorViewMessage {
  type: 'spectator.view';
  viewer: Extract<ViewerContext, { kind: 'spectator' }>;
  visibility: EventVisibility;
  snapshot: ProjectedSnapshot;
}

export type V3ServerMessage =
  | RoomSnapshotMessage
  | RoomClosedMessage
  | GameSnapshotMessage
  | GameEventsMessage
  | SpectatorViewMessage;

/**
 * 协议兼容性：新增字段均为可选；旧客户端忽略 deadlineTs/debugMode/serverEpoch，
 * 新客户端可继续消费旧快照。debug:* 为独立事件，不混入普通 snapshot。
 */
