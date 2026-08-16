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
const safeText = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

const evidenceIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').slice(0, 6))]
    : [];

const parseGeneration = (raw: string): ReviewGeneration => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('REVIEW_AI_INVALID_OUTPUT');
  }
  if (!value || typeof value !== 'object') throw new Error('REVIEW_AI_INVALID_OUTPUT');
  const record = value as Record<string, unknown>;
  const messages: ReviewMessageDraft[] = Array.isArray(record.messages)
    ? record.messages.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const draft = item as Record<string, unknown>;
        const text = safeText(draft.text, 240);
        const audience = draft.audience === 'team' || draft.audience === 'role' ? draft.audience : 'public';
        if (!text) return [];
        return [{
          text,
          audience,
          ...(draft.team === 'wolf' || draft.team === 'good' ? { team: draft.team } : {}),
          ...(roles.includes(draft.role as Role) ? { role: draft.role as Role } : {}),
          evidenceEventIds: evidenceIds(draft.evidenceEventIds),
          ...(typeof draft.operationId === 'string' ? { operationId: draft.operationId.slice(0, 160) } : {}),
        }];
      })
    : [];
  const insights: ReviewInsightDraft[] = Array.isArray(record.insights)
    ? record.insights.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const draft = item as Record<string, unknown>;
        const role = draft.role as Role;
        const text = safeText(draft.text, 100);
        if (!roles.includes(role) || !text) return [];
        return [{
          role,
          text,
          evidenceEventIds: evidenceIds(draft.evidenceEventIds),
          ...(typeof draft.operationId === 'string' ? { operationId: draft.operationId.slice(0, 160) } : {}),
        }];
      })
    : [];
  return { messages, insights };
};

/** Real review generator. The client is injected by the composition root. */
export class AIReviewGenerator implements ReviewGenerator {
  constructor(private readonly client: AIReviewCompletionClient) {}

  async generate(input: ReviewGeneratorInput): Promise<ReviewGeneration> {
    const prompt = {
      system: [
        '你是服务端狼人杀复盘分析器。',
        '只能引用输入事件中的 eventId；不得泄露不属于消息受众的隐私事实。',
        '输出 JSON：{messages:[...],insights:[...]}，每条产物必须有 evidenceEventIds。',
        '心得必须是具体的行动→结果经验，包含轮次、查验、投票、狼刀、放逐、守护、用药或遗言等可验证锚点；空泛建议会被拒绝。',
      ].join('\n'),
      user: JSON.stringify({
        operationId: input.archive.operationId,
        gameId: input.archive.gameId,
        winner: input.archive.winner,
        players: input.archive.players.map((player) => ({ id: player.id, role: player.role, isAlive: player.isAlive })),
        events: input.events.map(({ event }) => event),
      }),
    };
    return parseGeneration(await this.client.complete(prompt));
  }
}
