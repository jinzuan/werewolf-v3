import type { Role } from '../../shared/types';
import type {
  ReviewGeneration,
  ReviewGenerator,
  ReviewGeneratorInput,
  ReviewInsightDraft,
  ReviewMessageDraft,
} from './reviewPipeline';

export interface AIReviewCompletionClient {
  complete(prompt: { system: string; user: string }): Promise<string>;
}

const roles: Role[] = ['wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager'];
const teams = ['good', 'wolf'] as const;
const safeText = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? [...value]
        .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character)
        .join('')
        .replace(/[<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const evidenceIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').slice(0, 8))]
    : [];

const parseGeneration = (raw: string): ReviewGeneration => {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('REVIEW_AI_INVALID_OUTPUT'); }
  if (!value || typeof value !== 'object') throw new Error('REVIEW_AI_INVALID_OUTPUT');
  const record = value as Record<string, unknown>;
  const messages: ReviewMessageDraft[] = Array.isArray(record.messages)
    ? record.messages.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const draft = item as Record<string, unknown>;
        const message = safeText(draft.text, 300);
        if (!message) return [];
        return [{
          text: message,
          audience: draft.audience === 'team' || draft.audience === 'role' ? draft.audience : 'public',
          ...(draft.team === 'wolf' || draft.team === 'good' ? { team: draft.team } : {}),
          ...(roles.includes(draft.role as Role) ? { role: draft.role as Role } : {}),
          ...(typeof draft.playerId === 'string' ? { playerId: draft.playerId.slice(0, 120) } : {}),
          evidenceEventIds: evidenceIds(draft.evidenceEventIds),
        }];
      })
    : [];
  const insights: ReviewInsightDraft[] = Array.isArray(record.insights)
    ? record.insights.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const draft = item as Record<string, unknown>;
        const role = draft.role as Role;
        const insight = safeText(draft.text, 160);
        if (!roles.includes(role) || !insight) return [];
        return [{
          role,
          text: insight,
          evidenceEventIds: evidenceIds(draft.evidenceEventIds),
          ...(typeof draft.playerId === 'string' ? { playerId: draft.playerId.slice(0, 120) } : {}),
          ...(typeof draft.experienceInstanceId === 'string' ? { experienceInstanceId: draft.experienceInstanceId.slice(0, 120) } : {}),
          ...(typeof draft.experienceUpdate === 'string' ? { experienceUpdate: safeText(draft.experienceUpdate, 160) } : {}),
        }];
      })
    : [];
  return { messages, insights };
};

const eventVisibleToTeam = (
  event: { visibility: string; audienceIds?: string[] },
  team: 'good' | 'wolf',
): boolean =>
  event.visibility === 'public_timeline' ||
  (team === 'wolf' && event.visibility === 'wolf_private');

const redactNames = (value: unknown, names: readonly string[]): unknown => {
  if (typeof value === 'string') return names.reduce((text, name) => name ? text.split(name).join('某位玩家') : text, value);
  if (Array.isArray(value)) return value.map((item) => redactNames(item, names));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactNames(item, names)]));
  return value;
};

const callPrompt = (
  client: AIReviewCompletionClient,
  pass: string,
  instruction: string,
  input: Record<string, unknown>,
): Promise<ReviewGeneration> => client.complete({
  system: [
    '你是狼人杀真人风格的服务端复盘分析器，不是主持人，不要写模板口号。',
    `这是${pass}。${instruction}`,
    '只能引用输入里的 eventId；每条 message/insight 都必须填写 evidenceEventIds。',
    '输出 JSON 且只能包含 {messages:[...],insights:[...]}；没有足够依据就少写，不要补全不存在的事实。',
    '表达可以短，优先写“观察到什么→因此怎么判断/下次怎么改”，不要重复“重视信息、认真沟通”等空话。',
  ].join('\n'),
  user: JSON.stringify(input),
}).then(parseGeneration);

/** Real three-pass review generator. Credentials stay in the injected client. */
export class AIReviewGenerator implements ReviewGenerator {
  constructor(private readonly client: AIReviewCompletionClient) {}

  async generate(input: ReviewGeneratorInput): Promise<ReviewGeneration> {
    const messages: ReviewMessageDraft[] = [];
    const insights: ReviewInsightDraft[] = [];
    for (const team of teams) {
      const events = input.events.filter(({ event }) => eventVisibleToTeam(event, team));
      const generated = await callPrompt(this.client, `${team === 'wolf' ? '狼人' : '好人'}阵营团队复盘`, '只分析本阵营能看到的事实，讨论协作、交换信息、站边/刀口与关键失误。不要替另一阵营总结。', {
        round: 'team', team, winner: input.archive.winner, events: events.map(({ event }) => event),
      });
      messages.push(...generated.messages.map((message) => ({ ...message, audience: 'team' as const, team, round: 'team' as const })));
      insights.push(...generated.insights.map((insight) => ({ ...insight, round: 'team' as const })));
    }

    const publicEvents = input.events.filter(({ event }) => event.visibility === 'public_timeline');
    const global = await callPrompt(this.client, '全局公开复盘', '只使用公开时间线，分析发言前后、票型、公开行动和被抓住的突破口；禁止引用任何私密行动。', {
      round: 'global', winner: input.archive.winner, events: publicEvents.map(({ event }) => event),
    });
    messages.push(...global.messages.map((message) => ({ ...message, audience: 'public' as const, round: 'global' as const })));

    for (const player of input.archive.players.filter((candidate) => candidate.isAI && candidate.role && candidate.experienceInstanceId)) {
      const visible = input.events.filter(({ event }) =>
        event.visibility === 'public_timeline' ||
        (event.visibility === 'role_private' && (event.audienceIds ?? []).includes(player.id)) ||
        (player.role === 'wolf' && event.visibility === 'wolf_private' && (event.audienceIds ?? []).includes(player.id)),
      );
      const names = input.archive.players.map((candidate) => candidate.name).filter(Boolean);
      const generated = await callPrompt(this.client, 'AI 个体自我复盘', '只复盘这个 AI 自己能看到的内容。输出一条短自我总结和一条可迁移的 experienceUpdate。严禁出现任何人名、昵称或 playerId；只能写方法和踩坑，不能改公共经验库。', {
        round: 'self', playerId: player.id, role: player.role, experienceInstanceId: player.experienceInstanceId,
        currentExperience: redactNames(player.experienceText ?? '', names), winner: input.archive.winner,
        events: redactNames(visible.map(({ event }) => event), names),
      });
      messages.push(...generated.messages.map((message) => ({ ...message, audience: 'role' as const, role: player.role!, playerId: player.id, round: 'self' as const })));
      insights.push(...generated.insights.map((insight) => ({ ...insight, role: player.role!, playerId: player.id, experienceInstanceId: player.experienceInstanceId, round: 'self' as const })));
    }
    return { messages, insights };
  }
}
