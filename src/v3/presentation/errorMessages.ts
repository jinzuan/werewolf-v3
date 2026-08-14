import type { ProtocolErrorCode } from '../../../shared/protocol';

/** Errors added by the V3.1 room contract before shared/ is migrated. */
export const V31_PROTOCOL_ERROR_CODES = [
  'ROOM_REVISION_CONFLICT',
  'INVALID_ROOM_CONFIG',
  'ROLE_COUNT_MISMATCH',
  'RULESET_UNAVAILABLE',
  'MIN_PLAYERS_NOT_MET',
  'HUMAN_PLAYERS_NOT_READY',
  'MEMBER_OFFLINE',
  'CONFIG_LOCKED',
  'GAME_START_IN_PROGRESS',
] as const;

export type V31ProtocolErrorCode = (typeof V31_PROTOCOL_ERROR_CODES)[number];
export type PresentationProtocolErrorCode =
  | ProtocolErrorCode
  | V31ProtocolErrorCode;

export type ErrorRecovery =
  | 'return_lobby'
  | 'recover_identity'
  | 'refresh_room'
  | 'refresh_game'
  | 'keep_view'
  | 'clear_target'
  | 'focus_join_token'
  | 'open_spectator'
  | 'open_waiting_room'
  | 'show_transition'
  | 'retry';

export interface ErrorPresentation {
  message: string;
  recovery: ErrorRecovery;
}

type LegacyProtocolErrorCode = Exclude<
  ProtocolErrorCode,
  V31ProtocolErrorCode
>;

const CORE_ERROR_MESSAGES = {
  UNAUTHENTICATED: '身份已失效，请重新加入房间。',
  IDENTITY_MISMATCH: '当前连接身份已变化，正在重新恢复。',
  ROOM_MISMATCH: '你已不在这个房间，请重新进入。',
  GAME_MISMATCH: '对局已经更新，正在载入最新进度。',
  SPECTATOR_READ_ONLY: '观战者不能提交玩家行动。',
  DUPLICATE_COMMAND: '这个操作已经提交，无需重复点击。',
  STALE_STAGE_REVISION: '阶段已经变化，已为你刷新。',
  EXPIRED_COMMAND: '行动时间已结束，已进入最新阶段。',
  ACTION_NOT_ALLOWED: '当前阶段不能进行这个操作。',
  INVALID_TARGET: '当前不能选择这个目标。',
  ACTOR_NOT_FOUND: '未找到你的玩家席位，请重新进入。',
  ACTOR_DEAD: '你已出局，不能进行该行动。',
  INVALID_COMMAND: '这个操作未被接受，请刷新后重试。',
  INVALID_GAME_META: '对局信息已过期，正在重新载入。',
  IDENTITY_ALREADY_BOUND: '当前连接已用于另一个身份，请重新进入。',
  IDENTITY_ALREADY_EXISTS: '该身份已在房间中，请使用恢复入口。',
  ROOM_TOKEN_INVALID: '邀请口令不正确，请向房主确认。',
  ROOM_FULL: '玩家席已满，你可以进入观战席。',
  ROOM_NOT_FOUND: '没有找到这个房间，请检查房间码。',
  HOST_REQUIRED: '只有房主可以执行这个操作。',
  GAME_ALREADY_STARTED: '对局已经开始，将为你打开对应视图。',
  GAME_NOT_STARTED: '对局尚未开始，请留在等待房间。',
  MEMBER_NOT_FOUND: '该成员已离开房间。',
  ROLE_NOT_ASSIGNED: '身份仍在分配，请稍候。',
  COMMAND_NOT_IMPLEMENTED: '当前版本暂不支持这个操作。',
  PUSH_FAILED: '实时更新中断，正在重新连接。',
  UNKNOWN_ERROR: '请求未完成，请稍后重试。',
} satisfies Record<LegacyProtocolErrorCode, string>;

const V31_ERROR_MESSAGES = {
  ROOM_REVISION_CONFLICT: '房间设置刚刚发生变化，请确认最新内容。',
  INVALID_ROOM_CONFIG: '房间设置不完整，请检查标出的项目。',
  ROLE_COUNT_MISMATCH: '角色总数必须与本局人数一致。',
  RULESET_UNAVAILABLE: '这套规则当前不可用，请重新选择。',
  MIN_PLAYERS_NOT_MET: '真人玩家还未达到最低开局人数。',
  HUMAN_PLAYERS_NOT_READY: '仍有真人玩家没有准备。',
  MEMBER_OFFLINE: '有玩家离线，暂时无法开局。',
  CONFIG_LOCKED: '准备检查已经开始，房间设置暂时锁定。',
  GAME_START_IN_PROGRESS: '房间正在开局，请勿重复操作。',
} satisfies Record<V31ProtocolErrorCode, string>;

export const PROTOCOL_ERROR_MESSAGES: Record<
  PresentationProtocolErrorCode,
  string
> = {
  ...CORE_ERROR_MESSAGES,
  ...V31_ERROR_MESSAGES,
};

export const ERROR_MESSAGES = PROTOCOL_ERROR_MESSAGES;
export const ERROR_LABELS = PROTOCOL_ERROR_MESSAGES;

const RECOVERIES: Record<PresentationProtocolErrorCode, ErrorRecovery> = {
  UNAUTHENTICATED: 'return_lobby',
  IDENTITY_MISMATCH: 'recover_identity',
  ROOM_MISMATCH: 'return_lobby',
  GAME_MISMATCH: 'refresh_game',
  SPECTATOR_READ_ONLY: 'keep_view',
  DUPLICATE_COMMAND: 'refresh_game',
  STALE_STAGE_REVISION: 'refresh_game',
  EXPIRED_COMMAND: 'refresh_game',
  ACTION_NOT_ALLOWED: 'refresh_game',
  INVALID_TARGET: 'clear_target',
  ACTOR_NOT_FOUND: 'return_lobby',
  ACTOR_DEAD: 'keep_view',
  INVALID_COMMAND: 'keep_view',
  INVALID_GAME_META: 'refresh_game',
  IDENTITY_ALREADY_BOUND: 'recover_identity',
  IDENTITY_ALREADY_EXISTS: 'recover_identity',
  ROOM_TOKEN_INVALID: 'focus_join_token',
  ROOM_FULL: 'open_spectator',
  ROOM_NOT_FOUND: 'return_lobby',
  HOST_REQUIRED: 'refresh_room',
  GAME_ALREADY_STARTED: 'refresh_room',
  GAME_NOT_STARTED: 'open_waiting_room',
  MEMBER_NOT_FOUND: 'refresh_room',
  ROLE_NOT_ASSIGNED: 'show_transition',
  COMMAND_NOT_IMPLEMENTED: 'keep_view',
  PUSH_FAILED: 'recover_identity',
  UNKNOWN_ERROR: 'retry',
  ROOM_REVISION_CONFLICT: 'refresh_room',
  INVALID_ROOM_CONFIG: 'refresh_room',
  ROLE_COUNT_MISMATCH: 'refresh_room',
  RULESET_UNAVAILABLE: 'refresh_room',
  MIN_PLAYERS_NOT_MET: 'refresh_room',
  HUMAN_PLAYERS_NOT_READY: 'refresh_room',
  MEMBER_OFFLINE: 'refresh_room',
  CONFIG_LOCKED: 'refresh_room',
  GAME_START_IN_PROGRESS: 'refresh_room',
};

const UNKNOWN_ERROR_PRESENTATION: ErrorPresentation = {
  message: '请求未完成，请稍后重试。',
  recovery: 'retry',
};

export const getErrorPresentation = (
  code: string | null | undefined,
): ErrorPresentation => {
  if (
    !code ||
    !Object.prototype.hasOwnProperty.call(PROTOCOL_ERROR_MESSAGES, code)
  ) {
    return UNKNOWN_ERROR_PRESENTATION;
  }
  const typedCode = code as PresentationProtocolErrorCode;
  return {
    message: PROTOCOL_ERROR_MESSAGES[typedCode],
    recovery: RECOVERIES[typedCode],
  };
};

export const getErrorMessage = (code?: string | null): string =>
  getErrorPresentation(code).message;

/** Compatibility name used by the pre-M11 store. */
export const messageForError = getErrorMessage;
export const messageFor = getErrorMessage;
