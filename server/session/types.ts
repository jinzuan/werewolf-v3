import type { DomainEvent } from '../../shared/events';
import type { DiscussionQueueEntry, GameState, Player } from '../../shared/types';
import type { AIMemoryBoards } from '../ai/memory';
import type { AIPersonaAssignments } from '../ai/persona';
import type { SecureRandomIndex } from '../ai/randomSelection';
import type {
  DayStage,
  NightState,
  PlayerId,
  VoteTally,
  VoteBallot,
  WitchInventory,
} from '../../src/core';

export interface AuthorityGameState extends GameState {
  deadlineTs: number | null;
  dayStage: DayStage | null;
}

/** One AI's private, server-owned experience instance for this game. */
export interface AIExperienceAssignment {
  experienceInstanceId: string;
  assetId: string;
  role: import('../../shared/types').Role;
  baseText: string;
  updatedText?: string;
  revision: number;
}

export interface DayFlowState {
  stage: DayStage | null;
  voteRound: 1 | 2;
  voteCandidates: PlayerId[];
  votes: Record<PlayerId, PlayerId | null>;
  voteReasons: Record<PlayerId, string | null>;
  speechQueue: PlayerId[];
  speechDirection: 'clockwise' | 'counterclockwise' | null;
  speechStartPlayerId: PlayerId | null;
  /** These fields are optional for recovery of pre-queue snapshots. */
  discussionMode?: 'first_report' | 'free_discussion' | null;
  discussionQueue?: DiscussionQueueEntry[];
  discussionMentionCounts?: Record<PlayerId, number>;
  discussionMentionOrder?: PlayerId[];
  discussionSpokenPlayerIds?: PlayerId[];
  discussionRequestSequence?: number;
  discussionCycle?: number;
  discussionCyclesRequired?: number;
  /** Free discussion is quota-based; cycles remain only for legacy snapshots. */
  discussionSpeechQuota?: number;
  discussionSpeechCounts?: Record<PlayerId, number>;
  /** Reasons are retained for server review only and never projected. */
  discussionRequestReasons?: Record<PlayerId, string>;
  lastWordsPlayerId: PlayerId | null;
  lastWordsRemaining: number;
  pendingHunterId: PlayerId | null;
  pendingExile: {
    status: 'exiled' | 'no_exile';
    targetId: PlayerId | null;
    round: 1 | 2;
    tally: VoteTally;
    ballots: VoteBallot[];
  } | null;
}

export interface SessionState {
  roomId: string;
  gameId: string;
  players: Player[];
  gameState: AuthorityGameState;
  night: NightState;
  dayFlow: DayFlowState;
  roleConfirmations: Record<PlayerId, boolean>;
  witchInventory: WitchInventory;
  processedCommands: Record<string, CommandResult>;
  /** Per-seat memory boards; private board data never enters a viewer snapshot. */
  aiMemories: AIMemoryBoards;
  /** Per-AI voice profiles; private IDs never enter Player or public projections. */
  aiPersonas: AIPersonaAssignments;
  /** Per-AI experience assignments; never projected to other players. */
  aiExperiences: Record<string, AIExperienceAssignment>;
  sequence: number;
  streamVersion: number;
}

export interface CommandResult {
  ok: boolean;
  code?:
    | 'DUPLICATE_COMMAND'
    | 'STALE_STAGE_REVISION'
    | 'EXPIRED_COMMAND'
    | 'ACTOR_NOT_FOUND'
    | 'ACTOR_DEAD'
    | 'ACTION_NOT_ALLOWED'
    | 'REASON_REQUIRED'
    | 'INVALID_TARGET'
    | 'CONTENT_TOO_LONG'
    | 'INVALID_COMMAND';
  events: DomainEvent[];
}

export interface SessionSnapshot {
  state: SessionState;
}

export interface SessionScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface SessionOptions {
  now?: () => number;
  rng?: () => number;
  /** Injectable secure index source used only for role-independent personas. */
  personaRandomIndex?: SecureRandomIndex;
  scheduler?: SessionScheduler;
  /** Keep real-time stage timers referenced for self-driving computer rooms. */
  keepTimersRefed?: boolean;
  stageDurationMs?: number;
  onChanged?: (session: import('./gameSession').GameSession) => void | Promise<void>;
}
