import type { DomainEvent } from '../../../shared/events';
import { canWolfTeamSeeEvent, speechAnnotationFromEvent, wolfContributionsFromEvent } from './gates';
import { emptyWolfConsensus } from './state';
import type {
  CognitionPlayer,
  ConsolidationCheckpoint,
  SpeechAnnotation,
  WolfAttackBoard,
  WolfCandidate,
  WolfConsensus,
  WolfFeatureContribution,
  WolfFeatureKey,
  WolfFeatureName,
  WolfPreference,
} from './types';

const FEATURE_KEY: Record<WolfFeatureName, WolfFeatureKey> = {
  publicRoleClaimValue: 'R',
  informationPower: 'I',
  voteInfluence: 'V',
  coordinationCentrality: 'C',
  routeUtility: 'E',
  dayExileResistance: 'X',
  protectionRisk: 'P',
  retaliationRisk: 'H',
  coverExposureCost: 'O',
  uncertainty: 'U',
};

const clamp = (value: number, minimum = 0, maximum = 1): number =>
  Math.min(maximum, Math.max(minimum, value));

const emptyFeatures = (): Record<WolfFeatureKey, number> => ({
  R: 0,
  I: 0,
  V: 0,
  C: 0,
  E: 0,
  X: 0,
  P: 0,
  H: 0,
  O: 0,
  U: 0,
});

const confidenceValue = (value: 'low' | 'medium' | 'high'): number =>
  value === 'high' ? 1 : value === 'medium' ? 0.7 : 0.4;

const contributionId = (
  targetId: string,
  feature: WolfFeatureName,
  sourceEventId: string,
): string => `${targetId}:${feature}:${sourceEventId}`;

const addContribution = (
  board: WolfAttackBoard,
  contribution: Omit<WolfFeatureContribution, 'id' | 'observedAtSequence' | 'observedAtWindow'>,
  sequence: number,
): boolean => {
  const id = contributionId(contribution.targetId, contribution.feature, contribution.sourceEventId);
  if (board.featureContributionsById[id]) return false;
  board.featureContributionsById[id] = {
    id,
    ...contribution,
    value: clamp(contribution.value),
    extractionConfidence: clamp(contribution.extractionConfidence),
    observedAtSequence: sequence,
    observedAtWindow: board.currentWindow,
  };
  board.featureContributionIds.push(id);
  if (board.featureContributionIds.length > 256) {
    const removed = board.featureContributionIds.splice(0, board.featureContributionIds.length - 256);
    for (const removedId of removed) delete board.featureContributionsById[removedId];
  }
  return true;
};

const addStructuredContributions = (
  board: WolfAttackBoard,
  event: DomainEvent,
  playersById: Readonly<Record<string, CognitionPlayer>>,
  annotation: SpeechAnnotation | null,
): boolean => {
  let changed = false;
  for (const draft of wolfContributionsFromEvent(event, playersById)) {
    changed = addContribution(board, draft, event.sequence) || changed;
  }
  if (event.visibility !== 'public_timeline' || !annotation || annotation.parseStatus === 'unparsed') {
    return changed;
  }
  for (const claim of annotation.claims) {
    const targetId = claim.targetId ?? claim.subjectId;
    if (
      !targetId ||
      playersById[targetId]?.role === 'wolf' ||
      !['claims_role', 'role_claim'].includes(claim.predicate)
    ) {
      continue;
    }
    changed = addContribution(board, {
      targetId,
      feature: 'publicRoleClaimValue',
      value: 1,
      extractionConfidence: confidenceValue(claim.confidence),
      sourceEventId: event.eventId,
    }, event.sequence) || changed;
  }
  return changed;
};

const upsertPreference = (
  board: WolfAttackBoard,
  wolfId: string,
  preference: WolfPreference,
): boolean => {
  if (!board.knownWolfIds.includes(wolfId)) return false;
  const current = board.preferencesByWolf[wolfId] ?? [];
  const same = current.find((item) =>
    item.targetId === preference.targetId &&
    item.kind === preference.kind &&
    item.route === preference.route &&
    item.reasonCode === preference.reasonCode,
  );
  if (same) return false;
  let next = current.filter((item) => item.targetId !== preference.targetId);
  if (preference.kind === 'primary') {
    next = next.filter((item) => item.kind !== 'primary');
  }
  next.push(preference);
  board.preferencesByWolf[wolfId] = next.slice(-6);
  return true;
};

const addStructuredPreferences = (
  board: WolfAttackBoard,
  event: DomainEvent,
  annotation: SpeechAnnotation | null,
): boolean => {
  const actorId = typeof event.actorId === 'string'
    ? event.actorId
    : typeof event.payload.actorId === 'string'
      ? event.payload.actorId
      : null;
  if (!actorId || !board.knownWolfIds.includes(actorId)) return false;
  let changed = false;
  if (event.eventType === 'wolf.vote_cast' && typeof event.payload.targetId === 'string') {
    changed = upsertPreference(board, actorId, {
      targetId: event.payload.targetId,
      kind: 'primary',
      route: board.route.value,
      reasonCode: 'authoritative_vote',
      evidenceEventIds: [event.eventId],
      sourceEventId: event.eventId,
    }) || changed;
  }
  if (event.eventType !== 'wolf.message' || !annotation || annotation.parseStatus === 'unparsed') {
    return changed;
  }
  for (const commitment of annotation.commitments) {
    if (commitment.kind !== 'kill' || !commitment.targetId) continue;
    changed = upsertPreference(board, actorId, {
      targetId: commitment.targetId,
      kind: commitment.polarity === 'reject'
        ? 'reject'
        : commitment.strength === 'firm'
          ? 'primary'
          : 'alternate',
      route: board.route.value,
      reasonCode: commitment.reasonCode ?? annotation.speechAct,
      evidenceEventIds: [event.eventId],
      sourceEventId: event.eventId,
    }) || changed;
  }
  return changed;
};

const aggregateFeature = (
  board: WolfAttackBoard,
  targetId: string,
  feature: WolfFeatureName,
): number => {
  let inverse = 1;
  for (const id of board.featureContributionIds) {
    const contribution = board.featureContributionsById[id];
    if (contribution.targetId !== targetId || contribution.feature !== feature) continue;
    const ageWindows = Math.max(0, board.currentWindow - contribution.observedAtWindow);
    const freshness = 2 ** (-ageWindows / 2);
    const quality = clamp(contribution.value * contribution.extractionConfidence * freshness);
    inverse *= 1 - quality;
  }
  return clamp(1 - inverse);
};

const tacticalScore = (features: Record<WolfFeatureKey, number>): number => clamp(
  100 * (
    0.22 * features.R +
    0.20 * features.I +
    0.18 * features.V +
    0.12 * features.C +
    0.18 * features.E +
    0.10 * features.X -
    0.10 * features.P -
    0.08 * features.H -
    0.07 * features.O -
    0.05 * features.U
  ),
  0,
  100,
);

const currentPreferencesFor = (board: WolfAttackBoard, targetId: string): WolfPreference[] =>
  board.aliveWolfIds.flatMap((wolfId) =>
    (board.preferencesByWolf[wolfId] ?? []).filter((item) => item.targetId === targetId),
  );

const preferenceStats = (board: WolfAttackBoard, targetId: string) => {
  const livingCount = Math.max(1, board.aliveWolfIds.length);
  const preferences = currentPreferencesFor(board, targetId);
  const perWolf = new Map<string, WolfPreference>();
  for (const wolfId of board.aliveWolfIds) {
    const own = (board.preferencesByWolf[wolfId] ?? []).find((item) => item.targetId === targetId);
    if (own) perWolf.set(wolfId, own);
  }
  let net = 0;
  let support = 0;
  let opposition = 0;
  const fingerprints = new Map<string, number>();
  for (const preference of perWolf.values()) {
    if (preference.kind === 'primary') {
      net += 1;
      support += 1;
    } else if (preference.kind === 'alternate') {
      net += 0.5;
      support += 1;
    } else {
      net -= 1;
      opposition += 1;
    }
    const fingerprint = `${targetId}:${preference.route}:${preference.reasonCode}`;
    fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
  }
  const bestFingerprint = [...fingerprints.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  return {
    preferences,
    coverage: perWolf.size / livingCount,
    supportRatio: support / livingCount,
    oppositionRatio: opposition / livingCount,
    netPreference: net / livingCount,
    reasonAgreement: (bestFingerprint?.[1] ?? 0) / livingCount,
    fingerprint: bestFingerprint?.[0] ?? null,
  };
};

const buildCandidate = (board: WolfAttackBoard, targetId: string): WolfCandidate => {
  const normalized = emptyFeatures();
  for (const [feature, key] of Object.entries(FEATURE_KEY) as Array<[WolfFeatureName, WolfFeatureKey]>) {
    normalized[key] = aggregateFeature(board, targetId, feature);
  }
  if (board.route.basis === 'none') normalized.E = 0;
  const tactical = tacticalScore(normalized);
  const stats = preferenceStats(board, targetId);
  return {
    targetId,
    legal: board.legalTargetIds.includes(targetId),
    teammate: board.knownWolfIds.includes(targetId),
    normalized,
    tacticalScore: tactical,
    finalScore: clamp(tactical + 15 * stats.netPreference + 5 * stats.reasonAgreement, 0, 100),
  };
};

const sortedCandidates = (board: WolfAttackBoard, candidates: Record<string, WolfCandidate>) =>
  board.legalTargetIds
    .map((id, stableOrder) => ({ candidate: candidates[id], stableOrder }))
    .filter((entry): entry is { candidate: WolfCandidate; stableOrder: number } => Boolean(entry.candidate))
    .sort((left, right) =>
      right.candidate.finalScore - left.candidate.finalScore ||
      left.candidate.normalized.U - right.candidate.normalized.U ||
      left.stableOrder - right.stableOrder,
    )
    .map((entry) => entry.candidate);

const computeConsensus = (
  board: WolfAttackBoard,
  candidates: Record<string, WolfCandidate>,
): WolfConsensus => {
  if (board.lockedKill) {
    return {
      ...emptyWolfConsensus(),
      status: 'locked',
      targetId: board.lockedKill.targetId,
      fingerprint: `locked:${board.lockedKill.targetId}`,
      evidenceEventIds: [board.lockedKill.eventId],
    };
  }
  const ordered = sortedCandidates(board, candidates);
  const target = ordered.find((candidate) => currentPreferencesFor(board, candidate.targetId).length > 0);
  if (!target) return emptyWolfConsensus();
  const stats = preferenceStats(board, target.targetId);
  const second = ordered.find((candidate) => candidate.targetId !== target.targetId);
  const margin = target.finalScore - (second?.finalScore ?? 0);
  const decisive = stats.preferences
    .filter((preference) => preference.kind !== 'reject')
    .sort((left, right) => left.reasonCode.localeCompare(right.reasonCode))[0];
  let status: WolfConsensus['status'];
  if (
    stats.coverage === 1 &&
    stats.supportRatio >= 2 / 3 &&
    stats.oppositionRatio === 0 &&
    margin >= 15 &&
    stats.reasonAgreement >= 0.5
  ) {
    status = 'agreed';
  } else if (
    stats.oppositionRatio > 0 ||
    (stats.coverage >= 0.5 && (margin < 15 || stats.reasonAgreement < 0.5))
  ) {
    status = 'disputed';
  } else if (stats.coverage < 0.5) {
    status = 'proposed';
  } else {
    status = 'plurality';
  }
  return {
    status,
    targetId: target.targetId,
    backupTargetId: second?.targetId ?? null,
    decisiveReasonCode: decisive?.reasonCode ?? null,
    coverage: stats.coverage,
    supportRatio: stats.supportRatio,
    oppositionRatio: stats.oppositionRatio,
    scoreMargin: margin,
    fingerprint: stats.fingerprint,
    evidenceEventIds: [...new Set(stats.preferences.flatMap((item) => item.evidenceEventIds))],
  };
};

const recompute = (board: WolfAttackBoard): boolean => {
  const nextCandidates: Record<string, WolfCandidate> = {};
  for (const targetId of board.legalTargetIds) {
    if (board.knownWolfIds.includes(targetId)) continue;
    nextCandidates[targetId] = buildCandidate(board, targetId);
  }
  const nextConsensus = computeConsensus(board, nextCandidates);
  const changed = JSON.stringify(board.candidatesById) !== JSON.stringify(nextCandidates) ||
    JSON.stringify(board.consensus) !== JSON.stringify(nextConsensus);
  board.candidatesById = nextCandidates;
  board.consensus = nextConsensus;
  if (nextConsensus.fingerprint && !board.recentPlanFingerprints.includes(nextConsensus.fingerprint)) {
    board.recentPlanFingerprints.push(nextConsensus.fingerprint);
    if (board.recentPlanFingerprints.length > 16) board.recentPlanFingerprints.shift();
  }
  return changed;
};

export const reduceWolfAttackBoard = (
  board: WolfAttackBoard,
  event: DomainEvent,
  playersById: Readonly<Record<string, CognitionPlayer>>,
): void => {
  if (!canWolfTeamSeeEvent(event, playersById)) return;
  board.throughSequence = Math.max(board.throughSequence, event.sequence);
  const annotation = speechAnnotationFromEvent(event);
  let changed = addStructuredContributions(board, event, playersById, annotation);
  changed = addStructuredPreferences(board, event, annotation) || changed;

  if (event.eventType === 'wolf.kill_locked' && typeof event.payload.targetId === 'string') {
    const nextLock = {
      targetId: event.payload.targetId,
      eventId: event.eventId,
      sequence: event.sequence,
    };
    if (JSON.stringify(board.lockedKill) !== JSON.stringify(nextLock)) {
      board.lockedKill = nextLock;
      changed = true;
    }
  }
  if (changed && recompute(board)) board.planVersion += 1;
};

export const consolidateWolfAttackBoard = (
  board: WolfAttackBoard,
  checkpoint: ConsolidationCheckpoint,
): void => {
  const before = JSON.stringify({
    currentWindow: board.currentWindow,
    aliveWolfIds: board.aliveWolfIds,
    legalTargetIds: board.legalTargetIds,
    consensus: board.consensus,
    lockedKill: board.lockedKill,
    preferencesByWolf: board.preferencesByWolf,
    candidatesById: board.candidatesById,
  });
  const alive = new Set(checkpoint.alivePlayerIds);
  board.currentWindow = Math.max(board.currentWindow, checkpoint.stageWindow);
  board.aliveWolfIds = board.knownWolfIds.filter((id) => alive.has(id));
  board.legalTargetIds = checkpoint.legalWolfTargetIds.filter((id) =>
    alive.has(id) && !board.knownWolfIds.includes(id),
  );
  if (checkpoint.kind === 'dawn') {
    if (board.lockedKill && !board.completedLocks.some((item) => item.eventId === board.lockedKill?.eventId)) {
      board.completedLocks.push(board.lockedKill);
    }
    board.lockedKill = null;
    board.preferencesByWolf = Object.fromEntries(board.knownWolfIds.map((id) => [id, []]));
    board.consensus = emptyWolfConsensus();
  }
  recompute(board);
  board.throughSequence = Math.max(board.throughSequence, checkpoint.throughSequence);
  const after = JSON.stringify({
    currentWindow: board.currentWindow,
    aliveWolfIds: board.aliveWolfIds,
    legalTargetIds: board.legalTargetIds,
    consensus: board.consensus,
    lockedKill: board.lockedKill,
    preferencesByWolf: board.preferencesByWolf,
    candidatesById: board.candidatesById,
  });
  if (before !== after) board.planVersion += 1;
};

export const featureValue = (
  board: WolfAttackBoard,
  targetId: string,
  feature: WolfFeatureName,
): number => aggregateFeature(board, targetId, feature);
