import type { DomainEvent } from '../../shared/events';
import type { GameState, Player } from '../../shared/types';
import type { AIMemoryBoards } from '../ai/memory';
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

export interface DayFlowState {
  stage: DayStage | null;
  voteRound: 1 | 2;
  voteCandidates: PlayerId[];
  votes: Record<PlayerId, PlayerId | null>;
  voteReasons: Record<PlayerId, string | null>;
  speechQueue: PlayerId[];
  speechDirection: 'clockwise' | 'counterclockwise' | null;
  speechStartPlayerId: PlayerId | null;
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
  scheduler?: SessionScheduler;
  /** Keep real-time stage timers referenced for self-driving computer rooms. */
  keepTimersRefed?: boolean;
  stageDurationMs?: number;
  onChanged?: (session: import('./gameSession').GameSession) => void | Promise<void>;
}
