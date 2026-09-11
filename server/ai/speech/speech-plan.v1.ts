export const SPEECH_PLAN_CONTRACT_VERSION = 'speech-plan.v1' as const;

export type PublicSpeechAct =
  | 'report_fact'
  | 'answer'
  | 'correct'
  | 'align'
  | 'ask'
  | 'hold'
  | 'nominate';

export type WolfSpeechAct =
  | 'propose_kill'
  | 'change_kill'
  | 'reject_kill'
  | 'add_risk'
  | 'ask_for_target';

export type PlannedClaimPredicate =
  | 'states_public_fact'
  | 'leans_alignment'
  | 'asks_question'
  | 'answers_question'
  | 'corrects_claim'
  | 'commits_vote'
  | 'holds_position'
  | 'prefer_as_kill_target'
  | 'changes_kill_target'
  | 'rejects_kill_target'
  | 'adds_kill_risk';

export interface PlannedClaim {
  kind: 'fact' | 'observation' | 'inference' | 'proposal';
  subject_id: string | null;
  predicate: PlannedClaimPredicate;
  object: string | number | boolean | null;
  evidence_event_ids: string[];
  confidence: 'low' | 'medium' | 'high';
  commitment_strength: null | 'tentative' | 'firm';
}

export interface PlannedRoleHypothesis {
  role: 'unknown' | 'seer' | 'witch' | 'hunter' | 'guardian' | 'villager';
  confidence: 'low' | 'medium' | 'high';
  basis: 'none' | 'public_role_claim' | 'validated_team_state';
  evidence_event_ids: string[];
}

export interface PlannedSpecialStrategy {
  code: 'self_kill_deception' | 'teammate_sacrifice';
  expected_benefit:
    | 'potion_bait'
    | 'public_credibility'
    | 'route_change'
    | 'team_survival';
  evidence_event_ids: string[];
}

export interface PlannedWolfDelta {
  plan_version: number;
  coordination: 'propose' | 'change' | 'reject' | 'add_risk';
  route: 'uncommitted' | 'gods' | 'villagers';
  route_basis: 'none' | 'count_math' | 'public_role_claim' | 'validated_team_state';
  route_evidence_event_ids: string[];
  target_role_hypothesis: PlannedRoleHypothesis;
  decisive_reason_code:
    | 'public_information_threat'
    | 'public_role_claim'
    | 'vote_control'
    | 'rescue_risk'
    | 'day_exile_value'
    | 'route_distance'
    | 'team_survival'
    | 'alternative_comparison'
    | 'blind_pick';
  alternative_target_id: string | null;
  new_risk_code: string | null;
  special_strategy: PlannedSpecialStrategy | null;
}

export interface RenderDirective {
  length: 'very_short' | 'short' | 'normal';
  max_graphemes: number;
  max_sentences: 1 | 2 | 3;
  allow_direct_quote: false;
  tone: 'table_talk';
}

interface SpeechPlanBase {
  contract_version: typeof SPEECH_PLAN_CONTRACT_VERSION;
  result: 'speech';
  novelty:
    | 'new_fact'
    | 'new_inference'
    | 'new_proposal'
    | 'changed_plan'
    | 'direct_response';
  responding_to_event_id: string | null;
  new_event_ids: string[];
  target_id: string | null;
  claim: PlannedClaim;
  render: RenderDirective;
}

export interface PublicSpeechPlan extends SpeechPlanBase {
  action: 'speak';
  channel: 'public';
  speech_act: PublicSpeechAct;
  wolf_plan: null;
}

export interface WolfSpeechPlan extends SpeechPlanBase {
  action: 'wolf_speak';
  channel: 'wolf_private';
  speech_act: WolfSpeechAct;
  wolf_plan: PlannedWolfDelta;
}

export type SpeechPlan = PublicSpeechPlan | WolfSpeechPlan;

export interface SkipPlan {
  contract_version: typeof SPEECH_PLAN_CONTRACT_VERSION;
  result: 'skip';
  action: 'skip_speech';
  channel: 'public' | 'wolf_private';
  speech_act: 'skip';
  novelty: 'none';
  responding_to_event_id: null;
  new_event_ids: [];
  target_id: null;
  reason_code: 'no_new_information' | 'team_consensus_unchanged' | 'not_addressed';
}

export interface InvalidContextResult {
  contract_version: typeof SPEECH_PLAN_CONTRACT_VERSION;
  result: 'invalid_context';
  error: 'INVALID_CONTEXT';
}

export type SpeechPlannerResult = SpeechPlan | SkipPlan | InvalidContextResult;
export type SpeechPlanAction = SpeechPlan['action'] | SkipPlan['action'];
