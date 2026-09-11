import type { DomainEvent, EventVisibility } from '../../../shared/events';
import type { GameAction, Role } from '../../../shared/types';

export type PlayerId = string;
export type EventId = string;

export interface CognitionPlayer {
  id: PlayerId;
  role: Role;
  isAlive: boolean;
  order: number;
}

export interface CognitionOwner {
  playerId: PlayerId;
  role: Role;
  deathCutoffSequence?: number | null;
}

export interface SourceRef {
  eventId: EventId;
  sequence: number;
  visibility: EventVisibility;
  audienceIds: PlayerId[];
}

export type FactKind =
  | 'game_started'
  | 'day_started'
  | 'player_alive_changed'
  | 'seer_alignment_result'
  | 'guardian_action'
  | 'witch_notice'
  | 'witch_action'
  | 'night_public_result'
  | 'vote_result'
  | 'hunter_result'
  | 'wolf_kill_locked';

export interface FactRecord {
  id: string;
  kind: FactKind;
  subjectId?: PlayerId;
  objectId?: PlayerId;
  value: string | number | boolean | null | readonly string[];
  certainty: 'authoritative';
  source: SourceRef;
}

export interface FactLedger {
  byId: Record<string, FactRecord>;
  orderedIds: string[];
}

export type CanonicalSpeechAct =
  | 'report_fact'
  | 'answer'
  | 'correct'
  | 'align'
  | 'ask'
  | 'hold'
  | 'nominate'
  | 'propose_kill'
  | 'change_kill'
  | 'reject_kill'
  | 'add_risk'
  | 'ask_for_target'
  | 'skip'
  | 'unknown';

export interface ObservedClaim {
  claimId: string;
  eventId: EventId;
  speakerId: PlayerId;
  source: 'validated_ai_plan' | 'human_analyzer' | 'legacy_unparsed';
  speechAct: CanonicalSpeechAct;
  kind: 'fact_claim' | 'observation' | 'inference' | 'proposal';
  subjectId: PlayerId | null;
  targetId: PlayerId | null;
  predicate: string;
  object: string | number | boolean | null;
  confidence: 'low' | 'medium' | 'high';
  evidenceRefs: string[];
  replyToEventId?: EventId;
  revisesClaimId?: string;
  explanationClaimId?: string;
  certainty: 'speaker_claim';
}

export interface SpeechCommitment {
  kind: 'vote' | 'protect' | 'check' | 'kill' | 'public_stance';
  targetId: PlayerId | null;
  strength: 'tentative' | 'firm';
  polarity: 'support' | 'reject';
  reasonCode?: string;
}

export interface SpeechAnnotation {
  annotationVersion: 'speech-annotation.v1';
  eventId: EventId;
  speakerId: PlayerId;
  channel: 'public' | 'wolf_private';
  source: 'validated_ai_plan' | 'human_analyzer' | 'legacy_unparsed';
  parseStatus: 'validated' | 'parsed' | 'unparsed';
  speechAct: CanonicalSpeechAct;
  replyToEventId: EventId | null;
  claims: ObservedClaim[];
  mentionedPlayerIds: PlayerId[];
  commitments: SpeechCommitment[];
  renderedContent: string;
}

export interface UtteranceRecord {
  id: string;
  source: SourceRef;
  speakerId: PlayerId;
  channel: 'public' | 'wolf_private';
  claimIds: string[];
  parseStatus: 'validated' | 'parsed' | 'unparsed';
}

export interface DiscourseLedger {
  utterancesById: Record<string, UtteranceRecord>;
  utteranceIds: string[];
  claimsById: Record<string, ObservedClaim>;
  claimIds: string[];
}

export interface VoteCommitment {
  id: string;
  speakerId: PlayerId;
  targetId: PlayerId | null;
  day: number;
  round: number;
  strength: 'tentative' | 'firm';
  polarity: 'support' | 'reject';
  status: 'open' | 'kept' | 'broken' | 'withdrawn';
  source: SourceRef;
}

export interface BallotRecord {
  id: string;
  voterId: PlayerId;
  targetId: PlayerId | null;
  day: number;
  round: number;
  canonical: boolean;
  source: SourceRef;
}

export interface VoteLedger {
  commitmentsById: Record<string, VoteCommitment>;
  commitmentIds: string[];
  ballotsByKey: Record<string, BallotRecord>;
  ballotKeys: string[];
}

export type TargetStance = 'suspect' | 'trust' | 'neutral';

export interface StanceRecord {
  claimId: string;
  speakerId: PlayerId;
  targetId: PlayerId;
  predicate: string;
  stance: TargetStance;
  source: SourceRef;
}

export interface DisagreementRecord {
  id: string;
  targetId: PlayerId;
  predicate: string;
  leftClaimId: string;
  rightClaimId: string;
  speakerIds: [PlayerId, PlayerId];
}

export interface ContradictionRecord {
  id: string;
  speakerId: PlayerId;
  targetId: PlayerId;
  predicate: string;
  earlierClaimId: string;
  laterClaimId: string;
  explanationClaimId?: string;
  status: 'unexplained' | 'explained';
}

export interface PlayerModel {
  stancesByClaimId: Record<string, StanceRecord>;
  stanceClaimIds: string[];
  disagreementsById: Record<string, DisagreementRecord>;
  disagreementIds: string[];
  contradictionsById: Record<string, ContradictionRecord>;
  contradictionIds: string[];
}

export interface StrategyPriority {
  kind:
    | 'verify_claim'
    | 'answer_question'
    | 'compare_vote'
    | 'protect_info'
    | 'prepare_vote'
    | 'coordinate_team';
  targetId?: PlayerId;
  evidenceIds: string[];
  expiresAtStageRevision?: number;
}

export interface StrategyNotebook {
  ownerId: PlayerId;
  gameId: string;
  throughSequence: number;
  priorities: StrategyPriority[];
  publicCommitmentIds: string[];
  openQuestionClaimIds: string[];
  nextActionCandidates: string[];
  doNotRepeatFingerprints: string[];
  lastDecisionSummaries: Array<{
    stageRevision: number;
    action: string;
    targetId?: PlayerId;
    evidenceIds: string[];
    resultEventId?: EventId;
  }>;
}

export type WolfFeatureName =
  | 'publicRoleClaimValue'
  | 'informationPower'
  | 'voteInfluence'
  | 'coordinationCentrality'
  | 'routeUtility'
  | 'dayExileResistance'
  | 'protectionRisk'
  | 'retaliationRisk'
  | 'coverExposureCost'
  | 'uncertainty';

export interface WolfFeatureContributionDraft {
  targetId: PlayerId;
  feature: WolfFeatureName;
  value: number;
  extractionConfidence: number;
  sourceEventId: EventId;
}

export interface WolfFeatureContribution extends WolfFeatureContributionDraft {
  id: string;
  observedAtSequence: number;
  observedAtWindow: number;
}

export type WolfFeatureKey = 'R' | 'I' | 'V' | 'C' | 'E' | 'X' | 'P' | 'H' | 'O' | 'U';

export interface WolfCandidate {
  targetId: PlayerId;
  legal: boolean;
  teammate: boolean;
  normalized: Record<WolfFeatureKey, number>;
  tacticalScore: number;
  finalScore: number;
}

export interface WolfPreference {
  targetId: PlayerId;
  kind: 'primary' | 'alternate' | 'reject';
  route: 'uncommitted' | 'gods' | 'villagers';
  reasonCode: string;
  evidenceEventIds: string[];
  sourceEventId: EventId;
}

export interface WolfConsensus {
  status: 'empty' | 'proposed' | 'plurality' | 'agreed' | 'disputed' | 'locked';
  targetId: PlayerId | null;
  backupTargetId: PlayerId | null;
  decisiveReasonCode: string | null;
  coverage: number;
  supportRatio: number;
  oppositionRatio: number;
  scoreMargin: number;
  fingerprint: string | null;
  evidenceEventIds: string[];
}

export interface WolfAttackBoard {
  gameId: string;
  planVersion: number;
  throughSequence: number;
  currentWindow: number;
  knownWolfIds: PlayerId[];
  aliveWolfIds: PlayerId[];
  legalTargetIds: PlayerId[];
  route: {
    value: 'uncommitted' | 'gods' | 'villagers';
    basis: 'none' | 'count_math' | 'public_role_claim' | 'validated_team_state';
    evidenceEventIds: string[];
    confidence: 'low' | 'medium' | 'high';
  };
  featureContributionsById: Record<string, WolfFeatureContribution>;
  featureContributionIds: string[];
  candidatesById: Record<PlayerId, WolfCandidate>;
  preferencesByWolf: Record<PlayerId, WolfPreference[]>;
  consensus: WolfConsensus;
  lockedKill: { targetId: PlayerId; eventId: EventId; sequence: number } | null;
  completedLocks: Array<{ targetId: PlayerId; eventId: EventId; sequence: number }>;
  recentPlanFingerprints: string[];
}

export interface OwnerCognition {
  owner: CognitionOwner;
  throughSequence: number;
  facts: FactLedger;
  discourse: DiscourseLedger;
  votes: VoteLedger;
  playerModel: PlayerModel;
  strategy: StrategyNotebook;
}

export interface CognitionStateV2 {
  schemaVersion: 2;
  gameId: string;
  throughSequence: number;
  playersById: Record<PlayerId, CognitionPlayer>;
  ownerMemoriesById: Record<PlayerId, OwnerCognition>;
  wolfAttackBoard: WolfAttackBoard | null;
  appliedEventIds: string[];
  appliedEventIdSet: Record<EventId, true>;
  consolidatedCheckpointIds: string[];
}

export interface CreateCognitionStateInput {
  gameId: string;
  players: readonly CognitionPlayer[];
  ownerIds?: readonly PlayerId[];
  deathCutoffSequenceByOwner?: Readonly<Record<PlayerId, number | null>>;
}

export interface ReduceContext {
  /** Optional override supplied by a replay projector. State ownership remains authoritative. */
  deathCutoffSequenceByOwner?: Readonly<Record<PlayerId, number | null>>;
}

export interface PrepareDecisionInput {
  ownerId: PlayerId;
  asOfSequence: number;
  stageRevision: number;
  legalActions: readonly GameAction[];
  legalTargetIds: readonly PlayerId[];
  mode?: 'full' | 'compact';
  maxItems?: number;
}

export interface PreparedMemoryContext {
  ownerId: PlayerId;
  asOfSequence: number;
  stageRevision: number;
  legalActions: GameAction[];
  legalTargetIds: PlayerId[];
  facts: FactRecord[];
  claims: ObservedClaim[];
  openCommitments: VoteCommitment[];
  commitmentOutcomes: VoteCommitment[];
  disagreements: DisagreementRecord[];
  contradictions: ContradictionRecord[];
  priorities: StrategyPriority[];
  openQuestionClaimIds: string[];
  avoidFingerprints: string[];
  wolfTeam?: {
    candidates: Array<{ targetId: PlayerId; tacticalScore: number; finalScore: number }>;
    consensus: WolfConsensus;
    alternatives: PlayerId[];
    lockedTargetId: PlayerId | null;
    shouldSkipRepeatedConsensus: boolean;
  };
  omitted: { facts: number; claims: number };
}

export interface ConsolidationCheckpoint {
  id: string;
  kind: 'night_open' | 'dawn';
  day: number;
  throughSequence: number;
  stageWindow: number;
  alivePlayerIds: readonly PlayerId[];
  legalWolfTargetIds: readonly PlayerId[];
}

export type CognitionDomainEvent = DomainEvent<string, Record<string, unknown>>;
