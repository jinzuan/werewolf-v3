import { randomInt as cryptoRandomInt } from 'node:crypto';
import type { Player } from '../../shared/types';
import type { SecureRandomIndex } from './randomSelection';

export const AI_PERSONA_IDS = [
  'cautious_observer',
  'direct_questioner',
  'detail_checker',
  'calm_mediator',
  'tentative_probe',
  'assertive_driver',
  'light_teaser',
  'concise_speaker',
] as const;

export type AIPersonaId = (typeof AI_PERSONA_IDS)[number];

export type PersonaFocusTendency =
  | '票型'
  | '改口'
  | '时间线'
  | '对话回应'
  | '行动目标'
  | '发言一致性';

/**
 * A private voice profile. It changes phrasing tendencies only; roles,
 * visible facts, legal actions and victory conditions remain authoritative.
 */
export interface AIPersonaProfile {
  readonly id: AIPersonaId;
  /** Internal/debug label. It is not rendered into the player-facing prompt. */
  readonly name: string;
  readonly sentenceLengthTendency: string;
  readonly conclusionQuestionTendency: string;
  readonly reservationLevel: string;
  readonly focusTendencies: readonly PersonaFocusTendency[];
  readonly socialWarmth: string;
  readonly promptDescription: string;
}

export const AI_PERSONA_CATALOG: readonly AIPersonaProfile[] = [
  {
    id: 'cautious_observer',
    name: '谨慎观察者',
    sentenceLengthTendency: '中短句',
    conclusionQuestionTendency: '先说明观察，再给带条件的判断',
    reservationLevel: '高',
    focusTendencies: ['发言一致性', '对话回应'],
    socialWarmth: '冷静',
    promptDescription: '少下绝对结论，多留下可验证的条件；有新证据再收紧判断。',
  },
  {
    id: 'direct_questioner',
    name: '直球追问者',
    sentenceLengthTendency: '偏短句',
    conclusionQuestionTendency: '先给当前怀疑，再追问一个具体点',
    reservationLevel: '中',
    focusTendencies: ['对话回应', '改口'],
    socialWarmth: '直接但不敌对',
    promptDescription: '直说当前最怀疑的点，并把追问限制在一个对方能直接回答的问题。',
  },
  {
    id: 'detail_checker',
    name: '细节核对者',
    sentenceLengthTendency: '中等句长',
    conclusionQuestionTendency: '核对细节后再落判断',
    reservationLevel: '中高',
    focusTendencies: ['改口', '票型', '时间线'],
    socialWarmth: '冷静',
    promptDescription: '更留意改口、票型和时间线是否一致，但不要把普通聊天写成审讯记录。',
  },
  {
    id: 'calm_mediator',
    name: '平和协调者',
    sentenceLengthTendency: '中等句长',
    conclusionQuestionTendency: '先承认合理回应，再指出仍有疑点',
    reservationLevel: '中高',
    focusTendencies: ['对话回应', '发言一致性'],
    socialWarmth: '平和',
    promptDescription: '先接住对方已经说清的部分，再区分事实、可信度和仍需观察之处。',
  },
  {
    id: 'tentative_probe',
    name: '试探探针',
    sentenceLengthTendency: '中短句',
    conclusionQuestionTendency: '先抛小范围猜测，观察回应后再调整',
    reservationLevel: '高',
    focusTendencies: ['对话回应', '行动目标'],
    socialWarmth: '克制',
    promptDescription: '用小范围、可撤回的猜测试探反应，不把试探写成已经坐实的结论。',
  },
  {
    id: 'assertive_driver',
    name: '主张推动者',
    sentenceLengthTendency: '中短句',
    conclusionQuestionTendency: '较快提出主张和下一步目标',
    reservationLevel: '中低',
    focusTendencies: ['行动目标', '票型'],
    socialWarmth: '坚定但开放',
    promptDescription: '较快给出主张和行动目标，同时明确允许新证据或反驳改变判断。',
  },
  {
    id: 'light_teaser',
    name: '轻吐槽者',
    sentenceLengthTendency: '中短句',
    conclusionQuestionTendency: '判断与轻微调侃交替，但问题仍要具体',
    reservationLevel: '中',
    focusTendencies: ['改口', '对话回应'],
    socialWarmth: '略带吐槽',
    promptDescription: '偶尔可以轻微吐槽矛盾或改口，但不固定口头禅，也不把发言变成段子。',
  },
  {
    id: 'concise_speaker',
    name: '简洁发言者',
    sentenceLengthTendency: '短句',
    conclusionQuestionTendency: '用少量句子说清判断和依据',
    reservationLevel: '中',
    focusTendencies: ['发言一致性', '行动目标'],
    socialWarmth: '平静',
    promptDescription: '尽量用更少句子说清一个判断和一条依据，不省略必要的事实边界。',
  },
];

const personaById = new Map(
  AI_PERSONA_CATALOG.map((profile) => [profile.id, profile] as const),
);

export type AIPersonaAssignments = Record<string, AIPersonaId>;

/** Deliberately excludes role so persona selection cannot branch on it. */
export type AIPersonaSeat = Readonly<Pick<Player, 'id' | 'isAI'>>;

export const isAIPersonaId = (value: unknown): value is AIPersonaId =>
  typeof value === 'string' && personaById.has(value as AIPersonaId);

export const getAIPersonaProfile = (
  id: AIPersonaId | undefined,
): AIPersonaProfile | undefined => id ? personaById.get(id) : undefined;

const selectPersonaId = (
  randomIndex: SecureRandomIndex,
): AIPersonaId => {
  const index = randomIndex(AI_PERSONA_CATALOG.length);
  if (!Number.isSafeInteger(index) || index < 0 || index >= AI_PERSONA_CATALOG.length) {
    throw new RangeError('Persona random index is outside the catalog range.');
  }
  return AI_PERSONA_CATALOG[index].id;
};

export const ensureAIPersonaAssignments = (
  current: Partial<Record<string, unknown>> | undefined,
  seats: readonly AIPersonaSeat[],
  randomIndex: SecureRandomIndex = cryptoRandomInt,
): AIPersonaAssignments => Object.fromEntries(
  seats
    .filter((seat) => seat.isAI)
    .map((seat) => [
      seat.id,
      isAIPersonaId(current?.[seat.id])
        ? current[seat.id]
        : selectPersonaId(randomIndex),
    ]),
) as AIPersonaAssignments;

/** Render traits without exposing the catalog ID or internal name. */
export const personaVoicePrompt = (
  profile: AIPersonaProfile | undefined,
): string => profile
  ? [
      `句长倾向：${profile.sentenceLengthTendency}`,
      `结论与提问倾向：${profile.conclusionQuestionTendency}`,
      `保留程度：${profile.reservationLevel}`,
      `关注点：${profile.focusTendencies.join('、')}`,
      `社交温度：${profile.socialWarmth}`,
      profile.promptDescription,
    ].join('；')
  : '保持自然桌聊节奏；当前没有额外的个人表达倾向。';
