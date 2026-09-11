export type Alignment = 'wolf' | 'good';

export type Role =
  | 'wolf'
  | 'seer'
  | 'witch'
  | 'hunter'
  | 'guardian'
  | 'villager';

export type PlayerId = string;

export interface CorePlayer {
  id: PlayerId;
  role: Role;
  alive: boolean;
}

export type TopLevelPhase = 'lobby' | 'role_confirm' | 'night' | 'day' | 'ended';

export const NIGHT_STAGES = [
  'guard_seer',
  'wolf_discussion',
  'wolf_vote',
  'witch',
  'resolve',
] as const;

export type NightStage = (typeof NIGHT_STAGES)[number];

export type DayStage =
  | 'dawn'
  | 'speech'
  | 'discussion'
  | 'voting'
  | 'exile_result'
  | 'last_words'
  | 'hunter'
  | 'day_end';

export type DeathCause = 'wolf_kill' | 'poison' | 'exile' | 'hunter_shot';

export interface DeathRecord {
  playerId: PlayerId;
  cause: DeathCause;
}

export interface ValidationIssue {
  code:
    | 'actor_not_found'
    | 'actor_dead'
    | 'wrong_role'
    | 'wrong_stage'
    | 'target_required'
    | 'target_not_found'
    | 'target_dead'
    | 'self_target_forbidden'
    | 'consecutive_guard_forbidden'
    | 'antidote_unavailable'
    | 'poison_unavailable'
    | 'kill_notice_unavailable'
    | 'both_potions_forbidden'
    | 'ineligible_voter'
    | 'ineligible_target'
    | 'abstain_forbidden';
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: readonly ValidationIssue[] };

export interface WitchInventory {
  antidote: number;
  poison: number;
}

export interface NightActions {
  guardTargetId: PlayerId | null;
  seerTargetId: PlayerId | null;
  wolfKillTargetId: PlayerId | null;
  witchUsesAntidote: boolean;
  witchPoisonTargetId: PlayerId | null;
}

export interface NightState {
  stage: NightStage;
  stageRevision: number;
  guardComplete: boolean;
  seerComplete: boolean;
  actions: NightActions;
}

export interface WitchNightView {
  hasKillNotice: boolean;
  killTargetId: PlayerId | null;
  canUseAntidote: boolean;
}

export interface NightResolution {
  players: readonly CorePlayer[];
  deaths: readonly DeathRecord[];
  guardedTargetId: PlayerId | null;
  healedTargetId: PlayerId | null;
  poisonedTargetId: PlayerId | null;
  peacefulNight: boolean;
  publicDeaths: readonly PlayerId[];
}

export type Winner = 'good' | 'wolf' | 'draw';

export interface VictoryResult {
  winner: Winner | null;
  reason:
    | 'all_werewolves_dead'
    | 'all_gods_dead'
    | 'all_villagers_dead'
    | 'simultaneous_conditions'
    | null;
}

export interface VictoryContext {
  checkpoint: 'after_atomic_resolution';
}

export type VoteChoice = PlayerId | null;

export interface VoteBallot {
  voterId: PlayerId;
  targetId: VoteChoice;
  reason?: string | null;
}

export interface VoteTally {
  counts: Readonly<Record<PlayerId, number>>;
  leaders: readonly PlayerId[];
  maxVotes: number;
}

export interface WolfVoteResult {
  status: 'kill_locked';
  targetId: PlayerId | null;
}

export type ExileVoteResult =
  | { status: 'exiled'; targetId: PlayerId; round: 1 | 2; tally: VoteTally }
  | {
      status: 'revote_required';
      candidates: readonly PlayerId[];
      eligibleVoterIds: readonly PlayerId[];
      round: 2;
      tally: VoteTally;
    }
  | { status: 'no_exile'; round: 1 | 2; tally: VoteTally };

export interface LastWordsEligibility {
  eligible: boolean;
  maxRounds: 0 | 2;
  reason: 'exile_two_rounds' | 'death_cause_ineligible';
}
