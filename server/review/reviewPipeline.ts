import type { EventStore, StoredEvent, ViewerContext } from '../../shared/events';
import { createHash } from 'node:crypto';
import type {
  ReviewArchivePlayer,
  ReviewEvidenceRef,
  ReviewInsight,
  ReviewMessage,
  ReviewTeam,
  ReviewGenerationMode,
  ReviewRound,
} from '../../shared/reviewContract';
import { isEvidenceBackedInsight } from '../../shared/experienceReview';
import type { Role } from '../../shared/types';
import { InMemoryInsightStore, type InsightStore, type ServerInsightRecord } from './insightStore';
import { projectReview } from './reviewProjector';
import type {
  CanonicalReviewArchive,
  ReviewJobRecord,
  ReviewRepository,
} from './reviewRepository';

export interface ReviewMessageDraft {
  text: string;
  audience: 'public' | 'team' | 'role';
  team?: ReviewTeam;
  role?: Role;
  evidenceEventIds: string[];
  round?: ReviewRound;
  playerId?: string;
  operationId?: string;
}

export interface ReviewInsightDraft {
  role: Role;
  text: string;
  evidenceEventIds: string[];
  round?: ReviewRound;
  playerId?: string;
  experienceInstanceId?: string;
  experienceUpdate?: string;
  operationId?: string;
}

export interface ReviewGeneration {
  messages: ReviewMessageDraft[];
  insights: ReviewInsightDraft[];
}

export interface ReviewGeneratorInput {
  archive: CanonicalReviewArchive;
  events: StoredEvent[];
}

export interface ReviewGenerator {
  generate(input: ReviewGeneratorInput): Promise<ReviewGeneration>;
}

const ROLE_ORDER: Role[] = ['wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager'];
const clone = <T>(value: T): T => structuredClone(value);
const text = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const safe = [...value]
    .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character)
    .join('');
  return safe.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
};

const refFor = (stored: StoredEvent): ReviewEvidenceRef => ({
  eventId: stored.event.eventId,
  eventType: stored.event.eventType,
  sequence: stored.event.sequence,
});

/** Safe local fallback used when no external review provider is configured. */
export class RulesReviewGenerator implements ReviewGenerator {
  async generate(input: ReviewGeneratorInput): Promise<ReviewGeneration> {
    const publicEvents = input.events.filter(({ event }) => event.visibility === 'public_timeline');
    const ended = publicEvents.find(({ event }) => event.eventType === 'game.ended') ?? input.events.at(-1);
    const vote = [...publicEvents].reverse().find(({ event }) =>
      event.eventType === 'day.exiled' || event.eventType === 'day.no_exile',
    );
    const endedRef = ended ? refFor(ended) : undefined;
    const voteRef = vote ? refFor(vote) : endedRef;
    const messages: ReviewMessageDraft[] = endedRef
      ? [{
          text: '本局复盘基于服务端完整事件流生成，结果与时间线已归档。',
          audience: 'public',
          round: 'global',
          evidenceEventIds: [endedRef.eventId],
        }]
      : [];
    const roles = [...new Set(input.archive.players.map((player) => player.role).filter((role): role is Role => role !== null))];
    const insights: ReviewInsightDraft[] = roles.flatMap((role) => {
      const roleEvent = [...input.events].reverse().find(({ event }) =>
        event.visibility === 'public_timeline' ||
        (event.visibility === 'role_private' && (event.audienceIds ?? []).some((id) =>
          input.archive.players.some((player) => player.id === id && player.role === role),
        )) ||
        (role === 'wolf' && event.visibility === 'wolf_private'),
      );
      const evidence = roleEvent ?? vote ?? ended;
      if (!evidence) return [];
      const anchor = evidence.event.eventType === 'day.exiled' || evidence.event.eventType === 'day.no_exile'
        ? '公开投票结果'
        : evidence.event.eventType === 'seer.result'
          ? '查验结果'
          : evidence.event.eventType === 'wolf.kill_locked'
            ? '狼刀决定'
            : '行动记录';
      const evidenceDay = typeof (evidence.event.payload as { day?: unknown }).day === 'number'
        ? (evidence.event.payload as { day: number }).day
        : 1;
      return [{
        role,
        round: 'team',
        text: `复盘第${evidenceDay}天${anchor}时，阵营应把已知信息与后续行动一起核对。`,
        evidenceEventIds: [evidence.event.eventId],
      }];
    });
    if (voteRef && roles.length > 0) {
      messages.push({
        text: '公开投票与行动记录已保留，下一局先核对事实，再决定是否收紧判断。',
        audience: 'team',
        team: 'good',
        round: 'team',
        evidenceEventIds: [voteRef.eventId],
      });
    }
    const aiPlayers = input.archive.players.filter((player) => player.isAI && player.role);
    for (const player of aiPlayers) {
      const visible = input.events.filter(({ event }) =>
        event.visibility === 'public_timeline' ||
        (event.visibility === 'role_private' && (event.audienceIds ?? []).includes(player.id)) ||
        (player.role === 'wolf' && event.visibility === 'wolf_private' && (event.audienceIds ?? []).includes(player.id)),
      );
      const evidence = visible.at(-1) ?? ended;
      if (!evidence) continue;
      const day = typeof (evidence.event.payload as { day?: unknown }).day === 'number'
        ? (evidence.event.payload as { day: number }).day
        : 1;
      const anchor = anchorFor(evidence);
      messages.push({
        text: '个人复盘已生成：保留可验证事实，下一局只更新自己的经验版本。',
        audience: 'role',
        role: player.role!,
        round: 'self',
        evidenceEventIds: [evidence.event.eventId],
      });
      insights.push({
        role: player.role!,
        playerId: player.id,
        experienceInstanceId: player.experienceInstanceId,
        round: 'self' as const,
        text: `第${day}天${anchor}后，应复核自己的行动与结果。`,
        experienceUpdate: `第${day}天${anchor}后，先核对行动结果再调整判断。`,
        evidenceEventIds: [evidence.event.eventId],
      });
    }
    return { messages, insights };
  }
}

const anchorFor = (evidence: StoredEvent): string => {
  switch (evidence.event.eventType) {
    case 'day.exiled':
    case 'day.no_exile': return '公开投票';
    case 'seer.result': return '查验结果';
    case 'wolf.kill_locked': return '狼刀决定';
    default: return '行动记录';
  }
};

/** Compatibility name for older in-process tests; production selects rules mode explicitly. */
export class DeterministicReviewGenerator extends RulesReviewGenerator {}

export interface ReviewPipelineOptions {
  now?: () => number;
  generator?: ReviewGenerator;
  insightStore?: InsightStore;
  runningTimeoutMs?: number;
  defaultGenerationMode?: ReviewGenerationMode;
  aiGenerator?: ReviewGenerator;
  rulesGenerator?: ReviewGenerator;
}

export interface ReviewEnqueueInput {
  gameId: string;
  roomId: string;
  reviewEnabled: boolean;
  generationMode?: ReviewGenerationMode;
}

export class ReviewPipeline {
  private readonly generator: ReviewGenerator;
  private readonly now: () => number;
  private readonly runningTimeoutMs: number;
  private readonly insightStore: InsightStore;
  private readonly defaultGenerationMode: ReviewGenerationMode;
  private readonly aiGenerator?: ReviewGenerator;
  private readonly rulesGenerator: ReviewGenerator;
  private readonly active = new Map<string, Promise<ReviewJobRecord | undefined>>();
  private closed = false;

  constructor(
    private readonly eventStore: EventStore,
    private readonly repository: ReviewRepository,
    private readonly options: ReviewPipelineOptions,
  ) {
    this.generator = options.generator ?? options.rulesGenerator ?? new RulesReviewGenerator();
    this.rulesGenerator = options.rulesGenerator ?? this.generator;
    this.aiGenerator = options.aiGenerator ?? (options.generator ? options.generator : undefined);
    this.defaultGenerationMode = options.defaultGenerationMode ?? 'rules';
    this.now = options.now ?? Date.now;
    this.runningTimeoutMs = options.runningTimeoutMs ?? 60_000;
    this.insightStore = options.insightStore ?? new InMemoryInsightStore();
  }

  async enqueue(input: ReviewEnqueueInput): Promise<ReviewJobRecord> {
    const generationMode = input.generationMode ?? this.defaultGenerationMode;
    const existing = await this.repository.get(input.gameId);
    if (existing) {
      if (existing.enabled !== input.reviewEnabled) {
        // The room configuration is authoritative at the end transition. A
        // duplicate callback must never change a previously committed job.
        return existing;
      }
      if ((existing.generationMode ?? 'rules') !== generationMode) return existing;
      void this.process(input.gameId);
      return existing;
    }
    const archive = await this.buildArchive(input.gameId, input.roomId);
    const result = await this.repository.createPending({
      gameId: input.gameId,
      roomId: input.roomId,
      enabled: input.reviewEnabled,
      generationMode,
      operationId: `review:${input.gameId}:${generationMode}`,
      archive,
    });
    void this.process(input.gameId);
    return result.job;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.active.values());
    this.active.clear();
  }

  async process(gameId: string): Promise<ReviewJobRecord | undefined> {
    if (this.closed) return this.repository.get(gameId);
    const current = this.active.get(gameId);
    if (current) return current;
    const run = this.processOnce(gameId).finally(() => this.active.delete(gameId));
    this.active.set(gameId, run);
    return run;
  }

  async restore(): Promise<void> {
    const now = this.now();
    const jobs = await this.repository.list();
    await Promise.all(
      jobs
        .filter((job) =>
          job.status === 'pending' ||
          job.status === 'running' && now - (job.runningSince ?? 0) >= this.runningTimeoutMs,
        )
        .map((job) => this.process(job.gameId)),
    );
  }

  async get(gameId: string): Promise<ReviewJobRecord | undefined> {
    return this.repository.get(gameId);
  }

  /** Remove terminal review data after the owning room leaves retention. */
  async remove(gameId: string): Promise<void> {
    const active = this.active.get(gameId);
    if (active) await Promise.allSettled([active]);
    this.active.delete(gameId);
    await this.repository.remove?.(gameId);
  }

  /** Explicit operator retry; result-page reads do not invoke this method. */
  async retry(gameId: string): Promise<ReviewJobRecord | undefined> {
    const job = await this.repository.get(gameId);
    if (!job) return undefined;
    if (job.status === 'completed' || job.status === 'disabled') return job;
    await this.repository.save({ ...job, status: 'pending', runningSince: undefined, errorCode: undefined });
    return this.process(gameId);
  }

  async view(gameId: string, viewer: ViewerContext): Promise<ReturnType<typeof projectReview> | undefined> {
    const job = await this.repository.get(gameId);
    return job ? projectReview(job, viewer) : undefined;
  }

  /** Only a player can clear the experience for that player's own role. */
  async clearInsights(viewer: ViewerContext, role?: Role): Promise<void> {
    if (viewer.kind !== 'player') throw new Error('REVIEW_INSIGHT_CLEAR_FORBIDDEN');
    if (role && role !== viewer.role) throw new Error('REVIEW_INSIGHT_CLEAR_FORBIDDEN');
    await this.insightStore.clear(viewer.role, viewer.playerId);
  }

  private async processOnce(gameId: string): Promise<ReviewJobRecord | undefined> {
    let job = await this.repository.get(gameId);
    if (!job) return undefined;
    if (job.status === 'completed' || job.status === 'disabled') return job;
    job = await this.repository.save({
      ...job,
      status: 'running',
      runningSince: this.now(),
      attempts: job.attempts + 1,
      errorCode: undefined,
    });
    if (!job.enabled) {
      return this.repository.save({ ...job, status: 'disabled', runningSince: undefined });
    }
    try {
      const generator = job.generationMode === 'ai'
        ? this.aiGenerator
        : this.rulesGenerator;
      if (!generator && job.generationMode === 'ai') {
        // A god-view archive is still useful without an LLM. Complete the job
        // with no generated copy so the UI can explicitly say it degraded.
        return this.repository.save({
          ...job,
          status: 'completed',
          messages: [],
          insights: [],
          runningSince: undefined,
          errorCode: undefined,
        });
      }
      if (!generator) throw new Error('REVIEW_GENERATOR_UNAVAILABLE');
      const generated = await generator.generate({
        archive: clone(job.archive),
        events: clone(job.archive.events),
      });
      const eventsById = new Map(job.archive.events.map((stored) => [stored.event.eventId, stored]));
      const messages = generated.messages
        .map((draft, index) => this.validMessage(draft, index, eventsById))
        .filter((message): message is ReviewMessage => message !== undefined);
      const insights: ReviewInsight[] = [];
      const insightKeys = new Set<string>();
      for (const [index, draft] of generated.insights.entries()) {
        const key = `${draft.round ?? 'team'}:${draft.playerId ?? draft.role}`;
        if (insightKeys.has(key)) continue;
        const insight = this.validInsight(draft, index, eventsById, job);
        if (!insight) continue;
        insightKeys.add(key);
        insights.push(insight);
        if (insight.round === 'self' && insight.playerId && insight.experienceInstanceId && insight.experienceUpdate) {
          await this.insightStore.add({
            id: `${insight.id}:experience`,
            role: insight.role,
            text: insight.experienceUpdate,
            evidenceEventIds: insight.evidence.map((ref) => ref.eventId),
            gameId: job.gameId,
            createdAt: insight.createdAt,
            schemaVersion: 2,
            scope: 'agent',
            playerId: insight.playerId,
            experienceInstanceId: insight.experienceInstanceId,
          });
        } else {
          await this.insightStore.add({
          id: insight.id,
          role: insight.role,
          text: insight.text,
          evidenceEventIds: insight.evidence.map((ref) => ref.eventId),
          gameId: job.gameId,
          createdAt: insight.createdAt,
            schemaVersion: 2,
            scope: 'shared',
          } satisfies ServerInsightRecord);
        }
      }
      return this.repository.save({
        ...job,
        status: 'completed',
        messages,
        insights,
        runningSince: undefined,
        errorCode: undefined,
      });
    } catch (error) {
      const errorCode = error instanceof Error && error.message.startsWith('REVIEW_')
        ? error.message.split(':')[0]
        : 'REVIEW_GENERATION_FAILED';
      return this.repository.save({
        ...job,
        status: 'failed',
        runningSince: undefined,
        errorCode,
      });
    }
  }

  private async buildArchive(gameId: string, roomId: string): Promise<CanonicalReviewArchive> {
    const events = (await this.eventStore.read(`game:${gameId}`)).sort(
      (left, right) => left.event.sequence - right.event.sequence,
    );
    const ended = [...events].reverse().find(({ event }) => event.eventType === 'game.ended');
    if (!ended) throw new Error('REVIEW_GAME_NOT_ENDED');
    const state = [...events].reverse().find(({ event }) => event.eventType === 'game.state_updated');
    const sessionState = state?.event.payload && typeof state.event.payload === 'object'
      ? (state.event.payload as { sessionState?: { aiExperiences?: Record<string, { experienceInstanceId?: string; assetId?: string; baseText?: string; updatedText?: string }> } }).sessionState
      : undefined;
    const players = Array.isArray(state?.event.payload.players)
      ? (state!.event.payload.players as ReviewArchivePlayer[]).map((player) => ({
          id: player.id,
          name: player.name,
          role: player.role,
          isAI: Boolean(player.isAI),
          isAlive: Boolean(player.isAlive),
          order: Number(player.order ?? 0),
          ...(sessionState?.aiExperiences?.[player.id]?.experienceInstanceId
            ? {
                experienceInstanceId: sessionState.aiExperiences[player.id].experienceInstanceId,
                experienceAssetId: sessionState.aiExperiences[player.id].assetId,
                experienceText: sessionState.aiExperiences[player.id].updatedText
                  ?? sessionState.aiExperiences[player.id].baseText
                  ?? '',
              }
            : {}),
        }))
      : [];
    const winner = ended.event.payload.winner === 'wolf' || ended.event.payload.winner === 'good'
      ? ended.event.payload.winner
      : 'draw';
    const started = events.find(({ event }) => event.eventType === 'game.started');
    return {
      gameId,
      roomId,
      operationId: `review-archive:${gameId}:${createHash('sha256').update(JSON.stringify(events)).digest('hex')}`,
      streamId: `game:${gameId}`,
      contentHash: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
      startedAt: started?.event.occurredAt ?? events[0]?.event.occurredAt ?? this.now(),
      endedAt: ended.event.occurredAt,
      winner,
      players,
      events: clone(events),
      sourceEventIds: events.map(({ event }) => event.eventId),
    };
  }

  private validMessage(
    draft: ReviewMessageDraft,
    index: number,
    eventsById: Map<string, StoredEvent>,
  ): ReviewMessage | undefined {
    const messageText = text(draft.text);
    if (!messageText || !Array.isArray(draft.evidenceEventIds)) return undefined;
    const refs = this.refs(draft.evidenceEventIds, eventsById);
    if (refs.length === 0) return undefined;
    if (draft.audience === 'team' && draft.team !== 'wolf' && draft.team !== 'good') return undefined;
    if (draft.audience === 'role' && !ROLE_ORDER.includes(draft.role as Role)) return undefined;
    if (draft.audience === 'public' && refs.some((ref) => eventsById.get(ref.eventId)?.event.visibility !== 'public_timeline')) return undefined;
    return {
      id: `review-message:${index}:${refs[0].eventId}`,
      operationId: draft.operationId ?? `review-message:${eventsById.get(refs[0].eventId)?.event.gameId ?? 'unknown'}:${index}`,
      text: messageText,
      audience: draft.audience,
      ...(draft.team ? { team: draft.team } : {}),
      ...(draft.role ? { role: draft.role } : {}),
      ...(draft.round ? { round: draft.round } : {}),
      ...(draft.playerId ? { playerId: draft.playerId } : {}),
      evidence: refs,
    };
  }

  private validInsight(
    draft: ReviewInsightDraft,
    index: number,
    eventsById: Map<string, StoredEvent>,
    job: ReviewJobRecord,
  ): ReviewInsight | undefined {
    const insightText = text(draft.text);
    if (!ROLE_ORDER.includes(draft.role) || !insightText || !Array.isArray(draft.evidenceEventIds)) return undefined;
    const playerNames = job.archive.players.map((player) => player.name.trim()).filter((name) => name.length >= 2);
    if (playerNames.some((name) => insightText.includes(name))) return undefined;
    if (draft.round === 'self' && (!draft.playerId || !draft.experienceInstanceId)) return undefined;
    if (draft.round === 'self') {
      const owner = job.archive.players.find((player) => player.id === draft.playerId && player.isAI);
      if (!owner || owner.role !== draft.role || owner.experienceInstanceId !== draft.experienceInstanceId) return undefined;
    }
    const refs = this.refs(draft.evidenceEventIds, eventsById);
    if (refs.length === 0) return undefined;
    // An event id alone is not a transferable lesson. Require a concrete
    // event anchor so generic advice and hallucinated conclusions do not enter
    // the cross-game prompt context.
    if (!isEvidenceBackedInsight(insightText)) {
      return undefined;
    }
    return {
      id: `review-insight:${job.gameId}:${draft.role}:${index}`,
      operationId: draft.operationId ?? `review-insight:${job.operationId}:${draft.role}`,
      role: draft.role,
      ...(draft.round ? { round: draft.round } : {}),
      ...(draft.playerId ? { playerId: draft.playerId } : {}),
      ...(draft.experienceInstanceId ? { experienceInstanceId: draft.experienceInstanceId } : {}),
      text: insightText,
      ...(draft.experienceUpdate ? { experienceUpdate: text(draft.experienceUpdate) } : {}),
      evidence: refs,
      createdAt: job.archive.endedAt,
    };
  }

  private refs(ids: readonly string[], eventsById: Map<string, StoredEvent>): ReviewEvidenceRef[] {
    return [...new Set(ids)]
      .map((id) => eventsById.get(id))
      .filter((event): event is StoredEvent => event !== undefined)
      .map(refFor);
  }
}
