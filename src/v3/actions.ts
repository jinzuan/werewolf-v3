import type {
  DomainEvent,
  ProjectedSnapshot,
} from '../../shared/events';
import type { GameCommand } from '../../shared/protocol';
import {
  GAME_ACTIONS,
  type GameAction,
  type Player,
  type Role,
} from '../../shared/types';

export type ActionInputKind = 'target' | 'text' | 'confirm' | 'immediate';

export interface ActionDefinition {
  action: GameAction;
  input: ActionInputKind;
  allowsEmptyTarget?: boolean;
}

export const ACTION_DEFINITIONS: Record<GameAction, ActionDefinition> = {
  confirm_role: { action: 'confirm_role', input: 'confirm' },
  guard: { action: 'guard', input: 'target' },
  check: { action: 'check', input: 'target' },
  wolf_speak: { action: 'wolf_speak', input: 'text' },
  wolf_vote: {
    action: 'wolf_vote',
    input: 'target',
    allowsEmptyTarget: true,
  },
  heal: { action: 'heal', input: 'confirm' },
  poison: { action: 'poison', input: 'target' },
  skip_night: { action: 'skip_night', input: 'immediate' },
  speak: { action: 'speak', input: 'text' },
  skip_speech: { action: 'skip_speech', input: 'immediate' },
  request_speech: { action: 'request_speech', input: 'immediate' },
  vote: { action: 'vote', input: 'target' },
  abstain: { action: 'abstain', input: 'immediate' },
  hunter_shoot: { action: 'hunter_shoot', input: 'target' },
  skip_hunter_shot: {
    action: 'skip_hunter_shot',
    input: 'immediate',
  },
};

export const orderedAllowedActions = (
  allowedActions: readonly GameAction[],
): GameAction[] =>
  GAME_ACTIONS.filter((action) => allowedActions.includes(action));

export interface GameActionReadiness {
  connected: boolean;
  recovering: boolean;
  syncStatus: 'idle' | 'syncing' | 'synced' | 'error';
  authorityStatus: 'resolving' | 'authorized' | 'unauthorized' | 'error';
  hasSnapshot: boolean;
}

/** Never turn a transient reconnect into an identity-loss action request. */
export const gameActionsReady = (state: GameActionReadiness): boolean =>
  state.connected &&
  !state.recovering &&
  state.syncStatus === 'synced' &&
  state.authorityStatus === 'authorized' &&
  state.hasSnapshot;

export interface VoteRoundProjection {
  key: string;
  active: boolean;
  kind: 'ordinary' | 'revote' | null;
  abstainAllowed: boolean;
  boundarySequence: number;
  candidates: Player[];
  currentTargetId: string | null;
  submitted: boolean;
  changed: boolean;
  submittedCount: number;
  totalVoters: number;
  waitingFor: number;
  voteCounts: Record<string, number>;
}

const latestEvent = (
  events: readonly DomainEvent[],
  eventType: DomainEvent['eventType'],
): DomainEvent | undefined =>
  [...events]
    .reverse()
    .find((event) => event.eventType === eventType);

const latestSequence = (
  events: readonly DomainEvent[],
  eventTypes: readonly DomainEvent['eventType'][],
): number =>
  events.reduce(
    (latest, event) =>
      eventTypes.includes(event.eventType)
        ? Math.max(latest, event.sequence)
        : latest,
    0,
  );

const payloadDay = (event: DomainEvent): number | null =>
  typeof event.payload.day === 'number' ? event.payload.day : null;

export const currentVoteRoundProjection = (
  snapshot: ProjectedSnapshot,
  events: readonly DomainEvent[],
  allowedActions: readonly GameAction[],
): VoteRoundProjection => {
  const actorId =
    snapshot.viewer.kind === 'player' ? snapshot.viewer.playerId : '';
  const day = snapshot.gameState.day;
  const revision = snapshot.gameState.stageRevision ?? 0;
  const active =
    allowedActions.includes('vote') || allowedActions.includes('abstain');
  const abstainAllowed =
    active && allowedActions.includes('abstain');
  const scopedEvents = events.filter(
    (event) =>
      event.roomId === snapshot.roomId &&
      event.gameId === snapshot.gameId &&
      event.sequence <= snapshot.lastSequence,
  );
  const dayBoundary = scopedEvents.reduce(
    (latest, event) =>
      (event.eventType === 'day.started' ||
        event.eventType === 'night.started') &&
      payloadDay(event) === day
        ? Math.max(latest, event.sequence)
        : latest,
    0,
  );
  const votingBoundary = scopedEvents.reduce(
    (latest, event) =>
      event.eventType === 'day.voting_started' &&
      event.sequence > dayBoundary
        ? Math.max(latest, event.sequence)
        : latest,
    0,
  );
  const boundarySequence = Math.max(dayBoundary, votingBoundary);
  const revote =
    dayBoundary > 0
      ? [...scopedEvents]
          .reverse()
          .find(
            (event) =>
              event.eventType === 'day.revote_required' &&
              event.sequence > boundarySequence,
          )
      : undefined;
  const snapshotRevoteIds =
    snapshot.gameState.voteRound === 2 &&
    Array.isArray(snapshot.gameState.voteCandidates)
      ? snapshot.gameState.voteCandidates
      : [];
  const eventRevoteIds = Array.isArray(revote?.payload.candidates)
    ? revote.payload.candidates.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const revoteIds = snapshotRevoteIds.length > 0
    ? snapshotRevoteIds
    : eventRevoteIds;
  const kind = active
    ? snapshot.gameState.voteRound === 2
      ? 'revote'
      : abstainAllowed
      ? 'ordinary'
      : 'revote'
    : null;
  const roundBoundarySequence = kind === 'revote' && revote
    ? Math.max(boundarySequence, revote.sequence)
    : boundarySequence;
  const allowedTargetIds =
    kind === 'revote' ? new Set(revoteIds) : null;
  const candidates = active
    ? snapshot.players.filter(
        (player) =>
          player.isAlive &&
          (allowedTargetIds === null || allowedTargetIds.has(player.id)),
      )
    : [];
  const latestVote = [...scopedEvents]
    .reverse()
    .find(
      (event) =>
        event.eventType === 'day.vote_cast' &&
        event.sequence > roundBoundarySequence &&
        (event.actorId === actorId || event.payload.actorId === actorId),
    );
  const snapshotSubmission = snapshot.gameState.voteSubmission;
  const currentTargetId = snapshotSubmission?.submitted
    ? snapshotSubmission.targetId
    : typeof latestVote?.payload.targetId === 'string'
      ? latestVote.payload.targetId
      : latestVote?.payload.targetId === null
        ? null
        : null;
  const submitted = snapshotSubmission?.submitted ?? (latestVote !== undefined);
  return {
    key: [
      snapshot.gameId,
      day,
      revision,
      kind ?? 'inactive',
    ].join(':'),
    active,
    kind,
    abstainAllowed,
    boundarySequence: roundBoundarySequence,
    candidates,
    currentTargetId,
    submitted,
    changed: latestVote?.payload.changed === true,
    submittedCount: snapshotSubmission?.submittedCount ??
      (typeof latestVote?.payload.submittedCount === 'number'
        ? latestVote.payload.submittedCount
        : submitted ? 1 : 0),
    totalVoters: snapshotSubmission?.totalVoters ??
      (typeof latestVote?.payload.totalVoters === 'number'
        ? latestVote.payload.totalVoters
        : 0),
    waitingFor: snapshotSubmission?.waitingFor ??
      (typeof latestVote?.payload.waitingFor === 'number'
        ? latestVote.payload.waitingFor
        : 0),
    voteCounts: snapshotSubmission?.voteCounts ?? {},
  };
};

export const eligibleTargets = (
  action: GameAction,
  snapshot: ProjectedSnapshot,
  events: readonly DomainEvent[],
  allowedActions: readonly GameAction[] =
    snapshot.gameState.allowedActions ?? [],
): Player[] => {
  const actorId =
    snapshot.viewer.kind === 'player' ? snapshot.viewer.playerId : '';
  const alive = snapshot.players.filter((player) => player.isAlive);

  if (action === 'guard') {
    return alive.filter(
      (player) =>
        player.id !== snapshot.gameState.guardianLastTarget,
    );
  }
  if (action === 'wolf_vote') return alive;
  if (
    action === 'check' ||
    action === 'poison' ||
    action === 'hunter_shoot'
  ) {
    return alive.filter((player) => player.id !== actorId);
  }
  if (action === 'vote') {
    return currentVoteRoundProjection(
      snapshot,
      events,
      allowedActions,
    ).candidates;
  }
  return [];
};

export const healTargetId = (
  events: readonly DomainEvent[],
): string | null => {
  const notice = latestEvent(events, 'witch.kill_notice');
  const nightStartedAt = latestSequence(events, [
    'game.started',
    'night.started',
  ]);
  return notice &&
    notice.sequence > nightStartedAt &&
    typeof notice.payload.killTargetId === 'string'
    ? notice.payload.killTargetId
    : null;
};

interface BuildCommandInput {
  actorId: string;
  actorRole?: Role | null;
  action: GameAction;
  allowedActions: readonly GameAction[];
  targetId?: string | null;
  content?: string;
  reason?: string;
}

export const buildGameCommand = ({
  actorId,
  actorRole,
  action,
  allowedActions,
  targetId = null,
  content = '',
  reason = '',
}: BuildCommandInput): GameCommand | null => {
  if (!allowedActions.includes(action)) return null;
  switch (action) {
    case 'confirm_role':
      return { type: 'game.confirm_role', payload: {} };
    case 'guard':
    case 'check':
    case 'heal':
    case 'poison':
      return {
        type: 'game.night_action',
        payload: { playerId: actorId, action, targetId },
      };
    case 'wolf_speak':
      return content.trim()
        ? {
            type: 'game.wolf_speak',
            payload: { content: content.trim() },
          }
        : null;
    case 'wolf_vote':
      return { type: 'game.wolf_vote', payload: { targetId } };
    case 'skip_night': {
      const skippedAction = allowedActions.find((candidate) =>
        ['guard', 'check', 'heal', 'poison'].includes(candidate),
      ) ?? (
        actorRole === 'guardian'
          ? 'guard'
          : actorRole === 'seer'
            ? 'check'
            : actorRole === 'witch'
              ? 'heal'
              : undefined
      );
      return skippedAction
        ? {
            type: 'game.skip_night',
            payload: { action: skippedAction },
          }
        : null;
    }
    case 'speak':
      return content.trim()
        ? {
            type: 'game.speak',
            payload: { content: content.trim() },
          }
        : null;
    case 'skip_speech':
      return content.trim()
        ? { type: 'game.skip_speech', payload: { reason: content.trim() } }
        : { type: 'game.skip_speech', payload: {} };
    case 'request_speech':
      return {
        type: 'game.request_speech',
        payload: reason?.trim() ? { reason: reason.trim() } : {},
      };
    case 'vote':
      return targetId
        ? {
            type: 'game.vote',
            payload: { targetId, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
          }
        : null;
    case 'abstain':
      return {
        type: 'game.vote',
        payload: { targetId: null, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
      };
    case 'hunter_shoot':
      return targetId
        ? { type: 'game.hunter_shoot', payload: { targetId } }
        : null;
    case 'skip_hunter_shot':
      return { type: 'game.hunter_shoot', payload: { targetId: null } };
  }
};
