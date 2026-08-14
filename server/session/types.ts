import type { DomainEvent } from '../../shared/events';
import type { GameState, Player } from '../../shared/types';
import type {
  DayStage,
  NightState,
  PlayerId,
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
  speechQueue: PlayerId[];
  lastWordsPlayerId: PlayerId | null;
  lastWordsRemaining: number;
  pendingHunterId: PlayerId | null;
}

export interface SessionState {
  roomId: string;
  gameId: string;
  players: Player[];
  gameState: AuthorityGameState;
  night: NightState;
  dayFlow: DayFlowState;
  witchInventory: WitchInventory;
  processedCommands: Record<string, CommandResult>;
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
    | 'INVALID_TARGET'
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
  stageDurationMs?: number;
  onChanged?: (session: import('./gameSession').GameSession) => void | Promise<void>;
}
