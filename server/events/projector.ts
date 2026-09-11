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
  sessionState?: {
    dayFlow?: {
      stage?: string | null;
      voteRound?: 1 | 2;
      voteCandidates?: string[];
      votes?: Record<string, string | null>;
    };
  };
}

const isOmniscient = (viewer: ViewerContext): boolean =>
  viewer.kind === 'spectator' && viewer.omniscient;

const isLivePlayer = (
  viewer: ViewerContext,
): viewer is Extract<ViewerContext, { kind: 'player' }> =>
  viewer.kind === 'player' && viewer.isAlive !== false;

const isPreDeathPlayerEvent = (
  event: DomainEvent,
  viewer: ViewerContext,
): viewer is Extract<ViewerContext, { kind: 'player' }> =>
  viewer.kind === 'player' &&
  viewer.isAlive === false &&
  typeof viewer.deathCutoffSequence === 'number' &&
  event.sequence < viewer.deathCutoffSequence;

/**
 * Exile is the one death that keeps a player in the action projection: the
 * eliminated seat owns the public last-words turn until it is completed.
 * Night deaths (and every other dead player) remain read-only.
 */
const isExiledLastWordsPlayer = (
  state: GameState,
  viewer: ViewerContext,
): viewer is Extract<ViewerContext, { kind: 'player' }> =>
  viewer.kind === 'player' &&
  viewer.isAlive === false &&
  (state as GameState & { dayStage?: string | null }).dayStage === 'last_words' &&
  state.lastWordsPlayer === viewer.playerId &&
  state.currentSpeaker === viewer.playerId;

const isDeadHunterActionPlayer = (
  state: GameState,
  viewer: ViewerContext,
): viewer is Extract<ViewerContext, { kind: 'player' }> =>
  viewer.kind === 'player' &&
  viewer.isAlive === false &&
  (state as GameState & { dayStage?: string | null }).dayStage === 'hunter' &&
  state.allowedActors?.some(
    (actor) =>
      actor.playerId === viewer.playerId &&
      (actor.actions.includes('hunter_shoot') || actor.actions.includes('skip_hunter_shot')),
  ) === true;

const canSeeEvent = (event: DomainEvent, viewer: ViewerContext): boolean => {
  switch (event.visibility) {
    case 'public_timeline':
      return true;
    case 'role_private':
      return (
        isOmniscient(viewer) ||
        ((isLivePlayer(viewer) || isPreDeathPlayerEvent(event, viewer)) &&
          // A seer result is private to the seer even if a malformed or
          // migrated event carries a broader audience list.
          (event.eventType !== 'seer.result' || viewer.role === 'seer') &&
          (event.audienceIds ?? []).includes(viewer.playerId))
      );
    case 'wolf_private':
      return (
        isOmniscient(viewer) ||
        ((isLivePlayer(viewer) || isPreDeathPlayerEvent(event, viewer)) &&
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
      viewer.kind === 'spectator' ||
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
  const canActAsPlayer =
    isLivePlayer(viewer) ||
    isExiledLastWordsPlayer(state, viewer) ||
    isDeadHunterActionPlayer(state, viewer);
  const playerId = canActAsPlayer ? viewer.playerId : null;
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
  if (!(isLivePlayer(viewer) && viewer.role === 'seer')) {
    delete projected.seerResults;
  }
  return projected;
};

const projectOwnVoteSubmission = (
  payload: StateEventPayload,
  viewer: ViewerContext,
): ProjectedGameState['voteSubmission'] => {
  if (viewer.kind !== 'player') return null;
  const flow = payload.sessionState?.dayFlow;
  if (flow?.stage !== 'voting' || !flow.votes) return null;
  const candidates = new Set(flow.voteCandidates ?? []);
  const voterIds = payload.players
    .filter((player) =>
      player.isAlive &&
      (flow.voteRound !== 2 || !candidates.has(player.id)),
    )
    .map((player) => player.id);
  const submitted = Object.prototype.hasOwnProperty.call(
    flow.votes,
    viewer.playerId,
  );
  const target = flow.votes[viewer.playerId];
  const voteCounts = Object.values(flow.votes).reduce<Record<string, number>>((counts, targetId) => {
    if (typeof targetId === 'string') counts[targetId] = (counts[targetId] ?? 0) + 1;
    return counts;
  }, {});
  const submittedCount = voterIds.filter((playerId) =>
    Object.prototype.hasOwnProperty.call(flow.votes, playerId),
  ).length;
  return {
    submitted,
    targetId: submitted && (typeof target === 'string' || target === null)
      ? target
      : null,
    submittedCount,
    totalVoters: voterIds.length,
    waitingFor: Math.max(0, voterIds.length - submittedCount),
    voteCounts,
  };
};

export class VisibilityProjector implements EventProjector {
  projectEvent(
    event: DomainEvent,
    viewer: ViewerContext,
  ): DomainEvent | undefined {
    if (!canSeeEvent(event, viewer)) return undefined;
    const projected = structuredClone(event);
    // The state event is an internal recovery checkpoint. Omniscient viewers
    // may inspect game facts, but per-AI voice assignments are not game facts
    // and must never leave the private session boundary.
    if (projected.eventType === 'game.state_updated') {
      const state = (projected.payload as { sessionState?: unknown }).sessionState;
      if (state && typeof state === 'object' && !Array.isArray(state)) {
        delete (state as { aiPersonas?: unknown }).aiPersonas;
      }
    }
    return projected;
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
    const gameState = projectGameState(payload.gameState, viewer);
    gameState.voteSubmission = projectOwnVoteSubmission(payload, viewer);
    return {
      roomId: stateEvent.event.roomId,
      gameId: stateEvent.event.gameId,
      viewer,
      gameState: {
        ...gameState,
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
