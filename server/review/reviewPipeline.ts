import type { EventStore, StoredEvent, ViewerContext } from '../../shared/events';
import { createHash } from 'node:crypto';
import type {
  ReviewArchivePlayer,
  ReviewEvidenceRef,
  ReviewInsight,
  ReviewMessage,
  ReviewTeam,
  ReviewGenerationMode,
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
  operationId?: string;
}

export interface ReviewInsightDraft {
  role: Role;
  text: string;
  evidenceEventIds: string[];
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
          evidenceEventIds: [endedRef.eventId],
        }]
      : [];
    const roles = [...new Set(input.archive.players.map((player) => player.role).filter((role): role is Role => role !== null))];
    const insights = roles.flatMap((role) => {
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
        text: `复盘第${evidenceDay}天${anchor}时，应把服务端记录与后续行动一起核对。`,
        evidenceEventIds: [evidence.event.eventId],
      }];
    });
    if (voteRef && roles.length > 0) {
      messages.push({
        text: '公开投票与行动记录已保留，后续判断应以已发生的服务端事件为依据。',
        audience: 'team',
        team: 'good',
        evidenceEventIds: [voteRef.eventId],
      });
    }
    return { messages, insights };
  }
}

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
    await this.insightStore.clear(viewer.role);
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
      const insightRoles = new Set<Role>();
      for (const [index, draft] of generated.insights.entries()) {
        if (insightRoles.has(draft.role)) continue;
        const insight = this.validInsight(draft, index, eventsById, job);
        if (!insight) continue;
        insightRoles.add(draft.role);
        insights.push(insight);
        await this.insightStore.add({
          id: insight.id,
          role: insight.role,
          text: insight.text,
          evidenceEventIds: insight.evidence.map((ref) => ref.eventId),
          gameId: job.gameId,
          createdAt: insight.createdAt,
          schemaVersion: 1,
        } satisfies ServerInsightRecord);
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
    const players = Array.isArray(state?.event.payload.players)
      ? (state!.event.payload.players as ReviewArchivePlayer[]).map((player) => ({
          id: player.id,
          name: player.name,
          role: player.role,
          isAI: Boolean(player.isAI),
          isAlive: Boolean(player.isAlive),
          order: Number(player.order ?? 0),
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
      text: insightText,
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
