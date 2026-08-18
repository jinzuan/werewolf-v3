import type { DomainEvent } from '../../shared/events';
import type { GameAction, Player } from '../../shared/types';
import { buildAIPrompt, type AIPrompt } from './promptBuilder';
import { buildAIRuntimeContext } from './runtimeContext';
import type { AIRequestContext, AIPromptContext } from './types';

export interface PromptBudget {
  /** Maximum characters for the rendered system + user prompt. */
  maxChars?: number;
  /** Maximum projected events retained before rendering. */
  maxEvents?: number;
}

export interface PromptBudgetReport {
  maxChars: number;
  maxEvents: number;
  droppedEvents: number;
  droppedCharacters: number;
}

export interface PromptPipelineResult {
  prompt: AIPrompt;
  context: AIRequestContext;
  budget: PromptBudgetReport;
}

const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_MAX_EVENTS = 160;

const clone = <T>(value: T): T => structuredClone(value);

const projectedEvents = (context: AIRequestContext): DomainEvent[] => {
  const projection = context.projectedContext;
  if (!projection) return [];
  return [...new Map(
    [...projection.publicEvents, ...projection.privateEvents]
      .map((event) => [event.eventId, event]),
  ).values()].sort((left, right) => left.sequence - right.sequence);
};

const bounded = <T>(items: readonly T[] | undefined, limit: number): T[] =>
  items && items.length > limit ? [...items.slice(-limit)] : [...(items ?? [])];

const truncateText = (value: string | undefined, max: number): string | undefined =>
  value && value.length > max ? value.slice(-max) : value;

const basePromptContext = (context: AIRequestContext): AIPromptContext => {
  const events = projectedEvents(context);
  const projectedPlayers: Player[] = context.projectedContext?.snapshot.players ?? context.players.map((player) => ({
    ...player,
    role: player.id === context.playerId || context.role === 'wolf' && player.role === 'wolf'
      ? player.role
      : null,
    aiConfig: undefined,
  }));
  const allowedActions: GameAction[] = [
    ...(context.allowedActions ?? context.projectedContext?.allowedActions ?? []),
  ];
  const runtime = buildAIRuntimeContext({
    actorId: context.playerId,
    role: context.role,
    phase: context.phase,
    stage: context.stage,
    dayNumber: context.promptContext?.dayNumber ?? context.projectedContext?.snapshot.gameState.day ?? 1,
    roundNumber: context.promptContext?.roundNumber ?? 1,
    players: projectedPlayers,
    visibleEvents: events,
    allowedActions,
    experience: context.projectedContext?.experience,
  });
  const ruleset = context.projectedContext?.rules;
  return {
    ...runtime,
    ...(context.promptContext ?? {}),
    ...(ruleset ? { ruleset } : {}),
    memoryBoard:
      context.projectedContext?.memoryBoard ?? context.promptContext?.memoryBoard,
    // RepeatPolicy is a mandatory part of every provider request.  The
    // concrete history is supplied by the runtime context; this line keeps
    // the contract explicit even when the history is empty.
    requiredNovelty:
      context.promptContext?.requiredNovelty ??
      'RepeatPolicy：不得复述已经使用的主张或证据，必须回应新信息或提出具体下一步。',
    experience: [
      context.projectedContext?.experience,
      context.promptContext?.experience,
    ].filter((item): item is string => Boolean(item?.trim())).join('\n\n') || undefined,
    visibleEvents: events,
    legalActions: allowedActions,
  };
};

const trimContext = (
  context: AIRequestContext,
  promptContext: AIPromptContext,
  maxEvents: number,
): { context: AIRequestContext; droppedEvents: number } => {
  const events = bounded(promptContext.visibleEvents, maxEvents);
  const droppedEvents = (promptContext.visibleEvents?.length ?? 0) - events.length;
  const nextPromptContext: AIPromptContext = {
    ...promptContext,
    visibleEvents: events,
    publicEvents: bounded(promptContext.publicEvents, maxEvents),
    publicSpeeches: bounded(promptContext.publicSpeeches, Math.min(48, maxEvents)),
    currentRoundSpeeches: bounded(promptContext.currentRoundSpeeches, Math.min(24, maxEvents)),
    publicVoteHistory: bounded(promptContext.publicVoteHistory, Math.min(64, maxEvents)),
    ownPreviousSpeeches: bounded(promptContext.ownPreviousSpeeches, 12),
    wolfPrivateChat: bounded(promptContext.wolfPrivateChat, Math.min(32, maxEvents)),
    privateRoleFacts: bounded(promptContext.privateRoleFacts, Math.min(48, maxEvents)),
    lastWordsVisibleDeathHistory: bounded(promptContext.lastWordsVisibleDeathHistory, 48),
    lastWordsVisibleActionHistory: bounded(promptContext.lastWordsVisibleActionHistory, 48),
    experience: truncateText(promptContext.experience, 4_000),
    situationSummary: truncateText(promptContext.situationSummary, 2_000),
  };
  return { context: { ...context, promptContext: nextPromptContext }, droppedEvents };
};

/**
 * The only provider-facing prompt entry point.  It assembles viewer facts,
 * RuleSet, projected event history, static/historical experience and the
 * repeat policy before the common renderer is called.
 */
export const buildPromptPipeline = (
  input: AIRequestContext,
  budget: PromptBudget = {},
): PromptPipelineResult => {
  const maxChars = Math.max(4_000, budget.maxChars ?? DEFAULT_MAX_CHARS);
  const maxEvents = Math.max(8, budget.maxEvents ?? DEFAULT_MAX_EVENTS);
  let promptContext = basePromptContext(input);
  let current = trimContext(input, promptContext, maxEvents);
  let prompt = buildAIPrompt(current.context);
  let effectiveEvents = maxEvents;

  // Trim oldest event/context material first.  RuleSet and output contract
  // remain intact, so a bounded prompt is still actionable and parseable.
  while (prompt.system.length + prompt.user.length > maxChars && effectiveEvents > 8) {
    effectiveEvents = Math.max(8, Math.floor(effectiveEvents * 0.65));
    current = trimContext(input, promptContext, effectiveEvents);
    prompt = buildAIPrompt(current.context);
  }

  // A pathological custom experience/situation should not defeat the hard
  // budget.  Preserve the system contract and trim only user context.
  if (prompt.system.length + prompt.user.length > maxChars) {
    const availableUser = Math.max(1_000, maxChars - prompt.system.length);
    prompt = { ...prompt, user: prompt.user.slice(-availableUser) };
  }
  const total = prompt.system.length + prompt.user.length;
  return {
    prompt,
    context: clone(current.context),
    budget: {
      maxChars,
      maxEvents,
      droppedEvents: Math.max(0, (promptContext.visibleEvents?.length ?? 0) - effectiveEvents),
      droppedCharacters: Math.max(0, total - maxChars),
    },
  };
};
