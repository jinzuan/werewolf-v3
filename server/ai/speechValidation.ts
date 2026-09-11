import type { GameCommand } from '../../shared/protocol';
import {
  SpeechGate,
  type SpeechGateIssue,
  type SpeechPlannerResult,
} from './speech';
import { buildSpeechDecisionContext } from './speechDecisionContext';
import { inspectSpeechStyle } from './speechStyleGate';
import type { AIRequestContext } from './types';

export interface ProviderSpeechValidation {
  ok: boolean;
  category?: 'style' | 'render';
  rewriteInstruction: string;
  issues: string[];
}

const isWolfSpeech = (
  commandType: GameCommand['type'],
): commandType is 'game.wolf_speak' => commandType === 'game.wolf_speak';

const renderLimitFor = (context: AIRequestContext): number => {
  if (context.stage === 'discussion') return 90;
  if (context.stage === 'last_words' || context.phase === 'lastWords') return 80;
  if (context.role === 'wolf' && context.allowedCommandTypes.includes('game.wolf_speak')) return 60;
  return 80;
};

/**
 * The current provider contract still returns the legacy { action, content }
 * envelope, so it cannot carry a model-authored SpeechPlan yet.  We create a
 * deliberately conservative server-derived plan for the text-only gate. It
 * does not grant a target or invent evidence; it only lets the P0 renderer
 * checks run before any speech reaches GameSession.
 */
const compatibilityPlanFor = (
  context: AIRequestContext,
  commandType: 'game.speak' | 'game.wolf_speak',
): SpeechPlannerResult => {
  const wolf = isWolfSpeech(commandType);
  const decision = buildSpeechDecisionContext(context, context.promptContext ?? {});
  const render = {
    length: 'normal' as const,
    max_graphemes: renderLimitFor(context),
    max_sentences: (wolf || context.stage === 'discussion' ? 2 : 3) as 2 | 3,
    allow_direct_quote: false as const,
    tone: 'table_talk' as const,
  };
  const claim = {
    kind: 'observation' as const,
    subject_id: null,
    predicate: wolf ? 'adds_kill_risk' as const : 'holds_position' as const,
    object: null,
    evidence_event_ids: [],
    confidence: 'low' as const,
    commitment_strength: null,
  };
  if (!wolf) {
    return {
      contract_version: 'speech-plan.v1',
      result: 'speech',
      action: 'speak',
      channel: 'public',
      speech_act: decision.requiresResponse ? 'answer' : 'hold',
      novelty: decision.requiresResponse
        ? 'direct_response'
        : decision.newInformation.length > 0
          ? 'new_fact'
          : 'new_inference',
      responding_to_event_id: null,
      new_event_ids: [],
      target_id: null,
      claim,
      wolf_plan: null,
      render,
    };
  }
  return {
    contract_version: 'speech-plan.v1',
    result: 'speech',
    action: 'wolf_speak',
    channel: 'wolf_private',
    speech_act: 'add_risk',
    novelty: decision.newInformation.length > 0 ? 'new_fact' : 'new_inference',
    responding_to_event_id: null,
    new_event_ids: [],
    target_id: null,
    claim,
    wolf_plan: {
          plan_version: 0,
          coordination: 'add_risk',
          route: 'uncommitted',
          route_basis: 'none',
          route_evidence_event_ids: [],
          target_role_hypothesis: {
            role: 'unknown',
            confidence: 'low',
            basis: 'none',
            evidence_event_ids: [],
          },
          decisive_reason_code: 'blind_pick',
          alternative_target_id: null,
          new_risk_code: null,
          special_strategy: null,
        },
    render,
  };
};

const gateMessage = (issues: readonly SpeechGateIssue[]): string =>
  issues.map((issue) => issue.message).join('；');

/** Shared provider/orchestrator speech validation; human commands do not use this path. */
export const validateProviderSpeech = (
  text: string,
  context: AIRequestContext,
  commandType: 'game.speak' | 'game.wolf_speak',
): ProviderSpeechValidation => {
  const style = inspectSpeechStyle(text, {
    commandType,
    role: context.role,
    phase: context.phase,
    stage: context.stage,
    players: context.players,
    promptContext: context.promptContext,
  });
  if (!style.ok) {
    return {
      ok: false,
      category: 'style',
      rewriteInstruction: style.rewriteInstruction,
      issues: style.issues,
    };
  }

  const rendered = new SpeechGate().validate(
    text,
    compatibilityPlanFor(context, commandType),
    {
      source_speeches: (context.promptContext?.currentRoundSpeeches ?? [])
        .map((content, index) => ({ event_id: `context:${index}`, content })),
    },
  );
  if (rendered.ok === false) {
    return {
      ok: false,
      category: 'render',
      rewriteInstruction: `只保留一个新的桌上观点，直接说事实、判断或下一步；${gateMessage(rendered.issues)}不要解释改写过程。`,
      issues: rendered.issues.map((issue) => issue.code),
    };
  }
  return { ok: true, rewriteInstruction: '', issues: [] };
};
