import type {
  DomainEvent,
  EventVisibility,
  ViewerContext,
} from '../../shared/events';

export const canViewerSeeVisibility = (
  visibility: EventVisibility,
  viewer: ViewerContext,
  audienceIds: readonly string[] = [],
): boolean => {
  const omniscient =
    viewer.kind === 'spectator' && viewer.omniscient;

  if (visibility === 'public_timeline') return true;
  if (visibility === 'spectator_omniscient') return omniscient;
  if (visibility === 'role_private') {
    return (
      omniscient ||
      (viewer.kind === 'player' && audienceIds.includes(viewer.playerId))
    );
  }
  return (
    omniscient ||
    (viewer.kind === 'player' &&
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
    ),
  );
};

export const publicSpectatorEvents = (
  events: readonly DomainEvent[],
): DomainEvent[] =>
  filterVisibleEvents(events, {
    kind: 'spectator',
    spectatorId: 'public-view',
    omniscient: false,
  });
