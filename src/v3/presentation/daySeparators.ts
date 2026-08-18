import type { DomainEvent } from '../../../shared/events';

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

export const eventDayNumber = (event: DomainEvent, fallbackDay = 1): number => {
  const day = asRecord(event.payload).day;
  return typeof day === 'number' && Number.isFinite(day) && day > 0
    ? Math.floor(day)
    : fallbackDay;
};

export const eventPeriodLabel = (event: DomainEvent): string => {
  switch (event.eventType) {
    case 'day.speech':
    case 'day.speech_skipped':
    case 'day.discussion_started':
    case 'day.started':
      return '白天讨论';
    case 'day.voting_started':
    case 'day.vote_cast':
    case 'day.revote_required':
    case 'day.exile_result':
    case 'day.no_exile':
    case 'day.exiled':
      return '放逐投票';
    case 'night.started':
    case 'wolf.message':
    case 'wolf.vote_cast':
    case 'wolf.vote_unresolved':
    case 'wolf.kill_locked':
    case 'wolf.discussion_round_started':
    case 'wolf.discussion_timed_out':
    case 'guardian.completed':
    case 'seer.result':
    case 'witch.kill_notice':
    case 'witch.completed':
    case 'night.skipped':
    case 'night.roles_defaulted':
      return '夜间行动';
    case 'night.resolved':
      return '清晨结算';
    case 'role.confirmed':
    case 'role.confirmation_completed':
    case 'game.started':
      return '身份确认';
    case 'day.ended':
      return '白天结算';
    case 'hunter.entitled':
    case 'hunter.shot':
    case 'hunter.shot_skipped':
      return '特殊行动';
    case 'game.ended':
      return '对局结算';
    case 'game.state_updated':
    case 'stage.timed_out':
      return event.phase === 'night' ? '夜间行动' : '对局事件';
    default:
      return '对局事件';
  }
};

export const dayDividerForEvent = (
  event: DomainEvent,
  previous: DomainEvent | null,
  fallbackDay = 1,
): string | null => {
  const previousDay = previous ? eventDayNumber(previous, fallbackDay) : null;
  const day = eventDayNumber(event, previousDay ?? fallbackDay);
  return previousDay === day ? null : `——第${day}天·${eventPeriodLabel(event)}——`;
};
