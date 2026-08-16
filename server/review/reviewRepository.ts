import type { StoredEvent } from '../../shared/events';
import type {
  PostGameReviewView,
  ReviewArchivePlayer,
  ReviewInsight,
  ReviewJobStatus,
  ReviewMessage,
  ReviewGenerationMode,
} from '../../shared/reviewContract';

export interface CanonicalReviewArchive {
  gameId: string;
  roomId: string;
  operationId: string;
  /** Canonical source; the event bytes live in the durable event segments. */
  streamId?: string;
  contentHash?: string;
  startedAt: number;
  endedAt: number;
  winner: 'wolf' | 'good' | 'draw' | null;
  players: ReviewArchivePlayer[];
  /** Complete authoritative stream. This field is never projected directly. */
  events: StoredEvent[];
  sourceEventIds: string[];
}

export interface ReviewJobRecord {
  gameId: string;
  roomId: string;
  enabled: boolean;
  generationMode: ReviewGenerationMode;
  operationId: string;
  status: ReviewJobStatus;
  archive: CanonicalReviewArchive;
  messages: ReviewMessage[];
  insights: ReviewInsight[];
  attempts: number;
  createdAt: number;
  updatedAt: number;
  runningSince?: number;
  errorCode?: string;
}

export interface ReviewRepository {
  list(): Promise<ReviewJobRecord[]>;
  get(gameId: string): Promise<ReviewJobRecord | undefined>;
  /** Atomic by gameId; retries return the original durable job. */
  createPending(
    job: Omit<ReviewJobRecord, 'status' | 'messages' | 'insights' | 'attempts' | 'createdAt' | 'updatedAt' | 'generationMode' | 'operationId'> &
      Partial<Pick<ReviewJobRecord, 'generationMode' | 'operationId'>> &
      Partial<Pick<ReviewJobRecord, 'messages' | 'insights'>>,
  ): Promise<{ job: ReviewJobRecord; created: boolean }>;
  save(job: ReviewJobRecord): Promise<ReviewJobRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryReviewRepository implements ReviewRepository {
  private readonly jobs = new Map<string, ReviewJobRecord>();

  async list(): Promise<ReviewJobRecord[]> {
    return [...this.jobs.values()].map(clone);
  }

  async get(gameId: string): Promise<ReviewJobRecord | undefined> {
    const job = this.jobs.get(gameId);
    return job ? clone(job) : undefined;
  }

  async createPending(
    input: Parameters<ReviewRepository['createPending']>[0],
  ): Promise<{ job: ReviewJobRecord; created: boolean }> {
    const existing = this.jobs.get(input.gameId);
    if (existing) return { job: clone(existing), created: false };
    const now = Date.now();
    const job: ReviewJobRecord = {
      ...clone(input),
      generationMode: input.generationMode ?? 'rules',
      operationId: input.operationId ?? `review:${input.gameId}:${input.generationMode ?? 'rules'}`,
      status: 'pending',
      messages: clone(input.messages ?? []),
      insights: clone(input.insights ?? []),
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.gameId, job);
    return { job: clone(job), created: true };
  }

  async save(job: ReviewJobRecord): Promise<ReviewJobRecord> {
    const next = clone({ ...job, updatedAt: Date.now() });
    this.jobs.set(next.gameId, next);
    return clone(next);
  }
}

/** Convert an internal job to a deliberately small transport view. */
export const reviewViewFromJob = (job: ReviewJobRecord): PostGameReviewView => ({
  gameId: job.gameId,
  roomId: job.roomId,
  status: job.status,
  enabled: job.enabled,
  generationMode: job.generationMode ?? 'rules',
  operationId: job.operationId ?? `review:${job.gameId}:${job.generationMode ?? 'rules'}`,
  ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  timeline: [],
  messages: clone(job.messages),
  insights: clone(job.insights),
  updatedAt: job.updatedAt,
});
