import type { ViewerContext, StoredEvent } from '../../shared/events';
import type {
  PostGameReviewView,
  ReviewEvidenceRef,
  ReviewMessage,
  ReviewTimelineEntry,
} from '../../shared/reviewContract';
import type { Role } from '../../shared/types';
import type { ReviewJobRecord } from './reviewRepository';

const clone = <T>(value: T): T => structuredClone(value);
const isOmniscient = (viewer: ViewerContext): boolean =>
  viewer.kind === 'spectator' && viewer.omniscient;
const teamOf = (role: Role): 'wolf' | 'good' => role === 'wolf' ? 'wolf' : 'good';

const cleanText = (value: unknown, max = 240): string =>
  typeof value === 'string'
    ? [...value]
        .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character)
        .join('')
        .replace(/[<>]/g, '').trim().slice(0, max)
    : '';

const payloadOf = (event: StoredEvent): Record<string, unknown> =>
  event.event.payload as Record<string, unknown>;

const safeSummary = (stored: StoredEvent, omniscient: boolean): string => {
  const event = stored.event;
  const payload = payloadOf(stored);
  if (event.eventType === 'day.speech' || (omniscient && event.eventType === 'wolf.message')) {
    const content = cleanText(payload.content);
    return content ? `发言：${content}` : '发言记录';
  }
  if (event.eventType === 'game.ended') {
    const winner = payload.winner === 'wolf' ? '狼人阵营' : payload.winner === 'good' ? '好人阵营' : '平局';
    return `对局结束，${winner}获胜`;
  }
  const labels: Record<string, string> = {
    'game.started': '对局开始',
    'day.started': '进入白天',
    'night.started': '进入夜晚',
    'night.resolved': '夜间结算完成',
    'day.voting_started': '放逐投票开始',
    'day.vote_cast': '公开投票记录',
    'day.exiled': '投票结果已结算',
    'day.no_exile': '本轮无人出局',
    'day.revote_required': '本轮需要重新投票',
    'hunter.shot': '猎人行动已结算',
    'hunter.shot_skipped': '猎人选择不开枪',
    'day.speech_skipped': '本轮发言被跳过',
    'stage.timed_out': '阶段按超时规则结算',
  };
  return labels[event.eventType] ?? '对局事件已记录';
};

const evidenceFor = (
  refs: readonly ReviewEvidenceRef[],
  allowed: Set<string>,
): ReviewEvidenceRef[] => refs
  .filter((ref) => allowed.has(ref.eventId))
  .map((ref) => ({ eventId: ref.eventId, eventType: ref.eventType, sequence: ref.sequence }));

const messageVisible = (message: ReviewMessage, viewer: ViewerContext): boolean => {
  if (isOmniscient(viewer) || message.audience === 'public') return true;
  if (viewer.kind !== 'player') return false;
  if (message.audience === 'role') return message.role === viewer.role;
  return message.team === teamOf(viewer.role);
};

const eventVisible = (stored: StoredEvent, viewer: ViewerContext): boolean => {
  const event = stored.event;
  if (event.visibility === 'public_timeline') return true;
  if (isOmniscient(viewer)) return true;
  if (viewer.kind !== 'player') return false;
  if (event.visibility === 'role_private') {
    return (event.audienceIds ?? []).includes(viewer.playerId);
  }
  return viewer.role === 'wolf' && (event.audienceIds ?? []).includes(viewer.playerId);
};

export const projectReview = (
  job: ReviewJobRecord,
  viewer: ViewerContext,
): PostGameReviewView => {
  const omniscient = isOmniscient(viewer);
  const allowedEvents = job.archive.events.filter((stored) => eventVisible(stored, viewer));
  const allowedIds = new Set(allowedEvents.map(({ event }) => event.eventId));
  const timeline: ReviewTimelineEntry[] = allowedEvents
    .filter(({ event }) => event.eventType !== 'game.state_updated')
    .map((stored) => ({
      eventId: stored.event.eventId,
      eventType: stored.event.eventType,
      sequence: stored.event.sequence,
      occurredAt: stored.event.occurredAt,
      summary: safeSummary(stored, omniscient),
    }));

  const messages = job.messages
    .filter((message) => messageVisible(message, viewer))
    .map((message) => ({
      ...clone(message),
      evidence: evidenceFor(message.evidence, allowedIds),
    }));
  const insights = job.insights
    .filter((insight) =>
      omniscient || viewer.kind === 'player' && insight.role === viewer.role,
    )
    .map((insight) => ({
      ...clone(insight),
      evidence: evidenceFor(insight.evidence, allowedIds),
    }));

  return {
    gameId: job.gameId,
    roomId: job.roomId,
    status: job.status,
    enabled: job.enabled,
    generationMode: job.generationMode ?? 'rules',
    operationId: job.operationId ?? `review:${job.gameId}:${job.generationMode ?? 'rules'}`,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    timeline,
    messages,
    insights,
    updatedAt: job.updatedAt,
  };
};
