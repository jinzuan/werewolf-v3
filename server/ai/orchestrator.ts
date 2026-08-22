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
import type { PromptContextCache } from './promptContextCache';
import {
  AIFallbackRegistry,
  defaultAIFallbackRegistry,
  defaultAITelemetry,
  type AITelemetry,
} from './aiTelemetry';
import { defaultAILogger, type AILogger } from './types';
import { randomElement } from './randomSelection';
import { recommendedWolfTarget } from './memory';
import { shouldPreferSpeechSkip } from './speechDecisionContext';
import { fallbackSpeechContent, fallbackWolfSpeechContent } from './fallbackSpeech';

export interface AIOrchestratorOptions {
  timeoutMs?: number;
  telemetry?: AITelemetry;
  fallbackRegistry?: AIFallbackRegistry;
  contextCache?: PromptContextCache;
  logger?: AILogger;
}

const commandTypeForAction = (action: GameAction): GameCommand['type'] => {
  switch (action) {
    case 'confirm_role':
      return 'game.confirm_role';
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
    case 'request_speech':
      return 'game.request_speech';
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

const errorDetailOf = (error: unknown): string | undefined =>
  error instanceof ProviderError ? error.detail : undefined;

const retryCountOf = (error: unknown): number =>
  error instanceof ProviderError ? error.retryCount : 0;

const isLastWordsContext = (context: AIRequestContext): boolean =>
  context.phase === 'lastWords' ||
  context.stage === 'last_words' ||
  context.promptContext?.lastWordsRoundsRemaining !== undefined;

const safeLastWordsFact = (value: string | undefined): string => {
  if (!value) return '';
  const cleaned = value
    .replace(/INVALID_CONTEXT/gu, '')
    .replace(/\{\{[^}]*\}\}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned ? Array.from(cleaned).slice(0, 34).join('') : '';
};

const lastWordsFallbackContent = (context: AIRequestContext): string => {
  const prompt = context.promptContext;
  const previous = safeLastWordsFact(prompt?.firstLastWords);
  const round = prompt?.lastWordsRound ?? 1;
  const content = round > 1 && previous
    ? `补充遗言：${previous}。请结合公开票型和发言复盘。`
    : '我被投票出局。请结合公开票型和发言复盘，重点看投票理由与立场变化。';
  return Array.from(content).slice(0, 80).join('');
};

export class AIOrchestrator {
  private readonly telemetryEntries: AITelemetryEntry[] = [];
  private readonly timeoutMs: number;
  private readonly aggregateTelemetry: AITelemetry;
  private readonly fallbackRegistry: AIFallbackRegistry;
  private readonly contextCache?: PromptContextCache;
  private readonly logger: AILogger;

  constructor(
    private readonly provider: AIProvider,
    private readonly now: () => number = Date.now,
    options: AIOrchestratorOptions = {},
  ) {
    this.timeoutMs =
      options.timeoutMs ?? Number(process.env.WW_AI_TIMEOUT_MS ?? '60000');
    this.aggregateTelemetry = options.telemetry ?? defaultAITelemetry;
    this.fallbackRegistry = options.fallbackRegistry ?? defaultAIFallbackRegistry;
    this.contextCache = options.contextCache;
    this.logger = options.logger ?? defaultAILogger;
  }

  async act(
    session: GameSession,
    context: Omit<AIRequestContext, 'callId'>,
  ): Promise<{ suggestion: AISuggestion; accepted: boolean }> {
    const callId = randomUUID();
    const startedAt = this.now();
    this.aggregateTelemetry.start();
    this.telemetryEntries.push({
      roomId: context.roomId,
      gameId: context.gameId,
      playerId: context.playerId,
      callId,
      status: 'started',
      retryCount: 0,
    });

    const projection = await projectAIContext(session, context, {
      cache: this.contextCache,
    });
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
      actorStatus: context.actorStatus ?? projection.actorStatus,
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
    let errorDetail: string | undefined;
    let timeoutOrCancellation = false;
    const controller = new AbortController();
    const parentSignal = context.signal;
    const abortParent = () => controller.abort();
    parentSignal?.addEventListener('abort', abortParent, { once: true });
    const deadlineRemaining = context.deadlineTs == null
      ? this.timeoutMs
      : Math.min(this.timeoutMs, Math.max(0, context.deadlineTs - this.now()));

    try {
      if (deadlineRemaining <= 0) throw new ProviderError('timeout', 0);
      suggestion = await this.withTimeout(
        Promise.resolve().then(() => this.provider.suggest({
          ...providerContext,
          signal: controller.signal,
        })),
        controller,
        deadlineRemaining,
        parentSignal,
      );
      retryCount = suggestion.providerMeta?.retryCount ?? 0;
      if (!allowedCommandTypes.includes(suggestion.command.type)) {
        throw new ProviderError('invalid_output', retryCount);
      }
    } catch (error) {
      retryCount = Math.max(retryCount, retryCountOf(error));
      errorClass = errorClassOf(error);
      errorDetail = errorDetailOf(error);
      timeoutOrCancellation = errorClass === 'timeout' || errorClass === 'cancelled';
      if (errorClass === 'timeout') this.aggregateTelemetry.recordTimeout();
      if (errorClass === 'cancelled') this.aggregateTelemetry.recordCancelled();
      const fallbackAllowed = this.fallbackRegistry.claim(
        context.gameId,
        context.stageRevision,
        context.playerId,
      );
      suggestion = fallbackAllowed
        ? this.fallback(providerContext, timeoutOrCancellation)
        : this.unavailableSuggestion(providerContext);
      usedFallback = true;
    } finally {
      parentSignal?.removeEventListener('abort', abortParent);
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
      this.aggregateTelemetry.finish('failed', this.now() - startedAt);
      this.logger({
        layer: 'orchestrator',
        status: 'failed',
        roomId: context.roomId,
        gameId: context.gameId,
        playerId: context.playerId,
        callId,
        stage: context.stage,
        commandType: context.allowedCommandTypes[0],
        errorClass: errorClass ?? 'no_allowed_action',
        ...(errorDetail ? { detail: errorDetail } : {}),
        retryCount,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      return { suggestion: unavailable, accepted: false };
    }

    let result = await session.dispatch(
      this.meta(session, context, callId),
      suggestion.command,
    );
    if (!result.ok && !usedFallback) {
      errorClass = result.code ?? 'command_rejected';
      const fallbackAllowed = this.fallbackRegistry.claim(
        context.gameId,
        context.stageRevision,
        context.playerId,
      );
      suggestion = fallbackAllowed
        ? this.fallback(providerContext, false)
        : this.unavailableSuggestion(providerContext);
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
    this.aggregateTelemetry.finish(
      result.ok ? (usedFallback ? 'fallback' : 'completed') : 'failed',
      this.now() - startedAt,
    );
    this.logger({
      layer: 'orchestrator',
      status: result.ok ? (usedFallback ? 'fallback' : 'success') : 'failed',
      roomId: context.roomId,
      gameId: context.gameId,
      playerId: context.playerId,
      callId,
      stage: context.stage,
      commandType: suggestion.command.type,
      ...(errorClass ? { errorClass } : {}),
      ...(errorDetail ? { detail: errorDetail } : {}),
      retryCount,
      durationMs: Math.max(0, this.now() - startedAt),
    });
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
      expectedStageRevision: context.stageRevision,
    };
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    controller: AbortController,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    let parentAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          handle = setTimeout(() => {
            controller.abort();
            reject(new ProviderError('timeout', 0));
          }, timeoutMs);
        }),
        ...(parentSignal
          ? [new Promise<never>((_, reject) => {
              parentAbort = () => {
                controller.abort();
                reject(new ProviderError('cancelled', 0));
              };
              if (parentSignal.aborted) parentAbort();
              else parentSignal.addEventListener('abort', parentAbort, { once: true });
            })]
          : []),
      ]);
    } finally {
      if (handle !== undefined) clearTimeout(handle);
      if (parentSignal && parentAbort) parentSignal.removeEventListener('abort', parentAbort);
    }
  }

  private fallback(
    context: AIRequestContext,
    timeoutOrCancellation = false,
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
    const wolfCandidates = alive.filter(
      (player) => player.id !== actor.id && player.role !== 'wolf',
    );
    const promptTargets = context.promptContext?.legalTargets ?? [];
    const legalWolfCandidates = promptTargets.length > 0
      ? wolfCandidates.filter((player) => promptTargets.some((target) => target.id === player.id))
      : wolfCandidates;
    const board = context.projectedContext?.memoryBoard ?? context.promptContext?.memoryBoard;
    const wolfTarget = board
      ? recommendedWolfTarget(board, legalWolfCandidates.map((player) => player.id)) ??
        randomElement(legalWolfCandidates)?.id ?? firstOther?.id ?? null
      : randomElement(legalWolfCandidates)?.id ?? firstOther?.id ?? null;

    if (allowed.has('confirm_role')) {
      return {
        command: { type: 'game.confirm_role', payload: {} },
        reason: 'deterministic role confirmation',
      };
    }

    // A deadline is an explicit consent to skip, not a reason to invent a
    // normal speech turn. Normal provider failures still use the contextual
    // rules-degraded text below so an AI room does not go silent.
    if (timeoutOrCancellation && allowed.has('skip_speech')) {
      return {
        command: {
          type: 'game.skip_speech',
          payload:
            context.phase === 'lastWords' || context.stage === 'last_words'
              ? { reason: '行动时间已结束' }
              : {},
        },
        reason: 'stage deadline timeout',
      };
    }

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
          payload: { targetId: wolfTarget },
        },
        reason: 'randomized legal wolf target fallback',
      };
    }
    if (allowed.has('wolf_speak')) {
      return {
        command: {
          type: 'game.wolf_speak',
          payload: {
            content: fallbackWolfSpeechContent(context),
          },
        },
        reason: 'deterministic wolf speech fallback',
      };
    }
    if (
      allowed.has('speak') &&
      allowed.has('skip_speech') &&
      shouldPreferSpeechSkip(context)
    ) {
      return {
        command: {
          type: 'game.skip_speech',
          payload: isLastWordsContext(context)
            ? { reason: '没有新的信息可补充' }
            : {},
        },
        reason: 'no-content speech skip fallback',
      };
    }
    if (allowed.has('speak')) {
      return {
        command: {
          type: 'game.speak',
          payload: {
              content: isLastWordsContext(context)
                ? lastWordsFallbackContent(context)
              : fallbackSpeechContent(context),
          },
        },
        reason: isLastWordsContext(context)
          ? 'contextual last-words fallback'
          : 'deterministic speech fallback',
      };
    }
    if (allowed.has('request_speech')) {
      return {
        command: { type: 'game.request_speech', payload: {} },
        reason: 'requesting a public speech queue turn',
      };
    }
    if (allowed.has('skip_speech')) {
      return {
        command: {
          type: 'game.skip_speech',
          payload:
            context.phase === 'lastWords' || context.stage === 'last_words'
              ? { reason: '没有新的信息可补充' }
              : {},
        },
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
        command: {
          type: 'game.skip_speech',
          payload:
            context.phase === 'lastWords' || context.stage === 'last_words'
              ? { reason: '没有新的信息可补充' }
              : {},
        },
        reason: 'deterministic compatibility fallback',
      };
    }
    return null;
  }

  private unavailableSuggestion(context: AIRequestContext): AISuggestion {
    const actor = context.players.find(
      (player) => player.id === context.playerId,
    );
    const allowed = new Set(context.allowedActions ?? []);
    if (allowed.has('confirm_role')) {
      return {
        command: { type: 'game.confirm_role', payload: {} },
        reason: 'role confirmation is the only allowed action',
      };
    }
    if (
      allowed.has('speak') &&
      allowed.has('skip_speech') &&
      shouldPreferSpeechSkip(context)
    ) {
      return {
        command: {
          type: 'game.skip_speech',
          payload: isLastWordsContext(context)
            ? { reason: '没有新的信息可补充' }
            : {},
        },
        reason: 'no-content speech skip while provider unavailable',
      };
    }
    if (allowed.has('speak')) {
      return {
        command: {
          type: 'game.speak',
          payload: {
            content: isLastWordsContext(context)
              ? lastWordsFallbackContent(context)
              : `第${context.promptContext?.dayNumber ?? '?'}天我会结合已公开的信息继续观察并说明判断。`,
          },
        },
        reason: isLastWordsContext(context)
          ? 'last-words content is required'
          : 'speech content is required',
      };
    }
    if (allowed.has('request_speech')) {
      return {
        command: { type: 'game.request_speech', payload: {} },
        reason: 'speech queue request is the only available action',
      };
    }
    if (allowed.has('skip_speech')) {
      return {
        command: {
          type: 'game.skip_speech',
          payload:
            context.phase === 'lastWords' || context.stage === 'last_words'
              ? { reason: '行动时间已结束' }
              : {},
        },
        reason: 'no allowed AI action',
      };
    }
    if (allowed.has('skip_hunter_shot')) {
      return {
        command: { type: 'game.hunter_shoot', payload: { targetId: null } },
        reason: 'no allowed AI action',
      };
    }
    if (allowed.has('abstain')) {
      return {
        command: { type: 'game.vote', payload: { targetId: null } },
        reason: 'no allowed AI action',
      };
    }
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
