import { defaultAILogger, type AILogger } from './types';

export interface AITurnTask {
  roomCode: string;
  gameId: string;
  stageRevision: number;
  actorId: string;
  actionClass: string;
}

export interface AITurnExecution extends AITurnTask {
  signal: AbortSignal;
}

/** Human-readable pacing for computer-player speech in production rooms. */
export const AI_SPEECH_DELAY_MIN_MS = 8_000;
export const AI_SPEECH_DELAY_MAX_MS = 15_000;

export type AITurnExecutor = (task: AITurnExecution) => Promise<void>;
export type AITurnIdleHandler = (task: AITurnTask) => void;

const taskKey = (task: AITurnTask): string =>
  [task.roomCode.toUpperCase(), task.gameId, task.stageRevision, task.actorId, task.actionClass].join(':');

/**
 * A small durable-transition companion: it does not own game state, it only
 * coalesces notifications for one committed revision and cancels in-flight
 * provider work when the application closes.
 */
export class AITurnScheduler {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly roomActive = new Map<string, Promise<void>>();
  private readonly queuedByRoom = new Map<string, AITurnTask>();
  private closed = false;
  private lastFailure?: string;

  constructor(
    private readonly execute: AITurnExecutor,
    private readonly onIdle?: AITurnIdleHandler,
    private readonly logger: AILogger = defaultAILogger,
  ) {}

  schedule(task: AITurnTask): Promise<void> {
    const key = taskKey(task);
    const existing = this.active.get(key);
    if (existing) return existing;
    const roomKey = task.roomCode.toUpperCase();
    const roomExisting = this.roomActive.get(roomKey);
    if (roomExisting) {
      this.queuedByRoom.set(roomKey, task);
      return roomExisting;
    }
    if (this.closed) return Promise.resolve();
    this.logger({
      layer: 'scheduler',
      status: 'started',
      roomId: task.roomCode,
      gameId: task.gameId,
      playerId: task.actorId,
      stage: String(task.stageRevision),
      actionClass: task.actionClass,
    });
    const controller = new AbortController();
    const run = this.execute({ ...task, signal: controller.signal })
      .catch((error) => {
        this.lastFailure = error instanceof Error ? `${error.name}:${error.message}` : String(error);
        this.logger({
          layer: 'scheduler',
          status: 'failed',
          roomId: task.roomCode,
          gameId: task.gameId,
          playerId: task.actorId,
          stage: String(task.stageRevision),
          actionClass: task.actionClass,
          errorClass: error instanceof Error ? error.name : 'unknown',
        });
      })
      .finally(() => {
        this.active.delete(key);
        this.controllers.delete(key);
        this.roomActive.delete(roomKey);
        const queued = this.queuedByRoom.get(roomKey);
        this.queuedByRoom.delete(roomKey);
        if (!this.closed && queued) void this.schedule(queued);
        if (!this.closed && !queued) this.onIdle?.(task);
      });
    this.controllers.set(key, controller);
    this.active.set(key, run);
    this.roomActive.set(roomKey, run);
    return run;
  }

  pending(): string[] {
    return [...this.active.keys()];
  }

  failure(): string | undefined {
    return this.lastFailure;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.active.values());
    this.active.clear();
    this.controllers.clear();
    this.roomActive.clear();
    this.queuedByRoom.clear();
  }

  dispose(): Promise<void> {
    return this.close();
  }
}

export const aiTurnTaskKey = taskKey;
