import type { DomainEvent } from '../../../shared/events';
import { sourceRefForEvent } from './gates';
import type { ObservedClaim, OwnerCognition, StanceRecord, TargetStance } from './types';

const stanceForClaim = (claim: ObservedClaim): TargetStance | null => {
  const value = typeof claim.object === 'string' ? claim.object.toLowerCase() : claim.object;
  if (
    value === 'wolf' || value === 'suspect' || value === 'distrust' || value === 'negative' ||
    claim.predicate === 'opposes'
  ) {
    return 'suspect';
  }
  if (
    value === 'good' || value === 'trust' || value === 'support' || value === 'positive' ||
    claim.predicate === 'supports'
  ) {
    return 'trust';
  }
  if (value === 'neutral' || value === 'unknown') return 'neutral';
  return null;
};

const latestMatching = (
  owner: OwnerCognition,
  predicate: (record: StanceRecord) => boolean,
): StanceRecord | undefined => {
  for (let index = owner.playerModel.stanceClaimIds.length - 1; index >= 0; index -= 1) {
    const record = owner.playerModel.stancesByClaimId[owner.playerModel.stanceClaimIds[index]];
    if (record && predicate(record)) return record;
  }
  return undefined;
};

export const reducePlayerModel = (
  owner: OwnerCognition,
  event: DomainEvent,
  claims: readonly ObservedClaim[],
): void => {
  for (const claim of claims) {
    const targetId = claim.targetId ?? claim.subjectId;
    const stance = stanceForClaim(claim);
    if (!targetId || !stance || stance === 'neutral') continue;

    const priorOwn = latestMatching(owner, (record) =>
      record.speakerId === claim.speakerId &&
      record.targetId === targetId &&
      record.predicate === claim.predicate,
    );
    const priorOther = latestMatching(owner, (record) =>
      record.speakerId !== claim.speakerId &&
      record.targetId === targetId &&
      record.predicate === claim.predicate &&
      record.stance !== stance,
    );

    if (priorOwn && priorOwn.stance !== stance) {
      const explained = claim.revisesClaimId === priorOwn.claimId || Boolean(claim.explanationClaimId);
      if (!explained) {
        const id = `contradiction:${priorOwn.claimId}:${claim.claimId}`;
        if (!owner.playerModel.contradictionsById[id]) {
          owner.playerModel.contradictionsById[id] = {
            id,
            speakerId: claim.speakerId,
            targetId,
            predicate: claim.predicate,
            earlierClaimId: priorOwn.claimId,
            laterClaimId: claim.claimId,
            status: 'unexplained',
          };
          owner.playerModel.contradictionIds.push(id);
        }
      }
    }

    if (priorOther) {
      const pair = [priorOther.claimId, claim.claimId].sort();
      const id = `disagreement:${pair[0]}:${pair[1]}`;
      if (!owner.playerModel.disagreementsById[id]) {
        owner.playerModel.disagreementsById[id] = {
          id,
          targetId,
          predicate: claim.predicate,
          leftClaimId: priorOther.claimId,
          rightClaimId: claim.claimId,
          speakerIds: [priorOther.speakerId, claim.speakerId],
        };
        owner.playerModel.disagreementIds.push(id);
      }
    }

    owner.playerModel.stancesByClaimId[claim.claimId] = {
      claimId: claim.claimId,
      speakerId: claim.speakerId,
      targetId,
      predicate: claim.predicate,
      stance,
      source: sourceRefForEvent(event),
    };
    owner.playerModel.stanceClaimIds.push(claim.claimId);
  }
};
