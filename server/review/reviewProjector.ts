import type { ViewerContext, StoredEvent } from '../../shared/events';
import type {
  PostGameReviewView,
  ReviewDeathCause,
  ReviewDeathRecord,
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

const stringOf = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const playerIdOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return stringOf(record.playerId) ?? stringOf(record.targetId) ?? stringOf(record.id);
};

const playerNameOf = (id: unknown, names: ReadonlyMap<string, string>): string => {
  const playerId = playerIdOf(id);
  return playerId ? names.get(playerId) ?? '未知玩家' : '空目标';
};

const dayOf = (payload: Record<string, unknown>, fallback = 1): number =>
  typeof payload.day === 'number' && Number.isFinite(payload.day) ? payload.day : fallback;

const voteDetails = (value: unknown, names: ReadonlyMap<string, string>): string => {
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    if (!item || typeof item !== 'object') return '';
    const ballot = item as Record<string, unknown>;
    return `${playerNameOf(ballot.voterId, names)}→${playerNameOf(ballot.targetId, names)}`;
  }).filter(Boolean).join('、');
};

const causeLabel = (cause: unknown): string =>
  cause === 'poison' ? '💊毒' : cause === 'wolf_kill' ? '🌙夜刀' : '出局';

const safeSummary = (
  stored: StoredEvent,
  omniscient: boolean,
  names: ReadonlyMap<string, string>,
): string => {
  const event = stored.event;
  const payload = payloadOf(stored);
  const actor = playerNameOf(event.actorId ?? payload.actorId, names);
  const target = playerNameOf(payload.targetId ?? payload.playerId, names);
  const day = dayOf(payload);
  if (omniscient) {
    if (event.eventType === 'night.started') return `第${day}夜开始`;
    if (event.eventType === 'day.started') return `第${day}天开始`;
    if (event.eventType === 'role.confirmed') return `${actor}已确认身份牌`;
    if (event.eventType === 'guardian.completed') return `守卫守护了${target}`;
    if (event.eventType === 'seer.result') {
      const alignment = payload.alignment === 'wolf' ? '狼人' : payload.alignment === 'good' ? '好人' : '未知阵营';
      return `预言家查验${target}：${alignment}`;
    }
    if (event.eventType === 'witch.kill_notice') {
      return `女巫收到刀口：${playerNameOf(payload.killTargetId ?? payload.targetId, names)}`;
    }
    if (event.eventType === 'witch.completed') {
      const action = payload.action === 'heal' ? '使用解药' : payload.action === 'poison' ? '使用毒药' : '结束行动';
      return `女巫${action}${payload.targetId ? `：${target}` : ''}`;
    }
    if (event.eventType === 'wolf.vote_cast') return `${actor}狼人投票：${target}`;
    if (event.eventType === 'wolf.kill_locked') return `狼人决定夜刀目标：${target}`;
    if (event.eventType === 'day.vote_cast') return `${actor}已提交投票`;
    if (event.eventType === 'day.exile_result' || event.eventType === 'day.revote_required') {
      const details = voteDetails(payload.voteHistory, names);
      return `${event.eventType === 'day.revote_required' ? '平票，准备重投' : '投票结算'}${details ? `：${details}` : ''}`;
    }
    if (event.eventType === 'day.exiled') {
      const details = voteDetails(payload.voteHistory, names);
      return `🗳️第${day}天票出${target}${details ? `（${details}）` : ''}`;
    }
    if (event.eventType === 'hunter.shot') return `🔫猎人开枪带走${target}`;
    if (event.eventType === 'night.resolved') {
      const deaths = Array.isArray(payload.deaths)
        ? payload.deaths.map((id) => playerNameOf(id, names)).join('、')
        : '';
      return `第${day}夜结算：${deaths ? `夜间出局 ${deaths}` : '平安夜'}`;
    }
    if (event.eventType === 'night.resolution_detail') {
      const deaths = Array.isArray(payload.deaths)
        ? payload.deaths.map((item) => {
            const death = item && typeof item === 'object' ? item as Record<string, unknown> : {};
            return `${causeLabel(death.cause)}${playerNameOf(death.playerId, names)}`;
          }).join('、')
        : '';
      const actions = [
        payload.guardedTargetId ? `守护${playerNameOf(payload.guardedTargetId, names)}` : '',
        payload.healedTargetId ? `解药${playerNameOf(payload.healedTargetId, names)}` : '',
        payload.poisonedTargetId ? `毒药${playerNameOf(payload.poisonedTargetId, names)}` : '',
      ].filter(Boolean).join('，');
      return `第${day}夜上帝视角：${deaths || '无死亡'}${actions ? `；${actions}` : ''}`;
    }
  }
  if (event.eventType === 'day.speech' || (omniscient && event.eventType === 'wolf.message')) {
    const content = cleanText(payload.content);
    return content ? `${actor}：${content}` : '发言记录';
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

const projectDeaths = (
  events: readonly StoredEvent[],
  players: readonly { id: string; name: string; role: Role | null }[],
): ReviewDeathRecord[] => {
  const byId = new Map(players.map((player) => [player.id, player]));
  const deaths: ReviewDeathRecord[] = [];
  const seen = new Set<string>();
  const add = (
    playerId: string | null,
    cause: ReviewDeathCause,
    stored: StoredEvent,
    day: number,
  ) => {
    if (!playerId || seen.has(playerId)) return;
    const player = byId.get(playerId);
    if (!player) return;
    seen.add(playerId);
    deaths.push({
      playerId,
      name: player.name,
      role: player.role,
      cause,
      day,
      sequence: stored.event.sequence,
      eventId: stored.event.eventId,
      occurredAt: stored.event.occurredAt,
    });
  };
  for (const stored of events) {
    const event = stored.event;
    const payload = payloadOf(stored);
    const day = dayOf(payload);
    if (event.eventType === 'night.resolution_detail' && Array.isArray(payload.deaths)) {
      for (const item of payload.deaths) {
        const death = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        add(playerIdOf(death.playerId), death.cause === 'poison' ? 'poison' : 'night_kill', stored, day);
      }
    } else if (event.eventType === 'night.resolved' && Array.isArray(payload.deaths)) {
      for (const item of payload.deaths) add(playerIdOf(item), 'night_kill', stored, day);
    } else if (event.eventType === 'day.exiled') {
      add(playerIdOf(payload.playerId), 'vote', stored, day);
    } else if (event.eventType === 'hunter.shot') {
      add(playerIdOf(payload.targetId), 'hunter_shot', stored, day);
    }
  }
  return deaths.sort((left, right) => left.sequence - right.sequence);
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
  if (message.playerId) return message.playerId === viewer.playerId;
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
      summary: safeSummary(stored, omniscient, new Map(job.archive.players.map((player) => [player.id, player.name]))),
    }));

  const messages = job.messages
    .filter((message) => messageVisible(message, viewer))
    .map((message) => ({
      ...clone(message),
      evidence: evidenceFor(message.evidence, allowedIds),
    }));
  const insights = job.insights
    .filter((insight) =>
      omniscient || viewer.kind === 'player' && (
        insight.playerId ? insight.playerId === viewer.playerId : insight.role === viewer.role
      ),
    )
    .map((insight) => ({
      ...clone(insight),
      evidence: evidenceFor(insight.evidence, allowedIds),
    }));

  const result: PostGameReviewView = {
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
  if (omniscient) {
    result.omniscient = true;
    result.players = clone(job.archive.players);
    result.deaths = projectDeaths(job.archive.events, job.archive.players);
  }
  return result;
};
