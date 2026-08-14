import type { DomainEvent, DomainEventType, ViewerContext } from '../../../shared/events';
import type { GameState } from '../../../shared/types';
import {
  ALIGNMENT_LABELS,
  EVENT_VISIBILITY_LABELS,
  NIGHT_STAGE_LABELS,
  UNKNOWN_LABEL,
  UNKNOWN_TARGET_LABEL,
} from './domainLabels';

export const UNKNOWN_EVENT_MESSAGE = '系统状态已更新';

/** Stable template keys make additions fail at compile time instead of falling through to raw enum values. */
export const DOMAIN_EVENT_MESSAGE_KEYS = {
  'game.started': 'game_started',
  'game.state_updated': 'state_updated',
  'game.ended': 'game_ended',
  'stage.timed_out': 'stage_timed_out',
  'guardian.completed': 'guardian_completed',
  'seer.result': 'seer_result',
  'witch.kill_notice': 'witch_kill_notice',
  'witch.completed': 'witch_completed',
  'night.skipped': 'night_skipped',
  'night.roles_defaulted': 'night_roles_defaulted',
  'night.resolved': 'night_resolved',
  'night.resolution_detail': 'night_resolution_detail',
  'night.started': 'night_started',
  'wolf.message': 'wolf_message',
  'wolf.vote_cast': 'wolf_vote_cast',
  'wolf.vote_unresolved': 'wolf_vote_unresolved',
  'wolf.kill_locked': 'wolf_kill_locked',
  'wolf.discussion_timed_out': 'wolf_discussion_timed_out',
  'day.started': 'day_started',
  'day.speech': 'day_speech',
  'day.speech_skipped': 'day_speech_skipped',
  'day.voting_started': 'day_voting_started',
  'day.vote_cast': 'day_vote_cast',
  'day.revote_required': 'day_revote_required',
  'day.no_exile': 'day_no_exile',
  'day.exiled': 'day_exiled',
  'hunter.entitled': 'hunter_entitled',
  'hunter.shot': 'hunter_shot',
  'hunter.shot_skipped': 'hunter_shot_skipped',
} satisfies Record<DomainEventType, string>;

/** Human-readable templates are kept as Chinese strings; placeholders are internal, never exposed raw. */
export const DOMAIN_EVENT_MESSAGES = {
  'game.started': '对局开始，进入第 {day} 夜。',
  'game.state_updated': UNKNOWN_EVENT_MESSAGE,
  'game.ended': '对局结束，{winner}获胜。',
  'stage.timed_out': '{stage}行动时间已结束。',
  'guardian.completed': '你已守护{target}。',
  'seer.result': '查验结果：{target}属于{alignment}。',
  'witch.kill_notice': '今晚受到袭击的是{target}。',
  'witch.completed': '你已完成本夜用药。',
  'night.skipped': '你已跳过本次夜间行动。',
  'night.roles_defaulted': '夜间行动时间已结束，未完成的行动已按规则处理。',
  'night.resolved': '天亮了，昨夜是{result}。',
  'night.resolution_detail': '夜间结算明细已生成。',
  'night.started': '第 {day} 夜开始。',
  'wolf.message': '{actor}：{content}',
  'wolf.vote_cast': '{actor}已提交狼人投票。',
  'wolf.vote_unresolved': '狼人尚未选出今晚的目标。',
  'wolf.kill_locked': '狼人已决定今晚的目标。',
  'wolf.discussion_timed_out': '狼人讨论时间已结束。',
  'day.started': '第 {day} 天开始。',
  'day.speech': '{actor}：{content}',
  'day.speech_skipped': '{actor}跳过了本轮发言。',
  'day.voting_started': '放逐投票开始。',
  'day.vote_cast': '{actor}已投票。',
  'day.revote_required': '本轮出现平票，将在候选人中重新投票。',
  'day.no_exile': '本轮无人出局。',
  'day.exiled': '{target}被投票出局。',
  'hunter.entitled': '猎人可以选择是否开枪。',
  'hunter.shot': '猎人开枪带走了{target}。',
  'hunter.shot_skipped': '猎人选择不开枪。',
} satisfies Record<DomainEventType, string>;

export const EVENT_MESSAGES = DOMAIN_EVENT_MESSAGES;
export const EVENT_TEMPLATES = DOMAIN_EVENT_MESSAGES;

export interface EventMessageOptions {
  viewer?: ViewerContext | null;
  advanced?: boolean;
}

export interface EventMessageContext extends EventMessageOptions {
  playerName: (id: string | null) => string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};

const textValue = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value : fallback;

const idFrom = (payload: Record<string, unknown>, key: string): string | null =>
  typeof payload[key] === 'string' ? payload[key] as string : null;

const safePlayerName = (
  playerName: (id: string | null) => string,
  id: string | null,
): string => textValue(playerName(id), UNKNOWN_TARGET_LABEL);

const dayFrom = (payload: Record<string, unknown>, fallback = 1): number =>
  typeof payload.day === 'number' && Number.isFinite(payload.day)
    ? payload.day
    : fallback;

const stageFrom = (payload: Record<string, unknown>): string => {
  const stage = payload.stage;
  return typeof stage === 'string' && stage in NIGHT_STAGE_LABELS
    ? NIGHT_STAGE_LABELS[stage as keyof typeof NIGHT_STAGE_LABELS]
    : '当前阶段';
};

const isAdvancedView = (event: DomainEvent, options: EventMessageOptions): boolean =>
  options.advanced === true ||
  (options.viewer?.kind === 'spectator' && options.viewer.omniscient) ||
  event.visibility === 'spectator_omniscient';

const formattedDeaths = (
  payload: Record<string, unknown>,
  playerName: (id: string | null) => string,
): string => {
  if (payload.peacefulNight === true) return '昨夜是平安夜';
  if (!Array.isArray(payload.deaths)) return '结算结果未知';
  const names = payload.deaths
    .filter((id): id is string => typeof id === 'string')
    .map((id) => safePlayerName(playerName, id));
  return names.length > 0 ? `昨夜出局：${names.join('、')}` : '昨夜是平安夜';
};

const winnerLabel = (winner: unknown): string => {
  if (winner === 'wolf') return '狼人阵营';
  if (winner === 'good') return '好人阵营';
  return '胜负结果未知';
};

/**
 * Render a projected event without ever using eventType as a fallback.
 * Payload text is player-authored content and is therefore preserved; domain
 * values and missing fields always go through a safe Chinese label.
 */
export const describeEvent = (
  event: DomainEvent,
  playerName: (id: string | null) => string,
  options: EventMessageOptions = {},
): string => {
  const payload = asRecord(event.payload);
  const actor = safePlayerName(playerName, idFrom(payload, 'actorId') ?? event.actorId ?? null);
  const target = safePlayerName(
    playerName,
    idFrom(payload, 'targetId') ?? idFrom(payload, 'playerId'),
  );

  switch (event.eventType) {
    case 'game.started':
      return `对局开始，进入第 ${dayFrom(payload)} 夜。`;
    case 'game.state_updated':
      return UNKNOWN_EVENT_MESSAGE;
    case 'game.ended':
      return `对局结束，${winnerLabel(payload.winner)}获胜。`;
    case 'stage.timed_out':
      return `${stageFrom(payload)}行动时间已结束。`;
    case 'guardian.completed':
      return `你已守护${target}。`;
    case 'seer.result': {
      const alignment = payload.alignment === 'wolf'
        ? ALIGNMENT_LABELS.wolf
        : payload.alignment === 'good'
          ? ALIGNMENT_LABELS.good
          : UNKNOWN_LABEL;
      return `查验结果：${target}属于${alignment}。`;
    }
    case 'witch.kill_notice':
      return `今晚受到袭击的是${safePlayerName(playerName, idFrom(payload, 'killTargetId'))}。`;
    case 'witch.completed':
      return '你已完成本夜用药。';
    case 'night.skipped':
      return '你已跳过本次夜间行动。';
    case 'night.roles_defaulted':
      return '夜间行动时间已结束，未完成的行动已按规则处理。';
    case 'night.resolved':
      return `天亮了，${formattedDeaths(payload, playerName)}。`;
    case 'night.resolution_detail':
      return isAdvancedView(event, options) ? '夜间结算明细已生成。' : UNKNOWN_EVENT_MESSAGE;
    case 'night.started':
      return `第 ${dayFrom(payload)} 夜开始。`;
    case 'wolf.message':
      return `${actor}：${textValue(payload.content, '')}`.replace(/：$/, '');
    case 'wolf.vote_cast':
      return `${actor}已提交狼人投票。`;
    case 'wolf.vote_unresolved':
      return '狼人尚未选出今晚的目标。';
    case 'wolf.kill_locked':
      return isAdvancedView(event, options) && idFrom(payload, 'targetId')
        ? `狼人已决定今晚的目标：${target}。`
        : '狼人已决定今晚的目标。';
    case 'wolf.discussion_timed_out':
      return '狼人讨论时间已结束。';
    case 'day.started':
      return `第 ${dayFrom(payload)} 天开始。`;
    case 'day.speech':
      return `${actor}：${textValue(payload.content, '')}`.replace(/：$/, '');
    case 'day.speech_skipped':
      return `${actor}跳过了本轮发言。`;
    case 'day.voting_started':
      return '放逐投票开始。';
    case 'day.vote_cast':
      return `${actor}已投票。`;
    case 'day.revote_required':
      return '本轮出现平票，将在候选人中重新投票。';
    case 'day.no_exile':
      return '本轮无人出局。';
    case 'day.exiled':
      return `${target}被投票出局。`;
    case 'hunter.entitled':
      return '猎人可以选择是否开枪。';
    case 'hunter.shot':
      return `猎人开枪带走了${target}。`;
    case 'hunter.shot_skipped':
      return '猎人选择不开枪。';
    default:
      return UNKNOWN_EVENT_MESSAGE;
  }
};

export const eventMessage = describeEvent;

export const eventVisibilityLabel = (event: DomainEvent): string =>
  EVENT_VISIBILITY_LABELS[event.visibility] ?? UNKNOWN_LABEL;

export type EventPhase = GameState['phase'];
