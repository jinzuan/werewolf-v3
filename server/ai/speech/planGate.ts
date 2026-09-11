import type {
  PlannedClaimPredicate,
  PlannedSpecialStrategy,
  SpeechPlan,
  SpeechPlanAction,
  SpeechPlannerResult,
  SkipPlan,
  WolfSpeechPlan,
} from './speech-plan.v1';

export type PlanGateIssueCode =
  | 'INVALID_CONTEXT'
  | 'ILLEGAL_ACTION'
  | 'ILLEGAL_TARGET'
  | 'INVALID_CLAIM_TARGET'
  | 'INVALID_CLAIM_CONFIDENCE'
  | 'INVALID_COMMITMENT'
  | 'INVALID_EVIDENCE'
  | 'PRIVATE_EVIDENCE_IN_PUBLIC'
  | 'INVALID_RESPONSE_REFERENCE'
  | 'UNSUPPORTED_ROUTE'
  | 'UNSUPPORTED_TARGET_ROLE'
  | 'SELF_TARGET_REQUIRES_STRATEGY'
  | 'TEAMMATE_TARGET_REQUIRES_STRATEGY'
  | 'INVALID_SPECIAL_STRATEGY';

export interface PlanGateIssue {
  code: PlanGateIssueCode;
  path: string;
  message: string;
}

export interface PlanGateTarget {
  id: string;
  self: boolean;
  teammate: boolean;
  special_strategy_required: boolean;
}

export interface PlanGateEvent {
  id: string;
  visibility: 'public' | 'wolf_private' | 'role_private';
  /** A response may reference only a source event, never another response. */
  reply_to_event_id?: string | null;
  recursive_bridge?: boolean;
}

export interface PlanGateContext {
  legal_actions: readonly SpeechPlanAction[];
  legal_targets: readonly PlanGateTarget[];
  visible_events: readonly PlanGateEvent[];
  allow_self_kill?: boolean;
  allow_teammate_sacrifice?: boolean;
}

export type PlanGateResult =
  | { ok: true; disposition: 'render'; plan: SpeechPlan }
  | { ok: true; disposition: 'skip'; plan: SkipPlan }
  | { ok: false; disposition: 'reject'; issues: PlanGateIssue[] };

const TARGET_BEARING_PREDICATES = new Set<PlannedClaimPredicate>([
  'leans_alignment',
  'commits_vote',
  'holds_position',
  'prefer_as_kill_target',
  'changes_kill_target',
  'rejects_kill_target',
  'adds_kill_risk',
]);

const COMMITMENT_PREDICATES = new Set<PlannedClaimPredicate>([
  'leans_alignment',
  'commits_vote',
  'holds_position',
  'prefer_as_kill_target',
  'changes_kill_target',
  'rejects_kill_target',
]);

const eventIsVisible = (
  channel: SpeechPlan['channel'],
  event: PlanGateEvent,
): boolean => channel === 'wolf_private' || event.visibility === 'public';

const strategyMatchesTarget = (
  strategy: PlannedSpecialStrategy | null,
  target: PlanGateTarget,
  context: PlanGateContext,
): PlanGateIssue | null => {
  if (target.self) {
    if (
      !context.allow_self_kill ||
      strategy?.code !== 'self_kill_deception' ||
      strategy.evidence_event_ids.length === 0
    ) {
      return {
        code: 'SELF_TARGET_REQUIRES_STRATEGY',
        path: 'target_id',
        message: 'A self target requires an enabled self_kill_deception strategy with evidence.',
      };
    }
    return null;
  }

  if (target.teammate) {
    if (
      !context.allow_teammate_sacrifice ||
      strategy?.code !== 'teammate_sacrifice' ||
      strategy.evidence_event_ids.length === 0
    ) {
      return {
        code: 'TEAMMATE_TARGET_REQUIRES_STRATEGY',
        path: 'target_id',
        message: 'A teammate target requires an enabled teammate_sacrifice strategy with evidence.',
      };
    }
    return null;
  }

  if (target.special_strategy_required && strategy === null) {
    return {
      code: 'INVALID_SPECIAL_STRATEGY',
      path: 'wolf_plan.special_strategy',
      message: 'This target requires an explicit special strategy.',
    };
  }
  if (!target.special_strategy_required && strategy !== null) {
    return {
      code: 'INVALID_SPECIAL_STRATEGY',
      path: 'wolf_plan.special_strategy',
      message: 'A normal target cannot carry a special strategy.',
    };
  }
  return null;
};

const validateEvidence = (
  ids: readonly string[],
  path: string,
  plan: SpeechPlan,
  eventsById: ReadonlyMap<string, PlanGateEvent>,
  issues: PlanGateIssue[],
): void => {
  for (const id of ids) {
    const event = eventsById.get(id);
    if (!event) {
      issues.push({
        code: 'INVALID_EVIDENCE',
        path,
        message: `Evidence event ${id} is absent from the canonical visible context.`,
      });
      continue;
    }
    if (!eventIsVisible(plan.channel, event)) {
      issues.push({
        code: 'PRIVATE_EVIDENCE_IN_PUBLIC',
        path,
        message: `Evidence event ${id} is not visible in the public channel.`,
      });
    }
  }
};

const validateTarget = (
  targetId: string,
  path: string,
  plan: WolfSpeechPlan | SpeechPlan,
  context: PlanGateContext,
  issues: PlanGateIssue[],
  allowSpecialStrategy: boolean,
): void => {
  const target = context.legal_targets.find((candidate) => candidate.id === targetId);
  if (!target) {
    issues.push({
      code: 'ILLEGAL_TARGET',
      path,
      message: `Target ${targetId} is not in the server-provided legal target set.`,
    });
    return;
  }

  const strategy = plan.channel === 'wolf_private' && allowSpecialStrategy
    ? plan.wolf_plan.special_strategy
    : null;
  if (!allowSpecialStrategy && (target.self || target.teammate || target.special_strategy_required)) {
    issues.push({
      code: 'ILLEGAL_TARGET',
      path,
      message: `Target ${targetId} requires a strategy that is not valid for this field.`,
    });
    return;
  }

  const issue = strategyMatchesTarget(strategy, target, context);
  if (issue) issues.push({ ...issue, path });
};

export const validateSpeechPlan = (
  candidate: SpeechPlannerResult,
  context: PlanGateContext,
): PlanGateResult => {
  if (candidate.result === 'invalid_context') {
    return {
      ok: false,
      disposition: 'reject',
      issues: [{
        code: 'INVALID_CONTEXT',
        path: 'result',
        message: 'Invalid planner context cannot enter rendering.',
      }],
    };
  }

  if (!context.legal_actions.includes(candidate.action)) {
    return {
      ok: false,
      disposition: 'reject',
      issues: [{
        code: 'ILLEGAL_ACTION',
        path: 'action',
        message: `Action ${candidate.action} is not legal in the current server state.`,
      }],
    };
  }

  if (candidate.result === 'skip') {
    return { ok: true, disposition: 'skip', plan: candidate };
  }

  const plan = candidate;
  const issues: PlanGateIssue[] = [];
  const eventsById = new Map(context.visible_events.map((event) => [event.id, event]));
  const targetBearing = TARGET_BEARING_PREDICATES.has(plan.claim.predicate);

  if (targetBearing) {
    if (plan.target_id === null) {
      issues.push({
        code: 'INVALID_CLAIM_TARGET',
        path: 'target_id',
        message: `Predicate ${plan.claim.predicate} requires a target.`,
      });
    } else if (
      plan.claim.subject_id !== null &&
      plan.claim.subject_id !== plan.target_id
    ) {
      issues.push({
        code: 'INVALID_CLAIM_TARGET',
        path: 'claim.subject_id',
        message: 'A target-bearing claim subject must be null or equal to target_id.',
      });
    }
  } else if (plan.target_id !== null) {
    issues.push({
      code: 'INVALID_CLAIM_TARGET',
      path: 'target_id',
      message: `Predicate ${plan.claim.predicate} does not use target_id.`,
    });
  }

  if (
    (plan.claim.kind === 'inference' || plan.claim.kind === 'proposal') &&
    plan.claim.confidence === 'high'
  ) {
    issues.push({
      code: 'INVALID_CLAIM_CONFIDENCE',
      path: 'claim.confidence',
      message: 'Inference and proposal claims cannot claim high confidence.',
    });
  }

  const commitmentRequired = COMMITMENT_PREDICATES.has(plan.claim.predicate);
  if (commitmentRequired !== (plan.claim.commitment_strength !== null)) {
    issues.push({
      code: 'INVALID_COMMITMENT',
      path: 'claim.commitment_strength',
      message: commitmentRequired
        ? 'This predicate requires tentative or firm commitment strength.'
        : 'This predicate cannot carry commitment strength.',
    });
  }

  if (plan.target_id !== null) {
    validateTarget(plan.target_id, 'target_id', plan, context, issues, true);
  } else if (plan.channel === 'wolf_private' && plan.wolf_plan.special_strategy !== null) {
    issues.push({
      code: 'INVALID_SPECIAL_STRATEGY',
      path: 'wolf_plan.special_strategy',
      message: 'A special strategy requires a target.',
    });
  }

  validateEvidence(
    plan.claim.evidence_event_ids,
    'claim.evidence_event_ids',
    plan,
    eventsById,
    issues,
  );
  validateEvidence(plan.new_event_ids, 'new_event_ids', plan, eventsById, issues);

  if (plan.responding_to_event_id !== null) {
    const responseSource = eventsById.get(plan.responding_to_event_id);
    if (
      !responseSource ||
      !eventIsVisible(plan.channel, responseSource) ||
      responseSource.reply_to_event_id != null ||
      responseSource.recursive_bridge === true
    ) {
      issues.push({
        code: 'INVALID_RESPONSE_REFERENCE',
        path: 'responding_to_event_id',
        message: 'A response may reference only one directly visible, non-recursive source event.',
      });
    }
  }

  if (plan.channel === 'wolf_private') {
    const wolfPlan = plan.wolf_plan;
    if (wolfPlan.route !== 'uncommitted') {
      if (
        wolfPlan.route_basis === 'none' ||
        wolfPlan.route_evidence_event_ids.length === 0
      ) {
        issues.push({
          code: 'UNSUPPORTED_ROUTE',
          path: 'wolf_plan.route',
          message: 'A gods or villagers route requires a non-none basis and evidence.',
        });
      }
      validateEvidence(
        wolfPlan.route_evidence_event_ids,
        'wolf_plan.route_evidence_event_ids',
        plan,
        eventsById,
        issues,
      );
    }

    const hypothesis = wolfPlan.target_role_hypothesis;
    if (hypothesis.role === 'unknown') {
      if (hypothesis.basis !== 'none' || hypothesis.evidence_event_ids.length !== 0) {
        issues.push({
          code: 'UNSUPPORTED_TARGET_ROLE',
          path: 'wolf_plan.target_role_hypothesis',
          message: 'An unknown target role cannot carry a role basis or evidence.',
        });
      }
    } else {
      if (hypothesis.basis === 'none' || hypothesis.evidence_event_ids.length === 0) {
        issues.push({
          code: 'UNSUPPORTED_TARGET_ROLE',
          path: 'wolf_plan.target_role_hypothesis',
          message: 'A named target role requires a public claim or validated team-state evidence.',
        });
      }
      validateEvidence(
        hypothesis.evidence_event_ids,
        'wolf_plan.target_role_hypothesis.evidence_event_ids',
        plan,
        eventsById,
        issues,
      );
    }

    if (wolfPlan.special_strategy !== null) {
      validateEvidence(
        wolfPlan.special_strategy.evidence_event_ids,
        'wolf_plan.special_strategy.evidence_event_ids',
        plan,
        eventsById,
        issues,
      );
    }

    if (wolfPlan.alternative_target_id !== null) {
      validateTarget(
        wolfPlan.alternative_target_id,
        'wolf_plan.alternative_target_id',
        plan,
        context,
        issues,
        false,
      );
    }
  }

  return issues.length > 0
    ? { ok: false, disposition: 'reject', issues }
    : { ok: true, disposition: 'render', plan };
};

export class PlanGate {
  validate(candidate: SpeechPlannerResult, context: PlanGateContext): PlanGateResult {
    return validateSpeechPlan(candidate, context);
  }
}
