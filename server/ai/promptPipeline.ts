import type { DomainEvent } from '../../shared/events';
import type { GameAction, Player } from '../../shared/types';
import { buildAIPrompt, PromptBuildError, type AIPrompt } from './promptBuilder';
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

const compactText = (value: string | undefined, max: number): string | undefined =>
  value && value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;

const compactItems = (
  items: readonly string[] | undefined,
  limit: number,
  maxItemChars: number,
): string[] => bounded(items, limit).map((item) => compactText(item, maxItemChars) ?? '');

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
    personaVoiceProfile:
      context.projectedContext?.personaVoiceProfile ??
      context.promptContext?.personaVoiceProfile,
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
      '轮到你时先尝试推进一件有价值的事：探查、追问、回应、暂时站边或信息交换均可。只在没有新信息、没有被点名且没有必须澄清的冲突时才可合法跳过；不得复述旧主张或旧证据。',
    // The coordinator's frozen per-seat assignment is authoritative for this
    // turn. Do not concatenate it with the projector's rotating legacy
    // reference: duplicated experience blocks make the model copy strategy
    // prose and defeat per-AI variation.
    experience:
      context.promptContext?.experience?.trim() ||
      context.projectedContext?.experience?.trim() ||
      undefined,
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
    alreadyStatedClaims: bounded(promptContext.alreadyStatedClaims, 12),
    alreadyUsedEvidence: bounded(promptContext.alreadyUsedEvidence, 12),
    newInformationSinceLastTurn: bounded(
      promptContext.newInformationSinceLastTurn,
      Math.min(24, maxEvents),
    ),
    wolfPrivateChat: bounded(promptContext.wolfPrivateChat, Math.min(32, maxEvents)),
    privateRoleFacts: bounded(promptContext.privateRoleFacts, Math.min(48, maxEvents)),
    lastWordsVisibleDeathHistory: bounded(promptContext.lastWordsVisibleDeathHistory, 48),
    lastWordsVisibleActionHistory: bounded(promptContext.lastWordsVisibleActionHistory, 48),
    experience: truncateText(promptContext.experience, 4_000),
    situationSummary: truncateText(promptContext.situationSummary, 2_000),
  };
  return { context: { ...context, promptContext: nextPromptContext }, droppedEvents };
};

const compactContext = (
  context: AIRequestContext,
  promptContext: AIPromptContext,
): { context: AIRequestContext; droppedEvents: number } => {
  const visibleEvents = bounded(promptContext.visibleEvents, 6);
  const nextPromptContext: AIPromptContext = {
    ...promptContext,
    visibleEvents,
    publicEvents: compactItems(promptContext.publicEvents, 6, 180),
    publicSpeeches: compactItems(promptContext.publicSpeeches, 4, 180),
    currentRoundSpeeches: compactItems(promptContext.currentRoundSpeeches, 4, 180),
    publicVoteHistory: compactItems(promptContext.publicVoteHistory, 6, 120),
    ownPreviousSpeeches: compactItems(promptContext.ownPreviousSpeeches, 4, 180),
    alreadyStatedClaims: compactItems(promptContext.alreadyStatedClaims, 4, 180),
    alreadyUsedEvidence: compactItems(promptContext.alreadyUsedEvidence, 4, 180),
    newInformationSinceLastTurn: compactItems(
      promptContext.newInformationSinceLastTurn,
      4,
      180,
    ),
    privateRoleFacts: compactItems(promptContext.privateRoleFacts, 6, 180),
    wolfPrivateChat: compactItems(promptContext.wolfPrivateChat, 4, 180),
    lastWordsVisibleDeathHistory: compactItems(
      promptContext.lastWordsVisibleDeathHistory,
      6,
      160,
    ),
    lastWordsVisibleActionHistory: compactItems(
      promptContext.lastWordsVisibleActionHistory,
      6,
      160,
    ),
    experience: compactText(promptContext.experience, 600),
    requiredNovelty: compactText(promptContext.requiredNovelty, 300),
    phaseTask: compactText(promptContext.phaseTask, 400),
  };
  return {
    context: { ...context, promptContext: nextPromptContext },
    droppedEvents: (promptContext.visibleEvents?.length ?? 0) - visibleEvents.length,
  };
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
  const promptContext = basePromptContext(input);
  let current = trimContext(input, promptContext, maxEvents);
  let prompt = buildAIPrompt(current.context);
  const initialCharacters = prompt.system.length + prompt.user.length;
  let effectiveEvents = maxEvents;

  // Trim oldest event/context material first.  RuleSet and output contract
  // remain intact, so a bounded prompt is still actionable and parseable.
  while (prompt.system.length + prompt.user.length > maxChars && effectiveEvents > 8) {
    effectiveEvents = Math.max(8, Math.floor(effectiveEvents * 0.65));
    current = trimContext(input, promptContext, effectiveEvents);
    prompt = buildAIPrompt(current.context);
  }

  // Once history trimming is exhausted, render the same canonical fragments
  // in compact mode. Optional style elaboration and duplicated context are
  // omitted, while safety, RuleSet, experience and the output contract remain
  // complete sections rather than being cut at an arbitrary character.
  if (prompt.system.length + prompt.user.length > maxChars) {
    current = compactContext(input, promptContext);
    prompt = buildAIPrompt(current.context, undefined, 'compact');
  }
  const total = prompt.system.length + prompt.user.length;
  if (total > maxChars) {
    throw new PromptBuildError(
      `Compact safety prompt exceeds maxChars (${total} > ${maxChars}).`,
      'PROMPT_CONTEXT_INVALID',
    );
  }
  return {
    prompt,
    context: clone(current.context),
    budget: {
      maxChars,
      maxEvents,
      droppedEvents: Math.max(0, current.droppedEvents),
      droppedCharacters: Math.max(0, initialCharacters - total),
    },
  };
};
