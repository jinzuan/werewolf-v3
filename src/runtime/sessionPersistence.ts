import {
  V3_SESSION_KEY,
  type V3Session,
} from '../v3/session';

export const SESSION_CURSOR_FLUSH_MS = 250;
export const MAX_SESSION_SERIALIZED_BYTES = 16 * 1024;

type SessionStorage = Pick<Storage, 'setItem' | 'removeItem'>;
type StorageSource = SessionStorage | (() => SessionStorage | null);
type EventTargetLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface SessionPersistenceStats {
  writeCount: number;
  totalWriteLatencyMs: number;
  lastWriteLatencyMs: number;
  lastSerializedBytes: number;
  lastError: string | null;
}

export interface SessionPersistenceOptions {
  storage?: StorageSource;
  eventTarget?: EventTargetLike | null;
  flushIntervalMs?: number;
  maxSerializedBytes?: number;
  now?: () => number;
  setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

const browserStorage = (): SessionStorage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

const browserEvents = (): EventTargetLike[] => [
  ...(typeof document === 'undefined' ? [] : [document]),
  ...(typeof window === 'undefined' ? [] : [window]),
];

const byteLength = (value: string): number => {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length;
};

const defaultNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * Keeps the durable browser session small and separates identity writes from
 * the high-frequency event cursor. A cursor write is deliberately lossy only
 * within the current flush window: the next replay starts from the last
 * durable cursor and eventStream's sequence checks make replay idempotent.
 */
export class SessionPersistenceWriter {
  private readonly storage: StorageSource;
  private readonly eventTargets: EventTargetLike[];
  private readonly flushIntervalMs: number;
  private readonly maxSerializedBytes: number;
  private readonly now: () => number;
  private readonly schedule: NonNullable<SessionPersistenceOptions['setTimeout']>;
  private readonly cancel: NonNullable<SessionPersistenceOptions['clearTimeout']>;
  private pendingCursor: V3Session | null = null;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private stats: SessionPersistenceStats = {
    writeCount: 0,
    totalWriteLatencyMs: 0,
    lastWriteLatencyMs: 0,
    lastSerializedBytes: 0,
    lastError: null,
  };

  private readonly flushOnLifecycle = (): void => {
    this.flush();
  };

  constructor(options: SessionPersistenceOptions = {}) {
    this.storage = options.storage ?? browserStorage;
    this.eventTargets = options.eventTarget === undefined
      ? browserEvents()
      : options.eventTarget ? [options.eventTarget] : [];
    this.flushIntervalMs = options.flushIntervalMs ?? SESSION_CURSOR_FLUSH_MS;
    this.maxSerializedBytes = options.maxSerializedBytes ?? MAX_SESSION_SERIALIZED_BYTES;
    this.now = options.now ?? defaultNow;
    this.schedule = options.setTimeout ?? ((handler, timeout) => globalThis.setTimeout(handler, timeout));
    this.cancel = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
  }

  start(): this {
    if (this.started || this.disposed) return this;
    this.started = true;
    for (const target of this.eventTargets) {
      target.addEventListener('visibilitychange', this.flushOnLifecycle);
      target.addEventListener('pagehide', this.flushOnLifecycle);
    }
    return this;
  }

  /** Identity and credential changes must survive a crash immediately. */
  persistIdentity(session: V3Session | null): void {
    if (this.disposed) return;
    this.cancelPendingTimer();
    this.write(session);
  }

  /** Coalesce cursor-only updates; the newest session always wins. */
  scheduleCursor(session: V3Session): void {
    if (this.disposed) return;
    this.pendingCursor = session;
    if (this.timer !== null) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
  }

  flush(): void {
    this.cancelPendingTimerOnly();
    const pending = this.pendingCursor;
    this.pendingCursor = null;
    if (pending) this.write(pending);
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    for (const target of this.eventTargets) {
      target.removeEventListener('visibilitychange', this.flushOnLifecycle);
      target.removeEventListener('pagehide', this.flushOnLifecycle);
    }
    this.started = false;
    this.disposed = true;
  }

  getStats(): SessionPersistenceStats {
    return { ...this.stats };
  }

  private cancelPendingTimer(): void {
    this.cancelPendingTimerOnly();
    this.pendingCursor = null;
  }

  private cancelPendingTimerOnly(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  private write(session: V3Session | null): void {
    const target = typeof this.storage === 'function' ? this.storage() : this.storage;
    if (!target) return;
    const startedAt = this.now();
    let serializedBytes = 0;
    try {
      if (session) {
        const serialized = JSON.stringify(session);
        serializedBytes = byteLength(serialized);
        if (serializedBytes > this.maxSerializedBytes) {
          throw new Error('V3_SESSION_TOO_LARGE');
        }
        target.setItem(V3_SESSION_KEY, serialized);
      } else {
        target.removeItem(V3_SESSION_KEY);
      }
      const latency = Math.max(0, this.now() - startedAt);
      this.stats = {
        ...this.stats,
        writeCount: this.stats.writeCount + 1,
        totalWriteLatencyMs: this.stats.totalWriteLatencyMs + latency,
        lastWriteLatencyMs: latency,
        lastSerializedBytes: serializedBytes,
        lastError: null,
      };
    } catch (error) {
      this.stats = {
        ...this.stats,
        lastSerializedBytes: serializedBytes,
        lastError: error instanceof Error ? error.message : 'V3_SESSION_WRITE_FAILED',
      };
    }
  }
}

let defaultWriter: SessionPersistenceWriter | null = null;

export const getSessionPersistence = (): SessionPersistenceWriter => {
  defaultWriter ??= new SessionPersistenceWriter();
  return defaultWriter;
};

export const startSessionPersistence = (): SessionPersistenceWriter =>
  getSessionPersistence().start();

export const disposeSessionPersistence = (): void => {
  defaultWriter?.dispose();
  defaultWriter = null;
};
