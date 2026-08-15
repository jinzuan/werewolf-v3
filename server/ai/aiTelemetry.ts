import type { ProviderQueue, ProviderQueueStats } from './providerQueue';

export interface AITelemetrySnapshot {
  active: number;
  queued: number;
  cancelled: number;
  timeout: number;
  retry: number;
  fallback: number;
  completed: number;
  failed: number;
  total: number;
  latencyMs: number;
}

/**
 * Process-lifetime AI counters. There are intentionally no room, player,
 * endpoint, model, prompt, or credential labels in this object.
 */
export class AITelemetry {
  private active = 0;
  private cancelled = 0;
  private timeout = 0;
  private retry = 0;
  private fallback = 0;
  private completed = 0;
  private failed = 0;
  private total = 0;
  private latencyMs = 0;
  private queueStats: ProviderQueueStats | undefined;
  private unsubscribeQueue?: () => void;

  observeQueue(queue: ProviderQueue): void {
    this.unsubscribeQueue?.();
    this.unsubscribeQueue = queue.subscribe((stats) => {
      this.queueStats = stats;
    });
  }

  start(): void {
    this.active += 1;
    this.total += 1;
  }

  finish(status: 'completed' | 'fallback' | 'failed', durationMs: number): void {
    this.active = Math.max(0, this.active - 1);
    if (status === 'completed') this.completed += 1;
    if (status === 'fallback') this.fallback += 1;
    if (status === 'failed') this.failed += 1;
    this.latencyMs += Math.max(0, durationMs);
  }

  recordCancelled(): void { this.cancelled += 1; }
  recordTimeout(): void { this.timeout += 1; }
  recordRetry(count = 1): void { this.retry += Math.max(0, count); }

  snapshot(): AITelemetrySnapshot {
    return {
      active: this.active,
      queued: this.queueStats?.queued ?? 0,
      cancelled: this.cancelled,
      timeout: this.timeout,
      retry: this.retry,
      fallback: this.fallback,
      completed: this.completed,
      failed: this.failed,
      total: this.total,
      latencyMs: this.latencyMs,
    };
  }

  resetForTest(): void {
    this.active = 0;
    this.cancelled = 0;
    this.timeout = 0;
    this.retry = 0;
    this.fallback = 0;
    this.completed = 0;
    this.failed = 0;
    this.total = 0;
    this.latencyMs = 0;
  }
}

export class AIFallbackRegistry {
  private readonly keys = new Set<string>();

  claim(gameId: string, stageRevision: number, _playerId?: string): boolean {
    const key = `${gameId}:${stageRevision}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}

import { defaultAICircuitBreaker, defaultProviderQueue } from './providerQueue';

export const defaultAITelemetry = new AITelemetry();
defaultAITelemetry.observeQueue(defaultProviderQueue);
export const defaultAIFallbackRegistry = new AIFallbackRegistry();

// Keep the import live for consumers that use this module as the application
// telemetry entrypoint; the breaker is process-scoped alongside the queue.
export { defaultAICircuitBreaker };
