import type {
  GameState,
  NightStage,
  Player,
  ProjectedGameState,
  Role,
} from './types';

export type EventVisibility =
  | 'public_timeline'
  | 'role_private'
  | 'wolf_private'
  | 'spectator_omniscient';

export const DOMAIN_EVENT_SCHEMA_VERSION = 1 as const;

export const DOMAIN_EVENT_TYPES = [
  'game.started',
  'role.confirmed',
  'role.confirmation_completed',
  'game.state_updated',
  'game.ended',
  'stage.timed_out',
  'guardian.completed',
  'seer.result',
  'witch.kill_notice',
  'witch.completed',
  'night.skipped',
  'night.roles_defaulted',
  'night.resolved',
  'night.resolution_detail',
  'night.started',
  'wolf.message',
  'wolf.vote_cast',
  'wolf.vote_unresolved',
  'wolf.kill_locked',
  'wolf.discussion_round_started',
  'wolf.discussion_timed_out',
  'day.started',
  'day.discussion_started',
  'day.speech',
  'day.speech_skipped',
  'day.voting_started',
  'day.vote_cast',
  'day.revote_required',
  'day.exile_result',
  'day.no_exile',
  'day.exiled',
  'day.ended',
  'hunter.entitled',
  'hunter.shot',
  'hunter.shot_skipped',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export type DayStage =
  | 'dawn'
  | 'speech'
  | 'discussion'
  | 'voting'
  | 'exile_result'
  | 'last_words'
  | 'hunter'
  | 'day_end';

export type DomainEventStage = NightStage | DayStage | null;

export interface DomainEvent<
  TType extends string = DomainEventType,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  eventId: string;
  roomId: string;
  gameId: string;
  sequence: number;
  occurredAt: number;
  phase: GameState['phase'];
  stage: DomainEventStage;
  actorId?: string;
  eventType: TType;
  payload: TPayload;
  visibility: EventVisibility;
  audienceIds?: string[];
  correlationId: string;
  schemaVersion: typeof DOMAIN_EVENT_SCHEMA_VERSION;
}

export interface StoredEvent<TEvent extends DomainEvent = DomainEvent> {
  streamId: string;
  streamVersion: number;
  event: TEvent;
}

export interface EventAppendRequest<TEvent extends DomainEvent = DomainEvent> {
  streamId: string;
  expectedVersion: number;
  events: TEvent[];
}

export interface EventStore {
  append(request: EventAppendRequest): Promise<StoredEvent[]>;
  read(streamId: string, afterSequence?: number): Promise<StoredEvent[]>;
  /** Optional retention hook; old adapters may omit it. */
  remove?(streamId: string): Promise<void>;
}

export type ViewerContext =
  | {
      kind: 'player';
      playerId: string;
      role: Role;
      /** Set by the authoritative room projection once a player is eliminated. */
      isAlive?: boolean;
      /** First authoritative death event sequence for a dead AI/player view. */
      deathCutoffSequence?: number;
    }
  | {
      kind: 'spectator';
      spectatorId: string;
      omniscient: boolean;
    };

export interface ProjectedSnapshot {
  roomId: string;
  gameId: string;
  viewer: ViewerContext;
  gameState: ProjectedGameState;
  players: Player[];
  /** Server clock used with stageStartedAt/deadlineTs for reliable progress. */
  serverTime: number;
  lastSequence: number;
}

export interface EventProjector {
  projectEvent(
    event: DomainEvent,
    viewer: ViewerContext,
  ): DomainEvent | undefined;
  projectSnapshot(
    events: readonly StoredEvent[],
    viewer: ViewerContext,
  ): ProjectedSnapshot;
}
