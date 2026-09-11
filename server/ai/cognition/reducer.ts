import type { DomainEvent } from '../../../shared/events';
import { reduceDiscourseLedger } from './discourseLedger';
import { reduceFactLedger } from './factLedger';
import { canOwnerSeeEvent } from './gates';
import { reducePlayerModel } from './playerModel';
import { reduceStrategyNotebook } from './strategyNotebook';
import type { CognitionStateV2, ReduceContext } from './types';
import { reduceVoteLedger } from './voteLedger';
import { reduceWolfAttackBoard } from './wolfAttackBoard';

const markKnownDeaths = (state: CognitionStateV2, event: DomainEvent): void => {
  const deadIds: string[] = [];
  if (event.eventType === 'player.exited' || event.eventType === 'day.exiled') {
    if (typeof event.payload.playerId === 'string') deadIds.push(event.payload.playerId);
  } else if (event.eventType === 'hunter.shot') {
    if (typeof event.payload.targetId === 'string') deadIds.push(event.payload.targetId);
  } else if (event.eventType === 'night.resolved' && Array.isArray(event.payload.deaths)) {
    deadIds.push(...event.payload.deaths.filter((id): id is string => typeof id === 'string'));
  }
  for (const id of deadIds) {
    if (state.playersById[id]) state.playersById[id].isAlive = false;
  }
};

/** Deterministic, immutable event reducer. */
export const reduce = (
  current: CognitionStateV2,
  event: DomainEvent,
  context: ReduceContext = {},
): CognitionStateV2 => {
  if (event.gameId !== current.gameId || current.appliedEventIdSet[event.eventId]) return current;
  const next = structuredClone(current);
  for (const owner of Object.values(next.ownerMemoriesById)) {
    const cutoffOverride = context.deathCutoffSequenceByOwner?.[owner.owner.playerId];
    if (!canOwnerSeeEvent(owner.owner, event, cutoffOverride)) continue;
    reduceFactLedger(owner, event);
    const discourse = reduceDiscourseLedger(owner, event);
    reduceVoteLedger(owner, event, discourse.annotation);
    reducePlayerModel(owner, event, discourse.addedClaims);
    reduceStrategyNotebook(owner, event, discourse.annotation, discourse.addedClaims);
    owner.throughSequence = Math.max(owner.throughSequence, event.sequence);
    owner.strategy.throughSequence = Math.max(owner.strategy.throughSequence, event.sequence);
  }
  if (next.wolfAttackBoard) {
    reduceWolfAttackBoard(next.wolfAttackBoard, event, next.playersById);
  }
  markKnownDeaths(next, event);
  next.throughSequence = Math.max(next.throughSequence, event.sequence);
  next.appliedEventIds.push(event.eventId);
  next.appliedEventIdSet[event.eventId] = true;
  return next;
};

export const reduceEvents = (
  current: CognitionStateV2,
  events: readonly DomainEvent[],
  context: ReduceContext = {},
): CognitionStateV2 => events.reduce(
  (state, event) => reduce(state, event, context),
  current,
);
