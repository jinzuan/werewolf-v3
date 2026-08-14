import { DOMAIN_EVENT_MESSAGES } from './eventMessages';
import {
  ACTION_LABELS,
  EVENT_VISIBILITY_LABELS,
  NIGHT_STAGE_LABELS,
  ROLE_LABELS,
  ROOM_ACTION_LABELS,
  ROOM_MODE_LABELS,
  ROOM_STATUS_LABELS,
  WIZARD_STATUS_LABELS,
} from './domainLabels';
import { PROTOCOL_ERROR_MESSAGES } from './errorMessages';

/**
 * Values that must never be rendered as ordinary player-facing copy. The
 * scanner is intentionally narrow: user-authored speech and names are not
 * passed to it, while enum/code leakage is caught deterministically.
 */
export const FORBIDDEN_UI_VALUES = [
  ...Object.keys(ROLE_LABELS),
  ...Object.keys(ROOM_STATUS_LABELS),
  ...Object.keys(WIZARD_STATUS_LABELS),
  ...Object.keys(ROOM_MODE_LABELS),
  ...Object.keys(ROOM_ACTION_LABELS),
  ...Object.keys(ACTION_LABELS),
  ...Object.keys(NIGHT_STAGE_LABELS),
  ...Object.keys(EVENT_VISIBILITY_LABELS),
  ...Object.keys(PROTOCOL_ERROR_MESSAGES),
  ...Object.keys(DOMAIN_EVENT_MESSAGES),
  'LIVE',
  'AI',
  'Match Console',
  'alive',
  'dead',
  'ViewerContext',
  'snapshot',
  'serverTime',
  'stageStartedAt',
  'deadlineTs',
  'stageRevision',
  'sequence',
  'eventType',
  'allowedActions',
  'host',
  'viewer',
  'token',
  'error code',
] as const;

export interface I18nViolation {
  value: string;
  index: number;
}

const boundaryPattern = (value: string): RegExp => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordLike = /^[A-Za-z0-9_]+$/.test(value);
  return wordLike
    ? new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'g')
    : new RegExp(escaped, 'g');
};

export const scanI18nText = (text: string): I18nViolation[] => {
  const violations: I18nViolation[] = [];
  for (const value of FORBIDDEN_UI_VALUES) {
    const pattern = boundaryPattern(value);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const offset = match[0].startsWith(value) ? 0 : match[0].length - value.length;
      violations.push({ value, index: match.index + offset });
      if (match[0] === '') pattern.lastIndex += 1;
    }
  }
  return violations.sort((left, right) => left.index - right.index || left.value.localeCompare(right.value));
};

export const hasUntranslatedText = (text: string): boolean =>
  scanI18nText(text).length > 0;

export const assertLocalizedText = (text: string): void => {
  const violations = scanI18nText(text);
  if (violations.length > 0) {
    throw new Error(`发现未汉化展示值：${violations.map((item) => item.value).join('、')}`);
  }
};

export const scanReachableText = (
  texts: Iterable<string>,
): I18nViolation[] => {
  const violations: I18nViolation[] = [];
  for (const text of texts) violations.push(...scanI18nText(text));
  return violations;
};
