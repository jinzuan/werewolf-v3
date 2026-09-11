import type {
  SpeechPlan,
  SpeechPlannerResult,
} from './speech-plan.v1';

export type SpeechGateIssueCode =
  | 'PLAN_NOT_RENDERABLE'
  | 'EMPTY_SPEECH'
  | 'INTERNAL_METADATA_LEAK'
  | 'GENERIC_RESPONSE_BRIDGE'
  | 'RECURSIVE_QUOTE'
  | 'UNSUPPORTED_ROUTE_REASON'
  | 'INCOMPLETE_SPEECH'
  | 'TEXT_TOO_LONG'
  | 'TOO_MANY_SENTENCES';

export interface SpeechGateIssue {
  code: SpeechGateIssueCode;
  message: string;
  source_event_id?: string;
}

export interface SpeechGateSource {
  event_id: string;
  content: string;
}

export interface SpeechGateContext {
  source_speeches?: readonly SpeechGateSource[];
  /** When supplied, only a provider-equivalent stop is accepted. */
  finish_reason?: string | null;
}

export type SpeechGateResult =
  | { ok: true; text: string }
  | { ok: false; issues: SpeechGateIssue[] };

const INTERNAL_METADATA_PATTERNS = [
  /【第\d+(?:天|晚)·[^】]{1,40}·第\d+轮】/u,
  /\b(?:discussion|speech|wolf_discussion|stageRevision|promptContext|currentRoundSpeeches|event_id)\b/iu,
  /(?:仅供模型内部|服务端阶段与任务|本轮逐条发言|必须体现的新内容|当前玩家状态)/u,
];

const RESPONSE_BRIDGE_PATTERNS = [
  /(?:先回应|我先回应).{0,40}(?:刚才|上一位|前面).{0,12}(?:发言|说法)/u,
  /(?:从刚才的发言看|我不重复前面的结论|我接着桌面信息说)/u,
];

const DANGLING_END_PATTERN =
  /(?:\.{2,}|…+|—+|[,，、:：;；]|因为|所以|但是|如果|然后|以及|而且|并且|比如|例如|关于|对于|至于|意味着|取决于)$/u;
const PARTIAL_STAGE_PATTERN =
  /(?:wolf_discuss|wolf_discussion|discuss|discussion|spee|speech|stageRevision|promptContex|promptContext)$/iu;
const ROUTE_GODS_PATTERN = /(?:走|改走|优先走)?屠神/u;
const ROUTE_VILLAGERS_PATTERN = /(?:走|改走|优先走)?屠民/u;

const normalizeForComparison = (value: string): string =>
  value.replace(/[\s，。！？、；：（）“”"'`·…—\-:：,.!?;《》【】]/gu, '');

const lcsLength = (left: string, right: string): number => {
  const row = new Array<number>(right.length + 1).fill(0);
  for (const leftChar of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const above = row[index];
      row[index] = leftChar === right[index - 1]
        ? diagonal + 1
        : Math.max(row[index], row[index - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
};

const sharesTwelveConsecutiveHan = (text: string, source: string): boolean => {
  for (const match of source.matchAll(/\p{Script=Han}{12,}/gu)) {
    const run = match[0];
    for (let index = 0; index <= run.length - 12; index += 1) {
      if (text.includes(run.slice(index, index + 12))) return true;
    }
  }
  return false;
};

const isNearCopy = (text: string, source: string): boolean => {
  const left = normalizeForComparison(text);
  const right = normalizeForComparison(source);
  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength < 12) return false;
  return lcsLength(left, right) / shorterLength > 0.55;
};

const hasUnclosedDelimiter = (text: string): boolean => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['“', '”'],
    ['‘', '’'],
    ['(', ')'],
    ['（', '）'],
    ['[', ']'],
    ['【', '】'],
    ['《', '》'],
  ];
  for (const [open, close] of pairs) {
    if (text.split(open).length !== text.split(close).length) return true;
  }
  return (text.match(/"/gu)?.length ?? 0) % 2 !== 0;
};

const graphemeCount = (text: string): number =>
  (() => {
    const Segmenter = (Intl as unknown as {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: 'grapheme' },
      ) => { segment(input: string): Iterable<unknown> };
    }).Segmenter;
    return Segmenter
      ? [...new Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].length
      : [...text].length;
  })();

const sentenceCount = (text: string): number => {
  const parts = text.split(/[。！？!?]+/u).filter((part) => part.trim().length > 0);
  return Math.max(1, parts.length);
};

const routeIssue = (text: string, plan: SpeechPlan): SpeechGateIssue | null => {
  const saysGods = ROUTE_GODS_PATTERN.test(text);
  const saysVillagers = ROUTE_VILLAGERS_PATTERN.test(text);
  if (!saysGods && !saysVillagers) return null;
  if (plan.channel !== 'wolf_private') {
    return {
      code: 'UNSUPPORTED_ROUTE_REASON',
      message: 'Route language is not supported by a validated wolf plan.',
    };
  }

  const expectedRoute = saysGods && !saysVillagers
    ? 'gods'
    : saysVillagers && !saysGods
      ? 'villagers'
      : null;
  const wolfPlan = plan.wolf_plan;
  if (
    expectedRoute === null ||
    wolfPlan.route !== expectedRoute ||
    wolfPlan.route_basis === 'none' ||
    wolfPlan.route_evidence_event_ids.length === 0 ||
    (
      plan.target_id !== null &&
      wolfPlan.target_role_hypothesis.role === 'unknown'
    )
  ) {
    return {
      code: 'UNSUPPORTED_ROUTE_REASON',
      message: '屠神/屠民 requires matching route evidence and cannot justify an unknown target role.',
    };
  }
  return null;
};

export const validateRenderedSpeech = (
  rawText: string,
  candidate: SpeechPlannerResult,
  context: SpeechGateContext = {},
): SpeechGateResult => {
  if (candidate.result !== 'speech') {
    return {
      ok: false,
      issues: [{
        code: 'PLAN_NOT_RENDERABLE',
        message: 'Skip and invalid-context planner results cannot enter SpeechGate.',
      }],
    };
  }

  const text = rawText.trim();
  const issues: SpeechGateIssue[] = [];
  const issueCodes = new Set<SpeechGateIssueCode>();
  const addIssue = (issue: SpeechGateIssue): void => {
    if (issueCodes.has(issue.code)) return;
    issueCodes.add(issue.code);
    issues.push(issue);
  };

  if (text.length === 0) {
    addIssue({ code: 'EMPTY_SPEECH', message: 'Rendered speech is empty.' });
  }
  if (INTERNAL_METADATA_PATTERNS.some((pattern) => pattern.test(text))) {
    addIssue({
      code: 'INTERNAL_METADATA_LEAK',
      message: 'Rendered speech exposes internal stage, event, prompt, or task metadata.',
    });
  }
  if (
    RESPONSE_BRIDGE_PATTERNS.some((pattern) => pattern.test(text)) ||
    (text.match(/回应/gu)?.length ?? 0) > 1
  ) {
    addIssue({
      code: 'GENERIC_RESPONSE_BRIDGE',
      message: 'Rendered speech describes the act of responding instead of answering directly.',
    });
  }

  for (const source of context.source_speeches ?? []) {
    if (
      sharesTwelveConsecutiveHan(text, source.content) ||
      isNearCopy(text, source.content)
    ) {
      addIssue({
        code: 'RECURSIVE_QUOTE',
        message: 'Rendered speech repeats too much source speech, including a forbidden 12-Han span.',
        source_event_id: source.event_id,
      });
      break;
    }
  }

  const unsupportedRoute = routeIssue(text, candidate);
  if (unsupportedRoute) addIssue(unsupportedRoute);

  if (
    context.finish_reason !== undefined &&
    context.finish_reason !== 'stop'
  ) {
    addIssue({
      code: 'INCOMPLETE_SPEECH',
      message: `Provider completion ended with ${String(context.finish_reason)}, not stop.`,
    });
  }
  if (
    DANGLING_END_PATTERN.test(text) ||
    PARTIAL_STAGE_PATTERN.test(text) ||
    hasUnclosedDelimiter(text)
  ) {
    addIssue({
      code: 'INCOMPLETE_SPEECH',
      message: 'Rendered speech ends as a fragment or contains an unclosed delimiter.',
    });
  }
  if (graphemeCount(text) > candidate.render.max_graphemes) {
    addIssue({
      code: 'TEXT_TOO_LONG',
      message: 'Rendered speech exceeds render.max_graphemes and must be rendered again.',
    });
  }
  if (sentenceCount(text) > candidate.render.max_sentences) {
    addIssue({
      code: 'TOO_MANY_SENTENCES',
      message: 'Rendered speech exceeds render.max_sentences.',
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, text };
};

export class SpeechGate {
  validate(
    text: string,
    plan: SpeechPlannerResult,
    context: SpeechGateContext = {},
  ): SpeechGateResult {
    return validateRenderedSpeech(text, plan, context);
  }
}
