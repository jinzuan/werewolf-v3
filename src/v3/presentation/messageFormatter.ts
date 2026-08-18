import type { DomainEvent } from '../../../shared/events';
import type { GameState, NightStage } from '../../../shared/types';
import {
  describeEvent,
  type EventMessageOptions,
} from './eventMessages';
import {
  GAME_PHASE_LABELS,
  DAY_STAGE_LABELS,
  NIGHT_STAGE_LABELS,
  UNKNOWN_LABEL,
  actionLabel,
  roleLabel,
} from './domainLabels';
import { getErrorMessage } from './errorMessages';

export const phaseLabel = (state: GameState | null | undefined): string => {
  if (!state) return '等待数据';
  if (state.phase === 'night') {
    if (!state.nightStage) return `第 ${state.day} 夜`;
    const stage = NIGHT_STAGE_LABELS[state.nightStage] ?? UNKNOWN_LABEL;
    const discussionRound = state.nightStage === 'wolf_discussion'
      ? `（第 ${state.wolfDiscussionRound ?? 1}/2 轮）`
      : '';
    return `第 ${state.day} 夜 · ${stage}${discussionRound}`;
  }
  const phase = GAME_PHASE_LABELS[state.phase];
  const dayStage = (state as GameState & { dayStage?: string | null }).dayStage;
  const dayLabel = dayStage && dayStage in DAY_STAGE_LABELS
    ? DAY_STAGE_LABELS[dayStage as keyof typeof DAY_STAGE_LABELS]
    : null;
  return phase
    ? state.phase === 'day' || state.phase === 'vote' || state.phase === 'voting'
      ? `第 ${state.day} 天 · ${dayLabel ?? phase}`
      : phase
    : UNKNOWN_LABEL;
};

export const formatPhase = phaseLabel;
export const formatGamePhase = phaseLabel;

export const formatNightStage = (
  stage: NightStage | null | undefined,
): string => (stage ? NIGHT_STAGE_LABELS[stage] ?? UNKNOWN_LABEL : UNKNOWN_LABEL);

export const formatEvent = (
  event: DomainEvent,
  playerName: (id: string | null) => string,
  options?: EventMessageOptions,
): string => describeEvent(event, playerName, options);

export { describeEvent };
export { actionLabel, roleLabel };

export const formatEventTime = (timestamp: number): string => {
  if (!Number.isFinite(timestamp)) return '时间未知';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
};

export const formatError = getErrorMessage;

/** Small interpolation helper for presentation templates. Unknown placeholders are removed safely. */
export const formatTemplate = (
  template: string,
  params: Record<string, string | number | null | undefined>,
): string => template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, key: string) => {
  const value = params[key];
  return value === null || value === undefined ? '' : String(value);
});
