import type { GameCommand } from '../../shared/protocol';
import type { GameAction, Role } from '../../shared/types';
import type { AIRequestContext, AIPromptContext, AILegalTarget } from './types';

export type ParsedAIOutput =
  | {
      ok: true;
      command: GameCommand;
      speechText?: string;
      reason: string;
    }
  | {
      ok: false;
      code:
        | 'EMPTY_OUTPUT'
        | 'MALFORMED_OUTPUT'
        | 'ACTION_NOT_ALLOWED'
        | 'TARGET_NOT_ALLOWED'
        | 'TARGET_AMBIGUOUS'
        | 'SKILL_NOT_ALLOWED'
        | 'REASON_REQUIRED';
      message: string;
    };

type ParseContext = Pick<
  AIRequestContext,
  'allowedCommandTypes' | 'players' | 'playerId' | 'role' | 'phase' | 'stage' | 'promptContext'
>;

const fail = (
  code: Exclude<ParsedAIOutput, { ok: true }>['code'],
  message: string,
): ParsedAIOutput => ({ ok: false, code, message });

const allowed = (
  context: ParseContext,
  commandType: GameCommand['type'],
): boolean => context.allowedCommandTypes.includes(commandType);

const cleanText = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .trim()
        .replace(/^```(?:json|text)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim()
    : '';

const stripTargetDecorators = (value: string): string =>
  value
    .trim()
    .replace(/^(?:目标|对象|投给|查验|守护|毒药|解药|枪口)\s*[:：]\s*/u, '')
    .replace(/^[`"'“”「」【】{]+|[`"'“”「」】}]+$/gu, '')
    .trim();

const legalTargets = (context: ParseContext): readonly AILegalTarget[] =>
  context.promptContext?.legalTargets ?? [];

const targetId = (
  raw: unknown,
  context: ParseContext,
): { ok: true; id: string } | { ok: false; result: ParsedAIOutput } => {
  const value = stripTargetDecorators(cleanText(raw));
  if (!value) {
    return {
      ok: false,
      result: fail('TARGET_NOT_ALLOWED', 'A target is required.'),
    };
  }
  const exact = legalTargets(context).filter(
    (target) => target.id === value || target.name === value,
  );
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  if (exact.length > 1) {
    return {
      ok: false,
      result: fail('TARGET_AMBIGUOUS', `Target "${value}" is ambiguous.`),
    };
  }
  return {
    ok: false,
    result: fail('TARGET_NOT_ALLOWED', `Target "${value}" is not legal.`),
  };
};

const isSkip = (value: unknown): boolean =>
  /^(?:跳过|弃票|不用|不行动|放弃|空刀|不杀|skip|pass|null)$/iu.test(
    cleanText(value),
  );

const lastWordsSkipLine = /^(?:放弃遗言|跳过遗言|跳过|放弃|过过|过|没话说|不想说|懒得说)\s*(?:[：:,，；;-]\s*(.*))?$/u;

const isLastWordsContext = (context: ParseContext): boolean =>
  context.phase === 'lastWords' ||
  context.stage === 'last_words' ||
  context.promptContext?.lastWordsRoundsRemaining !== undefined;

const parseSkipSpeech = (
  reason: unknown,
  context: ParseContext,
): ParsedAIOutput => {
  if (!allowed(context, 'game.skip_speech')) {
    return fail('ACTION_NOT_ALLOWED', 'game.skip_speech is not allowed.');
  }
  const cleanReason = cleanText(reason);
  if (isLastWordsContext(context) && !cleanReason) {
    return fail('REASON_REQUIRED', 'A last-words skip reason is required.');
  }
  return {
    ok: true,
    command: {
      type: 'game.skip_speech',
      payload: cleanReason ? { reason: cleanReason } : {},
    },
    reason: cleanReason ? `parsed speech skip: ${cleanReason}` : 'parsed speech skip',
  };
};

const parseJson = (raw: string): Record<string, unknown> | null => {
  const cleaned = cleanText(raw);
  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Plain text contracts are supported below.
    }
  }
  return null;
};

const actionForRole = (role: Role, promptContext?: AIPromptContext): GameAction | null => {
  const legalSkill = promptContext?.legalActions?.find((action) =>
    ['guard', 'check', 'heal', 'poison'].includes(action),
  );
  if (legalSkill) return legalSkill;
  if (role === 'guardian') return 'guard';
  if (role === 'seer') return 'check';
  if (role === 'witch') return 'heal';
  return null;
};

const parseSpeech = (
  content: string,
  context: ParseContext,
  commandType: 'game.speak' | 'game.wolf_speak',
): ParsedAIOutput => {
  if (!allowed(context, commandType)) {
    return fail('ACTION_NOT_ALLOWED', `${commandType} is not allowed.`);
  }
  if (!content.trim()) {
    return fail('EMPTY_OUTPUT', 'Speech content is empty.');
  }
  return {
    ok: true,
    command:
      commandType === 'game.speak'
        ? { type: 'game.speak', payload: { content: content.trim() } }
        : { type: 'game.wolf_speak', payload: { content: content.trim() } },
    speechText: content.trim(),
    reason: 'parsed speech',
  };
};

const parseVote = (
  target: unknown,
  reason: unknown,
  context: ParseContext,
  commandType: 'game.vote' | 'game.wolf_vote',
): ParsedAIOutput => {
  if (!allowed(context, commandType)) {
    return fail('ACTION_NOT_ALLOWED', `${commandType} is not allowed.`);
  }
  const voteReason = cleanText(reason);
  const emptyTarget = target === null || target === undefined || isSkip(target);
  if (emptyTarget) {
    if (commandType === 'game.vote' && !context.promptContext?.abstainAllowed) {
      return fail('TARGET_NOT_ALLOWED', 'Abstention is forbidden.');
    }
    if (commandType === 'game.wolf_vote' && target !== null && !isSkip(target)) {
      return fail('TARGET_NOT_ALLOWED', 'A wolf vote target is required.');
    }
    return {
      ok: true,
      command:
        commandType === 'game.vote'
          ? { type: 'game.vote', payload: { targetId: null, reason: voteReason || '弃票' } }
          : { type: 'game.wolf_vote', payload: { targetId: null } },
      reason: commandType === 'game.vote' ? 'parsed abstention' : 'parsed empty kill',
    };
  }
  const resolved = targetId(target, context);
  if (resolved.ok === false) return resolved.result;
  if (commandType === 'game.vote' && !voteReason) {
    return fail('REASON_REQUIRED', 'A vote reason is required.');
  }
  return {
    ok: true,
    command:
      commandType === 'game.vote'
        ? {
            type: 'game.vote',
            payload: { targetId: resolved.id, ...(voteReason ? { reason: voteReason } : {}) },
          }
        : { type: 'game.wolf_vote', payload: { targetId: resolved.id } },
    reason: voteReason || 'parsed legal target',
  };
};

const parseNightAction = (
  skillValue: unknown,
  target: unknown,
  context: ParseContext,
): ParsedAIOutput => {
  if (!allowed(context, 'game.night_action')) {
    return fail('ACTION_NOT_ALLOWED', 'game.night_action is not allowed.');
  }
  const skill = cleanText(skillValue).toLowerCase() as GameAction;
  const legalSkills = (context.promptContext?.legalActions ?? []).filter((action) =>
    ['guard', 'check', 'heal', 'poison'].includes(action),
  );
  const selectedSkill = (skill || (legalSkills.length === 1 ? legalSkills[0] : '')) as GameAction | '';
  if (selectedSkill === '' || !legalSkills.includes(selectedSkill)) {
    return fail('SKILL_NOT_ALLOWED', `Skill "${selectedSkill || 'unknown'}" is not legal.`);
  }
  if (selectedSkill === 'heal') {
    return {
      ok: true,
      command: {
        type: 'game.night_action',
        payload: { playerId: context.playerId, action: 'heal', targetId: null },
      },
      reason: 'parsed heal action',
    };
  }
  const resolved = targetId(target, context);
  if (resolved.ok === false) return resolved.result;
  return {
    ok: true,
    command: {
      type: 'game.night_action',
      payload: {
        playerId: context.playerId,
        action: selectedSkill as 'guard' | 'check' | 'poison',
        targetId: resolved.id,
      },
    },
    reason: `parsed ${selectedSkill} action`,
  };
};

const parseSkipNight = (context: ParseContext): ParsedAIOutput => {
  if (!allowed(context, 'game.skip_night')) {
    return fail('ACTION_NOT_ALLOWED', 'game.skip_night is not allowed.');
  }
  const action = actionForRole(context.role, context.promptContext);
  if (!action || !['guard', 'check', 'heal', 'poison'].includes(action)) {
    return fail('SKILL_NOT_ALLOWED', 'No legal night skip action is available.');
  }
  return {
    ok: true,
    command: { type: 'game.skip_night', payload: { action } },
    reason: 'parsed night skip',
  };
};

const parseHunter = (target: unknown, action: unknown, context: ParseContext): ParsedAIOutput => {
  if (!allowed(context, 'game.hunter_shoot')) {
    return fail('ACTION_NOT_ALLOWED', 'game.hunter_shoot is not allowed.');
  }
  if (isSkip(action) || isSkip(target)) {
    if (!context.promptContext?.legalActions?.includes('skip_hunter_shot')) {
      return fail('TARGET_NOT_ALLOWED', 'Skipping the hunter shot is forbidden.');
    }
    return {
      ok: true,
      command: { type: 'game.hunter_shoot', payload: { targetId: null } },
      reason: 'parsed skipped hunter shot',
    };
  }
  const resolved = targetId(target, context);
  if (resolved.ok === false) return resolved.result;
  return {
    ok: true,
    command: { type: 'game.hunter_shoot', payload: { targetId: resolved.id } },
    reason: 'parsed hunter shot',
  };
};

const parseObject = (
  object: Record<string, unknown>,
  context: ParseContext,
): ParsedAIOutput => {
  const action = cleanText(object.action).toLowerCase();
  switch (action) {
    case 'confirm_role':
    case 'confirm':
      return allowed(context, 'game.confirm_role')
        ? {
            ok: true,
            command: { type: 'game.confirm_role', payload: {} },
            reason: 'parsed role confirmation',
          }
        : fail('ACTION_NOT_ALLOWED', 'Role confirmation is not allowed.');
    case 'speak':
      return parseSpeech(cleanText(object.content), context, 'game.speak');
    case 'wolf_speak':
    case 'wolf-chat':
      return parseSpeech(cleanText(object.content), context, 'game.wolf_speak');
    case 'vote':
      return parseVote(object.target ?? object.targetId, object.reason, context, 'game.vote');
    case 'wolf_vote':
    case 'kill':
      return parseVote(object.target ?? object.targetId, object.reason, context, 'game.wolf_vote');
    case 'night_action':
      return parseNightAction(object.skill ?? object.actionType, object.target ?? object.targetId, context);
    case 'check':
    case 'guard':
    case 'heal':
    case 'poison':
      return parseNightAction(action, object.target ?? object.targetId, context);
    case 'skip_night':
      return parseSkipNight(context);
    case 'skip_speech':
      return parseSkipSpeech(object.reason, context);
    case 'abstain':
      return parseVote(null, '弃票', context, 'game.vote');
    case 'hunter_shoot':
    case 'skip_hunter_shot':
      return parseHunter(object.target ?? object.targetId, action, context);
    default:
      return fail('MALFORMED_OUTPUT', `Unknown action "${action || 'empty'}".`);
  }
};

const parsePlain = (raw: string, context: ParseContext): ParsedAIOutput => {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return fail('EMPTY_OUTPUT', 'Output is empty.');

  if (allowed(context, 'game.confirm_role')) {
    return {
      ok: true,
      command: { type: 'game.confirm_role', payload: {} },
      reason: 'parsed role confirmation',
    };
  }

  const first = lines[0];
  const voteLike =
    allowed(context, 'game.vote') || allowed(context, 'game.wolf_vote');
  if (voteLike) {
    const canAbstain =
      (allowed(context, 'game.vote') && context.promptContext?.abstainAllowed) ||
      allowed(context, 'game.wolf_vote');
    const isTargetLine =
      canAbstain && isSkip(first)
        ? true
        : legalTargets(context).some(
            (target) => target.name === stripTargetDecorators(first) || target.id === stripTargetDecorators(first),
          );
    if (isTargetLine) {
      const reason = lines.slice(1).join(' ').replace(/^(?:理由|原因)\s*[:：]\s*/u, '');
      if (allowed(context, 'game.vote')) {
        return parseVote(isSkip(first) ? null : first, reason, context, 'game.vote');
      }
      return parseVote(isSkip(first) ? null : first, reason, context, 'game.wolf_vote');
    }
  }

  if (allowed(context, 'game.night_action')) {
    const actionMatch = /(?:查验|检查|check|守护|guard|解药|救|heal|毒药|毒|poison)\s*[:：]?\s*(.*)$/iu.exec(raw);
    if (actionMatch) {
      const actionText = actionMatch[0].toLowerCase();
      const skill = actionText.includes('查验') || actionText.includes('检查') || actionText.includes('check')
        ? 'check'
        : actionText.includes('守护') || actionText.includes('guard')
          ? 'guard'
          : actionText.includes('毒') || actionText.includes('poison')
            ? 'poison'
            : 'heal';
      return parseNightAction(skill, actionMatch[1], context);
    }
  }

  if (allowed(context, 'game.skip_night') && isSkip(first)) {
    return parseSkipNight(context);
  }
  if (allowed(context, 'game.hunter_shoot')) {
    return parseHunter(isSkip(first) ? null : first, isSkip(first) ? first : undefined, context);
  }
  if (allowed(context, 'game.skip_speech') && isSkip(first)) {
    return parseSkipSpeech(lines.slice(1).join(' '), context);
  }
  if (allowed(context, 'game.skip_speech') && isLastWordsContext(context)) {
    const skipLine = lastWordsSkipLine.exec(first);
    if (skipLine) {
      const shortReason = ['没话说', '不想说', '懒得说'].includes(first) ? first : '';
      return parseSkipSpeech(skipLine[1] || shortReason || lines.slice(1).join(' '), context);
    }
  }
  if (allowed(context, 'game.speak')) return parseSpeech(raw, context, 'game.speak');
  if (allowed(context, 'game.wolf_speak')) return parseSpeech(raw, context, 'game.wolf_speak');
  return fail('ACTION_NOT_ALLOWED', 'No matching command type is allowed.');
};

export const parseAIOutput = (
  rawOutput: string,
  context: ParseContext,
): ParsedAIOutput => {
  const raw = cleanText(rawOutput);
  if (!raw) return fail('EMPTY_OUTPUT', 'AI output is empty.');
  const object = parseJson(raw);
  return object ? parseObject(object, context) : parsePlain(raw, context);
};
