import type { DomainEvent } from '../../../shared/events';
import type {
  CognitionOwner,
  CognitionPlayer,
  SourceRef,
  SpeechAnnotation,
  WolfFeatureContributionDraft,
  WolfFeatureName,
} from './types';

const FEATURE_NAMES = new Set<WolfFeatureName>([
  'publicRoleClaimValue',
  'informationPower',
  'voteInfluence',
  'coordinationCentrality',
  'routeUtility',
  'dayExileResistance',
  'protectionRisk',
  'retaliationRisk',
  'coverExposureCost',
  'uncertainty',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const eventActorId = (event: DomainEvent): string | null => {
  if (typeof event.actorId === 'string') return event.actorId;
  return typeof event.payload.actorId === 'string' ? event.payload.actorId : null;
};

/**
 * The single owner-view gate for reducers. Missing private audiences are
 * deliberately invisible, including to the expected role.
 */
export const canOwnerSeeEvent = (
  owner: CognitionOwner,
  event: DomainEvent,
  deathCutoffOverride?: number | null,
): boolean => {
  const cutoff = deathCutoffOverride ?? owner.deathCutoffSequence;
  if (cutoff !== undefined && cutoff !== null && event.sequence > cutoff) return false;
  if (event.visibility === 'public_timeline') return true;
  if (event.visibility === 'spectator_omniscient') return false;
  if (!Array.isArray(event.audienceIds) || event.audienceIds.length === 0) return false;
  if (!event.audienceIds.includes(owner.playerId)) return false;
  return event.visibility !== 'wolf_private' || owner.role === 'wolf';
};

/** Team-private state also fails closed unless every declared audience member is a wolf. */
export const canWolfTeamSeeEvent = (
  event: DomainEvent,
  playersById: Readonly<Record<string, CognitionPlayer>>,
): boolean => {
  if (event.visibility === 'public_timeline') return true;
  if (event.visibility !== 'wolf_private') return false;
  if (!Array.isArray(event.audienceIds) || event.audienceIds.length === 0) return false;
  return event.audienceIds.every((id) => playersById[id]?.role === 'wolf');
};

export const sourceRefForEvent = (event: DomainEvent): SourceRef => ({
  eventId: event.eventId,
  sequence: event.sequence,
  visibility: event.visibility,
  audienceIds: Array.isArray(event.audienceIds) ? [...event.audienceIds] : [],
});

/**
 * Accept only an annotation that is transaction-bound to this exact speech
 * event. Raw content is never parsed here and malformed annotations degrade to
 * an unparsed utterance.
 */
export const speechAnnotationFromEvent = (event: DomainEvent): SpeechAnnotation | null => {
  if (event.eventType !== 'day.speech' && event.eventType !== 'wolf.message') return null;
  const value = event.payload.speechAnnotation;
  if (!isRecord(value)) return null;
  const actorId = eventActorId(event);
  const expectedChannel = event.eventType === 'wolf.message' ? 'wolf_private' : 'public';
  if (
    value.annotationVersion !== 'speech-annotation.v1' ||
    value.eventId !== event.eventId ||
    value.speakerId !== actorId ||
    value.channel !== expectedChannel ||
    !['validated_ai_plan', 'human_analyzer', 'legacy_unparsed'].includes(String(value.source)) ||
    !['validated', 'parsed', 'unparsed'].includes(String(value.parseStatus)) ||
    !Array.isArray(value.claims) ||
    !Array.isArray(value.commitments) ||
    !Array.isArray(value.mentionedPlayerIds) ||
    typeof value.renderedContent !== 'string'
  ) {
    return null;
  }
  const claimsValid = value.claims.every((claim) =>
    isRecord(claim) &&
    typeof claim.claimId === 'string' &&
    claim.eventId === event.eventId &&
    claim.speakerId === actorId &&
    claim.certainty === 'speaker_claim' &&
    typeof claim.predicate === 'string' &&
    Array.isArray(claim.evidenceRefs),
  );
  const commitmentsValid = value.commitments.every((commitment) =>
    isRecord(commitment) &&
    ['vote', 'protect', 'check', 'kill', 'public_stance'].includes(String(commitment.kind)) &&
    ['tentative', 'firm'].includes(String(commitment.strength)) &&
    ['support', 'reject'].includes(String(commitment.polarity)),
  );
  return claimsValid && commitmentsValid ? value as unknown as SpeechAnnotation : null;
};

/**
 * Explicit structured scoring seam. Contributions are accepted only from the
 * cognitionContributions field and must bind to this event; prose never enters
 * the attack board.
 */
export const wolfContributionsFromEvent = (
  event: DomainEvent,
  playersById: Readonly<Record<string, CognitionPlayer>>,
): WolfFeatureContributionDraft[] => {
  const value = event.payload.cognitionContributions;
  if (!Array.isArray(value)) return [];
  const result: WolfFeatureContributionDraft[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item.targetId !== 'string' ||
      playersById[item.targetId]?.role === 'wolf' ||
      !FEATURE_NAMES.has(item.feature as WolfFeatureName) ||
      typeof item.value !== 'number' ||
      !Number.isFinite(item.value) ||
      item.value < 0 ||
      item.value > 1 ||
      typeof item.extractionConfidence !== 'number' ||
      !Number.isFinite(item.extractionConfidence) ||
      item.extractionConfidence < 0 ||
      item.extractionConfidence > 1 ||
      item.sourceEventId !== event.eventId
    ) {
      continue;
    }
    result.push({
      targetId: item.targetId,
      feature: item.feature as WolfFeatureName,
      value: item.value,
      extractionConfidence: item.extractionConfidence,
      sourceEventId: item.sourceEventId,
    });
  }
  return result;
};
