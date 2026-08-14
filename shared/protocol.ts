import type {
  GameAction,
  GameState,
  Message,
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

/**
 * protocol.ts — 联机模式（B批）socket.io 协议：客户端↔服务端共享的类型定义。
 * 服务端（server/engine.ts）通过 tsx 直接 import 本文件，客户端（src/net）也复用，
 * 保证两端对拍（snapshot 结构、action 结构）完全一致。
 */

export type ReviewStage = 'idle' | 'team-wolf' | 'team-good' | 'meeting' | 'done';

export interface ReviewState {
  enabled: boolean;
  stage: ReviewStage;
  messages: Message[];
  /** 同阵营复盘时当前进行中的阵营（meeting 时为空） */
  team: 'wolf' | 'good' | null;
  startedAt: number | null;
}

/** 服务端推送给单个客户端的个性化快照（身份视角已按观看者做掩码） */
export interface Snapshot {
  roomId: string;
  roomCode: string;
  roomName: string;
  hostId: string;
  isHost: boolean;
  isSpectator: boolean;
  /** 斗蛐蛐创建者（观战视角接管房间操作） */
  isCreator?: boolean;
  /** 进入令牌（仅房主/创建者视角下发，加入者凭码+令牌进房） */
  joinToken?: string;
  myRole: Role | null;
  gameState: GameState | null;
  players: Player[];
  spectators: Array<{ id: string; name: string }>;
  messages: Message[];
  wolfChatMessages: Message[];
  wolfVotes: Record<string, string>;
  wolfCurrentSpeaker: string | null;
  wolfSpeakerOrder: string[];
  wolfDiscussionRound: number;
  wolfVoteComplete: boolean;
  wolfDecisions: Record<string, { targetId: string; intention: string; reason: string }>;
  thinkingPlayers: Record<string, number>;
  dayDiscussionRound: number;
  dayVoteCount: number;
  tiePlayers: string[];
  tieDebateRound: number;
  isInTieDebate: boolean;
  /** 玩家连接在线状态（playerId -> 是否在线；离线标记挂机） */
  connected: Record<string, boolean>;
  review: ReviewState;
  /** 临时状态提示（如「等待玩家准备」） */
  notice: string | null;
  /** 服务端权威时钟（客户端用它 + deadlineTs 算 offset 渲染倒计时，雲鵺 A3.7） */
  serverTime: number;
  /**
   * 阶段 0d：当前限时阶段的绝对截止时间戳（毫秒）。null = 当前无倒计时。
   * 服务端权威裁决：deadline 到期只结算一次；逾期到达的 action 一律拒绝（客户端不能补投/补发言）。
   * 兼容：旧客户端忽略此字段仍按旧逻辑渲染（新增可选字段）。
   */
  deadlineTs?: number | null;
  /** 阶段 0d：调试模式（建房勾选；调试事件只 emit 给 isHost，普通玩家零字段） */
  debugMode?: boolean;
  /** 阶段 0d：服务端启动 epoch（时间戳）。客户端断线重连时对比，变了说明服务端重启过 */
  serverEpoch?: number;
}

/** 阶段 0d：调试快照（上帝视角全量，只 emit 给 isHost/有权限 socket） */
export interface DebugSnapshot {
  roomCode: string;
  hostId: string;
  isHost: boolean;
  debugMode: boolean;
  /** 全量玩家（含身份） */
  players: Array<{ id: string; name: string; role: Role | null; isAlive: boolean; isAI: boolean }>;
  /** 全量 gameState（未掩码） */
  gameState: GameState | null;
  messages: Message[];
  wolfChatMessages: Message[];
  thinkingPlayers: Record<string, number>;
  serverTime: number;
}

/** 阶段 0d：调试日志条目（分类 event/api/error + 级别，已脱敏） */
export interface DebugLogEntry {
  seq: number;
  ts: number;
  category: 'event' | 'api' | 'error';
  level: 'info' | 'warning' | 'error';
  text: string;
}

/** 客户端 → 服务端 指令 */
export type ClientAction =
  | { t: 'ready' }
  | { t: 'start-game' }
  | { t: 'confirm-roles' }
  | { t: 'redraw-role'; playerId: string }
  | { t: 'force-assign-role'; playerId: string; role: Role }
  | { t: 'reassign-all' }
  | { t: 'speak'; content: string }
  | { t: 'skip-speech' }
  | { t: 'start-vote' }
  | { t: 'vote'; targetId: string; reason: string }
  | { t: 'wolf-speak'; content: string }
  | { t: 'wolf-vote'; targetId: string }
  | { t: 'wolf-execute-kill'; targetId: string }
  | { t: 'wolf-next-speaker' }
  | { t: 'night-action'; action: 'kill' | 'check' | 'heal' | 'poison' | 'guard'; targetId: string }
  | { t: 'skip-night' }
  | { t: 'hunter-shoot'; targetId: string }
  | { t: 'review-speak'; content: string }
  | { t: 'restart' }
  | { t: 'abort' }
  | { t: 'kick-player'; playerId: string }
  | { t: 'set-review'; enabled: boolean }
  | { t: 'destroy-room' }
  | { t: 'leave' }
  /** 阶段 0d：房主转移（原房主主动移交/离线顺位由服务端裁决） */
  | { t: 'transfer-host'; targetPlayerId: string };

/** 复盘存档记录（可回看） */
export interface ArchiveRecord {
  id: string;
  roomId: string;
  roomName: string;
  roomCode: string;
  startedAt: string;
  endedAt: string;
  winner: 'wolf' | 'good' | null;
  day: number;
  playerCount: number;
  players: Array<{ name: string; role: Role | null; isAI: boolean }>;
  /** 死亡时间线 */
  deaths: Array<{ name: string; role: Role | null; day: number; reason: string }>;
  /** 复盘产出消息 */
  reviewMessages: Message[];
  /** 复盘归档的经验心得 */
  insights: Array<{ role: Role; text: string }>;
  kind: 'online' | 'auto'; // auto = 斗蛐蛐
}

/** 监控页使用的脱敏房间摘要。 */
export interface RoomSummary {
  roomCode: string;
  roomName: string;
  status: 'waiting' | 'playing' | 'ended';
  playerCount: number;
  maxPlayers: number;
  onlinePlayers: number;
  spectatorCount: number;
  auto: boolean;
  debugMode: boolean;
}

export type RoomMemberKind = 'player' | 'spectator';

export interface RoomMemberView {
  id: string;
  name: string;
  kind: RoomMemberKind;
  connected: boolean;
  isHost: boolean;
}

export interface RoomViewerView {
  actorId: string;
  kind: RoomMemberKind;
  omniscient: boolean;
  canStart: boolean;
  canSubmitGameCommands: boolean;
  allowedActions: GameAction[];
}

/** Public room projection. Credentials and authoritative session state are excluded. */
export interface RoomView {
  id: string;
  code: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  status: RoomSummary['status'];
  auto: boolean;
  debugMode: boolean;
  members: RoomMemberView[];
  viewer: RoomViewerView;
  gameId?: string;
  createdAt: number;
}

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
] as const;

export const PROTOCOL_ERROR_CODES = [
  ...STABLE_COMMAND_ERROR_CODES,
  'ACTOR_NOT_FOUND',
  'ACTOR_DEAD',
  'INVALID_COMMAND',
  'INVALID_GAME_META',
  'IDENTITY_ALREADY_BOUND',
  'IDENTITY_ALREADY_EXISTS',
  'ROOM_TOKEN_INVALID',
  'ROOM_FULL',
  'ROOM_NOT_FOUND',
  'HOST_REQUIRED',
  'GAME_ALREADY_STARTED',
  'GAME_NOT_STARTED',
  'MEMBER_NOT_FOUND',
  'ROLE_NOT_ASSIGNED',
  'COMMAND_NOT_IMPLEMENTED',
  'PUSH_FAILED',
  'UNKNOWN_ERROR',
] as const;

export type StableCommandErrorCode =
  (typeof STABLE_COMMAND_ERROR_CODES)[number];
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export interface ProtocolAckError {
  ok: false;
  code: ProtocolErrorCode;
  message?: string;
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
export type ResumeRoomAck = ProtocolAck<
  RoomAccess & { events?: DomainEvent[] }
>;
export type RoomViewAck = ProtocolAck<{ room: RoomView }>;
export type GameCommandAck = ProtocolAck<{ events: DomainEvent[] }>;
export type RoomListAck = ProtocolAck<{ rooms: RoomSummary[] }>;
export type SnapshotAck = ProtocolAck<{ snapshot: ProjectedSnapshot }>;

export interface RoomCreateOptions {
  roomName: string;
  maxPlayers: number;
  aiCount: number;
  name: string;
  spectator?: boolean;
  reviewEnabled?: boolean;
  /** 斗蛐蛐：纯 AI 房间，开房即自动开局 */
  auto?: boolean;
  /** 阶段 0d：调试模式（上帝视角 + 日志事件 gate 只给 isHost） */
  debugMode?: boolean;
}

export interface BaseCommandMeta {
  commandId: string;
  actorId: string;
  sentAt: number;
}

export interface RoomCommandMeta extends BaseCommandMeta {
  roomId?: string;
}

export interface GameCommandMeta extends BaseCommandMeta {
  roomId: string;
  gameId: string;
  expectedStageRevision: number;
}

export interface SpectatorCommandMeta extends BaseCommandMeta {
  roomId: string;
}

export type RoomCommand =
  | { type: 'room.create'; payload: RoomCreateOptions }
  | { type: 'room.join'; payload: { roomCode: string; joinToken?: string } }
  | { type: 'room.leave'; payload: Record<string, never> }
  | { type: 'room.ready'; payload: { ready: boolean } }
  | { type: 'room.start_game'; payload: Record<string, never> };

export type GameCommand =
  | { type: 'game.speak'; payload: { content: string } }
  | { type: 'game.skip_speech'; payload: Record<string, never> }
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
  | { meta: RoomCommandMeta; command: RoomCommand }
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

export interface RoomSnapshotMessage {
  type: 'room.snapshot';
  snapshot: Snapshot;
}

export interface GameSnapshotMessage {
  type: 'game.snapshot';
  snapshot: ProjectedSnapshot;
}

export interface GameEventsMessage {
  type: 'game.events';
  roomId: string;
  gameId: string;
  afterSequence: number;
  events: DomainEvent[];
}

export interface SpectatorViewMessage {
  type: 'spectator.view';
  viewer: Extract<ViewerContext, { kind: 'spectator' }>;
  visibility: EventVisibility;
  snapshot: ProjectedSnapshot;
}

export type V3ServerMessage =
  | RoomSnapshotMessage
  | GameSnapshotMessage
  | GameEventsMessage
  | SpectatorViewMessage;

/**
 * 协议兼容性：新增字段均为可选；旧客户端忽略 deadlineTs/debugMode/serverEpoch，
 * 新客户端可继续消费旧快照。debug:* 为独立事件，不混入普通 snapshot。
 */
