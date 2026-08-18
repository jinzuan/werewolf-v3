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
  /** The envelope starts after a local gap and must be replayed from the watermark. */
  needsRecovery?: boolean;
}

export const mergeEventEnvelope = (
  state: EventStreamState,
  envelope: GameEventsMessage,
  viewer: ViewerContext,
): EventStreamMergeResult => {
  if (
    envelope.roomId !== state.roomId ||
    envelope.gameId !== state.gameId ||
    containsSensitiveKeys(envelope)
  ) {
    return { ...state, accepted: false };
  }

  // Pushes from automatic turns can overlap while the server is projecting
  // the same room for multiple sockets.  `afterSequence` is a transport
  // cursor, not an ordering guarantee for the events carried in the envelope:
  // merge any newer event by its authoritative sequence and treat older
  // duplicates as harmless no-ops.
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
  const startsAfterLocalWatermark = envelope.afterSequence > state.lastSeenSeq;
  const hasStalledPage = envelope.hasMore === true &&
    envelope.afterSequence >= state.lastSeenSeq &&
    cursor <= state.lastSeenSeq;
  const needsRecovery = startsAfterLocalWatermark || hasStalledPage;

  return {
    roomId: state.roomId,
    gameId: state.gameId,
    lastSeenSeq: Math.max(
      state.lastSeenSeq,
      ...(needsRecovery
        ? []
        : [envelope.afterSequence, cursor, ...scoped.map((event) => event.sequence)]),
    ),
    events: [...merged.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_EVENT_WINDOW),
    accepted: true,
    ...(needsRecovery ? { needsRecovery: true } : {}),
  };
};
