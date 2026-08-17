import type {
  DomainEvent,
  EventProjector,
  ProjectedSnapshot,
  StoredEvent,
  ViewerContext,
} from '../../shared/events';
import type { GameState, Player, ProjectedGameState } from '../../shared/types';

interface StateEventPayload extends Record<string, unknown> {
  gameState: GameState;
  players: Player[];
}

const isOmniscient = (viewer: ViewerContext): boolean =>
  viewer.kind === 'spectator' && viewer.omniscient;

const isLivePlayer = (
  viewer: ViewerContext,
): viewer is Extract<ViewerContext, { kind: 'player' }> =>
  viewer.kind === 'player' && viewer.isAlive !== false;

const canSeeEvent = (event: DomainEvent, viewer: ViewerContext): boolean => {
  switch (event.visibility) {
    case 'public_timeline':
      return true;
    case 'role_private':
      return (
        isOmniscient(viewer) ||
        (isLivePlayer(viewer) &&
          (event.audienceIds ?? []).includes(viewer.playerId))
      );
    case 'wolf_private':
      return (
        isOmniscient(viewer) ||
        (isLivePlayer(viewer) &&
          viewer.role === 'wolf' &&
          (event.audienceIds ?? []).includes(viewer.playerId))
      );
    case 'spectator_omniscient':
      return isOmniscient(viewer);
  }
};

const projectPlayers = (
  players: readonly Player[],
  viewer: ViewerContext,
): Player[] => {
  if (isOmniscient(viewer)) return structuredClone([...players]);
  return players.map((player) => {
    const canSeeRole =
      viewer.kind === 'player' &&
      (player.id === viewer.playerId ||
        (viewer.isAlive !== false && viewer.role === 'wolf' && player.role === 'wolf'));
    const projected = {
      ...player,
      role: canSeeRole ? player.role : null,
    };
    return projected;
  });
};

const projectGameState = (
  state: GameState,
  viewer: ViewerContext,
): ProjectedGameState => {
  if (isOmniscient(viewer)) {
    return {
      ...structuredClone(state),
      allowedActors: [...(state.allowedActors ?? [])],
      allowedActions: [...(state.allowedActions ?? [])],
      deadlineTs: state.deadlineTs ?? null,
      stageStartedAt: state.stageStartedAt ?? null,
    };
  }

  // An eliminated player stays authenticated as a player so the browser can
  // recover its room session, but receives the same private-state boundary as
  // a public spectator.  Own identity remains available through projectPlayers.
  const playerId = isLivePlayer(viewer) ? viewer.playerId : null;
  const role = isLivePlayer(viewer) ? viewer.role : null;
  const ownActor =
    playerId === null
      ? undefined
      : state.allowedActors?.find((actor) => actor.playerId === playerId);
  const projected = {
    ...structuredClone(state),
    allowedActors: ownActor ? [structuredClone(ownActor)] : [],
    allowedActions: ownActor ? [...ownActor.actions] : [],
    deadlineTs: state.deadlineTs ?? null,
    stageStartedAt: state.stageStartedAt ?? null,
  };
  delete projected.votes;
  if (playerId === null) {
    delete projected.nightActions;
    delete projected.actionDone;
  } else {
    projected.nightActions = state.nightActions.filter(
      (action) => action.playerId === playerId,
    );
    projected.actionDone = Object.fromEntries(
      Object.entries(state.actionDone).filter(([id]) => id === playerId),
    );
  }
  if (role !== 'wolf') {
    delete projected.wolfVotes;
    delete projected.wolfSpeakerOrder;
    delete projected.wolfCurrentSpeaker;
    delete projected.wolfDiscussionRound;
    delete projected.wolfVoteComplete;
  }
  if (role !== 'guardian') {
    delete projected.guardianLastTarget;
    delete projected.guardianActionComplete;
  }
  if (role !== 'witch') {
    delete projected.witchHasHealPotion;
    delete projected.witchHasPoisonPotion;
    delete projected.witchActionComplete;
    delete projected.witchAntidoteUsed;
  }
  return projected;
};

export class VisibilityProjector implements EventProjector {
  projectEvent(
    event: DomainEvent,
    viewer: ViewerContext,
  ): DomainEvent | undefined {
    return canSeeEvent(event, viewer) ? structuredClone(event) : undefined;
  }

  projectSnapshot(
    events: readonly StoredEvent[],
    viewer: ViewerContext,
  ): ProjectedSnapshot {
    const stateEvent = [...events]
      .reverse()
      .find(({ event }) => event.eventType === 'game.state_updated');
    if (!stateEvent) throw new Error('Game stream has no state snapshot event.');

    const payload = stateEvent.event.payload as StateEventPayload;
    return {
      roomId: stateEvent.event.roomId,
      gameId: stateEvent.event.gameId,
      viewer,
      gameState: {
        ...projectGameState(payload.gameState, viewer),
        // Older persisted state events do not carry this authority field. The
        // session projector still has to emit the complete V3.1 shape.
        stageStartedAt: payload.gameState.stageStartedAt ?? null,
      },
      players: projectPlayers(payload.players, viewer),
      serverTime: Date.now(),
      lastSequence: events.at(-1)?.event.sequence ?? 0,
    };
  }
}
