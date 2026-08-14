import type {
  CorePlayer,
  NightStage,
  PlayerId,
  Role,
  ValidationIssue,
  ValidationResult,
  WitchInventory,
} from './types';

const success = (): ValidationResult => ({ ok: true });
const failure = (...issues: ValidationIssue[]): ValidationResult => ({ ok: false, issues });

function findPlayer(players: readonly CorePlayer[], playerId: PlayerId): CorePlayer | undefined {
  return players.find((player) => player.id === playerId);
}

export function validateActor(
  players: readonly CorePlayer[],
  actorId: PlayerId,
  role: Role,
  actualStage: NightStage,
  allowedStages: readonly NightStage[],
): ValidationResult {
  const actor = findPlayer(players, actorId);
  if (!actor) return failure({ code: 'actor_not_found', message: 'Actor does not exist.' });
  if (!actor.alive) return failure({ code: 'actor_dead', message: 'Dead players cannot act.' });
  if (actor.role !== role) return failure({ code: 'wrong_role', message: `Action requires role ${role}.` });
  if (!allowedStages.includes(actualStage)) {
    return failure({ code: 'wrong_stage', message: `Action is not allowed during ${actualStage}.` });
  }
  return success();
}

export interface TargetPolicy {
  required?: boolean;
  allowSelf?: boolean;
  allowedTargetIds?: readonly PlayerId[];
}

export function validateTarget(
  players: readonly CorePlayer[],
  actorId: PlayerId,
  targetId: PlayerId | null,
  policy: TargetPolicy = {},
): ValidationResult {
  if (targetId === null) {
    return policy.required
      ? failure({ code: 'target_required', message: 'A target is required.' })
      : success();
  }

  const target = findPlayer(players, targetId);
  if (!target) return failure({ code: 'target_not_found', message: 'Target does not exist.' });
  if (!target.alive) return failure({ code: 'target_dead', message: 'Target must be alive.' });
  if (targetId === actorId && policy.allowSelf === false) {
    return failure({ code: 'self_target_forbidden', message: 'Self targeting is forbidden.' });
  }
  if (policy.allowedTargetIds && !policy.allowedTargetIds.includes(targetId)) {
    return failure({ code: 'ineligible_target', message: 'Target is outside the allowed candidate set.' });
  }
  return success();
}

export function validateGuardAction(
  players: readonly CorePlayer[],
  actorId: PlayerId,
  targetId: PlayerId | null,
  lastTargetId: PlayerId | null,
  stage: NightStage,
): ValidationResult {
  const actor = validateActor(players, actorId, 'guardian', stage, ['guard_seer']);
  if (!actor.ok) return actor;
  const target = validateTarget(players, actorId, targetId, { allowSelf: true });
  if (!target.ok) return target;
  if (targetId !== null && targetId === lastTargetId) {
    return failure({
      code: 'consecutive_guard_forbidden',
      message: 'The guardian cannot protect the same target on consecutive nights.',
    });
  }
  return success();
}

export function validateSeerAction(
  players: readonly CorePlayer[],
  actorId: PlayerId,
  targetId: PlayerId,
  stage: NightStage,
): ValidationResult {
  const actor = validateActor(players, actorId, 'seer', stage, ['guard_seer']);
  if (!actor.ok) return actor;
  return validateTarget(players, actorId, targetId, { required: true, allowSelf: false });
}

export function validateWolfKillTarget(
  players: readonly CorePlayer[],
  actorId: PlayerId,
  targetId: PlayerId | null,
  stage: NightStage,
): ValidationResult {
  const actor = validateActor(players, actorId, 'wolf', stage, ['wolf_vote']);
  if (!actor.ok) return actor;
  return validateTarget(players, actorId, targetId, {
    allowSelf: true,
  });
}

export interface WitchActionInput {
  useAntidote: boolean;
  poisonTargetId: PlayerId | null;
}

export function validateWitchAction(
  players: readonly CorePlayer[],
  actorId: PlayerId,
  action: WitchActionInput,
  inventory: WitchInventory,
  killNoticeTargetId: PlayerId | null,
  stage: NightStage,
): ValidationResult {
  const actor = validateActor(players, actorId, 'witch', stage, ['witch']);
  if (!actor.ok) return actor;

  const issues: ValidationIssue[] = [];
  if (action.useAntidote && inventory.antidote < 1) {
    issues.push({ code: 'antidote_unavailable', message: 'The antidote has already been used.' });
  }
  if (action.useAntidote && killNoticeTargetId === null) {
    issues.push({
      code: 'kill_notice_unavailable',
      message: 'The antidote cannot be used without a current kill notice.',
    });
  }
  if (action.poisonTargetId !== null && inventory.poison < 1) {
    issues.push({ code: 'poison_unavailable', message: 'The poison has already been used.' });
  }
  if (action.useAntidote && action.poisonTargetId !== null) {
    issues.push({
      code: 'both_potions_forbidden',
      message: 'The witch cannot use antidote and poison in the same night.',
    });
  }
  if (action.poisonTargetId !== null) {
    const target = validateTarget(players, actorId, action.poisonTargetId, {
      required: true,
      allowSelf: false,
    });
    if (target.ok === false) issues.push(...target.issues);
  }

  return issues.length > 0 ? { ok: false, issues } : success();
}

export interface VoteValidationPolicy {
  eligibleVoterIds: readonly PlayerId[];
  eligibleTargetIds: readonly PlayerId[];
  abstainAllowed: boolean;
}

export function validateVoteChoice(
  voterId: PlayerId,
  targetId: PlayerId | null,
  policy: VoteValidationPolicy,
): ValidationResult {
  if (!policy.eligibleVoterIds.includes(voterId)) {
    return failure({ code: 'ineligible_voter', message: 'This player cannot vote in the current round.' });
  }
  if (targetId === null) {
    return policy.abstainAllowed
      ? success()
      : failure({ code: 'abstain_forbidden', message: 'Abstention is forbidden in this vote.' });
  }
  if (targetId === voterId) {
    return failure({ code: 'self_target_forbidden', message: 'A voter cannot vote for themselves.' });
  }
  if (!policy.eligibleTargetIds.includes(targetId)) {
    return failure({ code: 'ineligible_target', message: 'This target is not eligible in the current round.' });
  }
  return success();
}

export function canHunterShoot(cause: 'wolf_kill' | 'poison' | 'exile' | 'hunter_shot'): boolean {
  return cause === 'exile';
}

export function validateHunterShot(
  players: readonly CorePlayer[],
  hunterId: PlayerId,
  cause: 'wolf_kill' | 'poison' | 'exile' | 'hunter_shot',
  targetId: PlayerId | null,
): ValidationResult {
  const hunter = findPlayer(players, hunterId);
  if (!hunter) return failure({ code: 'actor_not_found', message: 'Hunter does not exist.' });
  if (hunter.role !== 'hunter') {
    return failure({ code: 'wrong_role', message: 'Only the hunter can use the hunter shot.' });
  }
  if (!canHunterShoot(cause)) {
    return failure({ code: 'wrong_stage', message: 'The hunter may shoot only after exile.' });
  }
  return validateTarget(players, hunterId, targetId, { allowSelf: false });
}
