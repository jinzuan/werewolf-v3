import type { DomainEvent, ProjectedSnapshot, ViewerContext } from '../../shared/events';
import type { GameCommand } from '../../shared/protocol';
import type { GameAction, Player, Role } from '../../shared/types';

export interface AILegalTarget {
  id: string;
  name: string;
}

export type AIDeathStatus =
  | 'alive'
  | 'dead'
  | 'dead_last_words'
  | 'dead_hunter_action';

export type AITurnKind =
  | 'regular_action'
  | 'regular_speech'
  | 'last_words'
  | 'hunter_shoot'
  | 'read_only';

/**
 * Server-derived actor state. The model must not infer this from the player
 * list or from the presence of a legal command alone.
 */
export interface AIActorStatus {
  isAlive: boolean;
  deathStatus: AIDeathStatus;
  turnKind: AITurnKind;
  /** First event sequence at which this actor was dead, when known. */
  deathCutoffSequence?: number | null;
}

/**
 * Facts are already projected by the server for the current AI actor.
 * Prompt code may format these facts, but must not infer hidden state.
 */
export interface AIPromptContext {
  /** Authoritative status of the player receiving this prompt. */
  actorStatus?: AIActorStatus;
  dayNumber?: number;
  roundNumber?: number;
  visibleEvents?: DomainEvent[];
  publicEvents?: string[];
  /** Structured behavior reference selected by the server for this role/stage. */
  experience?: string;
  publicVoteHistory?: string[];
  publicSpeeches?: string[];
  currentRoundSpeeches?: string[];
  ownPreviousSpeeches?: string[];
  /** Optional structured anti-repeat summaries; speech history remains the fallback. */
  alreadyStatedClaims?: string[];
  alreadyUsedEvidence?: string[];
  ownVoteCommitment?: string;
  privateRoleFacts?: string[];
  wolfPrivateChat?: string[];
  situationSummary?: string;
  newInformationSinceLastTurn?: string[];
  requiredNovelty?: string;
  phaseTask?: string;
  roleRevealContext?: string;
  publicRoleClaims?: string[];
  publicSeerClaims?: string[];
  guardianHistory?: string[];
  seerCheckHistory?: string[];
  witchKillNotice?: string;
  witchPotionState?: string;
  hunterShotAvailable?: boolean;
  wolfTeammates?: string[];
  wolfDiscussionRound?: number;
  wolfVoteRound?: number;
  wolfEdgeAssessment?: string;
  wolfTeamDisagreement?: string;
  tiedWolfKillTargets?: string[];
  wolfVoteReasons?: string[];
  repeatVoteVoterStatus?: string;
  isRepeatVote?: boolean;
  tieCandidateSpeeches?: string[];
  lastWordsRound?: number;
  lastWordsRoundsRemaining?: number;
  lastWordsTask?: string;
  firstLastWords?: string;
  /** Explicit final-words history assembled from the actor's projection. */
  lastWordsVisibleDeathHistory?: string[];
  lastWordsVisibleActionHistory?: string[];
  previousSituationSummary?: string;
  overnightPublicEvents?: string[];
  overnightPrivateRoleFacts?: string[];
  summaryCharLimit?: number;
  validationError?: string;
  isDailySummarizer?: boolean;
  legalActions?: GameAction[];
  legalTargets?: AILegalTarget[];
  abstainAllowed?: boolean;
  publicClaimPlan?: string;
  /** The authoritative RuleSet projection used for this request. */
  ruleset?: {
    id: string;
    version: string;
    values: Record<string, unknown>;
  };
}

export interface AIContextProjection {
  viewer: Extract<ViewerContext, { kind: 'player' }>;
  snapshot: ProjectedSnapshot;
  publicEvents: DomainEvent[];
  privateEvents: DomainEvent[];
  rules: {
    id: string;
    version: string;
    values: Record<string, unknown>;
  };
  experience: string;
  allowedActions: GameAction[];
  actorStatus?: AIActorStatus;
}

export interface AIRequestContext {
  roomId: string;
  gameId: string;
  playerId: string;
  role: Role;
  phase: string;
  stage: string | null;
  stageRevision: number;
  callId: string;
  players: Player[];
  allowedCommandTypes: GameCommand['type'][];
  /** Authoritative status of the player receiving this provider request. */
  actorStatus?: AIActorStatus;
  promptContext?: AIPromptContext;
  allowedActions?: GameAction[];
  projectedContext?: AIContextProjection;
  /** One cancellation signal for the whole provider attempt and its retries. */
  signal?: AbortSignal;
  /** Optional authoritative stage deadline; orchestrator uses the earlier limit. */
  deadlineTs?: number | null;
}

export interface AISuggestion {
  command: GameCommand;
  reason: string;
  providerMeta?: {
    retryCount: number;
  };
}

export class AIProviderError extends Error {
  constructor(
    readonly errorClass: string,
    readonly retryCount: number,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(errorClass);
    this.name = 'AIProviderError';
  }
}

export interface AILogEntry {
  layer: 'provider' | 'orchestrator' | 'scheduler';
  status: 'started' | 'success' | 'fallback' | 'failed';
  roomId?: string;
  gameId?: string;
  playerId?: string;
  callId?: string;
  stage?: string | null;
  actionClass?: string;
  commandType?: GameCommand['type'];
  provider?: string;
  model?: string;
  endpoint?: string;
  durationMs?: number;
  retryCount?: number;
  errorClass?: string;
  detail?: string;
  httpStatus?: number;
}

export type AILogger = (entry: AILogEntry) => void;

/**
 * Operational AI logs deliberately contain no prompt, completion, or
 * credential data.  They are enough to tell whether a turn reached the
 * provider, parsed successfully, fell back, or failed before dispatch.
 */
export const defaultAILogger: AILogger = (entry) => {
  const level = entry.status === 'failed' ? 'warn' : 'info';
  console[level]('[server:ai]', JSON.stringify(entry));
};

export interface AIProvider {
  /** real_ai is the only production provider mode; rules-degraded is explicit. */
  readonly mode?: 'real_ai' | 'rules-degraded' | 'test-deterministic';
  suggest(context: AIRequestContext): Promise<AISuggestion>;
}

export interface AITelemetryEntry {
  roomId: string;
  gameId: string;
  playerId: string;
  callId: string;
  status: 'started' | 'completed' | 'fallback' | 'failed';
  retryCount: number;
  durationMs?: number;
  errorClass?: string;
}
