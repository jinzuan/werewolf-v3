import type { DomainEvent } from '../../../shared/events';
import { sourceRefForEvent } from './gates';
import type { OwnerCognition, SpeechAnnotation, VoteCommitment } from './types';

const finiteInteger = (value: unknown, fallback: number): number =>
  Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;

const currentDay = (owner: OwnerCognition, event: DomainEvent): number => {
  if (Number.isInteger(event.payload.day)) return Number(event.payload.day);
  for (let index = owner.facts.orderedIds.length - 1; index >= 0; index -= 1) {
    const fact = owner.facts.byId[owner.facts.orderedIds[index]];
    if (fact?.kind === 'day_started' && typeof fact.value === 'number') return fact.value;
  }
  return 0;
};

const addCommitments = (
  owner: OwnerCognition,
  event: DomainEvent,
  annotation: SpeechAnnotation | null,
): void => {
  if (!annotation || annotation.parseStatus === 'unparsed') return;
  const day = currentDay(owner, event);
  const round = finiteInteger(event.payload.round, 1);
  annotation.commitments.forEach((commitment, index) => {
    if (commitment.kind !== 'vote') return;
    const id = `commitment:${event.eventId}:${index}`;
    if (owner.votes.commitmentsById[id]) return;
    if (commitment.polarity === 'support') {
      for (const previousId of owner.votes.commitmentIds) {
        const previous = owner.votes.commitmentsById[previousId];
        if (
          previous.speakerId === annotation.speakerId &&
          previous.day === day &&
          previous.round === round &&
          previous.polarity === 'support' &&
          previous.status === 'open' &&
          previous.targetId !== commitment.targetId
        ) {
          previous.status = 'withdrawn';
        }
      }
    }
    const record: VoteCommitment = {
      id,
      speakerId: annotation.speakerId,
      targetId: commitment.targetId,
      day,
      round,
      strength: commitment.strength,
      polarity: commitment.polarity,
      status: 'open',
      source: sourceRefForEvent(event),
    };
    owner.votes.commitmentsById[id] = record;
    owner.votes.commitmentIds.push(id);
    owner.strategy.publicCommitmentIds.push(id);
  });
};

const upsertBallot = (
  owner: OwnerCognition,
  event: DomainEvent,
  voterId: string,
  targetId: string | null,
  day: number,
  round: number,
  canonical: boolean,
): void => {
  const key = `${day}:${round}:${voterId}`;
  const existing = owner.votes.ballotsByKey[key];
  if (existing?.canonical && !canonical) return;
  owner.votes.ballotsByKey[key] = {
    id: `ballot:${key}`,
    voterId,
    targetId,
    day,
    round,
    canonical,
    source: sourceRefForEvent(event),
  };
  if (!existing) owner.votes.ballotKeys.push(key);
};

const addBallots = (owner: OwnerCognition, event: DomainEvent): void => {
  const day = currentDay(owner, event);
  const round = finiteInteger(event.payload.round ?? event.payload.voteRound, 1);
  if (event.eventType === 'day.vote_cast') {
    const voterId = typeof event.payload.voterId === 'string'
      ? event.payload.voterId
      : typeof event.actorId === 'string'
        ? event.actorId
        : null;
    const targetId = typeof event.payload.targetId === 'string' ? event.payload.targetId : null;
    if (voterId) upsertBallot(owner, event, voterId, targetId, day, round, false);
    return;
  }
  if (event.eventType !== 'day.exile_result' && event.eventType !== 'day.revote_required') return;
  if (!Array.isArray(event.payload.voteHistory)) return;
  for (const item of event.payload.voteHistory) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const ballot = item as Record<string, unknown>;
    if (typeof ballot.voterId !== 'string') continue;
    const targetId = typeof ballot.targetId === 'string' ? ballot.targetId : null;
    const ballotRound = finiteInteger(ballot.round, round);
    upsertBallot(owner, event, ballot.voterId, targetId, day, ballotRound, true);
  }
};

export const reduceVoteLedger = (
  owner: OwnerCognition,
  event: DomainEvent,
  annotation: SpeechAnnotation | null,
): void => {
  addCommitments(owner, event, annotation);
  addBallots(owner, event);
};

export const reconcileVoteCommitments = (owner: OwnerCognition, throughDay: number): void => {
  for (const id of owner.votes.commitmentIds) {
    const commitment = owner.votes.commitmentsById[id];
    if (commitment.status !== 'open' || commitment.day > throughDay) continue;
    const ballots = owner.votes.ballotKeys
      .map((key) => owner.votes.ballotsByKey[key])
      .filter((ballot) =>
        ballot.canonical &&
        ballot.voterId === commitment.speakerId &&
        ballot.day === commitment.day,
      )
      .sort((left, right) => right.round - left.round);
    const ballot = ballots[0];
    if (!ballot) continue;
    const matches = ballot.targetId === commitment.targetId;
    commitment.status = commitment.polarity === 'support'
      ? matches ? 'kept' : 'broken'
      : matches ? 'broken' : 'kept';
  }
};
