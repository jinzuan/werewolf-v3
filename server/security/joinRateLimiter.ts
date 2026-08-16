export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * A store must make consume atomic across server instances. The in-memory
 * implementation is deliberately only for a single process/test fixture.
 */
export interface RateLimitStore {
  consume(
    key: string,
    nowMs: number,
    capacity: number,
    refillPerSecond: number,
  ): Promise<RateLimitDecision>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  async consume(
    key: string,
    nowMs: number,
    capacity: number,
    refillPerSecond: number,
  ): Promise<RateLimitDecision> {
    const previous = this.buckets.get(key) ?? { tokens: capacity, updatedAt: nowMs };
    const elapsedSeconds = Math.max(0, nowMs - previous.updatedAt) / 1_000;
    const tokens = Math.min(capacity, previous.tokens + elapsedSeconds * refillPerSecond);
    if (tokens < 1) {
      const retryAfterMs = Math.max(1, Math.ceil((1 - tokens) / refillPerSecond * 1_000));
      this.buckets.set(key, { tokens, updatedAt: nowMs });
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    const remaining = tokens - 1;
    this.buckets.set(key, { tokens: remaining, updatedAt: nowMs });
    return { allowed: true, remaining: Math.floor(remaining), retryAfterMs: 0 };
  }
}

export interface JoinRateLimiterOptions {
  store: RateLimitStore;
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
  onLimited?: (entry: { scope: 'ip' | 'actor'; roomCode: string }) => void;
}

export interface JoinRateLimitRequest {
  clientIp: string;
  roomCode: string;
  actorId?: string;
}

const normalized = (value: string, maxLength: number): string =>
  value.trim().toUpperCase().slice(0, maxLength);

export class JoinRateLimiter {
  private readonly now: () => number;

  constructor(private readonly options: JoinRateLimiterOptions) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error('join rate-limit capacity must be a positive integer');
    }
    if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) {
      throw new Error('join rate-limit refill rate must be positive');
    }
    this.now = options.now ?? Date.now;
  }

  async check(request: JoinRateLimitRequest): Promise<RateLimitDecision> {
    const roomCode = normalized(request.roomCode, 64) || '<invalid>';
    const ip = normalized(request.clientIp, 128) || '<unknown>';
    const ipDecision = await this.options.store.consume(
      `join:ip:${ip}:room:${roomCode}`,
      this.now(),
      this.options.capacity,
      this.options.refillPerSecond,
    );
    if (!ipDecision.allowed) {
      this.options.onLimited?.({ scope: 'ip', roomCode });
      return ipDecision;
    }

    // The actor bucket is secondary only. Rotating actorId cannot evade the
    // IP+room bucket above, while normal clients still get a per-identity cap.
    if (request.actorId?.trim()) {
      const actorDecision = await this.options.store.consume(
        `join:actor:${request.actorId.trim().slice(0, 128)}:room:${roomCode}`,
        this.now(),
        this.options.capacity,
        this.options.refillPerSecond,
      );
      if (!actorDecision.allowed) {
        this.options.onLimited?.({ scope: 'actor', roomCode });
        return actorDecision;
      }
    }
    return ipDecision;
  }
}
