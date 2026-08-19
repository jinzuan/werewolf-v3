import { PersistenceError } from './errors';

export const DEFAULT_EVENT_LIMIT = 10_000;
export const DEFAULT_EVENT_BYTES_LIMIT = 64 * 1024 * 1024;
export const DEFAULT_REVIEW_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RetentionBudgetOptions {
  maxEvents?: number;
  maxBytes?: number;
  archiveRetentionMs?: number;
  now?: () => number;
}

export interface StreamBudget {
  events: number;
  bytes: number;
}

export class ResourceBudgetError extends PersistenceError {
  constructor(
    public readonly resource: 'events' | 'bytes',
    public readonly limit: number,
  ) {
    super('PERSISTENCE_RESOURCE_LIMIT', 'Durable resource budget has been exhausted.', {
      retryable: false,
    });
    this.name = 'ResourceBudgetError';
  }
}

/** Central budget/retention policy shared by event and review storage. */
export class RetentionManager {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly archiveRetentionMs: number;
  private readonly clock: () => number;

  constructor(options: RetentionBudgetOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_EVENT_LIMIT;
    this.maxBytes = options.maxBytes ?? DEFAULT_EVENT_BYTES_LIMIT;
    this.archiveRetentionMs = options.archiveRetentionMs ?? DEFAULT_REVIEW_ARCHIVE_RETENTION_MS;
    this.clock = options.now ?? Date.now;
  }

  assertWithinBudget(current: StreamBudget, incoming: StreamBudget): void {
    if (current.events + incoming.events > this.maxEvents) {
      throw new ResourceBudgetError('events', this.maxEvents);
    }
    if (current.bytes + incoming.bytes > this.maxBytes) {
      throw new ResourceBudgetError('bytes', this.maxBytes);
    }
  }

  archiveExpired(createdAt: number): boolean {
    return this.clock() - createdAt >= this.archiveRetentionMs;
  }
}

