import { AIProviderError } from './types';

export type ProviderQueueErrorCode =
  | 'AI_QUEUE_FULL'
  | 'AI_QUEUE_DEADLINE'
  | 'AI_CANCELLED';

/** A stable, provider-facing error. It deliberately contains no endpoint or room data. */
export class AIQueueError extends AIProviderError {
  readonly code: ProviderQueueErrorCode;

  constructor(code: ProviderQueueErrorCode) {
    super(code, 0);
    this.name = code;
    this.code = code;
  }
}

export interface ProviderQueueStats {
  active: number;
  queued: number;
  capacity: number;
  activeByKey: Record<string, number>;
  queuedByKey: Record<string, number>;
}

export interface ProviderQueueOptions {
  /** Per endpoint/model concurrency. The production default is deliberately small. */
  concurrency?: number;
  /** Total waiting work across all endpoint/model keys. */
  maxQueued?: number;
  /** Waiting work for one endpoint/model key. */
  maxQueuedPerKey?: number;
  enqueueTimeoutMs?: number;
}

export interface ProviderQueueRunOptions {
  signal?: AbortSignal;
  enqueueTimeoutMs?: number;
}

interface QueueItem<T> {
  key: string;
  task: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  controller: AbortController;
  parentSignal?: AbortSignal;
  abortListener?: () => void;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

interface QueueBucket {
  active: number;
  items: QueueItem<unknown>[];
}

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isSafeInteger(value) && value! > 0 ? value! : fallback;

/**
 * Bounded, cancellable work queue shared by all HTTP AI providers in a process.
 * Queued work is removed on stage cancellation or enqueue expiry; it is never
 * allowed to grow as a side effect of a slow upstream endpoint.
 */
export class ProviderQueue {
  private readonly buckets = new Map<string, QueueBucket>();
  private readonly activeItems = new Set<QueueItem<unknown>>();
  private queuedCount = 0;
  private closed = false;
  private readonly listeners = new Set<(stats: ProviderQueueStats) => void>();
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly maxQueuedPerKey: number;
  private readonly enqueueTimeoutMs: number;

  constructor(options: ProviderQueueOptions = {}) {
    this.concurrency = positiveInteger(options.concurrency, 2);
    this.maxQueued = positiveInteger(options.maxQueued, 64);
    this.maxQueuedPerKey = positiveInteger(options.maxQueuedPerKey, 16);
    this.enqueueTimeoutMs = positiveInteger(options.enqueueTimeoutMs, 5_000);
  }

  run<T>(
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
    options: ProviderQueueRunOptions = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new AIQueueError('AI_QUEUE_FULL'));
    if (options.signal?.aborted) {
      return Promise.reject(new AIQueueError('AI_CANCELLED'));
    }

    const bucket = this.buckets.get(key) ?? { active: 0, items: [] };
    this.buckets.set(key, bucket);
    if (bucket.active >= this.concurrency &&
        (this.queuedCount >= this.maxQueued || bucket.items.length >= this.maxQueuedPerKey)) {
      return Promise.reject(new AIQueueError('AI_QUEUE_FULL'));
    }

    const controller = new AbortController();
    const itemPromise = new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        key,
        task,
        resolve,
        reject,
        controller,
        parentSignal: options.signal,
      };
      if (options.signal) {
        item.abortListener = () => {
          if (bucket.items.includes(item as QueueItem<unknown>)) {
            this.removeQueued(item as QueueItem<unknown>, new AIQueueError('AI_CANCELLED'));
          } else {
            controller.abort();
          }
        };
        options.signal.addEventListener('abort', item.abortListener, { once: true });
      }
      const timeoutMs = options.enqueueTimeoutMs ?? this.enqueueTimeoutMs;
      if (bucket.active >= this.concurrency && timeoutMs >= 0) {
        item.deadlineTimer = setTimeout(() => {
          if (bucket.items.includes(item as QueueItem<unknown>)) {
            this.removeQueued(item as QueueItem<unknown>, new AIQueueError('AI_QUEUE_DEADLINE'));
          }
        }, timeoutMs);
      }
      bucket.items.push(item as QueueItem<unknown>);
      this.queuedCount += 1;
      this.emit();
      this.drain(key);
    });
    return itemPromise;
  }

  stats(): ProviderQueueStats {
    const activeByKey: Record<string, number> = {};
    const queuedByKey: Record<string, number> = {};
    let active = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.active > 0) {
        activeByKey[key] = bucket.active;
        active += bucket.active;
      }
      if (bucket.items.length > 0) queuedByKey[key] = bucket.items.length;
    }
    return {
      active,
      queued: this.queuedCount,
      capacity: this.maxQueued,
      activeByKey,
      queuedByKey,
    };
  }

  subscribe(listener: (stats: ProviderQueueStats) => void): () => void {
    this.listeners.add(listener);
    listener(this.stats());
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [key, bucket] of this.buckets) {
      for (const item of [...bucket.items]) {
        this.removeQueued(item, new AIQueueError('AI_CANCELLED'));
      }
      void key;
    }
    for (const item of this.activeItems) item.controller.abort();
    for (const bucket of this.buckets.values()) {
      // Active items are not kept in the waiting array. Their controllers are
      // attached to the task closure and are aborted by drain completion.
      bucket.items.length = 0;
    }
    this.emit();
  }

  private removeQueued(item: QueueItem<unknown>, error: AIQueueError): void {
    const bucket = this.buckets.get(item.key);
    if (!bucket) return;
    const index = bucket.items.indexOf(item);
    if (index < 0) return;
    bucket.items.splice(index, 1);
    this.queuedCount = Math.max(0, this.queuedCount - 1);
    this.cleanupItem(item);
    item.reject(error);
    this.emit();
  }

  private drain(key: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    while (!this.closed && bucket.active < this.concurrency && bucket.items.length > 0) {
      const item = bucket.items.shift()!;
      this.queuedCount = Math.max(0, this.queuedCount - 1);
      bucket.active += 1;
      this.clearDeadline(item);
      this.activeItems.add(item);
      this.emit();
      void Promise.resolve()
        .then(() => item.task(item.controller.signal))
        .then(
          (value) => {
            this.finishActive(item);
            item.resolve(value);
          },
          (error) => {
            this.finishActive(item);
            item.reject(error);
          },
        );
    }
  }

  private finishActive(item: QueueItem<unknown>): void {
    const bucket = this.buckets.get(item.key);
    this.activeItems.delete(item);
    this.cleanupItem(item);
    if (bucket) {
      bucket.active = Math.max(0, bucket.active - 1);
      if (bucket.active === 0 && bucket.items.length === 0) {
        this.buckets.delete(item.key);
      }
    }
    this.emit();
    this.drain(item.key);
  }

  private cleanupItem(item: QueueItem<unknown>): void {
    this.clearDeadline(item);
    if (item.parentSignal && item.abortListener) {
      item.parentSignal.removeEventListener('abort', item.abortListener);
    }
  }

  private clearDeadline(item: QueueItem<unknown>): void {
    if (item.deadlineTimer !== undefined) {
      clearTimeout(item.deadlineTimer);
      item.deadlineTimer = undefined;
    }
  }

  private emit(): void {
    const snapshot = this.stats();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export class AICircuitBreaker {
  private readonly entries = new Map<string, {
    failures: number;
    openedAt: number | null;
    halfOpenInFlight: boolean;
    lastUsed: number;
  }>();
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private useCounter = 0;

  constructor(options: {
    failureThreshold?: number;
    openMs?: number;
    maxEntries?: number;
    now?: () => number;
  } = {}) {
    this.failureThreshold = positiveInteger(options.failureThreshold, 3);
    this.openMs = positiveInteger(options.openMs, 10_000);
    this.maxEntries = positiveInteger(options.maxEntries, 1_024);
    this.now = options.now ?? Date.now;
  }

  allow(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.openedAt === null) return true;
    entry.lastUsed = ++this.useCounter;
    if (this.now() - entry.openedAt < this.openMs) return false;
    if (entry.halfOpenInFlight) return false;
    entry.halfOpenInFlight = true;
    return true;
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Release a half-open probe when the request never reached the provider. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.halfOpenInFlight) entry.halfOpenInFlight = false;
    if (entry) entry.lastUsed = ++this.useCounter;
  }

  recordFailure(key: string): void {
    const entry = this.entries.get(key) ?? {
      failures: 0,
      openedAt: null,
      halfOpenInFlight: false,
      lastUsed: 0,
    };
    entry.failures += 1;
    entry.halfOpenInFlight = false;
    entry.lastUsed = ++this.useCounter;
    if (entry.failures >= this.failureThreshold) entry.openedAt = this.now();
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestUse = Number.POSITIVE_INFINITY;
      for (const [candidateKey, candidate] of this.entries) {
        if (candidate.lastUsed < oldestUse) {
          oldestKey = candidateKey;
          oldestUse = candidate.lastUsed;
        }
      }
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, entry);
  }

  state(key: string): 'closed' | 'open' | 'half_open' {
    const entry = this.entries.get(key);
    if (!entry || entry.openedAt === null) return 'closed';
    if (this.now() - entry.openedAt < this.openMs) return 'open';
    return entry.halfOpenInFlight ? 'half_open' : 'closed';
  }
}

export const defaultProviderQueue = new ProviderQueue();
export const defaultAICircuitBreaker = new AICircuitBreaker();
