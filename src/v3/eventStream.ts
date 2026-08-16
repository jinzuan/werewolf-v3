import type {
  DomainEvent,
  ViewerContext,
} from '../../shared/events';
import type { GameEventsMessage } from '../../shared/protocol';
import { containsSensitiveKeys } from '../../shared/redact';
import { filterVisibleEvents } from './visibility';

export const MAX_EVENT_WINDOW = 200;

export interface EventStreamState {
  roomId: string;
  gameId: string;
  lastSeenSeq: number;
  events: DomainEvent[];
}

export interface EventStreamMergeResult extends EventStreamState {
  accepted: boolean;
}

export const mergeEventEnvelope = (
  state: EventStreamState,
  envelope: GameEventsMessage,
  viewer: ViewerContext,
): EventStreamMergeResult => {
  if (
    envelope.roomId !== state.roomId ||
    envelope.gameId !== state.gameId ||
    envelope.afterSequence < state.lastSeenSeq ||
    containsSensitiveKeys(envelope)
  ) {
    return { ...state, accepted: false };
  }

  const scoped = envelope.events.filter(
    (event) =>
      event.roomId === state.roomId &&
      event.gameId === state.gameId &&
      event.sequence > state.lastSeenSeq,
  );
  const visible = filterVisibleEvents(scoped, viewer);
  const merged = new Map(
    state.events.map((event) => [event.eventId, event]),
  );
  for (const event of visible) merged.set(event.eventId, event);
  const cursor = envelope.hasMore === true
    ? envelope.nextAfterSequence ?? envelope.afterSequence
    : envelope.lastSequence
      ?? envelope.nextAfterSequence
      ?? envelope.afterSequence;

  return {
    roomId: state.roomId,
    gameId: state.gameId,
    lastSeenSeq: Math.max(
      state.lastSeenSeq,
      envelope.afterSequence,
      cursor,
      ...scoped.map((event) => event.sequence),
    ),
    events: [...merged.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_EVENT_WINDOW),
    accepted: true,
  };
};
