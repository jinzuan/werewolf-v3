import type { DomainEvent } from '../../../shared/events';
import type { ObservedClaim, OwnerCognition, SpeechAnnotation } from './types';

const appendUniqueBounded = (items: string[], value: string, limit: number): void => {
  if (items.includes(value)) return;
  items.push(value);
  if (items.length > limit) items.splice(0, items.length - limit);
};

export const reduceStrategyNotebook = (
  owner: OwnerCognition,
  event: DomainEvent,
  annotation: SpeechAnnotation | null,
  claims: readonly ObservedClaim[],
): void => {
  for (const claim of claims) {
    if (claim.speechAct === 'ask') {
      appendUniqueBounded(owner.strategy.openQuestionClaimIds, claim.claimId, 32);
    }
  }
  if (annotation?.speechAct === 'answer' && annotation.replyToEventId) {
    owner.strategy.openQuestionClaimIds = owner.strategy.openQuestionClaimIds.filter((claimId) =>
      owner.discourse.claimsById[claimId]?.eventId !== annotation.replyToEventId,
    );
  }
  const fingerprint = event.payload.planFingerprint;
  if (
    (event.eventType === 'day.speech' || event.eventType === 'wolf.message') &&
    typeof fingerprint === 'string' &&
    fingerprint.length > 0
  ) {
    appendUniqueBounded(owner.strategy.doNotRepeatFingerprints, fingerprint, 32);
  }
  const summary = event.payload.decisionSummary;
  if (typeof summary === 'object' && summary !== null && !Array.isArray(summary)) {
    const item = summary as Record<string, unknown>;
    if (Number.isInteger(item.stageRevision) && typeof item.action === 'string') {
      owner.strategy.lastDecisionSummaries.push({
        stageRevision: Number(item.stageRevision),
        action: item.action,
        ...(typeof item.targetId === 'string' ? { targetId: item.targetId } : {}),
        evidenceIds: Array.isArray(item.evidenceIds)
          ? item.evidenceIds.filter((id): id is string => typeof id === 'string')
          : [],
        resultEventId: event.eventId,
      });
      if (owner.strategy.lastDecisionSummaries.length > 16) {
        owner.strategy.lastDecisionSummaries.splice(0, owner.strategy.lastDecisionSummaries.length - 16);
      }
    }
  }
};

export const consolidateStrategyNotebook = (
  owner: OwnerCognition,
  kind: 'night_open' | 'dawn',
  alivePlayerIds: ReadonlySet<string>,
): void => {
  owner.strategy.priorities = owner.strategy.priorities.filter((priority) =>
    !priority.targetId || alivePlayerIds.has(priority.targetId),
  );
  if (kind === 'dawn') {
    owner.strategy.nextActionCandidates = owner.strategy.nextActionCandidates.filter(
      (candidate) => !candidate.startsWith('tonight:'),
    );
  }
};
