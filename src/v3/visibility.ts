import type {
  DomainEvent,
  EventVisibility,
  ViewerContext,
} from '../../shared/events';

export const canViewerSeeVisibility = (
  visibility: EventVisibility,
  viewer: ViewerContext,
  audienceIds: readonly string[] = [],
  eventType?: string,
): boolean => {
  const omniscient =
    viewer.kind === 'spectator' && viewer.omniscient;

  if (visibility === 'public_timeline') return true;
  if (visibility === 'spectator_omniscient') return omniscient;
  if (visibility === 'role_private') {
    return (
      omniscient ||
      (viewer.kind === 'player' &&
        viewer.isAlive !== false &&
        (eventType !== 'seer.result' || viewer.role === 'seer') &&
        audienceIds.includes(viewer.playerId))
    );
  }
  return (
    omniscient ||
    (viewer.kind === 'player' &&
      viewer.isAlive !== false &&
      viewer.role === 'wolf' &&
      audienceIds.includes(viewer.playerId))
  );
};

export const filterVisibleEvents = (
  events: readonly DomainEvent[],
  viewer: ViewerContext | null,
): DomainEvent[] => {
  if (!viewer) return [];
  return events.filter((event) =>
    canViewerSeeVisibility(
      event.visibility,
      viewer,
      event.audienceIds,
      event.eventType,
    ),
  );
};

/**
 * Build the chat projection from the same viewer-scoped event stream used by
 * recovery/live pushes.  Sequence ordering is explicit here because a socket
 * page may contain hidden events and therefore must not rely on arrival order
 * to render the next wolf speaker's message.
 */
export const chatEventsForViewer = (
  events: readonly DomainEvent[],
  viewer: ViewerContext | null,
): DomainEvent[] =>
  filterVisibleEvents(events, viewer)
    .filter((event) => event.eventType !== 'game.state_updated')
    .sort((left, right) => left.sequence - right.sequence);

export const publicSpectatorEvents = (
  events: readonly DomainEvent[],
): DomainEvent[] =>
  filterVisibleEvents(events, {
    kind: 'spectator',
    spectatorId: 'public-view',
    omniscient: false,
  });
