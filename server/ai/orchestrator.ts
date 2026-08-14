import { randomUUID } from 'node:crypto';
import type { GameCommand, GameCommandMeta } from '../../shared/protocol';
import type { GameAction } from '../../shared/types';
import { projectAIContext } from './contextProjector';
import type {
  AIProvider,
  AIRequestContext,
  AISuggestion,
  AITelemetryEntry,
} from './types';
import { AIProviderError as ProviderError } from './types';
import type { GameSession } from '../session/gameSession';

export interface AIOrchestratorOptions {
  timeoutMs?: number;
}

const commandTypeForAction = (action: GameAction): GameCommand['type'] => {
  switch (action) {
    case 'guard':
    case 'check':
    case 'heal':
    case 'poison':
      return 'game.night_action';
    case 'wolf_speak':
      return 'game.wolf_speak';
    case 'wolf_vote':
      return 'game.wolf_vote';
    case 'skip_night':
      return 'game.skip_night';
    case 'speak':
      return 'game.speak';
    case 'skip_speech':
      return 'game.skip_speech';
    case 'vote':
    case 'abstain':
      return 'game.vote';
    case 'hunter_shoot':
    case 'skip_hunter_shot':
      return 'game.hunter_shoot';
  }
};

const errorClassOf = (error: unknown): string => {
  if (error instanceof ProviderError) return error.errorClass;
  if (error instanceof Error && error.name === 'AIProviderTimeoutError') {
    return 'timeout';
  }
  if (error instanceof Error) return error.name || 'error';
  return 'unknown';
};

const retryCountOf = (error: unknown): number =>
  error instanceof ProviderError ? error.retryCount : 0;

export class AIOrchestrator {
  private readonly telemetryEntries: AITelemetryEntry[] = [];
  private readonly timeoutMs: number;

  constructor(
    private readonly provider: AIProvider,
    private readonly now: () => number = Date.now,
    options: AIOrchestratorOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async act(
    session: GameSession,
    context: Omit<AIRequestContext, 'callId'>,
  ): Promise<{ suggestion: AISuggestion; accepted: boolean }> {
    const callId = randomUUID();
    const startedAt = this.now();
    this.telemetryEntries.push({
      roomId: context.roomId,
      gameId: context.gameId,
      playerId: context.playerId,
      callId,
      status: 'started',
      retryCount: 0,
    });

    const projection = await projectAIContext(session, context);
    const allowedActions = [
      ...(context.allowedActions && context.allowedActions.length > 0
        ? context.allowedActions
        : projection.allowedActions),
    ];
    const allowedCommandTypes =
      context.allowedCommandTypes.length > 0
        ? [...context.allowedCommandTypes]
        : [...new Set(allowedActions.map(commandTypeForAction))];
    const providerContext: AIRequestContext = {
      ...context,
      callId,
      players: projection.snapshot.players,
      allowedActions,
      allowedCommandTypes,
      projectedContext: {
        ...projection,
        allowedActions,
      },
    };

    let suggestion: AISuggestion | null = null;
    let usedFallback = false;
    let retryCount = 0;
    let errorClass: string | undefined;

    try {
      suggestion = await this.withTimeout(
        this.provider.suggest(providerContext),
      );
      retryCount = suggestion.providerMeta?.retryCount ?? 0;
      if (!allowedCommandTypes.includes(suggestion.command.type)) {
        throw new ProviderError('invalid_output', retryCount);
      }
    } catch (error) {
      retryCount = Math.max(retryCount, retryCountOf(error));
      errorClass = errorClassOf(error);
      suggestion = this.fallback(providerContext);
      usedFallback = true;
    }

    if (!suggestion) {
      const unavailable = this.unavailableSuggestion(providerContext);
      this.recordFinal(
        context,
        callId,
        'failed',
        startedAt,
        retryCount,
        errorClass ?? 'no_allowed_action',
      );
      return { suggestion: unavailable, accepted: false };
    }

    let result = await session.dispatch(
      this.meta(session, context, callId),
      suggestion.command,
    );
    if (!result.ok && !usedFallback) {
      errorClass = result.code ?? 'command_rejected';
      suggestion = this.fallback(providerContext);
      usedFallback = true;
      if (suggestion) {
        result = await session.dispatch(
          this.meta(session, context, `${callId}:fallback`),
          suggestion.command,
        );
      } else {
        suggestion = this.unavailableSuggestion(providerContext);
      }
    }

    this.recordFinal(
      context,
      callId,
      result.ok ? (usedFallback ? 'fallback' : 'completed') : 'failed',
      startedAt,
      retryCount,
      result.ok ? errorClass : errorClass ?? result.code ?? 'command_rejected',
    );
    return { suggestion, accepted: result.ok };
  }

  telemetry(): AITelemetryEntry[] {
    return structuredClone(this.telemetryEntries);
  }

  private recordFinal(
    context: Omit<AIRequestContext, 'callId'>,
    callId: string,
    status: AITelemetryEntry['status'],
    startedAt: number,
    retryCount: number,
    errorClass?: string,
  ): void {
    this.telemetryEntries.push({
      roomId: context.roomId,
      gameId: context.gameId,
      playerId: context.playerId,
      callId,
      status,
      retryCount,
      durationMs: Math.max(0, this.now() - startedAt),
      ...(errorClass ? { errorClass } : {}),
    });
  }

  private meta(
    session: GameSession,
    context: Omit<AIRequestContext, 'callId'>,
    callId: string,
  ): GameCommandMeta {
    return {
      roomId: context.roomId,
      gameId: context.gameId,
      actorId: context.playerId,
      commandId: `ai:${callId}`,
      sentAt: this.now(),
      expectedStageRevision: session.stageRevision,
    };
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          handle = setTimeout(() => {
            const error = new Error('AI_PROVIDER_TIMEOUT');
            error.name = 'AIProviderTimeoutError';
            reject(error);
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (handle !== undefined) clearTimeout(handle);
    }
  }

  private fallback(
    context: AIRequestContext,
  ): AISuggestion | null {
    const actor = context.players.find(
      (player) => player.id === context.playerId,
    );
    if (!actor) return null;
    const allowed = new Set(context.allowedActions ?? []);
    const alive = context.players.filter((player) => player.isAlive);
    const gameState = context.projectedContext?.snapshot.gameState;
    const privateEvents = context.projectedContext?.privateEvents ?? [];
    const firstOther = alive.find((player) => player.id !== actor.id);
    const firstGuardTarget = alive.find(
      (player) => player.id !== gameState?.guardianLastTarget,
    );
    const firstWolfTarget =
      alive.find(
        (player) => player.id !== actor.id && player.role !== 'wolf',
      ) ?? firstOther;

    if (allowed.has('guard') && firstGuardTarget) {
      return {
        command: {
          type: 'game.night_action',
          payload: {
            playerId: actor.id,
            action: 'guard',
            targetId: firstGuardTarget.id,
          },
        },
        reason: 'deterministic guardian fallback',
      };
    }
    if (allowed.has('check') && firstOther) {
      return {
        command: {
          type: 'game.night_action',
          payload: {
            playerId: actor.id,
            action: 'check',
            targetId: firstOther.id,
          },
        },
        reason: 'deterministic seer fallback',
      };
    }
    if (allowed.has('heal')) {
      const notice = privateEvents.find(
        (event) => event.eventType === 'witch.kill_notice',
      );
      const targetId =
        notice &&
        typeof notice.payload.targetId === 'string'
          ? notice.payload.targetId
          : null;
      if (targetId !== null) {
        return {
          command: {
            type: 'game.night_action',
            payload: {
              playerId: actor.id,
              action: 'heal',
              targetId,
            },
          },
          reason: 'deterministic witch heal fallback',
        };
      }
    }
    if (allowed.has('poison') && firstOther) {
      return {
        command: {
          type: 'game.night_action',
          payload: {
            playerId: actor.id,
            action: 'poison',
            targetId: firstOther.id,
          },
        },
        reason: 'deterministic witch poison fallback',
      };
    }
    if (allowed.has('wolf_vote')) {
      return {
        command: {
          type: 'game.wolf_vote',
          payload: { targetId: firstWolfTarget?.id ?? null },
        },
        reason: 'deterministic wolf vote fallback',
      };
    }
    if (allowed.has('wolf_speak')) {
      return {
        command: {
          type: 'game.wolf_speak',
          payload: { content: 'pass' },
        },
        reason: 'deterministic wolf speech fallback',
      };
    }
    if (allowed.has('speak')) {
      return {
        command: {
          type: 'game.speak',
          payload: { content: 'pass' },
        },
        reason: 'deterministic speech fallback',
      };
    }
    if (allowed.has('skip_speech')) {
      return {
        command: { type: 'game.skip_speech', payload: {} },
        reason: 'deterministic speech skip fallback',
      };
    }
    if (allowed.has('vote') && firstOther) {
      return {
        command: {
          type: 'game.vote',
          payload: { targetId: firstOther.id },
        },
        reason: 'deterministic vote fallback',
      };
    }
    if (allowed.has('abstain')) {
      return {
        command: {
          type: 'game.vote',
          payload: { targetId: null },
        },
        reason: 'deterministic abstain fallback',
      };
    }
    if (allowed.has('hunter_shoot') && firstOther) {
      return {
        command: {
          type: 'game.hunter_shoot',
          payload: { targetId: firstOther.id },
        },
        reason: 'deterministic hunter fallback',
      };
    }
    if (allowed.has('skip_hunter_shot')) {
      return {
        command: {
          type: 'game.hunter_shoot',
          payload: { targetId: null },
        },
        reason: 'deterministic hunter skip fallback',
      };
    }
    if (allowed.has('skip_night')) {
      const action =
        actor.role === 'guardian'
          ? 'guard'
          : actor.role === 'seer'
            ? 'check'
            : actor.role === 'witch'
              ? 'heal'
              : 'poison';
      return {
        command: {
          type: 'game.skip_night',
          payload: { action },
        },
        reason: 'deterministic night skip fallback',
      };
    }

    const commandType = context.allowedCommandTypes[0];
    if (commandType === 'game.skip_speech') {
      return {
        command: { type: 'game.skip_speech', payload: {} },
        reason: 'deterministic compatibility fallback',
      };
    }
    return null;
  }

  private unavailableSuggestion(context: AIRequestContext): AISuggestion {
    const actor = context.players.find(
      (player) => player.id === context.playerId,
    );
    return {
      command: {
        type: 'game.skip_night',
        payload: {
          action:
            actor?.role === 'guardian'
              ? 'guard'
              : actor?.role === 'seer'
                ? 'check'
                : 'heal',
        },
      },
      reason: 'no allowed AI action',
    };
  }
}
