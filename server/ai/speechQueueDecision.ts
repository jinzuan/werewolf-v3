import { buildPromptPipeline } from './promptPipeline';
import type { AIRequestContext } from './types';
import type { AIPrompt } from './promptBuilder';
import type {
  SpeechQueueDecision,
  SpeechQueueDecline,
  SpeechQueueRequest,
} from './speech/speech-queue-decision.v1';

const REQUEST_REASON_CODES = new Set([
  'direct_mention',
  'unanswered_question',
  'new_role_claim',
  'new_vote_change',
  'material_disagreement',
  'new_private_information',
]);

const DECLINE_REASON_CODES = new Set([
  'no_new_information',
  'already_queued',
  'quota_exhausted',
  'same_fingerprint',
  'not_addressed',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseJson = (raw: string): Record<string, unknown> | null => {
  const cleaned = raw.trim().replace(/^```json\s*/iu, '').replace(/\s*```$/u, '').trim();
  for (const candidate of [cleaned, cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)]) {
    if (!candidate || !candidate.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (isRecord(value)) return value;
    } catch {
      // The caller treats malformed model output as a safe decline.
    }
  }
  return null;
};

/** Provider-facing prompt for the independent queue decision. */
export const buildSpeechQueuePrompt = (context: AIRequestContext): AIPrompt => {
  const base = buildPromptPipeline({
    ...context,
    allowedActions: ['request_speech'],
    allowedCommandTypes: ['game.request_speech'],
    promptContext: {
      ...(context.promptContext ?? {}),
      legalActions: ['request_speech'],
    },
  }).prompt;
  const visibleEvents = (context.promptContext?.visibleEvents ?? [])
    .slice(-12)
    .map((event) => `${event.eventId}：${event.eventType}`)
    .join('\n') || '无可引用事件';
  return {
    system: `${base.system}\n\n【发言队列决策协议】\n你现在只决定是否申请插队，不生成发言正文。`,
    user: `${base.user}\n\n【发言队列决策协议】
只输出一个 JSON 对象，不输出解释：
{"contract_version":"speech-queue-decision.v1","result":"request","action":"request_speech","reason_code":"direct_mention","trigger_event_ids":["可见事件ID"]}
{"contract_version":"speech-queue-decision.v1","result":"decline","reason_code":"no_new_information","trigger_event_ids":[]}
request 必须引用至少一个下面列出的、你当前可见且确实触发插话的事件；没有新的问题、点名、身份/票型变化或实质分歧就 decline。不要为了发言而申请插队。
【可引用事件】
${visibleEvents}`,
  };
};

export type ParsedSpeechQueueDecision =
  | { ok: true; decision: SpeechQueueDecision }
  | { ok: false; message: string };

/** Strict runtime parser; model text is never trusted through a TS cast. */
export const parseSpeechQueueDecision = (
  raw: string,
  context: AIRequestContext,
): ParsedSpeechQueueDecision => {
  const object = parseJson(raw);
  if (!object || object.contract_version !== 'speech-queue-decision.v1') {
    return { ok: false, message: 'invalid queue decision envelope' };
  }
  if (object.result === 'decline') {
    if (typeof object.reason_code !== 'string' || !DECLINE_REASON_CODES.has(object.reason_code)) {
      return { ok: false, message: 'invalid decline reason' };
    }
    if (!Array.isArray(object.trigger_event_ids) || object.trigger_event_ids.length !== 0) {
      return { ok: false, message: 'decline must not carry trigger events' };
    }
    return {
      ok: true,
      decision: {
        contract_version: 'speech-queue-decision.v1',
        result: 'decline',
        reason_code: object.reason_code as SpeechQueueDecline['reason_code'],
        trigger_event_ids: [],
      },
    };
  }
  if (
    object.result !== 'request' ||
    object.action !== 'request_speech' ||
    typeof object.reason_code !== 'string' ||
    !REQUEST_REASON_CODES.has(object.reason_code) ||
    !Array.isArray(object.trigger_event_ids) ||
    object.trigger_event_ids.length === 0 ||
    !object.trigger_event_ids.every((id): id is string => typeof id === 'string')
  ) {
    return { ok: false, message: 'invalid request decision fields' };
  }
  const visibleIds = new Set((context.promptContext?.visibleEvents ?? []).map((event) => event.eventId));
  if (!object.trigger_event_ids.every((id) => visibleIds.has(id))) {
    return { ok: false, message: 'request references an invisible event' };
  }
  return {
    ok: true,
    decision: {
      contract_version: 'speech-queue-decision.v1',
      result: 'request',
      action: 'request_speech',
      reason_code: object.reason_code as SpeechQueueRequest['reason_code'],
      trigger_event_ids: object.trigger_event_ids,
    },
  };
};
