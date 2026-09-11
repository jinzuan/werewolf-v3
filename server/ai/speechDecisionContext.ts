import type { GameAction } from '../../shared/types';
import { personaVoicePrompt } from './persona';
import type { AIRequestContext, AIPromptContext } from './types';

export type SpeechDecisionMove =
  | '报告当前已知信息'
  | '回应别人对自己的质疑'
  | '澄清一个误解'
  | '暂时站边并说明依据'
  | '认可一个具体判断'
  | '提出一个尚未回答的具体问题'
  | '保留观察'
  | '指认一个人'
  | '申请插队'
  | '跳过发言';

export interface SpeechDecisionContext {
  channel: 'public' | 'wolf_private';
  stageTask: string;
  legalActions: readonly GameAction[];
  allowedMoves: readonly SpeechDecisionMove[];
  newInformation: readonly string[];
  recentClaims: readonly string[];
  recentEvidence: readonly string[];
  currentRoundSpeeches: readonly string[];
  wasAddressed: boolean;
  responseTriggers: readonly string[];
  requiresResponse: boolean;
  canSkip: boolean;
  preferNoContentExit: boolean;
  persona: string;
  experience: string;
}

type SpeechDecisionRequestContext = Pick<
  AIRequestContext,
  'players' | 'playerId' | 'allowedCommandTypes' | 'promptContext'
> & Partial<Pick<AIRequestContext, 'allowedActions' | 'projectedContext' | 'phase' | 'stage'>>;

const nonEmpty = (items: readonly string[] | undefined): string[] =>
  (items ?? []).map((item) => item.trim()).filter(Boolean);

const list = (items: readonly string[], empty: string): string =>
  items.length > 0 ? items.join('\n') : empty;

const meaningfulNovelty = (value: string | undefined): boolean => {
  if (!value?.trim()) return false;
  return !/^(?:无|无强制新增主张|RepeatPolicy)/u.test(value.trim());
};

const actorWasAddressed = (
  context: SpeechDecisionRequestContext,
  speeches: readonly string[],
): boolean => {
  const actor = context.players.find((player) => player.id === context.playerId);
  if (!actor) return false;
  return speeches.slice(-4).some((speech) =>
    !speech.startsWith(`${actor.name}：`) &&
    !speech.startsWith(`${actor.name}:`) &&
    (speech.includes(actor.name) || speech.includes(context.playerId)),
  );
};

const responseTriggersFrom = (
  items: readonly string[],
  wasAddressed: boolean,
): string[] => {
  const triggers = items.filter((item) =>
    /(?:点名|追问|质疑|反驳|对跳|查杀|金水|改票|转投|新票型|票型变化|投票给|？|\?)/u.test(item),
  );
  if (wasAddressed) triggers.unshift('最近发言明确点名了你');
  return [...new Set(triggers)].slice(-6);
};

export const buildSpeechDecisionContext = (
  context: SpeechDecisionRequestContext,
  promptContext: AIPromptContext,
): SpeechDecisionContext => {
  const legalActions = promptContext.legalActions ?? context.allowedActions ?? [];
  const channel = context.allowedCommandTypes.includes('game.wolf_speak')
    ? 'wolf_private'
    : 'public';
  const currentRoundSpeeches = nonEmpty(
    promptContext.currentRoundSpeeches ?? promptContext.publicSpeeches,
  );
  const rawNewInformation = nonEmpty(promptContext.newInformationSinceLastTurn);
  const wolfTargetNames = (speech: string): Set<string> => {
    const speaker = speech.match(/^([^：:]{1,24})[：:]/u)?.[1]?.trim();
    return new Set(
      context.players
        .filter((player) => player.name !== speaker && speech.includes(player.name))
      .map((player) => player.name),
    );
  };
  const latestWolfSpeech = currentRoundSpeeches.at(-1) ?? '';
  const priorWolfSpeeches = currentRoundSpeeches.slice(0, -1);
  const priorWolfTargets = new Set(
    priorWolfSpeeches.flatMap((speech) => [...wolfTargetNames(speech)]),
  );
  const latestIntroducesTarget = [...wolfTargetNames(latestWolfSpeech)]
    .some((target) => !priorWolfTargets.has(target));
  const wolfPlanMarker = /换刀|改目标|改刀|反对|风险|备选|自刀|刀队友|不杀|不同意|不赞成|我不认同/u;
  const hasExplicitPlanMarker = (speech: string): boolean =>
    wolfPlanMarker.test(speech) || /空刀/u.test(speech.replace(/不空刀/gu, ''));
  const latestIntroducesPlanMarker = hasExplicitPlanMarker(latestWolfSpeech) &&
    !priorWolfSpeeches.some((speech) => hasExplicitPlanMarker(speech));
  const wolfPlanChanged = channel === 'wolf_private' && (
    latestIntroducesTarget || latestIntroducesPlanMarker
  );
  const roundTwoAlreadySummarized = channel === 'wolf_private' &&
    promptContext.wolfDiscussionRound === 2 &&
    currentRoundSpeeches.length > 0;
  // Wolf messages are genuine new events, but repeating the same target and
  // plan is not new decision value. Treat that consensus as already known so
  // the next wolf can skip instead of being forced to paraphrase it.
  const newInformation = channel === 'wolf_private' &&
    currentRoundSpeeches.length > 0 &&
    (!wolfPlanChanged || roundTwoAlreadySummarized)
    ? []
    : rawNewInformation;
  const recentClaims = nonEmpty(
    promptContext.alreadyStatedClaims ?? promptContext.ownPreviousSpeeches,
  );
  const recentEvidence = nonEmpty(promptContext.alreadyUsedEvidence);
  const wasAddressed = actorWasAddressed(context, currentRoundSpeeches);
  const responseTriggers = responseTriggersFrom(newInformation, wasAddressed);
  const requiresResponse = responseTriggers.length > 0;
  const canSkip = context.allowedCommandTypes.includes('game.skip_speech');
  // Historical role claims remain useful context, but they must not make every
  // later turn look urgent forever. Only a role conflict that is genuinely new
  // since this actor last spoke should suppress the no-content exit.
  const hasUrgentRoleConflict = newInformation.some((item) =>
    /对跳|预言家|查杀|金水|身份声明|跳了?身份|自称.{0,6}(?:预言家|女巫|猎人|守卫)/u.test(item),
  );
  // The first pass through a free-discussion queue is valuable even when the
  // event stream has not changed yet. Only permit a no-content exit after the
  // actor has already spoken in this round; otherwise every AI sees the same
  // empty novelty list and collectively skips the discussion.
  const hasSpokenInThisRound = currentRoundSpeeches.some((speech) => {
    const actor = context.players.find((player) => player.id === context.playerId);
    return Boolean(actor && (
      speech.startsWith(`${actor.name}：`) ||
      speech.startsWith(`${actor.name}:`)
    ));
  });
  const wolfHasPriorDiscussion = channel === 'wolf_private' && currentRoundSpeeches.length > 0;
  const isLastWords = context.phase === 'lastWords' || context.stage === 'last_words';
  const preferNoContentExit = canSkip &&
    newInformation.length === 0 &&
    !wasAddressed &&
    !requiresResponse &&
    !hasUrgentRoleConflict &&
    (hasSpokenInThisRound || wolfHasPriorDiscussion || isLastWords) &&
    !meaningfulNovelty(promptContext.requiredNovelty);

  const publicMoves: SpeechDecisionMove[] = [
    '报告当前已知信息',
    '回应别人对自己的质疑',
    '澄清一个误解',
    '暂时站边并说明依据',
    '认可一个具体判断',
    '提出一个尚未回答的具体问题',
    '保留观察',
    '指认一个人',
  ];
  if (legalActions.includes('request_speech')) publicMoves.push('申请插队');
  if (canSkip) publicMoves.push('跳过发言');

  const privateMoves: SpeechDecisionMove[] = [
    '报告当前已知信息',
    '暂时站边并说明依据',
    '认可一个具体判断',
    '提出一个尚未回答的具体问题',
    '保留观察',
    '指认一个人',
  ];
  if (canSkip) privateMoves.push('跳过发言');

  return {
    channel,
    stageTask: promptContext.phaseTask || '只执行当前服务端允许的动作。',
    legalActions,
    allowedMoves: channel === 'public' ? publicMoves : privateMoves,
    newInformation,
    recentClaims,
    recentEvidence,
    currentRoundSpeeches,
    wasAddressed,
    responseTriggers,
    requiresResponse,
    canSkip,
    preferNoContentExit,
    persona: personaVoicePrompt(
      promptContext.personaVoiceProfile ?? context.projectedContext?.personaVoiceProfile,
    ),
    experience: promptContext.experience || context.projectedContext?.experience || '无相关经验参考',
  };
};

export const shouldPreferSpeechSkip = (
  context: SpeechDecisionRequestContext,
  promptContext: AIPromptContext = context.promptContext ?? {},
): boolean => buildSpeechDecisionContext(context, promptContext).preferNoContentExit;

/**
 * One internal-only speech decision entry. It assembles authoritative facts,
 * stage needs, action candidates, persona, experience and continuity without
 * asking the model to reveal private reasoning to players.
 */
export const formatSpeechDecisionContext = (
  context: AIRequestContext,
  promptContext: AIPromptContext,
  mode: 'full' | 'compact' = 'full',
): string => {
  const decision = buildSpeechDecisionContext(context, promptContext);
  const targets = promptContext.legalTargets?.map((target) => target.name) ?? [];
  const privateFacts = nonEmpty(promptContext.privateRoleFacts);
  const noContentGuidance = decision.preferNoContentExit
    ? '仅当前没有真正的新信息、没有被点名，也没有必须澄清的冲突：可输出合法的 skip_speech。'
    : decision.requiresResponse
      ? `当前有必须处理的点名、追问、质疑、对跳或票型变化：${list(decision.responseTriggers, '已检测')}。优先 speak 准确回应，不得无理由 skip_speech。`
      : '轮到你时先推进一件有价值的事：探查、追问、回应、暂时站边或信息交换均可；不强迫指认。';
  const channelGuidance = decision.channel === 'wolf_private'
    ? '这是狼人私聊：只讨论今晚是否空刀、击杀候选、刀口收益与女巫风险；不要把白天站边或公开发言模板搬进狼聊。首夜没有公开信息时可以提出候选并说明理由，不能假装已经知道神职身份。若前面已经说清且你没有新分歧、新风险或新目标，直接选择 skip_speech；有新增时只补充新增部分，不复述共同结论。'
    : context.stage === 'speech'
      ? '当前是服务端轮流发言：不要催促尚未轮到的玩家，也不要把“谁还没说话”当作本轮主线；按队列回应上一位发言即可。只有自由讨论阶段才检查谁尚未发言。'
      : '公共发言优先回应上一条具体发言，再补充自己的判断。';
  const lengthGuidance = decision.requiresResponse
    ? '表达长度自适应：回应一个具体问题通常 1-2 句；有冲突时再补第 3 句。不要凑字数。'
    : decision.newInformation.length === 0
      ? '表达长度自适应：没有新信息时一句话也足够，可以直接短说、保留或过，不要为了显得像分析而扩写。'
      : '表达长度自适应：优先 1-2 句说清事实、判断和下一步；只有多个冲突需要拆开时才展开。';
  const humanConversationGuidance = decision.channel === 'wolf_private'
    ? promptContext.wolfDiscussionRound === 2
      ? '真人狼聊是压缩协议包：一人用一句话收束刀口/分工/条件；同轮已有收束且无新风险就 skip_speech，短确认不复述理由。'
      : '真人首夜狼聊像手势协议：首个提案只说刀口与一个理由；后续只说新目标、新风险或新分工。只是同意就短确认或 skip_speech。'
    : context.stage === 'discussion'
      ? '真人自由讨论一次只做一件事：叫人、问一个窄问题或回答一个点，1-2 句后让出话权。'
      : '真人桌聊只说一个增量：回应一个点、表态或短过；别重做全场总结。';

  if (mode === 'compact') {
    return [
      `【${decision.channel === 'wolf_private' ? '狼人私聊' : '公共发言'}决策上下文（仅供模型内部选择动作，不展示分析过程）】`,
      `阶段任务：${decision.stageTask}；合法动作：${decision.legalActions.join('、') || '无'}；合法目标：${targets.join('、') || '无需目标'}`,
      `平等候选：${decision.allowedMoves.join('、')}。“指认一个人”不是必填项；没有点名仍是合法发言。`,
      `新增信息：${list(decision.newInformation, '无')}；被点名：${decision.wasAddressed ? '是' : '否'}；必须回应：${decision.requiresResponse ? '是' : '否'}。`,
      `本轮逐条发言（先读再回应）：${list(decision.currentRoundSpeeches, '暂无')}`,
      `近期已说主张/证据：${list([...decision.recentClaims, ...decision.recentEvidence], '无')}。避免复述。`,
      '内部记住谁已回答；别复读“听到了/回应完整”。有矛盾直说，否则短过。',
      '表达倾向与经验已在系统层各注入一次；它们只改变说法/候选，不改变事实、权限或动作，与当前事实冲突时忽略。',
      '术语按事实使用；“加分/减分”必须同时说明具体玩家和改变信任的公开事实，只是软判断。',
      noContentGuidance,
      channelGuidance,
      humanConversationGuidance,
      lengthGuidance,
    ].join('\n');
  }

  return [
    `【${decision.channel === 'wolf_private' ? '狼人私聊' : '公共发言'}决策上下文（仅供模型内部选择动作，不得向玩家展示分析过程或本结构）】`,
    `服务端阶段与任务：${context.phase}/${context.stage ?? '无子阶段'}；${decision.stageTask}`,
    `服务端合法动作：${decision.legalActions.join('、') || '无'}；合法目标：${targets.join('、') || '当前动作无需目标'}`,
    `当前角色私有可见事实：${list(privateFacts, '无新增私有事实')}`,
    `本轮可选主动作：${decision.allowedMoves.join('；')}。这些动作地位相同；“指认一个人”不是必填项。`,
    '指认门槛：只有当前可见的具体证据足够、阶段需要归票/推进，或有人明确要求你回应时才指认。没有点名仍是合法有效发言；首轮信息报告尤其不强迫报狼坑。',
    `本轮真正的新信息：${list(decision.newInformation, '无新增信息')}`,
    `本轮逐条发言（必须先读取上一条，再决定是否回应）：${list(decision.currentRoundSpeeches, '暂无发言')}`,
    `你最近已经说过的主张：${list(decision.recentClaims, '无')}`,
    `你最近已经用过的证据：${list(decision.recentEvidence, '无结构化记录；仍须避免复述近期发言')}`,
    `是否被最近发言点名：${decision.wasAddressed ? '是，应准确回应被问到的部分' : '否'}`,
    `回应优先级：${decision.requiresResponse ? `高（${list(decision.responseTriggers, '已检测触发')}）` : '常规'}`,
    '回应完整性只在内部判断：区分“没回答”“回答一部分”“已回答但不信”。不要每轮口头复述“这点我听到了/回应完整”；已回答时直接指出剩余矛盾、给当前动作或短过，不得把不相信改写成没说。',
    '第一晚查验边界：首夜是当时的盲选，不要求事后动机；不得要求不存在的私聊、验人链或暗示。',
    '私有表达倾向已在系统身份层注入；只改变表达与关注点，不改变事实、权限或动作。',
    '相关经验候选已在系统经验层注入；只用于提出行为候选，不强制执行套路；与当前事实冲突时忽略。',
    '术语建议：金水、查杀、对跳、站边、狼坑、警上/警下、悍跳、倒钩、切割、反水、票型、平安夜等只在事实适配时使用，不为显得专业硬塞。',
    '“加分/减分”只是软判断：若使用，必须同时说清对象和导致信任变化的公开事实；它不是服务端分数，不自动等于金水、查杀或定狼。更自然时直接说“这让我更愿意信他/让我对他降一点信任”。',
    noContentGuidance,
    channelGuidance,
    humanConversationGuidance,
    lengthGuidance,
  ].join('\n');
};
