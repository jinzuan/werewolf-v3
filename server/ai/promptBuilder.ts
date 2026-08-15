import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DomainEvent } from '../../shared/events';
import type { GameCommand } from '../../shared/protocol';
import type { GameAction, Player, Role } from '../../shared/types';
import { RULE_VALUES } from '../../src/core/rules';
import type { AIRequestContext, AILegalTarget, AIPromptContext } from './types';

export interface AIPrompt {
  system: string;
  user: string;
}

export class PromptBuildError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PROMPT_TEMPLATE_NOT_FOUND'
      | 'PROMPT_CONTEXT_INVALID'
      | 'PROMPT_UNRENDERED_PLACEHOLDER',
  ) {
    super(message);
    this.name = 'PromptBuildError';
  }
}

const ROLE_NAMES: Record<Role, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  guardian: '守卫',
  hunter: '猎人',
  villager: '平民',
};

const ACTION_LABELS: Record<GameAction, string> = {
  guard: '守护',
  check: '查验',
  wolf_speak: '狼队发言',
  wolf_vote: '狼刀投票',
  heal: '使用解药',
  poison: '使用毒药',
  skip_night: '跳过夜间行动',
  speak: '公开发言',
  skip_speech: '跳过发言',
  vote: '放逐投票',
  abstain: '弃票',
  hunter_shoot: '猎人开枪',
  skip_hunter_shot: '跳过开枪',
};

const COMMAND_ACTION_NAMES: Partial<Record<GameCommand['type'], string>> = {
  'game.speak': 'speak',
  'game.wolf_speak': 'wolf_speak',
  'game.vote': 'vote',
  'game.wolf_vote': 'wolf_vote',
  'game.night_action': 'night_action',
  'game.skip_night': 'skip_night',
  'game.skip_speech': 'skip_speech',
  'game.hunter_shoot': 'hunter_shoot',
};

const invalidContextResponse = 'INVALID_CONTEXT';

const readPromptFile = (fileName: string): string => {
  const root =
    process.env.WEREWOLF_PROMPT_ROOT ||
    path.resolve(process.cwd(), 'src', 'ai-prompts');
  const filePath = path.join(root, fileName);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new PromptBuildError(
      `Prompt template not found: ${filePath}`,
      'PROMPT_TEMPLATE_NOT_FOUND',
    );
  }
};

const sectionByTitle = (markdown: string, title: string): string => {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    return match?.[2] === title || match?.[2]?.includes(title);
  });
  if (start < 0) return '';
  const heading = /^(#{2,6})\s+/.exec(lines[start]);
  const level = heading?.[1].length ?? 2;
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const match = /^(#{2,6})\s+/.exec(line);
    return Boolean(match && match[1].length <= level);
  });
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
};

const fencedText = (section: string): string => {
  const match = /```(?:text|plaintext)?\s*\r?\n([\s\S]*?)```/.exec(section);
  return match?.[1]?.trim() ?? '';
};

const loadFragment = (fileName: string, title: string): string => {
  const fragment = fencedText(sectionByTitle(readPromptFile(fileName), title));
  if (!fragment) {
    throw new PromptBuildError(
      `Prompt fragment not found: ${fileName} / ${title}`,
      'PROMPT_TEMPLATE_NOT_FOUND',
    );
  }
  return fragment;
};

const listText = (items: readonly string[] | undefined, empty = '无'): string =>
  items && items.length > 0 ? items.join('\n') : empty;

const playerName = (players: readonly Player[], playerId: string | undefined): string =>
  players.find((player) => player.id === playerId)?.name ?? playerId ?? '未知玩家';

const names = (targets: readonly AILegalTarget[] | undefined): string[] =>
  (targets ?? []).map((target) => target.name);

const formatTargets = (targets: readonly AILegalTarget[] | undefined): string =>
  targets && targets.length > 0
    ? targets.map((target) => `${target.name}（${target.id}）`).join('、')
    : '无（当前动作无需目标）';

const valueText = (value: unknown): string => {
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const roleAlignment = (role: Role): string =>
  role === 'wolf' ? '狼人阵营' : '好人阵营';

const ruleValue = <K extends keyof typeof RULE_VALUES>(key: K): string =>
  valueText(RULE_VALUES[key]);

const buildRulesForRole = (role: Role): string => {
  const common = [
    `服务端是唯一权威事实源；规则版本 ${ruleValue('game.authority')}。`,
    `夜间顺序：${ruleValue('flow.night_stages')}。`,
    `胜负模式：${ruleValue('victory.mode')}；判定点：${ruleValue('victory.check_points')}；双方同时达成时：${ruleValue('victory.simultaneous_both_sides_condition')}。`,
    `公开死因：${ruleValue('resolution.public_death_causes')}；平安夜公开结果：${ruleValue('resolution.peaceful_night_public_result')}。`,
    `投票前票型可见性：${ruleValue('voting.vote_visibility_before_lock')}；平票规则：${ruleValue('voting.tie_policy')}。`,
    `所有合法动作与合法目标均由本次服务端上下文给出，不得自行补全。`,
  ];

  const roleRules: Record<Role, string[]> = {
    wolf: [
      `狼人知道存活狼队友：${ruleValue('roles.werewolf.knows_teammates')}。`,
      `可自刀或选择狼队友：${ruleValue('roles.werewolf.can_self_kill')}；狼刀目标范围：${ruleValue('roles.werewolf.kill_target')}。`,
      `允许空刀：${ruleValue('roles.werewolf.can_empty_kill')}；狼刀决策：${ruleValue('roles.werewolf.kill_decision')}；狼刀平票：${ruleValue('roles.werewolf.kill_tie')}。`,
      `狼人胜利条件：神职边全部出局（${ruleValue('victory.werewolf_win_gods')}）或平民边全部出局（${ruleValue('victory.werewolf_win_villagers')}）。`,
    ],
    seer: [
      `每晚查验次数：${ruleValue('roles.seer.checks_per_night')}；可查验自己：${ruleValue('roles.seer.check_self')}。`,
      `查验结果粒度：${ruleValue('roles.seer.result_granularity')}；结果仅向角色私有视角提供。`,
    ],
    witch: [
      `解药数量：${ruleValue('roles.witch.antidote_count')}；毒药数量：${ruleValue('roles.witch.poison_count')}。`,
      `守护成功时刀口通知：${ruleValue('roles.witch.guarded_target_notice')}；无通知时解药：${ruleValue('roles.witch.antidote_when_no_notice')}。`,
      `可自救：${ruleValue('roles.witch.can_self_save')}；同夜同时使用两药：${ruleValue('roles.witch.can_use_both_potions_same_night')}。`,
      `解药目标绑定：${ruleValue('roles.witch.antidote_target_binding')}；毒药目标：${ruleValue('roles.witch.poison_target')}。`,
    ],
    guardian: [
      `每晚守护次数：${ruleValue('roles.guardian.guards_per_night')}；可自守：${ruleValue('roles.guardian.can_guard_self')}。`,
      `不可连续守同一目标：${ruleValue('roles.guardian.consecutive_same_target')}；守护阻断狼刀：${ruleValue('roles.guardian.blocks_wolf_kill')}。`,
    ],
    hunter: [
      `开枪触发：${ruleValue('roles.hunter.shoot_trigger')}；被毒死可开枪：${ruleValue('roles.hunter.shoot_when_poisoned')}；被狼刀可开枪：${ruleValue('roles.hunter.shoot_when_wolf_killed')}。`,
      `枪口目标：${ruleValue('roles.hunter.shot_target')}；允许放弃：${ruleValue('roles.hunter.may_skip_shot')}。`,
    ],
    villager: [
      `夜间能力：${ruleValue('roles.villager.night_ability')}；只能根据公开信息进行确定判断。`,
    ],
  };

  return [...common, ...roleRules[role]].join('\n');
};

const buildWinCondition = (role: Role): string =>
  role === 'wolf'
    ? `狼人阵营：${ruleValue('victory.werewolf_win_gods')} 或 ${ruleValue('victory.werewolf_win_villagers')}。`
    : `好人阵营：${ruleValue('victory.good_win')}。`;

const speechLimit = (context: AIRequestContext): number => {
  const limits = RULE_VALUES['speech.speech_limits'];
  if (context.allowedCommandTypes.includes('game.vote')) return limits.vote_reason_chars;
  if (
    context.phase === 'lastWords' ||
    context.stage === 'last_words' ||
    context.allowedCommandTypes.includes('game.hunter_shoot')
  ) {
    return limits.last_words_chars;
  }
  if (context.stage === 'discussion') return limits.free_discussion_chars;
  return limits.round_speech_chars;
};

const isTargetCommand = (commandType: GameCommand['type']): boolean =>
  commandType === 'game.vote' ||
  commandType === 'game.wolf_vote' ||
  commandType === 'game.night_action' ||
  commandType === 'game.hunter_shoot';

const buildOutputContract = (
  context: AIRequestContext,
  promptContext: AIPromptContext,
): string => {
  const allowed = context.allowedCommandTypes
    .map((commandType) => COMMAND_ACTION_NAMES[commandType])
    .filter((name): name is string => Boolean(name));
  const examples: string[] = allowed.map((action) => {
    switch (action) {
      case 'speak':
        return '{"action":"speak","content":"发言文本"}';
      case 'wolf_speak':
        return '{"action":"wolf_speak","content":"狼队讨论"}';
      case 'vote':
        return '{"action":"vote","target":"合法玩家名","reason":"一句具体理由"}';
      case 'wolf_vote':
        return '{"action":"wolf_vote","target":"合法玩家名"}';
      case 'night_action':
        return '{"action":"night_action","skill":"check|guard|heal|poison","target":"合法玩家名"}';
      case 'skip_night':
        return '{"action":"skip_night"}';
      case 'skip_speech':
        return '{"action":"skip_speech"}';
      case 'hunter_shoot':
        return '{"action":"hunter_shoot","target":"合法玩家名"}';
      default:
        return '';
    }
  });
  if (promptContext.abstainAllowed && context.allowedCommandTypes.includes('game.vote')) {
    examples.push('{"action":"vote","target":null,"reason":"弃票"}');
  }
  if (
    context.role === 'wolf' &&
    context.allowedCommandTypes.includes('game.wolf_vote') &&
    RULE_VALUES['roles.werewolf.can_empty_kill']
  ) {
    examples.push('{"action":"wolf_vote","target":null}');
  }
  return [
    '只输出一个 JSON 对象，不输出 Markdown、解释或分析过程。',
    `action 只能是：${allowed.join('、') || '无'}.`,
    ...examples,
    `发言/理由最多 ${speechLimit(context)} 字。`,
  ].join('\n');
};

const stageName = (context: AIRequestContext): string => {
  if (context.phase === 'night') return `夜间 ${context.stage ?? '当前阶段'}`;
  if (context.phase === 'lastWords' || context.stage === 'last_words') return '遗言';
  if (context.phase === 'voting' || context.stage === 'voting') return '白天投票';
  return `白天 ${context.stage ?? '当前阶段'}`;
};

const systemTaskTitle = (context: AIRequestContext): string | null => {
  if (context.phase === 'lastWords' || context.stage === 'last_words') {
    return '## 7. 遗言模板';
  }
  if (context.phase === 'voting' || context.stage === 'voting') {
    return context.promptContext?.isRepeatVote
      ? '## 6. 平票重投任务'
      : '## 5. 投票任务';
  }
  if (context.phase === 'day' || context.stage === 'speech' || context.stage === 'discussion') {
    return '## 2. 白天当轮事实模板';
  }
  return null;
};

const roleTaskTitle = (context: AIRequestContext): string[] => {
  if (context.phase === 'lastWords' || context.stage === 'last_words') {
    return ['遗言任务'];
  }
  if (context.allowedCommandTypes.includes('game.hunter_shoot')) {
    return ['开枪任务'];
  }
  if (context.phase === 'voting' || context.stage === 'voting') {
    return ['公开投票任务', '平票争辩任务'];
  }
  if (context.phase === 'night') {
    if (context.role === 'wolf') {
      return context.promptContext?.wolfVoteRound && context.promptContext.wolfVoteRound > 1
        ? ['狼人刀首次平票后的再讨论', '夜间讨论任务']
        : ['夜间讨论任务'];
    }
    const taskByRole: Partial<Record<Role, string>> = {
      guardian: '夜间守护任务',
      seer: '夜间查验任务',
      witch: '夜间用药任务',
    };
    return taskByRole[context.role] ? [taskByRole[context.role]!] : ['夜间任务'];
  }
  return context.promptContext?.roundNumber === 1
    ? ['白天首轮任务']
    : ['白天后续轮任务'];
};

const loadRoleTask = (context: AIRequestContext): string => {
  const fileName = `role-templates/${context.role}.md`;
  for (const title of roleTaskTitle(context)) {
    const section = fencedText(sectionByTitle(readPromptFile(fileName), title));
    if (section) return section;
  }
  return '';
};

const formatPublicEvent = (
  event: DomainEvent,
  players: readonly Player[],
): string | null => {
  const payload = event.payload as Record<string, unknown>;
  const actor = playerName(players, typeof payload.actorId === 'string' ? payload.actorId : event.actorId);
  switch (event.eventType) {
    case 'day.speech':
      return `${actor}：${String(payload.content ?? '')}`;
    case 'day.speech_skipped':
      return `${actor}：跳过发言`;
    case 'day.vote_cast':
      return typeof payload.targetId === 'string'
        ? `${actor} 投票给 ${playerName(players, payload.targetId)}`
        : `${actor} 已投票（票型尚未公开）`;
    case 'day.exiled':
      return `放逐：${playerName(players, typeof payload.playerId === 'string' ? payload.playerId : undefined)}`;
    case 'hunter.shot':
      return `猎人开枪：${playerName(players, typeof payload.targetId === 'string' ? payload.targetId : undefined)}`;
    case 'hunter.shot_skipped':
      return '猎人跳过开枪';
    case 'night.resolved': {
      const deaths = Array.isArray(payload.deaths)
        ? payload.deaths
            .filter((id): id is string => typeof id === 'string')
            .map((id) => playerName(players, id))
            .join('、')
        : '';
      if (deaths) return `夜间公开死亡：${deaths}`;
      if (payload.peacefulNight === true) return '平安夜';
      return '夜间公开死亡信息缺失（服务端事件异常）';
    }
    case 'day.started':
      return `第 ${String(payload.day ?? event.sequence)} 天开始`;
    case 'night.started':
      return `第 ${String(payload.day ?? event.sequence)} 晚开始`;
    case 'day.no_exile':
      return '本轮无人被放逐';
    default:
      return null;
  }
};

const formatProjectedEvents = (
  events: readonly DomainEvent[] | undefined,
  players: readonly Player[],
): string[] =>
  (events ?? [])
    .filter((event) => event.visibility === 'public_timeline')
    .map((event) => formatPublicEvent(event, players))
    .filter((event): event is string => Boolean(event));

const formatLatestOvernightEvent = (
  events: readonly DomainEvent[] | undefined,
  players: readonly Player[],
): string[] => {
  const event = [...(events ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.visibility === 'public_timeline' &&
        candidate.eventType === 'night.resolved',
    );
  const formatted = event ? formatPublicEvent(event, players) : null;
  return formatted ? [formatted] : [];
};

const formatRuntimeFacts = (
  context: AIRequestContext,
  promptContext: AIPromptContext,
): string => {
  const projectedEvents =
    promptContext.publicEvents ?? formatProjectedEvents(promptContext.visibleEvents, context.players);
  const overnightPublicEvents =
    promptContext.overnightPublicEvents ??
    formatLatestOvernightEvent(promptContext.visibleEvents, context.players);
  const alivePlayers = context.players
    .filter((player) => player.isAlive)
    .map((player) => player.name);
  const privateFacts = listText(promptContext.privateRoleFacts, '无新增私有事实');
  const isLastWords = context.phase === 'lastWords' || context.stage === 'last_words';
  const finalWordsFacts = isLastWords
    ? [
        '【遗言可见死亡公告历史】\n' +
          listText(
            promptContext.lastWordsVisibleDeathHistory,
            '系统未提供可见死亡公告历史（不等同于平安夜）',
          ),
        '【遗言可见行动历史（查验/用药/票型）】\n' +
          listText(promptContext.lastWordsVisibleActionHistory, '系统未提供可见行动历史'),
        '【遗言事实边界】\n“我不知道”表示事实不在你的可见视角内；“系统无记录”表示服务端本次没有注入该字段。二者都不能被改写成相反结论。',
      ]
    : [];
  return [
    ...finalWordsFacts,
    `【当前阶段】\n第 ${promptContext.dayNumber ?? 1} 天，${stageName(context)}，第 ${promptContext.roundNumber ?? 1} 轮。`,
    `【公开存活玩家】\n${listText(alivePlayers)}`,
    `【已公开事件】\n${listText(projectedEvents)}`,
    `【过夜后新公开信息】\n${listText(overnightPublicEvents, '无新增信息')}`,
    `【已公开历史票型】\n${listText(promptContext.publicVoteHistory)}`,
    `【本轮已发言】\n${listText(promptContext.currentRoundSpeeches ?? promptContext.publicSpeeches)}`,
    `【你自己的近期发言】\n${listText(promptContext.ownPreviousSpeeches)}`,
    `【你上次发言后出现的新信息】\n${listText(promptContext.newInformationSinceLastTurn, '无新增信息')}`,
    `【当前视角局势摘要】\n${promptContext.situationSummary || '无'}`,
    `【当前角色私有事实】\n${privateFacts}`,
    `【合法动作】\n${listText(promptContext.legalActions?.map((action) => ACTION_LABELS[action]), '无')}`,
    `【合法目标】\n${formatTargets(promptContext.legalTargets)}`,
    `【弃票规则】\n${promptContext.abstainAllowed ? '允许弃票' : '禁止弃票'}`,
    `【必须体现的新内容】\n${promptContext.requiredNovelty || '无；仍须避免复述旧主张和旧证据'}`,
  ].join('\n\n');
};

const placeholderValues = (
  context: AIRequestContext,
  promptContext: AIPromptContext,
  roleTask: string,
  outputContract: string,
): Record<string, string> => {
  const publicEvents =
    promptContext.publicEvents ?? formatProjectedEvents(promptContext.visibleEvents, context.players);
  const overnightPublicEvents =
    promptContext.overnightPublicEvents ??
    formatLatestOvernightEvent(promptContext.visibleEvents, context.players);
  const publicSpeeches =
    promptContext.publicSpeeches ??
    (promptContext.visibleEvents ?? [])
      .filter((event) => event.eventType === 'day.speech')
      .map((event) => formatPublicEvent(event, context.players))
      .filter((event): event is string => Boolean(event));
  const legalActions = promptContext.legalActions ?? [];
  const targetNames = names(promptContext.legalTargets);
  const roleTaskText = roleTask || '只执行当前服务端允许的动作。';
  const lastWordsTask =
    promptContext.lastWordsTask ||
    (roleTask.includes('{{last_words_round_task}}')
      ? '根据服务端注入的可见历史，交代真实信息、最新票型和最终行动建议。'
      : roleTaskText);

  return {
    player_name: playerName(context.players, context.playerId),
    role_name: ROLE_NAMES[context.role],
    alignment: roleAlignment(context.role),
    day_number: String(promptContext.dayNumber ?? 1),
    phase_name: stageName(context),
    round_number: String(promptContext.roundNumber ?? 1),
    speech_char_limit: String(speechLimit(context)),
    rules_for_role: buildRulesForRole(context.role),
    win_condition: buildWinCondition(context.role),
    legal_actions: listText(legalActions.map((action) => ACTION_LABELS[action])),
    legal_targets: targetNames.length > 0 ? targetNames.join('、') : '无',
    abstain_policy: promptContext.abstainAllowed ? '允许弃票' : '禁止弃票',
    last_words_policy: `仅被投票放逐者获得遗言，共 ${ruleValue('speech.last_words_scope')}。`,
    experience:
      promptContext.experience ??
      context.projectedContext?.experience ??
      '当前未提供经验参考；不得自行补充经验内容。',
    public_events: listText(publicEvents),
    alive_players: listText(context.players.filter((player) => player.isAlive).map((player) => player.name)),
    public_speeches: listText(publicSpeeches),
    public_vote_history: listText(promptContext.publicVoteHistory),
    current_round_speeches: listText(promptContext.currentRoundSpeeches ?? publicSpeeches),
    own_previous_speeches: listText(promptContext.ownPreviousSpeeches),
    own_vote_commitment: promptContext.ownVoteCommitment || '无',
    private_role_facts: listText(promptContext.privateRoleFacts, '无'),
    wolf_private_chat: listText(promptContext.wolfPrivateChat, '无'),
    new_information_since_last_turn: listText(promptContext.newInformationSinceLastTurn, '无新增信息'),
    situation_summary: promptContext.situationSummary || '无',
    already_stated_claims: listText(
      promptContext.alreadyStatedClaims ?? promptContext.ownPreviousSpeeches,
      '无',
    ),
    already_used_evidence: listText(
      promptContext.alreadyUsedEvidence,
      '未提供结构化旧证据；仅把近期发言作为防复读参考',
    ),
    other_players_current_claims: listText(publicSpeeches, '无'),
    required_novelty: promptContext.requiredNovelty || '无；不要复述旧主张和旧证据',
    is_daily_summarizer: promptContext.isDailySummarizer ? '是' : '否',
    phase_task: promptContext.phaseTask || lastWordsTask,
    role_reveal_context: promptContext.roleRevealContext || '服务端未要求亮身份',
    public_role_claims: listText(promptContext.publicRoleClaims),
    public_seer_claims: listText(promptContext.publicSeerClaims),
    public_claim_plan: promptContext.publicClaimPlan || '无；不得把策略口径当成服务端事实',
    guardian_history: listText(promptContext.guardianHistory),
    seer_check_history: listText(promptContext.seerCheckHistory),
    witch_kill_notice: promptContext.witchKillNotice || '无刀口通知；不得推断原因',
    witch_potion_state: promptContext.witchPotionState || '以服务端合法动作列表为准',
    hunter_shot_available: promptContext.hunterShotAvailable ? '有开枪资格' : '无开枪资格',
    wolf_teammates: listText(promptContext.wolfTeammates),
    wolf_vote_round: String(promptContext.wolfVoteRound ?? promptContext.roundNumber ?? 1),
    wolf_edge_assessment: promptContext.wolfEdgeAssessment || '无；只根据服务端可见事实评估',
    wolf_team_disagreement: promptContext.wolfTeamDisagreement || '无',
    tied_wolf_kill_targets: listText(promptContext.tiedWolfKillTargets),
    wolf_vote_reasons: listText(promptContext.wolfVoteReasons),
    repeat_vote_voter_status: promptContext.repeatVoteVoterStatus || '有投票权',
    tie_candidate_speeches: listText(promptContext.tieCandidateSpeeches),
    last_words_round: String(promptContext.lastWordsRound ?? 1),
    last_words_rounds_remaining: String(promptContext.lastWordsRoundsRemaining ?? 0),
    last_words_round_task: lastWordsTask,
    first_last_words: promptContext.firstLastWords || '无',
    last_words_public_death_history: listText(
      promptContext.lastWordsVisibleDeathHistory,
      '系统未提供可见死亡公告历史（不等同于平安夜）',
    ),
    last_words_action_history: listText(
      promptContext.lastWordsVisibleActionHistory,
      '系统未提供可见行动历史',
    ),
    previous_situation_summary: promptContext.previousSituationSummary || '无',
    overnight_public_events: listText(overnightPublicEvents, '无新增信息'),
    overnight_private_role_facts: listText(promptContext.overnightPrivateRoleFacts, '无新增信息'),
    summary_char_limit: String(promptContext.summaryCharLimit ?? RULE_VALUES['speech.speech_limits'].daily_summary_chars),
    validation_error: promptContext.validationError || '无',
    output_contract: outputContract,
    invalid_context_response: invalidContextResponse,
  };
};

const render = (template: string, values: Record<string, string>): string => {
  const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in values)) {
      throw new PromptBuildError(
        `Prompt value missing for placeholder: ${key}`,
        'PROMPT_UNRENDERED_PLACEHOLDER',
      );
    }
    return values[key] ?? '';
  });
  if (/\{\{|\}\}/.test(rendered)) {
    throw new PromptBuildError(
      'Prompt contains an unrendered placeholder.',
      'PROMPT_UNRENDERED_PLACEHOLDER',
    );
  }
  return rendered.trim();
};

export const buildAIPrompt = (
  context: AIRequestContext,
  repeatGuidance?: string,
): AIPrompt => {
  const promptContext = {
    ...(context.promptContext ?? {}),
    requiredNovelty: repeatGuidance || context.promptContext?.requiredNovelty,
  };
  if (!context.allowedCommandTypes.length) {
    throw new PromptBuildError(
      'No legal command type was supplied by the server.',
      'PROMPT_CONTEXT_INVALID',
    );
  }
  const targetRequired = context.allowedCommandTypes.some(isTargetCommand);
  if (
    targetRequired &&
    !promptContext.legalTargets?.length &&
    !context.allowedCommandTypes.every(
      (commandType) =>
        commandType === 'game.night_action' &&
        promptContext.legalActions?.every((action) => action === 'heal'),
    )
  ) {
    throw new PromptBuildError(
      'A target action was supplied without legal targets.',
      'PROMPT_CONTEXT_INVALID',
    );
  }

  const global = loadFragment('system-prompts.md', '全局系统提示词');
  const roleLayer = loadFragment(
    `role-templates/${context.role}.md`,
    '角色层',
  );
  const roleTask = loadRoleTask(context);
  const systemTaskTitleValue = systemTaskTitle(context);
  const systemTask = systemTaskTitleValue
    ? fencedText(sectionByTitle(readPromptFile('system-prompts.md'), systemTaskTitleValue.replace(/^##\s+\d+\.\s+/, '')))
    : '';
  const outputContract = buildOutputContract(context, promptContext);
  const values = placeholderValues(context, promptContext, roleTask, outputContract);
  const system = render([global, roleLayer].join('\n\n'), values);
  const user = render(
    [
      systemTask,
      roleTask,
      formatRuntimeFacts(context, promptContext),
      `【当前任务】\n${promptContext.phaseTask || roleTask || '执行一个服务端允许的动作。'}`,
      `【输出格式】\n${outputContract}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    values,
  );
  return { system, user };
};

export const promptRoleName = (role: Role): string => ROLE_NAMES[role];
