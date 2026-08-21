import type { DayStage, EventVisibility } from '../../../shared/events';
import type { GameAction, NightStage, Role } from '../../../shared/types';
import type {
  AllowedRoomAction,
  RoomMemberKind as ContractRoomMemberKind,
  RoomMode as ContractRoomMode,
  RoomStatus as ContractRoomStatus,
} from '../../../shared/roomContract';

/**
 * All user-facing names for the stable domain values live in this module.
 * Keep the values themselves in shared/; this layer only decides how they are
 * presented to a player or an authorized monitor.
 */

export type RoomStatus = ContractRoomStatus;
export type RoomMode = ContractRoomMode;
export type RoomAction = AllowedRoomAction;
export type RoomMemberKind = ContractRoomMemberKind;
export type ConnectionStatus = 'connected' | 'disconnected';
export type ReadyStatus = 'ready' | 'not_ready';
export type Team = 'wolf' | 'good';
export type Alignment = 'wolf' | 'good';

export const ROLE_LABELS = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  villager: '村民',
  guardian: '守卫',
} satisfies Record<Role, string>;

export const TEAM_LABELS = {
  wolf: '狼人阵营',
  good: '好人阵营',
} satisfies Record<Team, string>;

export const ALIGNMENT_LABELS = {
  wolf: '狼人',
  good: '好人阵营',
} satisfies Record<Alignment, string>;

export const ROOM_STATUS_LABELS = {
  waiting: '等待入座',
  ready_check: '等待准备',
  starting: '正在开局',
  playing: '对局中',
  ended: '对局结束',
} satisfies Record<RoomStatus, string>;

/** `configuring` belongs to the local four-step wizard, not RoomView. */
export const WIZARD_STATUS_LABELS = {
  configuring: '创建设置',
} as const;

export const ROOM_MODE_LABELS = {
  human: '真人房',
  mixed: '电脑补位房',
  quick_computer: '快速电脑局',
} satisfies Record<RoomMode, string>;

export const ROOM_ACTION_LABELS = {
  update_config: '修改房间设置',
  update_ai_config: '修改电脑玩家设置',
  begin_ready_check: '开始准备',
  cancel_ready_check: '返回设置',
  set_ready: '准备开局',
  start_game: '开始对局',
  leave: '离开房间',
  invite: '复制邀请',
  transfer_host: '转让房主',
  dissolve: '解散房间',
  claim_seat: '进入玩家席',
  become_spectator: '加入观战席',
  add_ai: '添加 AI 玩家',
  kick_player: '移出玩家席',
  request_seat: '申请玩家位置',
  respond_seat_request: '处理位置申请',
} satisfies Record<RoomAction, string>;

export const MEMBER_KIND_LABELS = {
  player: '玩家',
  spectator: '观战者',
} satisfies Record<RoomMemberKind, string>;

export const CONNECTION_STATUS_LABELS = {
  connected: '在线',
  disconnected: '离线',
} satisfies Record<ConnectionStatus, string>;

export const READY_STATUS_LABELS = {
  ready: '已准备',
  not_ready: '未准备',
} satisfies Record<ReadyStatus, string>;

export const GAME_ACTION_LABELS = {
  confirm_role: '确认身份',
  guard: '守护',
  check: '查验',
  wolf_speak: '狼人讨论',
  wolf_vote: '狼人投票',
  heal: '使用解药',
  poison: '使用毒药',
  skip_night: '跳过夜间行动',
  speak: '发言',
  skip_speech: '跳过发言',
  request_speech: '申请插队',
  vote: '投票',
  abstain: '弃票',
  hunter_shoot: '开枪',
  skip_hunter_shot: '不开枪',
} satisfies Record<GameAction, string>;

export const ACTION_LABELS = GAME_ACTION_LABELS;

export const NIGHT_STAGE_LABELS = {
  guard_seer: '守卫与预言家行动',
  wolf_discussion: '狼人讨论',
  wolf_vote: '狼人决定目标',
  witch: '女巫行动',
  resolve: '夜间结算',
} satisfies Record<NightStage, string>;

export const DAY_STAGE_LABELS = {
  dawn: '天亮公告',
  speech: '轮流发言',
  discussion: '白天讨论',
  voting: '放逐投票',
  exile_result: '放逐结果',
  last_words: '遗言',
  hunter: '猎人开枪',
  day_end: '白天结束',
} satisfies Record<DayStage, string>;

export const EVENT_VISIBILITY_LABELS = {
  public_timeline: '公开时间线',
  role_private: '角色私密',
  wolf_private: '狼人私密',
  spectator_omniscient: '全知观战',
} satisfies Record<EventVisibility, string>;

export const VISIBILITY_LABELS = EVENT_VISIBILITY_LABELS;

export type GamePhase =
  | 'waiting'
  | 'roleSelect'
  | 'role_confirm'
  | 'night'
  | 'day'
  | 'vote'
  | 'voting'
  | 'hunterShoot'
  | 'lastWords'
  | 'ended';

export const GAME_PHASE_LABELS = {
  waiting: '等待开局',
  roleSelect: '身份确认',
  role_confirm: '身份确认',
  night: '夜间',
  day: '发言',
  vote: '投票',
  voting: '投票',
  hunterShoot: '猎人开枪',
  lastWords: '遗言',
  ended: '对局结束',
} satisfies Record<GamePhase, string>;

export const UNKNOWN_LABEL = '未知';
export const UNKNOWN_TARGET_LABEL = '未知目标';
export const UNASSIGNED_ROLE_LABEL = '未分配';

export const roleLabel = (role: Role | null | undefined): string =>
  role ? ROLE_LABELS[role] ?? UNKNOWN_LABEL : UNASSIGNED_ROLE_LABEL;

export const actionLabel = (action: GameAction | null | undefined): string =>
  action ? GAME_ACTION_LABELS[action] ?? UNKNOWN_LABEL : UNKNOWN_LABEL;

export const visibilityLabel = (
  visibility: EventVisibility | null | undefined,
): string =>
  visibility
    ? EVENT_VISIBILITY_LABELS[visibility] ?? UNKNOWN_LABEL
    : UNKNOWN_LABEL;

export const roomStatusLabel = (
  status: RoomStatus | 'configuring' | null | undefined,
): string =>
  status
    ? status === 'configuring'
      ? WIZARD_STATUS_LABELS.configuring
      : ROOM_STATUS_LABELS[status] ?? UNKNOWN_LABEL
    : UNKNOWN_LABEL;

export const roomModeLabel = (mode: RoomMode | null | undefined): string =>
  mode ? ROOM_MODE_LABELS[mode] ?? UNKNOWN_LABEL : UNKNOWN_LABEL;

export const roomActionLabel = (
  action: RoomAction | null | undefined,
): string =>
  action ? ROOM_ACTION_LABELS[action] ?? UNKNOWN_LABEL : UNKNOWN_LABEL;

export const nightStageLabel = (
  stage: NightStage | null | undefined,
): string => (stage ? NIGHT_STAGE_LABELS[stage] ?? UNKNOWN_LABEL : UNKNOWN_LABEL);
