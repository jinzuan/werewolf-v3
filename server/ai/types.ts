import type { DomainEvent, ProjectedSnapshot } from '../../shared/events';
import type { GameCommand } from '../../shared/protocol';
import type { GameAction, Player, Role } from '../../shared/types';

export interface AILegalTarget {
  id: string;
  name: string;
}

/**
 * Facts are already projected by the server for the current AI actor.
 * Prompt code may format these facts, but must not infer hidden state.
 */
export interface AIPromptContext {
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
}

export interface AIContextProjection {
  viewer: {
    kind: 'player';
    playerId: string;
    role: Role;
  };
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
  ) {
    super(errorClass);
    this.name = 'AIProviderError';
  }
}

export interface AIProvider {
  /** Providers that consume V3 prompt context opt into the projected event read. */
  readonly requiresPromptContext?: boolean;
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
