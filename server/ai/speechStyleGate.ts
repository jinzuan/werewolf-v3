import type { GameCommand } from '../../shared/protocol';
import type { Player, Role } from '../../shared/types';
import type { AIPromptContext } from './types';
import { speechSimilarity } from './repeatPolicy';

export type SpeechStyleIssue =
  | 'EMPTY_ECHO'
  | 'PSEUDO_CONTRAST'
  | 'INDUSTRIAL_LANGUAGE'
  | 'ADJUDICATION_TONE'
  | 'MECHANICAL_ENUMERATION'
  | 'EXCESSIVE_DASH'
  | 'CUSTOMER_SERVICE_TONE'
  | 'UNVERIFIABLE_PRIVATE_FACT'
  | 'ANSWER_ERASURE'
  | 'RETROSPECTIVE_FIRST_CHECK_MOTIVE'
  | 'VAGUE_SCORE_SHORTHAND'
  | 'LOOPED_PRESSURE_PATTERN';

export interface SpeechStyleGateContext {
  commandType: Extract<GameCommand['type'], 'game.speak' | 'game.wolf_speak'>;
  role: Role;
  phase: string;
  stage: string | null;
  players?: readonly Pick<Player, 'name'>[];
  promptContext?: Pick<
    AIPromptContext,
    'currentRoundSpeeches' | 'publicSpeeches' | 'newInformationSinceLastTurn'
  >;
}

export interface SpeechStyleGateResult {
  ok: boolean;
  issues: SpeechStyleIssue[];
  rewriteInstruction: string;
}

const enterpriseLanguage =
  /赋能|闭环|抓手|底层逻辑|生态(?:布局|体系)?|链路|最优解|方法论|完整(?:的)?逻辑链条/u;

const adjudicationLanguage =
  /当前关键缺口|可信度下调|不能增加可信度|按时间顺序讲清|形成完整链条|综上|先说结论|总结一下/u;

const customerServiceLanguage =
  /我理解你的感受|别担心[，,]?我会一直(?:陪着你|在)|稳稳接住你|我会一直陪着你/u;

const compact = (value: string): string =>
  value
    .replace(/^【[^】]+】\s*/u, '')
    .replace(/^[^：:\n]{1,32}[：:]\s*/u, '')
    .replace(/[\s，。！？、；：（）“”"'`·…—\-:：,.!?;《》【】]/gu, '')
    .toLowerCase();

const previousSpeeches = (context: SpeechStyleGateContext): string[] =>
  context.promptContext?.currentRoundSpeeches ??
  context.promptContext?.publicSpeeches ??
  [];

const withoutPlayerNames = (
  text: string,
  context: SpeechStyleGateContext,
): string => (context.players ?? []).reduce(
  (result, player) => player.name.trim()
    ? result.split(player.name.trim()).join('')
    : result,
  text,
);

const isExplicitCorrection = (
  text: string,
  leftSide: string,
  matchIndex: number,
  context: SpeechStyleGateContext,
): boolean => {
  const leadIn = text.slice(Math.max(0, matchIndex - 24), matchIndex);
  if (/你(?:刚才)?说|他(?:刚才)?说|她(?:刚才)?说|有人(?:刚才)?说|别把|纠正(?:一下)?|回应.*说法/u.test(leadIn)) {
    return true;
  }
  const comparable = compact(leftSide).replace(/^(?:简单|单纯|仅仅|只是)/u, '');
  return comparable.length >= 4 && previousSpeeches(context).some(
    (speech) => compact(speech).includes(comparable),
  );
};

const hasPseudoContrast = (
  text: string,
  context: SpeechStyleGateContext,
): boolean => {
  const pattern = /不是\s*([^，。！？\n]{2,24})\s*[，,]?\s*而是/gu;
  for (const match of text.matchAll(pattern)) {
    if (!isExplicitCorrection(text, match[1], match.index ?? 0, context)) {
      return true;
    }
  }
  return false;
};

const hasMechanicalEnumeration = (text: string): boolean => {
  const orderedGameFacts = text.match(
    /第(?:[一二三四五六七八九十]+|\d+)(?:晚|天|轮)/gu,
  )?.length ?? 0;
  if (
    orderedGameFacts >= 2 &&
    /查|验|守护|守了|用药|救了|毒了|投票|改票/u.test(text)
  ) {
    return false;
  }
  if (/首先[\s\S]{1,120}其次[\s\S]{1,120}(?:最后|再次)/u.test(text)) {
    return true;
  }
  return /第一(?:点|个|是|[、，,:：.])[\s\S]{1,120}第二(?:点|个|是|[、，,:：.])[\s\S]{1,120}第三(?:点|个|是|[、，,:：.])/u.test(text);
};

const hasExcessiveDash = (text: string): boolean => {
  const dashes = text.match(/—/gu)?.length ?? 0;
  return dashes >= 3 || /—{2,}|-{3,}/u.test(text);
};

const isEmptyEcho = (
  text: string,
  context: SpeechStyleGateContext,
): boolean => {
  const trimmed = text.trim();
  if (/^(?:对[，,。！]?\s*)?(?:我也这么想|我同意|没什么补充|继续听听|再听听|先听听|先这样)[。！]?$/u.test(trimmed)) {
    return true;
  }
  const prior = previousSpeeches(context).at(-1);
  if (!prior) return false;
  const current = compact(trimmed);
  const previous = compact(prior);
  if (!current || !previous) return false;
  const lengthRatio = current.length / previous.length;
  return lengthRatio >= 0.75 && lengthRatio <= 1.25 &&
    speechSimilarity(current, previous) >= 0.9;
};

const claimsUnverifiablePrivateFact = (
  text: string,
  context: SpeechStyleGateContext,
): boolean => {
  // Wolf discussion is itself a server-authorized private channel. The style
  // checks still apply there, but mentioning wolf-only context is not a leak.
  if (context.commandType !== 'game.speak') return false;
  const qualifiedAsInference = /我猜|我怀疑|可能|也许|如果|假设/u.test(text);
  if (qualifiedAsInference) return false;
  if (/我们狼队|我(?:在|从)?狼聊(?:里)?(?:看到|听到|知道|收到)|狼队(?:昨晚|刚才)(?:已经)?(?:商量|说好|聊过)/u.test(text)) {
    return true;
  }
  return context.role !== 'wolf' &&
    /我昨晚(?:在)?(?:狼队私聊|狼聊)(?:里)?(?:看到|听到|知道|收到)/u.test(text);
};

const deniesAnsweredSeerAccount = (
  text: string,
  context: SpeechStyleGateContext,
): boolean => {
  if (!/(?:没|没有|未)(?:真正|正面|直接)?(?:回答|回应|解释|交代|说清)/u.test(text)) {
    return false;
  }
  if (!/(?:验人|查验)(?:链|过程|情况)|(?:为什么|为何).{0,16}(?:跳|冒头)|(?:跳|冒头).{0,16}(?:原因|理由)/u.test(text)) {
    return false;
  }
  return previousSpeeches(context).some((speech) => {
    const namesRemoved = withoutPlayerNames(speech, context);
    const suppliedCheck = /(?:验|查)(?:了|过)?[^，。！？\n]{1,18}/u.test(namesRemoved);
    const suppliedResult = /(?:是|为|验出|查出)[^，。！？\n]{0,6}(?:好人|金水|狼人|查杀)|(?:没|没有)验到狼/u.test(namesRemoved);
    const suppliedTiming = /不跳|没跳|猫着|跳出来|冒头|被逼|验我是狼|查杀我|对跳/u.test(namesRemoved);
    return suppliedCheck && suppliedResult && suppliedTiming;
  });
};

const asksRetrospectiveFirstCheckMotive = (text: string): boolean => {
  const firstCheck = /首夜|第一晚|第一夜/u;
  const checkVerb = /验|查/u;
  if (!firstCheck.test(text) || !checkVerb.test(text)) return false;
  return (
    /(?:为什么|为何)[^。！？\n]{0,28}(?:首夜|第一晚|第一夜)[^。！？\n]{0,18}(?:验|查)/u.test(text) ||
    /(?:首夜|第一晚|第一夜)[^。！？\n]{0,18}(?:验|查)[^。！？\n]{0,18}(?:为什么|为何)/u.test(text) ||
    /(?:首夜|第一晚|第一夜)[^。！？\n]{0,18}(?:验|查)[^。！？\n]{0,12}(?:理由|动机)(?:是什么|呢|没(?:有)?说|没(?:有)?解释|没(?:有)?交代)/u.test(text)
  );
};

const hasVagueScoreShorthand = (
  text: string,
  context: SpeechStyleGateContext,
): boolean => {
  const scoreSentences = text
    .split(/[。！？\n]/u)
    .filter((sentence) => /加分|减分/u.test(sentence));
  if (scoreSentences.length === 0) return false;
  const namedPlayers = (context.players ?? [])
    .map((player) => player.name.trim())
    .filter(Boolean);
  const concreteReason = /因为|由于|原因|改口|矛盾|票型|投票|改票|对跳|回应|回答|解释|查验|承诺|公开|事实|行为|站边|跟票|反水|救|守|验/u;
  return scoreSentences.some((sentence) =>
    !concreteReason.test(sentence) ||
    !namedPlayers.some((name) => sentence.includes(name)),
  );
};

type PressurePattern = 'binary' | 'name_suspect' | 'revision_condition' | 'no_independent_view';

const pressurePatterns = (text: string): PressurePattern[] => {
  const patterns: PressurePattern[] = [];
  if (/二选一|只能(?:从|在).{0,18}(?:选|挑)一个|必须选一个/u.test(text)) {
    patterns.push('binary');
  }
  if (/(?:点|报)(?:出|名)?(?:一个)?[^。！？\n]{0,10}(?:最可疑|怀疑对象|狼坑)|必须[^。！？\n]{0,8}点名/u.test(text)) {
    patterns.push('name_suspect');
  }
  if (/改判条件|什么情况下[^。！？\n]{0,10}(?:改|换)|怎样才会改/u.test(text)) {
    patterns.push('revision_condition');
  }
  if (/没有独立判断|缺少独立判断|没(?:有)?自己的判断/u.test(text)) {
    patterns.push('no_independent_view');
  }
  return patterns;
};

const repeatsPressurePattern = (
  text: string,
  context: SpeechStyleGateContext,
): boolean => {
  const current = pressurePatterns(text);
  if (current.length === 0) return false;
  const prior = previousSpeeches(context).slice(-4);
  const explicitlyNoNewInformation =
    context.promptContext?.newInformationSinceLastTurn !== undefined &&
    context.promptContext.newInformationSinceLastTurn.length === 0;
  return current.some((pattern) => {
    const uses = prior.filter((speech) => pressurePatterns(speech).includes(pattern)).length;
    return uses >= 2 || explicitlyNoNewInformation && uses >= 1;
  });
};

const rewriteInstructionFor = (issues: readonly SpeechStyleIssue[]): string => {
  const factBoundary = issues.includes('UNVERIFIABLE_PRIVATE_FACT')
    ? '只保留本次视角可见的事实，把推测明确说成怀疑，删掉未获知的私聊或夜间细节。'
    : '';
  const answerBoundary = issues.includes('ANSWER_ERASURE')
    ? '对方已经交代查验对象、结果和跳出时机；先承认已回应，再把异议准确改成真实性存疑或指出新的矛盾，不得说成没回答。'
    : '';
  const firstCheckBoundary = issues.includes('RETROSPECTIVE_FIRST_CHECK_MOTIVE')
    ? '删除对第一晚盲选查验的事后动机要求；可以质疑查验结果真实性，但不能要求补造当时理由。'
    : '';
  const scoreBoundary = issues.includes('VAGUE_SCORE_SHORTHAND')
    ? '删除没有明确对象和公开事实的“加分/减分”；改成具体说明哪件事让你更愿意相信谁或降低对谁的信任。'
    : '';
  const pressureBoundary = issues.includes('LOOPED_PRESSURE_PATTERN')
    ? '场上已经重复过同类施压，不再要求二选一、强迫点名、追问改判条件或泛称没有独立判断；改为报告新事实、准确回应、具体认可、保留观察，或在允许时跳过。'
    : '';
  return [
    factBoundary,
    answerBoundary,
    firstCheckBoundary,
    scoreBoundary,
    pressureBoundary,
    '保留原立场和已有事实，按信息量改成一句或 1-3 句桌上聊天；短说是允许的，不要为了凑长度扩写。一次只推进一个具体点，删掉模板腔和空泛附和，不要解释改写过程。',
  ].filter(Boolean).join(' ');
};

/**
 * Low-cost, conservative screening for model-generated speech only. It does
 * not rewrite content, infer the game world, or mutate authoritative state.
 */
export const inspectSpeechStyle = (
  text: string,
  context: SpeechStyleGateContext,
): SpeechStyleGateResult => {
  const issues: SpeechStyleIssue[] = [];
  const styleText = withoutPlayerNames(text, context);
  const add = (issue: SpeechStyleIssue): void => {
    if (!issues.includes(issue)) issues.push(issue);
  };

  if (isEmptyEcho(text, context)) add('EMPTY_ECHO');
  if (hasPseudoContrast(styleText, context)) add('PSEUDO_CONTRAST');
  if (enterpriseLanguage.test(styleText)) add('INDUSTRIAL_LANGUAGE');
  if (adjudicationLanguage.test(styleText)) add('ADJUDICATION_TONE');
  if (hasMechanicalEnumeration(styleText)) add('MECHANICAL_ENUMERATION');
  if (hasExcessiveDash(styleText)) add('EXCESSIVE_DASH');
  if (customerServiceLanguage.test(styleText)) add('CUSTOMER_SERVICE_TONE');
  if (claimsUnverifiablePrivateFact(text, context)) {
    add('UNVERIFIABLE_PRIVATE_FACT');
  }
  if (deniesAnsweredSeerAccount(text, context)) add('ANSWER_ERASURE');
  if (asksRetrospectiveFirstCheckMotive(styleText)) {
    add('RETROSPECTIVE_FIRST_CHECK_MOTIVE');
  }
  if (hasVagueScoreShorthand(text, context)) add('VAGUE_SCORE_SHORTHAND');
  if (repeatsPressurePattern(text, context)) add('LOOPED_PRESSURE_PATTERN');

  return {
    ok: issues.length === 0,
    issues,
    rewriteInstruction: issues.length > 0 ? rewriteInstructionFor(issues) : '',
  };
};
