import type { DomainEvent } from '../../../shared/events';
import { sourceRefForEvent, speechAnnotationFromEvent } from './gates';
import type { ObservedClaim, OwnerCognition, SpeechAnnotation } from './types';

export interface ReducedDiscourse {
  annotation: SpeechAnnotation | null;
  addedClaims: ObservedClaim[];
}

const actorIdForEvent = (event: DomainEvent): string | null =>
  typeof event.actorId === 'string'
    ? event.actorId
    : typeof event.payload.actorId === 'string'
      ? event.payload.actorId
      : null;

export const reduceDiscourseLedger = (
  owner: OwnerCognition,
  event: DomainEvent,
): ReducedDiscourse => {
  if (event.eventType !== 'day.speech' && event.eventType !== 'wolf.message') {
    return { annotation: null, addedClaims: [] };
  }
  const speakerId = actorIdForEvent(event);
  if (!speakerId) return { annotation: null, addedClaims: [] };
  const utteranceId = `utterance:${event.eventId}`;
  if (owner.discourse.utterancesById[utteranceId]) {
    return { annotation: null, addedClaims: [] };
  }
  const annotation = speechAnnotationFromEvent(event);
  const canUseClaims = annotation !== null &&
    annotation.parseStatus !== 'unparsed' &&
    annotation.source !== 'legacy_unparsed';
  const addedClaims: ObservedClaim[] = [];
  if (canUseClaims) {
    for (const claim of annotation.claims) {
      if (owner.discourse.claimsById[claim.claimId]) continue;
      const stored: ObservedClaim = {
        ...claim,
        evidenceRefs: [...claim.evidenceRefs],
      };
      owner.discourse.claimsById[stored.claimId] = stored;
      owner.discourse.claimIds.push(stored.claimId);
      addedClaims.push(stored);
    }
  }
  owner.discourse.utterancesById[utteranceId] = {
    id: utteranceId,
    source: sourceRefForEvent(event),
    speakerId,
    channel: event.eventType === 'wolf.message' ? 'wolf_private' : 'public',
    claimIds: addedClaims.map((claim) => claim.claimId),
    parseStatus: canUseClaims ? annotation.parseStatus : 'unparsed',
  };
  owner.discourse.utteranceIds.push(utteranceId);
  return { annotation, addedClaims };
};
