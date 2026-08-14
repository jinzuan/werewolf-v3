import { RULESET } from '../../src/core/rules';
import type { GameAction, Role } from '../../shared/types';
import type { GameSession } from '../session/gameSession';
import { experienceLibrary } from './experienceLibrary';
import type { AIContextProjection, AIRequestContext } from './types';

const BASE_RULE_KEYS = [
  'flow.night_stages',
  'flow.guard_seer_parallel',
  'flow.wait_guard_seer',
  'flow.wait_wolf_kill',
  'flow.day_stages',
  'flow.timeout_policy',
  'flow.stage_revision_required',
  'flow.command_id_required',
  'resolution.public_death_causes',
  'resolution.simultaneous_deaths',
  'victory.check_points',
  'voting.eligible_voters',
  'voting.eligible_targets',
  'voting.abstain_allowed',
  'voting.tie_policy',
  'voting.repeat_vote_scope',
  'validation.role_alive_stage',
  'validation.target_validation',
  'validation.duplicate_command',
  'validation.stale_revision',
  'validation.expired_command',
] as const;

const ROLE_RULE_KEYS: Record<Role, readonly string[]> = {
  wolf: [
    'roles.werewolf.alignment',
    'roles.werewolf.knows_teammates',
    'roles.werewolf.can_self_kill',
    'roles.werewolf.can_empty_kill',
    'roles.werewolf.kill_target',
    'roles.werewolf.kill_decision',
    'roles.werewolf.kill_tie',
    'speech.wolf_night_chat',
  ],
  seer: [
    'roles.seer.alignment',
    'roles.seer.checks_per_night',
    'roles.seer.check_self',
    'roles.seer.result_granularity',
    'roles.seer.result_visibility',
  ],
  witch: [
    'roles.witch.alignment',
    'roles.witch.antidote_count',
    'roles.witch.poison_count',
    'roles.witch.antidote_target_binding',
    'roles.witch.guarded_target_notice',
    'roles.witch.antidote_when_no_notice',
    'roles.witch.poison_target',
    'roles.witch.can_self_save',
    'roles.witch.can_use_both_potions_same_night',
    'roles.witch.poison_ignores_guard',
    'roles.witch.action_visibility',
  ],
  hunter: [
    'roles.hunter.alignment',
    'roles.hunter.shoot_trigger',
    'roles.hunter.shoot_when_poisoned',
    'roles.hunter.shoot_when_wolf_killed',
    'roles.hunter.shot_target',
    'roles.hunter.may_skip_shot',
  ],
  guardian: [
    'roles.guardian.alignment',
    'roles.guardian.guards_per_night',
    'roles.guardian.can_guard_self',
    'roles.guardian.consecutive_same_target',
    'roles.guardian.blocks_wolf_kill',
    'roles.guardian.action_visibility',
  ],
  villager: [
    'roles.villager.alignment',
    'roles.villager.night_ability',
  ],
};

const toRuleValues = (role: Role): Record<string, unknown> => {
  const values = RULESET.values as unknown as Record<string, unknown>;
  const keys = [...BASE_RULE_KEYS, ...ROLE_RULE_KEYS[role]];
  return Object.fromEntries(
    [...new Set(keys)].map((key) => [key, values[key]]),
  );
};

const playerViewer = (
  context: Pick<AIRequestContext, 'playerId' | 'role'>,
): AIContextProjection['viewer'] => ({
  kind: 'player',
  playerId: context.playerId,
  role: context.role,
});

export async function projectAIContext(
  session: GameSession,
  context: Pick<
    AIRequestContext,
    'playerId' | 'role' | 'stageRevision' | 'allowedActions'
  >,
): Promise<AIContextProjection> {
  const viewer = playerViewer(context);
  const snapshot = await session.snapshotFor(viewer);
  const events = await session.eventsFor(viewer);
  const allowedActions: GameAction[] = [
    ...(context.allowedActions && context.allowedActions.length > 0
      ? context.allowedActions
      : snapshot.gameState.allowedActions ?? []),
  ];

  return {
    viewer,
    snapshot,
    publicEvents: events.filter(
      (event) => event.visibility === 'public_timeline',
    ),
    privateEvents: events.filter(
      (event) =>
        event.visibility === 'role_private' ||
        event.visibility === 'wolf_private',
    ),
    rules: {
      id: RULESET.id,
      version: RULESET.rulesetVersion,
      values: toRuleValues(context.role),
    },
    experience: experienceLibrary.getReference(
      context.role,
      context.stageRevision,
    ),
    allowedActions,
  };
}
