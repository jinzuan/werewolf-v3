import type { AIConfig, Role, Player, Message } from './types';
import { getRoleInfo } from './roleConfig';
import { buildMemoryPrefillSection, getPlayerMemory } from './memorySystem';
import { mergeReviewInsights } from './experienceReview';

interface NightAction {
  playerId: string;
  action: 'kill' | 'check' | 'heal' | 'poison' | 'guard';
  targetId: string | null;
}

interface SkillUsage {
  result: string;
}

interface NightResult {
  day: number;
  killed?: string;
  healed?: string;
  poisoned?: string;
  checked?: { target: string; result: string };
  guarded?: string;
}

interface PlayerKnowledge {
  name: string;
  role?: Role;
  isConfirmedWolf?: boolean;
  isConfirmedGood?: boolean;
  checkResults?: Array<{ day: number; result: string }>;
  votes?: Array<{ day: number; target: string }>;
  suspiciousLevel: number; // 0-100
  notes?: string;
}

interface GameHistory {
  nightResults: NightResult[];
  votes: Record<string, string>;
  deadPlayers: Array<{ name: string; role: Role; day: number; reason: string }>;
  skillUsage?: Record<string, SkillUsage>;
  playerKnowledge?: Record<string, PlayerKnowledge>;
  timeline?: Array<{
    time: string;
    day: number;
    phase: string;
    event: string;
    actor?: string;
    target?: string;
  }>;
  /** v2.4.8 任务15：每日局势摘要（公开信息黑板：存活/死亡/阶段），由服务端每天刷新注入 */
  situationSummary?: string;
}

export type { GameHistory };

let logCallback: ((log: {
  type: 'info' | 'warning' | 'error' | 'success' | 'api';
  title: string;
  message: string;
  details?: string;
  playerId?: string;
  playerName?: string;
  apiEndpoint?: string;
  duration?: number;
}) => void) | null = null;

let thinkingCallback: ((playerId: string, progress: number) => void) | null = null;
let removeThinkingCallback: ((playerId: string) => void) | null = null;

let isAborted = false;

export const setLogCallback = (callback: typeof logCallback) => {
  logCallback = callback;
};

export const setThinkingCallback = (callback: typeof thinkingCallback) => {
  thinkingCallback = callback;
};

export const setRemoveThinkingCallback = (callback: typeof removeThinkingCallback) => {
  removeThinkingCallback = callback;
};

export const setAborted = (aborted: boolean) => {
  isAborted = aborted;
};

export const getAborted = () => isAborted;

const addLog = (log: Parameters<typeof logCallback>[0]) => {
  if (logCallback) {
    logCallback(log);
  }
};

/* ==================== 通用：AI 调用超时与重试 ==================== */

const AI_RETRY_COUNT = 1;
const AI_REQUEST_TIMEOUT_MS = 120000;

/* ==================== v2.4.4 发言长度控制（限长/截断，依据 WEREWOLF_FIXES_v2.4.4.md 任务 A） ==================== */

/** 各发言阶段硬上限（单位：字）与展示标签；超过上限由 truncateSpeech 截断兜底 */
export const SPEECH_LIMITS: Record<string, { max: number; label: string }> = {
  '白天发言': { max: 100, label: '轮次发言（≤100 字，3-5 句）' },       // round1 保底发言
  '自由讨论': { max: 150, label: '自由讨论（≤150 字，克制）' },          // free_discussion
  '遗言': { max: 80, label: '遗言（≤80 字）' },
  '平票争辩': { max: 100, label: '平票争辩（≤100 字）' },
  '狼人讨论': { max: 100, label: '狼人讨论（≤100 字）' },
};

export const getSpeechLimit = (gamePhase: string): { max: number; label: string } =>
  SPEECH_LIMITS[gamePhase] || { max: 100, label: '发言（≤100 字）' };

/** v2.4.10 任务1：今日"捋"人（逻辑梳理）字数放宽到 ≤300（其余人仍 ≤100/150） */
export const SORTER_MAX = 300;

/** v2.4.5-A A2：有实质内容（时间线/票型/逻辑链）的分析可展开到 200 字；限长只防"无内容凑字数" */
const SUBSTANTIVE_CONTENT_RE = /时间线|票型|逻辑|查验|验人|第\d+[晚天]|对跳|前后矛盾|改口|带节奏|遗言|狼坑|金水|查杀|昨天|今天/;

const getEffectiveMax = (gamePhase: string, text: string, isSorter?: boolean): number => {
  if (gamePhase !== '白天发言' && gamePhase !== '自由讨论') {
    return getSpeechLimit(gamePhase).max;
  }
  // v2.4.10 任务1：捋人做全盘梳理时放宽到 ≤300
  if (isSorter) {
    return SORTER_MAX;
  }
  const base = getSpeechLimit(gamePhase).max;
  if (text && text.length > base && SUBSTANTIVE_CONTENT_RE.test(text)) {
    return 200;
  }
  return base;
};

/** 超长截断：优先在句末边界截断，保证不切断一句话；不足则硬截 */
const truncateSpeech = (text: string, max: number): string => {
  const t = (text || '').trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const boundary = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('…'),
    slice.lastIndexOf('！？'),
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?')
  );
  // 边界太靠前（<40%）说明前面是长句，硬截即可
  if (boundary >= max * 0.4) return slice.slice(0, boundary + 1).trim();
  return slice.trim();
};

/** 死因 → 公开公告文案（不泄露身份）：第X晚/天 + 死因 */
const formatDeathDetail = (day: number, reason?: string): string => {
  const r = (reason || '').trim();
  if (r.includes('投票')) return `第${day}天 被投票出局`;
  if (r.includes('猎人') || r.includes('枪')) return `第${day}天 猎人开枪`;
  if (r.includes('毒')) return `第${day}晚 女巫毒杀`;
  if (r.includes('刀') || r.includes('狼')) return `第${day}晚 狼刀`;
  return `第${day}天 死亡`;
};

/**
 * 带超时的 fetch：仅对"获取响应头"计时，响应到达后流式读取不受限。
 * 超时/网络异常会抛错，交由 withRetry 重试。
 */
const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number = AI_REQUEST_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 失败自动重试（默认重试 2 次，指数退避）。
 */
const withRetry = async <T>(
  fn: () => Promise<T>,
  retries: number = AI_RETRY_COUNT,
  onRetry: (attempt: number, error: unknown) => void = () => {}
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        onRetry(attempt + 1, error);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
};

/* ==================== v2.4.5-A A1 + v2.4.5-B X1 + v2.4.5-C C2 复读硬拦截（模板归一化 + 句级相似度 + 整句 verbatim 硬门禁 + 撞模板重生成） ==================== */

/** 语气词：切句/骨架序列化时剔除 */
const PARTICLE_RE = /[啊呀嘛呢吧哦噢唉哎哈嘿嗯呃啦呗喽的了罢么呵诶嘞]/g;

/** 前缀口头禅/虚词层：剔除句子开头的口水话（"我觉得/说真的/讲道理/嗯/反正"等），防"加前缀绕过判重" */
const PREFIX_QUIRK_RE = /^(我觉得|我觉着|我感觉|个人觉得|说真的|说实话|讲道理|说句实话|坦白说|讲真|总之|反正|毕竟|其实|不过|但是|然而|可是|话说|对了|另外|再者|说起来|简单说|直说|说白了|真的|确实|嗯|唔|诶|呃|哎|唉|哈|呵呵|哈哈)\s*[,，、:：]?\s*/;

/** 名字屏蔽：玩家名 → {P}（最长优先，防子串误伤） */
const maskPlayerNames = (text: string, names: string[]): string => {
  let t = text;
  [...names].sort((a, b) => b.length - a.length).forEach((n) => {
    t = t.split(n).join('{P}');
  });
  return t;
};

/** 句子骨架：去前缀口头禅 + 屏蔽名字 + 去语气词 + 去标点/空白（模板比对基准） */
const sentenceSkeleton = (text: string, names: string[]): string => {
  return maskPlayerNames(text.replace(PREFIX_QUIRK_RE, ''), names)
    .replace(PARTICLE_RE, '')
    .replace(/[\s，。！？、；：（）“”"'·…—\-:：,.!?;《》【】]/g, '');
};

/** 相似度：字符级 Jaccard 与子串包含取最大（0~1） */
const templateSimilarity = (a: string, b: string): number => {
  if (!a || !b) return 0;
  const sa = new Set(a.split(''));
  const sb = new Set(b.split(''));
  let inter = 0;
  sa.forEach((c) => { if (sb.has(c)) inter++; });
  const union = sa.size + sb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  const contained = a.includes(b) || b.includes(a) ? 0.9 : 0;
  return Math.max(jaccard, contained);
};

/** 本轮+上轮发言窗口（跨玩家/跨天防复读比对基准） */
let recentSpeechWindow: Array<{ playerName: string; day: number; speech: string }> = [];

/** v2.4.5-B X1：同玩家跨天历史窗口：name → 历史发言（该玩家自己的历史发言窗口，跨天也查得到，上限 30） */
let playerSpeechHistory: Record<string, Array<{ day: number; speech: string }>> = {};

/** v2.4.5-B X1.4：投票理由模板窗口（理由撞模板换说法，上限 80） */
let recentVoteReasonWindow: string[] = [];

/** 开局清空复读比对窗口（配合 resetExperienceCache 调用） */
export const resetSpeechRepeatCache = () => {
  recentSpeechWindow = [];
  playerSpeechHistory = {};
  recentVoteReasonWindow = [];
};

/** 记录一条已发布发言进比对窗口（保持窗口 ≤60 条；同时记入该玩家跨天历史，上限 30） */
export const pushSpeechForRepeatCheck = (playerName: string, speech: string, day?: number) => {
  const d = day ?? 0;
  recentSpeechWindow.push({ playerName, day: d, speech });
  if (recentSpeechWindow.length > 60) recentSpeechWindow.shift();
  if (!playerSpeechHistory[playerName]) playerSpeechHistory[playerName] = [];
  playerSpeechHistory[playerName].push({ day: d, speech });
  if (playerSpeechHistory[playerName].length > 30) playerSpeechHistory[playerName].shift();
};

interface RepeatCheckResult {
  collided: boolean;
  collidedWith?: string;
  template?: string;
  level?: 'soft' | 'hard'; // v2.4.5-C C2.2：hard = 整句 verbatim 硬门禁（sim≥0.9 且两方骨架均≥15字），soft = 普通撞模板
  exact?: boolean; // v2.4.6 P0-2：整句骨架逐字相同（sim=1 且骨架相等，不限长度）——"两条相同即拦"，fallback 短句同样适用
}

/**
 * 模板比对（v2.4.5-C C2.1 / C2.2 升级）：
 * - 候选发言的每个整句 vs 窗口内所有整句的骨架（按 。！？； 切整句，与 qc.py ①.9 同口径，逗号残片不算处），
 * - 相似度 ≥0.75 判定撞模板（原 0.6 过松、误报率 ~15-20%）；
 * - 相似度 ≥0.9 且两方骨架均 ≥15 字 → 整句 verbatim 硬门禁（level='hard'，直接禁发）；
 * - 覆盖跨玩家（本轮+上轮窗口）+ 同玩家跨天（speakerName 对应历史窗口）。
 */
export const checkSpeechTemplateCollision = (speech: string, names: string[], speakerName?: string): RepeatCheckResult => {
  const splitSent = (s: string) => s.split(/[。！？!?；;]/).map((x) => x.trim()).filter(Boolean);
  const mySentences = splitSent(speech);
  const refs = [...recentSpeechWindow];
  if (speakerName && playerSpeechHistory[speakerName]) {
    for (const h of playerSpeechHistory[speakerName]) {
      refs.push({ playerName: speakerName, day: h.day, speech: h.speech });
    }
  }
  for (const ref of refs) {
    for (const rs of splitSent(ref.speech)) {
      const sk1 = sentenceSkeleton(rs, names);
      if (sk1.length < 6) continue;
      for (const s of mySentences) {
        const sk2 = sentenceSkeleton(s, names);
        if (sk2.length < 6) continue;
        const maxLen = Math.max(sk1.length, sk2.length);
        if (maxLen > 6 && Math.abs(sk1.length - sk2.length) > maxLen * 0.6) continue;
        const sim = templateSimilarity(sk1, sk2);
        if (sim >= 0.75) {
          const hard = sim >= 0.9 && Math.min(sk1.length, sk2.length) >= 15;
          return {
            collided: true,
            collidedWith: ref.playerName,
            template: sk2.length > 24 ? `${sk2.slice(0, 24)}…` : sk2,
            level: hard ? 'hard' : 'soft',
            exact: sk1 === sk2, // v2.4.6 P0-2：整句骨架逐字相同
          };
        }
      }
    }
  }
  return { collided: false };
};

/* ==================== v2.4.6 P0-2：publishSpeech 统一发布出口 ==================== */

/** 需要运行时防复读检查的发言阶段（轮次/自由讨论/平票争辩；遗言不拦截——死者唯一表达，见 v2.4.8 任务13） */
const SPEECH_PHASES_FOR_REPEAT = ['白天发言', '自由讨论', '平票争辩'];

/**
 * v2.4.6 P0-2：publishSpeech 统一发布出口——成功与 catch（fallback）两条路径都经它发布。
 * 内部先 checkSpeechTemplateCollision + pushSpeechForRepeatCheck，再返回最终发布文本。
 * fallback 短句（"我再想想…"等）同样受硬门禁约束：整句 verbatim（sim≥0.9 且两方骨架均≥15字）→ 拦为简略表态（两条相同即拦）。
 */
const publishSpeech = (
  playerName: string,
  rawText: string,
  gamePhase: string,
  day: number,
  names: string[],
  isSorter?: boolean // v2.4.10 任务1：捋人放宽到 ≤300
): string => {
  let text = rawText;
  // 狼人讨论含 {目标名称} 末行格式，不截断以免丢目标
  if (gamePhase !== '狼人讨论') {
    // v2.4.5-A A2：有实质内容（时间线/票型/逻辑链）的分析可展开到 200 字；捋人 ≤300
    text = truncateSpeech(rawText, getEffectiveMax(gamePhase, rawText, isSorter));
  }
  if (SPEECH_PHASES_FOR_REPEAT.includes(gamePhase)) {
    const check = checkSpeechTemplateCollision(text, names, playerName);
    // 硬门禁：整句 verbatim（sim≥0.9 且两方骨架均≥15字）或 整句骨架逐字相同（exact，不限长度，两条相同即拦）
    // → 直接禁发，返回简略表态（fallback 句同样受约束）
    if (check.collided && (check.level === 'hard' || check.exact)) {
      addLog({
        type: 'warning',
        title: '复读硬拦截（发布出口）',
        message: `${playerName} 发布发言与【${check.collidedWith}】逐字高度重复（模板：${check.template}）→ 已禁发，返回简略表态`,
        playerName,
        details: text.substring(0, 120),
      });
      text = `（与${check.collidedWith}发言高度重复，简略表态）`;
    }
    // 发布前把最终发言记入比对窗口（供后续玩家防复读；含跨天天数）
    pushSpeechForRepeatCheck(playerName, text, day);
  }
  return text;
};

/* ==================== v2.4.8 任务4/5：fallback 短句变体池（≥10 种，掉线不全员同句；避开近期重复） ==================== */

/** 掉线/失败时兜底短句池（仅依赖"本局当下"的通用表态，不引用前局/他人具体事实） */
const FALLBACK_VARIANTS = [
  '我再想想，先听听大家的意见。',
  '都听听吧，我现在信息太少。',
  '信息太少，先不急着站队。',
  '我跟前面分析的，先观望一下。',
  '先不表态，等更多人说话再看。',
  '我还没想好，先听一轮再说。',
  '感觉有点乱，我缓缓再看。',
  '这轮先跟大流，晚点再下判断。',
  '我再盘一盘，你们先聊。',
  '信息不够，我继续听。',
  '先看看票型，我再想想要投谁。',
  '我还拿不准，再等等。',
];

/** v2.4.8 任务4 测试钩子：fallback 变体池数量（要求 ≥10） */
export const getFallbackVariantCount = (): number => FALLBACK_VARIANTS.length;

/** v2.4.8 任务13 测试钩子：受防复读门禁约束的发言阶段（遗言已豁免） */
export const getRepeatCheckedPhases = (): readonly string[] => [...SPEECH_PHASES_FOR_REPEAT];

/**
 * v2.4.8 任务12：构建预言家"已查验名单"提示段（含结果），禁止重复查验。
 * 优先依据 gameHistory.playerKnowledge（服务端引擎每晚记录查验结果）；
 * 兜底解析 gameHistory.skillUsage[playerName] 的"第X晚查验"记录（离线单机只写 skillUsage）。
 */
export const buildSeerCheckedListSection = (
  gameHistory: GameHistory | undefined,
  playerName: string
): string => {
  const checked: string[] = [];
  const pk = gameHistory?.playerKnowledge;
  if (pk) {
    Object.entries(pk).forEach(([name, k]) => {
      if (k.checkResults && k.checkResults.length > 0) {
        const last = k.checkResults[k.checkResults.length - 1];
        checked.push(`${name}（第${last.day}晚验出：${last.result}）`);
      }
    });
  }
  // 兜底：离线单机模式只写 skillUsage → 解析"第X晚查验：查验了X，结果：好人/狼人"
  if (checked.length === 0 && gameHistory?.skillUsage?.[playerName]) {
    Object.entries(gameHistory.skillUsage[playerName]).forEach(([key, u]) => {
      if (!key.includes('查验')) return;
      const m = String(u.result).match(/查验了(.+?)，结果：(.+)$/);
      if (m) {
        const dayMatch = key.match(/(\d+)/);
        checked.push(`${m[1]}（第${dayMatch?.[1] ?? '?'}晚验出：${m[2]}）`);
      }
    });
  }
  if (checked.length > 0) {
    return `\n【你已查验名单（记住，禁止重复查验同一人）】\n${checked.join('、')}。\n你必须在【未查验过】的存活玩家中选择目标。\n`;
  }
  return `你还没查验过任何人，本轮必须查验一名玩家。\n`;
};

/** 挑一条不与该玩家近期/他人类似句重复的 fallback 变体（防 fallback 互相触发"高度重复"门禁） */
const pickFallbackVariant = (names: string[]): string => {
  const shuffled = [...FALLBACK_VARIANTS].sort(() => Math.random() - 0.5);
  for (const variant of shuffled) {
    const check = checkSpeechTemplateCollision(variant, names);
    if (!check.collided) return variant;
  }
  return shuffled[0];
};

/* ==================== 经验库 v1（跨局战术参考） ==================== */

// 运行期导入经验库 md（作为纯文本），缺失目录/文件时自动回退空内容
const ROLE_EXP_PREFIX: Record<Role, string> = {
  wolf: 'wolf',
  seer: 'seer',
  witch: 'witch',
  hunter: 'hunter',
  guardian: 'guard',
  villager: 'villager',
};

// 每名玩家每局缓存一次选择结果（开局随机、局内稳定，防止同一局内频繁换库）
const experienceCache = new Map<string, string | null>();

// v2.4.4 E3：每局每角色"不重复分配"池——同职业 N 人在场时按在场人数取 N 套不同经验库（4狼→4套不同 wolf 库）；
// 库不足（池抽空）时重洗随机，保证永远有库可回退，不返回 null 之外的退化
const experiencePool: Record<string, string[]> = {};
const experiencePoolCursor: Record<string, number> = {};

/**
 * 重置经验库缓存，供游戏开局调用，保证每局重新随机。
 */
export const resetExperienceCache = () => {
  experienceCache.clear();
  Object.keys(experiencePool).forEach((k) => delete experiencePool[k]);
  Object.keys(experiencePoolCursor).forEach((k) => delete experiencePoolCursor[k]);
  // v2.4.8：开局同时清经验库文件映射缓存（下次 loadExperienceFiles 重新读盘，玩家改动经验库后新局即生效）
  experienceFilesCache = undefined;
};

/** 从角色池顺序抽取：首次请求洗牌建池、逐次取出（不重复），池抽空后重洗再抽（库不足则随机） */
const drawFromPool = (prefix: string, files: Array<[string, string]>): [string, string] => {
  if (!experiencePool[prefix]) {
    experiencePool[prefix] = [...files].sort(() => Math.random() - 0.5).map(([k]) => k);
    experiencePoolCursor[prefix] = 0;
  }
  const pool = experiencePool[prefix];
  if (experiencePoolCursor[prefix] >= pool.length) {
    pool.sort(() => Math.random() - 0.5);
    experiencePoolCursor[prefix] = 0;
  }
  const key = pool[experiencePoolCursor[prefix]++];
  const entry = files.find(([k]) => k === key);
  return entry || files[Math.floor(Math.random() * files.length)];
};

// v2.4.8：经验库文件映射缓存（首次加载成功后不再重复读盘；失败则缓存 null 走硬编码回退）
let experienceFilesCache: Record<string, string> | null | undefined;

/**
 * 加载经验库（v2.4.8 修复：round10 日志实锤 `import.meta.glob is not a function` → 经验库根本没加载）。
 * 双通道，Vite 构建与 tsx 运行时都能加载：
 * 1) Vite 构建：`import.meta.glob(...)` 由编译期静态替换为 {路径: md 原文} 映射，直接命中返回；
 * 2) Node/tsx 运行时：`import.meta.glob` 未定义（调用即抛错）→ 走文件系统（fs.readdir + readFile 遍历 src/data/experience_library）。
 */
export const loadExperienceFiles = (): Record<string, string> | null => {
  if (experienceFilesCache !== undefined) return experienceFilesCache;

  // 通道 1：Vite 构建。直接调用 import.meta.glob，让其被编译期静态替换；tsx/node 下抛错进 catch 走通道 2
  try {
    const modules = import.meta.glob('../src/data/experience_library/*.md', {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>;
    if (modules && Object.keys(modules).length > 0) {
      experienceFilesCache = modules;
      console.log(`加载经验库 ${Object.keys(modules).length} 份`);
      return modules;
    }
  } catch {
    // tsx/node 直跑：import.meta.glob 未定义（round10 实锤的 TypeError）→ 静默改走文件系统加载
  }

  // 通道 2：Node/tsx 运行时文件系统加载（同步，无 import.meta.glob 依赖）
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    if (proc?.getBuiltinModule) {
      const fs = proc.getBuiltinModule('node:fs') as typeof import('node:fs');
      const path = proc.getBuiltinModule('node:path') as typeof import('node:path');
      const { fileURLToPath } = proc.getBuiltinModule('node:url') as typeof import('node:url');
      const expDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'experience_library');
      const modules: Record<string, string> = {};
      for (const f of fs.readdirSync(expDir)) {
        if (f.endsWith('.md')) modules[path.join(expDir, f)] = fs.readFileSync(path.join(expDir, f), 'utf-8');
      }
      if (Object.keys(modules).length > 0) {
        experienceFilesCache = modules;
        console.log(`加载经验库 ${Object.keys(modules).length} 份`);
        return modules;
      }
    }
  } catch (e) {
    console.warn('加载经验库失败，回退硬编码策略:', e);
  }
  experienceFilesCache = null;
  return null;
};

/**
 * v2.4.4 E3：开局按职业在场人数不重复分配经验库（同一职业 N 人 → N 套不同库，库不足随机回退）
 * + 伴随 1 份 common 发言风格库（common_1 沉稳 / common_2 活泼，同样不重复分配）。
 * 缺失经验库时返回 null（调用方回退原硬编码策略，不崩）。
 * 按 玩家名:角色 缓存，配合开局 resetExperienceCache 实现"每局重新随机 + 不重复分配"。
 */
const loadExperience = (role: Role, playerName: string): string | null => {
  const cacheKey = `${playerName}:${role}`;
  if (experienceCache.has(cacheKey)) return experienceCache.get(cacheKey)!;

  const files = loadExperienceFiles();
  let text: string | null = null;
  if (files) {
    const prefix = ROLE_EXP_PREFIX[role];
    // v2.4.8：文件名取尾段须兼容 Windows 反斜杠路径（tsx/node 运行时为 \ 分隔）
    const fileName = (k: string): string => k.split(/[/\\]/).pop() || '';
    const roleFiles = Object.entries(files).filter(([path]) => {
      const name = fileName(path);
      return name.startsWith(`${prefix}_`) && !name.startsWith('common_');
    });
    // v2.4.4 E3：common 层扩展为多套（common_1 沉稳 / common_2 活泼…），同样走"不重复分配"池
    const commonFiles = Object.entries(files).filter(([path]) => {
      const name = fileName(path);
      return name.startsWith('common_');
    });
    const parts: string[] = [];
    if (roleFiles.length > 0) {
      const pick = drawFromPool(prefix, roleFiles);
      parts.push(pick[1]);
    }
    if (commonFiles.length > 0) {
      const common = drawFromPool('common', commonFiles);
      parts.push(common[1]);
    }
    if (parts.length === 0) {
      experienceCache.set(cacheKey, null);
      return null;
    }
    text = parts.join('\n\n');
    // v2.4.5-A A4：局后复盘归并——把本角色待归并的复盘经验追加进经验库（去重/禁人名见 experienceReview）
    text = mergeReviewInsights(role, text);
  }
  experienceCache.set(cacheKey, text);
  return text;
};

interface GeneratePromptParams {
  role: Role;
  playerName: string;
  players: Player[];
  messages: Message[];
  gamePhase: string;
  day: number;
  nightActions?: NightAction[];
  gameHistory?: GameHistory;
  currentSpeaker?: string;
  speakerOrder?: string[];
  wolfDiscussionRound?: number;
  witchAntidoteUsed?: boolean; // N6：女巫解药是否已使用（状态持久，跨回合有效）
  isSorter?: boolean; // v2.4.10 任务1：今日"捋"人（逻辑梳理，字数放宽到 ≤300）
}

/**
 * 任务1/5/6：构建 system prompt（角色 / 阵营 / 技能 / 视角边界 + 游戏规则 + 撒谎边界 + 角色策略）。
 * 只包含静态信息，不包含任何轮次动态信息。
 */
export const buildSystemPrompt = (role: Role, playerName: string, players: Player[]): string => {
  const roleInfo = getRoleInfo(role);

  const wolfCount = players.filter(p => p.role === 'wolf').length;
  const seerCount = players.filter(p => p.role === 'seer').length;
  const witchCount = players.filter(p => p.role === 'witch').length;
  const hunterCount = players.filter(p => p.role === 'hunter').length;
  const guardianCount = players.filter(p => p.role === 'guardian').length;
  const villagerCount = players.filter(p => p.role === 'villager').length;

  let sys = `【狼人杀游戏】\n\n`;
  sys += `你扮演的是: ${roleInfo.icon} ${roleInfo.name}\n`;
  sys += `你的名字是: ${playerName}\n`;
  sys += `所属阵营: ${roleInfo.team === 'wolf' ? '🐺 狼人阵营' : '👥 好人阵营'}\n`;
  sys += `角色技能: ${roleInfo.description}\n\n`;

  // v2.3 任务 A：阵营立场（金钻核心）——不是"套不套话"，而是站在自己阵营立场分析
  sys += `【阵营立场】\n`;
  if (roleInfo.team === 'wolf') {
    sys += `你是狼人阵营，你的目标不是"要不要撒谎"，而是【完美隐瞒并团灭好人】：\n`;
    sys += `  - 用信息忽悠好人：发言要听起来有理有据，编造看似毫无破绽的谎言，让好人相信你。\n`;
    sys += `  - 全力辅助/配合狼队友：共享掩护口径、配合踩人或保人、把票型做漂亮，迷惑好人导致好人阵营被团灭。\n`;
    sys += `  - 你的"言行不一致"是合法策略：发言指向谁 ≠ 实际投/刀谁，这是狼队带节奏的常规手段，不是错误。\n`;
    sys += `  - 套话、装好人、悍跳都是你的合法掩护工具；唯一的红线是别和已公布的公开事实冲突。\n`;
  } else {
    sys += `你是好人阵营，你的目标不是"反复表态"，而是【找出狼人的破绽并放逐】：\n`;
    sys += `  - 狼人会套话、撒谎、带节奏——你的任务是拆穿它们：拆谎（指出前后矛盾）、对跳（身份对质）、票型分析（谁在带票/嫁祸）。\n`;
    sys += `  - 反对狼人的套话与谎言：凡是空话、和稀泥、甩锅给好人的发言，都用逻辑盘它，别被带偏。\n`;
    sys += `  - 你自己的发言要言行一致：这是好人基本盘，指向谁就投谁。\n`;
  }
  sys += `\n`;

  sys += `【本局角色配置】\n`;
  sys += `🐺 狼人: ${wolfCount}人\n`;
  sys += `🔮 预言家: ${seerCount}人\n`;
  sys += `🧙 女巫: ${witchCount}人\n`;
  sys += `🔫 猎人: ${hunterCount}人\n`;
  sys += `🛡️ 守卫: ${guardianCount}人\n`;
  sys += `👤 平民: ${villagerCount}人\n\n`;

  sys += `【视角边界 - 严格遵守】\n`;
  switch (role) {
    case 'wolf':
      sys += `你只能看到：狼人阵营成员名单、狼队夜晚行动、白天公开信息。\n`;
      sys += `你看不到：神职的具体身份、预言家查验结果、女巫/守卫/猎人的行动记录。\n`;
      break;
    case 'seer':
      sys += `你只能看到：你自己的查验记录、白天公开信息。\n`;
      sys += `你看不到：其他角色的夜晚行动、其他人的查验结果。\n`;
      break;
    case 'witch':
      sys += `你只能看到：你自己的用药记录、当晚被狼人袭击的目标、白天公开信息。\n`;
      sys += `你看不到：预言家查验结果、守卫的守护目标。\n`;
      break;
    case 'guardian':
      sys += `你只能看到：你自己的守护记录、白天公开信息。\n`;
      sys += `你看不到：预言家查验结果、女巫用药记录。\n`;
      break;
    default:
      sys += `你只能看到：白天公开信息（发言、投票、死亡公告）。\n`;
      sys += `你看不到：任何夜晚行动的细节与身份查验结果。\n`;
  }
  sys += `你不是上帝视角：不要把你不该知道的信息当作已知。\n\n`;

  sys += `【撒谎边界】（站在自己阵营立场看待，规则不变）\n`;
  sys += `✅ 允许的战术：${roleInfo.team === 'wolf' ? '狼人伪装身份、用套话做掩护、悍跳预言家（合法战术）' : '好人诈身份、悍跳预言家（合法战术）'}。\n`;
  sys += `❌ 禁止：否认公开事实（例如死讯已公布，却说"昨晚平安夜所有人都活着"）。\n`;
  sys += `❌ 禁止：编造不存在的发言、身份，或说出与你已知公开信息相矛盾的内容。\n\n`;

  sys += `【发言规则】\n`;
  sys += `1. 始终以"${playerName}"的身份发言，不要顶替或引用其他玩家名字开头。\n`;
  sys += `2. 只依据【当轮信息】中提供的已知信息发言，不要编造。\n`;
  sys += `3. 有依据时才下判断（验人结果/时间线/票型/发言矛盾）；没依据就如实说"我信息少/再听听"，或跳过，禁止硬编理由凑判断。\n`;
  sys += `   ⚠️ v2.4.5 限长：轮次发言 ≤100 字（重点信息 3 句说完）；自由讨论 ≤150 字；遗言 ≤80 字；投票理由 ≤40 字（一句话）。超长会被截断。\n`;
  sys += `   ⚠️ v2.4.10 捋配额：每天最多 1 人做"捋"（逻辑梳理），做捋的人字数放宽到 ≤300 字，且不能连天同一人；其余人仍 ≤100/150，不要抢做全盘总结。\n`;
  sys += `   ⚠️ 分析可展开：有实质内容（时间线/票型/逻辑链）的分析不会被截断；限长只防"无内容凑字数"。\n`;
  sys += `4. 自我介绍从简：一句话带过即可（如"我是好人/我跳预言家"），禁止长篇自我介绍，重点放对局分析。\n`;
  sys += `5. 用具体玩家名字或"我/我们/他们"指代，不要说模糊的"X个人"。\n`;
  sys += `6. 关注当前讨论的问题，直接发表观点，不要重复无关内容。\n`;
  sys += `7. 记忆边界（v2.4.8 防捏造记忆）：只能引用【记忆库】与【当轮信息】中实际提供的内容（验人结果/自己的发言/已公布死讯等公开事件）。禁止"我记得XX今天说过…"式凭空捏造记忆——预填/当轮里没写的就是不知道，宁可说"我信息不多/再听听"，也不要硬编别人说过什么。\n\n`;

  sys += `【说话方式 - 像真人一样讲话】\n`;
  sys += `1. 严禁 Markdown：不要用 **、-、1. 2. 3. 这类格式化标记，就像平时聊天一样把话说出来。\n`;
  sys += `2. 口语化：短句为主，可以用"我觉得""说白了""不好说""看票型""讲道理"这类口头语，但别堆砌成句。\n`;
  sys += `3. 结构别太工整：不要每次都是"先表态、再分析、再下结论"的三段式；想说多就多说，一两句也能算一条发言。\n`;
  sys += `4. 允许情绪和犹豫：可以反问、可以说"我再想想""有点拿不准"，可以有怀疑、无奈甚至嘲讽，但别演过头。\n`;
  sys += `5. 不要答辩腔：别用"先说结论""我立一个判断""暂不点人""附议"这类书面词。\n`;
   sys += `6. 保持你人设里的个人说话风格，别跟别人一个模板换名字。\n`;
   sys += `7. 防复读：不要把自己上一轮/上一天说过的话原样再说一遍，也别把别人刚说完的话换个词念一遍；每一轮发言要带出新信息或新角度（哪怕只是"我更怀疑谁了"）。\n`;
   sys += `8. 跨玩家防复读（说话前先听一圈）：如果你想说的高频句式/结构已在本轮被其他玩家说过（同一模板换名字，例如"昨天X还说要投别人，今天改口改得飞快"这类固定句式），必须换一种说法，或简短带过，不要复读成只换人名的同款模板。\n\n`;

  // v2.4.5-A A1.3：注入本人设说话风格（来自记忆库人设），要求"用你的风格说话，别跟别人一个调"
  // v2.4.9 任务1：人设集为占位代号（人设1…人设12），局内身份用玩家名；人设名只在提示词里作风格代号提示
  const persona = getPlayerMemory(playerName);
  if (persona) {
    sys += `【个人说话风格】\n`;
    sys += `你的说话风格是：${persona.persona.speechStyle}（人设代号：${persona.persona.name}）。\n`;
    sys += `你的名字是「${playerName}」，局内大家以名字互称；人设代号只是风格参考，不是你的名字。\n`;
    sys += `用你自己的风格说话，别跟别人一个调；别人的句式再顺也别学，保持自己的口癖与节奏。\n\n`;
  }

  sys += `【发言纪律 - 硬约束】（按阵营立场执行）\n`;
  if (role === 'wolf') {
    sys += `狼人视角：套话/装好人/附议是【掩护手段】，可以策略性使用，但每条发言仍要给出一个可自圆其说的信息点，避免暴露你是狼。\n`;
    sys += `1. 禁止低级谎言：绝不否认已公布的死讯/投票结果等公开事实（那会直接暴露你）。\n`;
    sys += `2. 套话可以但要有掩护：用"我是好人"开场没问题，但要跟上信息/推理，否则被好人当破绽盘。\n`;
    sys += `3. 附议/甩锅要自然：无脑附议或过度刻意附和会显得心虚，注意和狼队友保持口径一致。\n`;
    sys += `4. "再听听/再想想"是拖延工具：每轮至多 1 次，且要说出在等谁的什么信息，别让好人觉得你在混。\n`;
    sys += `5. 别硬编理由：想拖延就说"没信息，再听听"，但要说明在等谁的信息；为凑判断编不存在的依据，只会被好人盘穿。\n\n`;
  } else {
    sys += `好人视角：空话套话是狼人的掩护，你反套话就是盘狼的起点。\n`;
    sys += `1. 禁止"我是好人"裸用：可以作开场白，但必须紧跟信息或推理，否则视为空话。\n`;
    sys += `2. 禁止无脑附议（如"大家说得都有道理"）——要附议就附上理由，或直接点出谁在带节奏。\n`;
    sys += `3. "再听听/再想想"每轮最多用 1 次，且必须说明在等谁的什么信息。\n`;
    sys += `4. 反瞎猜（禁止硬编判断）：有依据才下判断；没依据就如实说"我信息少/再听听"或跳过；"我不做判断/随便投谁都行/无所谓/你们决定"这类推卸式表态仍按低质量发言处理。\n`;
    sys += `5. 违反上述任一条均视为低质量发言。\n\n`;
  }

  sys += `【角色策略】\n`;
  if (role === 'wolf') {
    sys += `核心目标：完美隐瞒——让好人相信你是好人，同时配合狼队友把好人骗到团灭。\n`;
    sys += `⚠️ 绝对不要暴露狼队友身份！不要说"狼队友"之类的话！除非你们已经决定这么做！\n`;
    sys += `可以冒充平民或神职，但要保持一致性，不要前后矛盾！\n`;
    sys += `【悍跳战术】若需要可悍跳预言家：必须编造一条完整、自洽的查验时间线（第X晚查验了谁、结果），并保证与已公布的死讯等公开事实不冲突。\n`;
    sys += `【带节奏策略 - 合法玩法】\n`;
    sys += `  1) 狼踩狼：可适当踩狼队友做身份，被踩队友配合演，不要真把他投出去（除非是计划好的弃子）。\n`;
    sys += `  2) 悍跳：可悍跳预言家/神职，编造自洽时间线带队归票。\n`;
    sys += `  3) 嫁祸：把白天焦点引向好人，用"他逻辑对不上""他票型怪"等理由带票。\n`;
    sys += `  4) 套话做掩护：用"我是好人""大家分析得都很有道理"等套话混在信息里，降低好人警觉——这是狼人的合法武器。\n`;
    sys += `  5) 注意：发言指向谁可以和你实际投谁不一致——这是狼队带节奏的合法手段，保持好前后一致性即可。\n`;
    sys += `【倒钩战术】不想悍跳就倒钩：真预言家带票时顺势投狼队友做身份，把自己做成"好人视角"，攒信任比硬保队友值钱。\n`;
    sys += `【潜水装民】也可潜水装民：少说话、不带队、跟着主流附和，把自己活成背景板；关键时刻（需要归票/掩护狼队友）再收网点人带票。\n`;
    sys += `【伪装时机】被好人怀疑时别急着跳真身，先把话题圆过去；需要带队或掩护狼队友时，才考虑跳身份/悍跳夺话语权。\n`;
  } else if (role === 'seer') {
    sys += `你是好人的眼睛：有查验就报，适当跳身份带队，帮好人确定狼坑。\n`;
    sys += `⚠️ 你每晚只能查验一个人，查验结果只能是"好人"或"狼人"，不要查验出具体职业。\n`;
    sys += `【藏身份防刀】开局可先装平民藏身份（防刀），但手上已有查验、你被怀疑、或需要带队时，要果断跳明公布，带队归票。\n`;
    sys += `【伪装时机】被怀疑时 / 需要带队时 / 遇到对跳时——这三点是你亮身份的合理窗口；其余时间保持平民口吻，别让狼猜到你是眼睛。\n`;
    sys += `【对跳判断】若有人和你对跳预言家：\n`;
    sys += `  1) 完整复述你自己的查验时间线（第X晚查验了谁、结果如何）。\n`;
    sys += `  2) 要求对方按同样格式报出查验时间线。\n`;
    sys += `  3) 指出对方时间线中的矛盾、遗漏或与公开信息冲突之处。\n`;
    sys += `  4) 若对方无法给出自洽时间线，判定其为悍跳狼人，号召好人放逐他。\n`;
  } else if (role === 'witch') {
    sys += `谨慎用药：解药救关键好人，毒药毒可疑的狼人。\n`;
    sys += `能藏就藏，让狼人猜不到谁是女巫。\n`;
    sys += `【藏身份防刀】平时装平民说话、别露用药口风；关键时刻（被怀疑/需要带队/要威慑狼队）才考虑跳明，跳明要接"我有药"的底气。\n`;
    sys += `必要时可诈身份或悍跳扰乱狼人（合法战术）。\n`;
  } else if (role === 'hunter') {
    sys += `帮好人阵营分析局势，隐藏身份不轻易暴露。\n`;
    sys += `被投票出局时可以开枪带走一人。\n`;
    sys += `【藏身份防刀】平时装平民说话、正常盘狼，别露"神味"；关键时刻（狼坑收敛不了/好人核心身份被针对）才亮身份带队，把威慑用在刀刃上。\n`;
    sys += `可以假装平民或预言家迷惑狼人（诈身份合法战术）。\n`;
  } else if (role === 'guardian') {
    sys += `隐藏身份，守护关键玩家，分析局势帮助好人。\n`;
    sys += `⚠️ 不能连续两晚守护同一个人！\n`;
    sys += `【藏身份防刀】装平民藏身份，让狼不知道守卫在哪；关键时刻（预言家暴露/好人核心要被打掉）才考虑跳明报守护信息。\n`;
    sys += `可以假装平民，让狼人不知道谁是守卫。\n`;
  } else {
    sys += `平民无技能，通过发言分析找狼。\n`;
    sys += `可以适当模仿神职发言帮神职挡刀，也可以诈身份/悍跳迷惑狼人（合法战术）。\n`;
    sys += `【挡刀伪装】可适度跳神职（预言家/女巫/守卫等）替真神挡刀，但别过头——被拆穿反而扰乱好人；被怀疑或需要带队时再考虑。\n`;
    sys += `但注意不要干扰真正的神职玩家！\n`;
  }
  sys += `\n`;

  // v2.2 身份差异化：好人阵营统一的"按逻辑盘狼"模板（狼人已有带节奏策略，不再下发）
  if (role !== 'wolf') {
    sys += `【好人盘狼模板】（v2.3 升级为"拆谎/对跳/票型"三维度）\n`;
    sys += `  1) 拆谎：盯紧发言矛盾——前后口径不一、改口时间线、解释不清细节，都是狼的破绽。\n`;
    sys += `  2) 对跳：有人跳神职/预言家就核对时间线，逼对方报查验细节，编不圆的就是悍跳狼。\n`;
    sys += `  3) 票型分析：谁在带票、谁在嫁祸好人、谁的票型紧跟狼队友，用票型反推狼坑。\n`;
    sys += `  4) 结论要跟上理由：说"我怀疑X"时必须给依据（发言矛盾/票型怪/在带节奏）。\n`;
    sys += `  5) 有查验/守护/用药信息就报，适时带队归票；发言指向要和投票一致，言行一致是好人基本盘。\n\n`;
    // v2.4.8 任务7：好人团队协作——神职在安全时机传递信息，平民配合分析
    sys += `【好人团队协作】（v2.4.8 任务7：好人的信息越早对齐，狼越难藏）\n`;
    sys += `  1) 神职：在【安全时机】传递信息——有查验就报（报时间线：第几晚验了谁、结果）、遗言尽量报身份/查验/守护/用药与狼坑；但别无脑裸跳，先评估自己会不会被刀。\n`;
    sys += `  2) 平民：配合分析——听到神职报信息就顺着盘，帮真神站台、别被悍跳带偏；把票型/时间线疑点补充给神职参考。\n`;
    sys += `  3) 传递信息要有组织：验到狼果断号票，验到好人明确保人；信息对齐后统一归票，别各说各的。\n\n`;
    // v2.4.8 任务8：神职藏身份合法，不报信息≠狼面；"见风使舵"类指控必须带依据
    sys += `【神职藏身份规则】（v2.4.8 任务8）\n`;
    sys += `  1) 神职没信息时保持低调、不报身份，是【合理策略】，不算狼面——不要因为"某人不报身份"就怀疑他。\n`;
    sys += `  2) 神职被质疑时可以回"我在藏身份/留牌到关键时刻"，只要他能给出合理解释（怕被刀/时机未到），就不算破绽。\n`;
    sys += `  3) 指控别人"见风使舵/改口/不交信息"【必须有具体行为依据】：验人结果矛盾、时间线真冲突、票型异常、发言前后实质矛盾。光凭"他话少/他不报信息/他改过口"不能当铁狼面，否则好人自相残杀。\n\n`;
  }

  // 经验库 v1：按角色随机注入一份通用战术参考（跨局经验，非本局事实）
  const experience = loadExperience(role, playerName);
  if (experience) {
    sys += `【通用战术参考】（跨局经验，非本局事实；仅作发言风格与战术参考，不要当作上帝视角信息使用）\n`;
    sys += `注意：以下内容中提到的"人/玩家"一律以身份或位置代称，与本局具体玩家无关。\n`;
    sys += experience;
    sys += `\n\n`;
  }

  // v2.3 任务 B：记忆库预填（开局由 memorySystem 初始化，含人设/公共信息/身份边界/经验库链接）
  const memoryPrefill = buildMemoryPrefillSection(playerName);
  if (memoryPrefill) {
    sys += memoryPrefill;
    sys += `\n\n`;
  }

  return sys;
};

/**
 * 任务1：按玩家视角过滤游戏历史，禁止上帝视角信息泄漏。
 * - 狼人：只保留自己阵营名单 + 狼队夜晚行动 + 白天公开信息
 * - 预言家：只保留自己的查验记录
 * - 女巫/猎人/守卫：只保留自己的行动记录
 * - 平民：只保留白天公开信息
 * - 死亡玩家信息全流摘除
 */
const filterGameHistoryForRole = (
  gameHistory: GameHistory | undefined,
  role: Role,
  players: Player[]
): GameHistory | undefined => {
  if (!gameHistory) return undefined;

  const aliveNames = new Set(players.filter(p => p.isAlive).map(p => p.name));
  const deadNames = new Set(players.filter(p => !p.isAlive).map(p => p.name));

  // 1) 夜晚记录按角色过滤，查验结果绝不对非预言家公开
  const nightResults = (gameHistory.nightResults || []).map((night) => {
    const filtered: NightResult = { day: night.day };
    if (role === 'wolf' && night.killed) {
      filtered.killed = night.killed;
    } else if (role === 'seer' && night.checked) {
      filtered.checked = night.checked;
    } else if (role === 'witch') {
      if (night.healed) filtered.healed = night.healed;
      if (night.poisoned) filtered.poisoned = night.poisoned;
    } else if (role === 'guardian' && night.guarded) {
      filtered.guarded = night.guarded;
    }
    return filtered;
  }).filter((night) => night.day !== undefined);

  // 2) 死亡玩家：只保留名字，不保留身份
  const deadPlayers = (gameHistory.deadPlayers || [])
    .filter((d) => !aliveNames.has(d.name))
    .map((d) => ({ name: d.name, role: d.role, day: d.day, reason: d.reason }));

  // 3) 玩家信息库：摘除死亡玩家，查验/阵营确认信息仅对相关角色可见
  const playerKnowledge: Record<string, PlayerKnowledge> = {};
  if (gameHistory.playerKnowledge) {
    Object.entries(gameHistory.playerKnowledge).forEach(([name, k]) => {
      if (!aliveNames.has(name)) return; // 死亡玩家信息摘除
      const entry: PlayerKnowledge = {
        name: k.name,
        suspiciousLevel: k.suspiciousLevel,
      };
      if (k.isConfirmedWolf && role === 'wolf') entry.isConfirmedWolf = k.isConfirmedWolf;
      if (k.isConfirmedGood) entry.isConfirmedGood = k.isConfirmedGood;
      if (role === 'seer' && k.checkResults && k.checkResults.length > 0) {
        entry.checkResults = k.checkResults;
      }
      if (k.votes && k.votes.length > 0) entry.votes = k.votes;
      if (k.notes) entry.notes = k.notes;
      playerKnowledge[name] = entry;
    });
  }

  // 4) 时间线：死亡玩家相关的记录不再进入 prompt
  const timeline = (gameHistory.timeline || [])
    .filter((e) => !(e.actor && deadNames.has(e.actor)))
    .filter((e) => !(e.target && deadNames.has(e.target)))
    .map((e) => ({ ...e }));

  return {
    ...gameHistory,
    nightResults,
    deadPlayers,
    playerKnowledge,
    timeline,
  };
};

/**
 * 任务1/3：死亡玩家信息全流摘除；保留系统公告。
 */
const filterMessagesForView = (messages: Message[], players: Player[]): Message[] => {
  const deadNames = new Set(players.filter(p => !p.isAlive).map(p => p.name));
  return messages.filter((m) => {
    if (m.type === 'system') return true;
    if (!m.playerName) return true;
    return !deadNames.has(m.playerName);
  });
};

const generatePrompt = (params: GeneratePromptParams): { system: string; user: string } => {
  const { role, playerName, players, messages, gamePhase, day, gameHistory, isSorter } = params;
  const alivePlayers = players.filter((p) => p.isAlive);
  const deadPlayers = players.filter((p) => !p.isAlive);
  const wolfTeammates = players.filter((p) => p.role === 'wolf' && p.isAlive && p.name !== playerName);
  const visibleGameHistory = filterGameHistoryForRole(gameHistory, role, players);
  const visibleMessages = filterMessagesForView(messages, players);
  // 任务3：发言历史从 8 条放宽到 12 条，并去除钟表时间噪声
  const recentMessages = visibleMessages
    .filter((msg) => msg.type !== 'system' && msg.type !== 'wolf_chat')
    .slice(-12);

  const system = buildSystemPrompt(role, playerName, players);

  let prompt = `【当轮信息】\n`;
  prompt += `现在是: 第${day}天 ${gamePhase}\n\n`;

  // v2.4.9 任务4：每天提示词明确"现在是第X天"（当前天数进记忆/当轮信息），
  // 并给"过夜分析"状态——基于昨晚最新信息（死亡/查验/平安夜）发言，不是接着昨天的话尾巴（防隔夜复读）
  if (day >= 2) {
    const lastNightDeaths = (visibleGameHistory?.deadPlayers || [])
      .filter((d) => d.day === day - 1)
      .map((d) => `${d.name}（${formatDeathDetail(d.day, d.reason)}）`);
    prompt += `【过夜分析 · 新的一天】\n`;
    prompt += `昨晚（第${day - 1}晚）之后，场上新信息：${lastNightDeaths.length ? `有人死亡：${lastNightDeaths.join('、')}。` : '平安夜，无人死亡。'}\n`;
    prompt += `今天是新的一天（第${day}天），请基于昨晚最新信息（死亡/查验/平安夜）重新组织发言，不要接着昨天的话尾巴继续说——隔夜复读会被视为低质量发言。\n\n`;
  }

  // v2.4.8 任务15：注入每日局势摘要（公开黑板），让 AI 每天开牌前先看清场上存活/死亡与阶段，防"遗忘存活/以为守卫还活着"
  if (gameHistory?.situationSummary) {
    prompt += `【局势黑板（每日更新）】\n${gameHistory.situationSummary}\n\n`;
  }

  // v2.4.10 任务1：逻辑梳理机制——鼓励"捋"（基于已知情报的结构化梳理），禁止纯感觉怀疑
  if (gamePhase === '白天发言' || gamePhase === '自由讨论') {
    const sorterText = isSorter
      ? `你是今天的捋人（每天最多 1 人，明天换人）：用"我给大家捋一下"开场，把已知情报串起来盘狼坑——时间线（谁哪天死/验了谁）、票型（谁投谁、带票节奏）、公开信息（查验/死亡/平安夜）、矛盾点（发言前后实质矛盾/改口）；字数放宽到 ≤300 字。`
      : `你不是今天的捋人（捋配额每天最多 1 人、不连天同一人），保持短发言（≤100/150 字），不要抢做全盘总结；若还没人做过捋而你判断有必要，可给一个关键梳理点，但控制在 ≤150 字。`;
    prompt += `【逻辑梳理】\n`;
    prompt += `- 鼓励"我给大家捋一下"式结构化梳理：把已知情报拼起来（时间线/票型/公开信息/矛盾点），而不是停留在"我觉得X可疑"。\n`;
    prompt += `- 禁止纯感觉怀疑："X可疑"必须有推理链（时间线矛盾/票型异常/发言前后实质矛盾/查验依据）；没有依据的怀疑按低质量发言。\n`;
    prompt += `- 捋配额：每白天最多 1 人做捋，做捋的人字数放宽到 ≤300 字，且不连天同一人。\n`;
    prompt += `- ${sorterText}\n\n`;
  }

  // v2.4.8 任务13：遗言是神职向好人传信息的最后通道——鼓励报身份/查验/守护/用药与狼坑，禁止捏造
  if (gamePhase === '遗言') {
    prompt += `【遗言规则 - 你已出局】\n`;
    prompt += `这是你出局前最后的话，没有下一次发言机会。\n`;
    prompt += `如果你是神职（预言家/女巫/守卫/猎人）：这是向好人传递信息的最后通道——尽量报出你的真实身份、查验结果、守护/用药情况、你盘的狼坑与建议归票方向；\n`;
    prompt += `如果你是平民：把你观察到的票型与逻辑疑点交代清楚，帮好人继续盘狼。\n`;
    prompt += `只能说你真实做过的事（真的查验/守护/用药），禁止编造不存在的查验或行动；禁止"我记得XX说过"式虚构。\n\n`;
  }

  // v2.4.9 任务6：PK（平票争辩）阶段明确禁止复用上一轮/昨天的同款句式与理由——必须基于本场争辩给新内容
  if (gamePhase === '平票争辩') {
    prompt += `【PK 争辩纪律（v2.4.9）】\n`;
    prompt += `这是平票加投（PK）阶段的争辩发言，基于【刚才两位候选人的争辩内容】给出新的判断。\n`;
    prompt += `禁止复用你自己上一轮/昨天用过的同款句式（例如"信我XX今天的破绽够多了这轮投他没错"这类固定句式）；\n`;
    prompt += `禁止说"我这边理由已经说完了"这类空转话术——理由说完就给出具体票型/时间线依据，或引用刚发生的争辩细节。\n\n`;
  }

  prompt += `【存活玩家】\n`;
  alivePlayers.forEach((p) => {
    let roleMark = '';
    if (role === 'wolf' && p.role === 'wolf') {
      roleMark = ' 🐺';
    }
    prompt += `- ${p.name}${roleMark}\n`;
  });
  prompt += `\n`;

  if (deadPlayers.length > 0) {
    prompt += `【死亡玩家】\n`;
    // 任务1：死亡公布只公布名字，不公布身份
    // v2.4.4：补全死讯（谁死了/何时死/怎么死，不泄露身份）——优先用 gameHistory.deadPlayers 的 day+reason
    const deathInfo = new Map<string, string>();
    (visibleGameHistory?.deadPlayers || []).forEach((d) => {
      if (!deathInfo.has(d.name)) deathInfo.set(d.name, formatDeathDetail(d.day, d.reason));
    });
    deadPlayers.forEach((p) => {
      const detail = deathInfo.get(p.name);
      prompt += detail ? `- ${p.name}（${detail}）\n` : `- ${p.name}（已死亡）\n`;
    });
    prompt += `\n`;
  }

  // 游戏时间线（按角色视角过滤）
  if (visibleGameHistory && visibleGameHistory.timeline && visibleGameHistory.timeline.length > 0) {
    prompt += `【时间线】\n`;
    const recentTimeline = visibleGameHistory.timeline.slice(-10);
    recentTimeline.forEach((event) => {
      prompt += `第${event.day}天${event.phase}: ${event.event}`;
      if (event.actor && event.target) {
        prompt += ` (${event.actor} → ${event.target})`;
      } else if (event.actor) {
        prompt += ` (${event.actor})`;
      }
      prompt += `\n`;
    });
    prompt += `\n`;
  }

  // 玩家信息库（按角色视角过滤）
  if (visibleGameHistory && visibleGameHistory.playerKnowledge) {
    const entries = Object.entries(visibleGameHistory.playerKnowledge);
    if (entries.length > 0) {
      prompt += `【玩家信息库】\n`;
      entries.forEach(([name, knowledge]) => {
        let info = `${name}: `;
        if (knowledge.isConfirmedWolf) {
          info += '🐺 已确认狼人';
        } else if (knowledge.isConfirmedGood) {
          info += '✅ 已确认好人';
        } else {
          info += `🤔 可疑度 ${knowledge.suspiciousLevel}%`;
        }

        if (knowledge.checkResults && knowledge.checkResults.length > 0) {
          const lastCheck = knowledge.checkResults[knowledge.checkResults.length - 1];
          info += ` (第${lastCheck.day}晚查验: ${lastCheck.result})`;
        }

        if (knowledge.votes && knowledge.votes.length > 0) {
          // v2.4.9 任务5：投票记录是公开信息，全量展示供分析票型（"第X天投→Y"）
          const voteStr = knowledge.votes
            .map((v) => `第${v.day}天投→${v.target}`)
            .join('、');
          info += ` (投票: ${voteStr})`;
        }

        if (knowledge.notes) {
          info += ` | ${knowledge.notes}`;
        }

        prompt += `${info}\n`;
      });
      prompt += `\n`;
    }
  }

  if (recentMessages.length > 0) {
    prompt += `【白天聊天记录】\n`;
    recentMessages.forEach((msg) => {
      prompt += `${msg.playerName}: ${msg.content}\n`;
    });
    prompt += `\n`;
  } else {
    prompt += `【白天聊天记录】\n目前还没有其他玩家发言。\n\n`;
  }

  if (role === 'wolf' && wolfTeammates.length > 0) {
    const wolfMessages = visibleMessages.filter((msg) => msg.type === 'wolf_chat').slice(-5);
    if (wolfMessages.length > 0) {
      prompt += `【狼人私聊】\n`;
      wolfMessages.forEach((msg) => {
        prompt += `${msg.playerName}: ${msg.content}\n`;
      });
      prompt += `\n`;
    }
  }

  // 夜晚行动记录 - 按角色过滤后分发
  if (visibleGameHistory && visibleGameHistory.nightResults && visibleGameHistory.nightResults.length > 0) {
    prompt += `【夜晚行动记录】\n`;
    const recentNights = visibleGameHistory.nightResults.slice(-3);
    let printedAny = false;
    recentNights.forEach((night) => {
      const actions: string[] = [];
      if (night.killed) actions.push(`⚔️ 击杀${night.killed}`);
      if (night.healed) actions.push(`💊 解药救${night.healed}`);
      if (night.poisoned) actions.push(`☠️ 毒药杀${night.poisoned}`);
      if (night.checked) actions.push(`🔮 查验${night.checked.target}(${night.checked.result})`);
      if (night.guarded) actions.push(`🛡️ 守护${night.guarded}`);
      if (actions.length === 0) {
        if (role === 'wolf') actions.push('🌙 平安夜');
        else return; // 对当前角色无可见信息，跳过该晚
      }
      printedAny = true;
      prompt += `📅 第${night.day}晚: ${actions.join(' | ')}\n`;
    });
    if (printedAny) prompt += `\n`;
  }

  // 详细的技能使用记录（只有自己的）
  if (visibleGameHistory && visibleGameHistory.skillUsage && visibleGameHistory.skillUsage[playerName]) {
    prompt += `【你的技能使用记录】\n`;
    Object.entries(visibleGameHistory.skillUsage[playerName]).forEach(([skillName, usage]) => {
      prompt += `  - ${skillName}: ${usage.result}\n`;
    });
    prompt += `\n`;
  }

  // 添加当前存活人数提示
  prompt += `【当前存活情况】\n`;
  prompt += `当前存活人数: ${alivePlayers.length}人\n`;
  prompt += `存活玩家: ${alivePlayers.map(p => p.name).join('、')}\n`;
  if (deadPlayers.length > 0) {
    prompt += `已死亡玩家: ${deadPlayers.map(p => p.name).join('、')}\n`;
  }
  prompt += `\n`;

  prompt += `【输出格式】\n`;
  // v2.4.4 任务 A：按阶段限长（轮次≤100 / 自由讨论≤150 / 遗言≤80 / 争辩≤100）
  prompt += `⚠️ 本阶段发言长度要求：${getSpeechLimit(gamePhase).label}。重点信息 3 句说完，禁止长篇大论、禁止复述前面内容。\n`;
  // v2.4.10 任务1：捋人放宽到 ≤300；非捋人保持限长（分析可展开 ≤200）
  prompt += isSorter
    ? `⚠️ 你是今日捋人：可全盘梳理，字数放宽到 ≤300 字（时间线/票型/公开信息/矛盾点），不要为了凑字硬注水。\n`
    : `⚠️ 例外：有实质内容（时间线/票型/逻辑链）的分析可展开到 ≤200 字；每天最多 1 人做捋（轮换制），你不是捋人就别做全盘总结。\n`;
  prompt += `⚠️ 反瞎猜：有依据才下判断；没依据明说"我信息少/再听听"或跳过，不要硬编理由。\n`;
  prompt += `直接像聊天一样发言，用"我"开头或干脆不加前缀，别提别人的名字！\n`;
  prompt += `⚠️ 不要使用任何 Markdown 标记（**、-、数字列表等），不要每次都自我介绍！\n`;
  prompt += `例如：说实话，场上有点乱，我先观望下。\n`;
  prompt += `例如：不好说，反正XX的发言让我不太舒服。\n`;
  prompt += `例如：我昨晚验了XX，好人。\n\n`;

  prompt += `你的发言:`;

  return { system, user: prompt };
};

const generateWolfChatPrompt = (params: GeneratePromptParams & { wolfDiscussionRound?: number }): { system: string; user: string } => {
  const { role, playerName, players, messages, day, wolfDiscussionRound = 1 } = params;
  const wolfPlayers = players.filter((p) => p.role === 'wolf' && p.isAlive);
  // v2.3 任务 C3：狼人可刀任何人（含狼队友自刀），也可空刀
  const aliveTargets = players.filter((p) => p.isAlive);
  const visibleMessages = filterMessagesForView(messages, players);
  const wolfMessages = visibleMessages.filter((msg) => msg.type === 'wolf_chat').slice(-10);
  const dayMessages = visibleMessages.filter((msg) => msg.type === 'public').slice(-12);

  const system = buildSystemPrompt(role, playerName, players);

  let prompt = `【狼人杀游戏 - 狼人内部频道】\n\n`;
  prompt += `🔴🔴🔴 狼人身份: 你和其他狼人队友互相认识！\n\n`;
  prompt += `现在是: 第${day}晚，讨论轮次: ${wolfDiscussionRound}\n\n`;

  prompt += `【已知信息】\n`;
  prompt += `- 所有狼人队友的身份你都知道\n`;
  prompt += `- 你不知道其他玩家的具体身份（平民/神职）\n`;
  prompt += `- 只能根据逻辑推理，不要编造不存在的信息！\n\n`;

  prompt += `【狼队友】\n`;
  wolfPlayers.forEach((p) => {
    const marker = p.name === playerName ? '(你)' : '';
    prompt += `- 🐺 ${p.name} ${marker}\n`;
  });

  prompt += `\n【可刀目标】\n`;
  aliveTargets.forEach((p) => {
    prompt += `- 👤 ${p.name}\n`;
  });
  prompt += `\n⚠️ 规则：可以刀任何人（包括狼队友自刀），也可以选择不杀人（空刀）。\n`;

  if (dayMessages.length > 0) {
    prompt += `\n【白天发言记录】\n`;
    dayMessages.forEach((msg) => {
      prompt += `${msg.playerName}: ${msg.content}\n`;
    });
    prompt += `\n`;
  }

  if (wolfMessages.length > 0) {
    prompt += `\n【狼人私聊记录】\n`;
    wolfMessages.forEach((msg) => {
      prompt += `${msg.playerName}: ${msg.content}\n`;
    });
    prompt += `\n`;
  }

  prompt += `【狼人策略讨论】\n`;
  prompt += `作为狼人团队，你们需要讨论：\n`;
  prompt += `1. 【今晚刀谁】选择今晚要袭击的目标\n`;
  prompt += `2. 【白天策略】如何在白天的发言中伪装自己\n`;
  prompt += `3. 【身份猜测】根据白天发言判断谁可能是神职\n`;
  prompt += `4. 【团队配合】谁应该跳身份挡刀（如悍跳预言家），谁应该潜伏\n`;
  prompt += `5. 【优先击杀】神职优先还是平民优先\n\n`;

  prompt += `【严格规则】\n`;
  prompt += `1. 绝对不要编造不存在的发言或剧情！\n`;
  prompt += `2. 不要说"不确定谁是狼人"这种话！\n`;
  prompt += `3. 可以讨论杀人目标和策略，不仅仅是投票！\n`;
  prompt += `4. 发言简短（20-50字），直接说想法！\n`;
  prompt += `5. 如果确定要杀人，必须在最后一行单独写: {目标名称}\n`;
  prompt += `6. 如果只是讨论策略或还没决定，最后一行写: {待定}\n`;
  prompt += `7. ⚠️ 必须使用纯中文，不能有任何乱码、符号或英文！\n`;
  prompt += `8. ⚠️ {目标名称}中只能写中文名字，不能有任何其他内容！\n\n`;

  prompt += `【输出格式】\n`;
  prompt += `先说你的分析和建议（可以讨论策略），然后在最后一行单独写:\n`;
  prompt += `{目标名称} 或 {待定}\n`;
  prompt += `例如:\n`;
  prompt += `我觉得大壮发言比较冲，可能是个神职。小美比较低调，先刀她吧。\n`;
  prompt += `{小美}\n\n`;
  prompt += `例如:\n`;
  prompt += `先讨论一下，谁跳预言家挡刀比较合适？我还没想好刀谁。\n`;
  prompt += `{待定}\n\n`;
  prompt += `例如:\n`;
  prompt += `今晚平安夜吧，让大家以为守卫还在。\n`;
  prompt += `{跳过}\n\n`;

  prompt += `你的回复:`;

  return { system, user: prompt };
};

const generateVotePrompt = (params: GeneratePromptParams & { tiePlayers?: string[]; isInTieDebate?: boolean }): { system: string; user: string } => {
  const { role, playerName, players, messages, gamePhase, day, tiePlayers = [], isInTieDebate = false } = params;
  const roleInfo = getRoleInfo(role);
  const alivePlayers = players.filter((p) => p.isAlive);
  const visibleMessages = filterMessagesForView(messages, players);
  const recentMessages = visibleMessages.filter((msg) => msg.type !== 'system' && msg.type !== 'wolf_chat').slice(-15);

  // v2.4 任务 A-1：取该玩家自己的最新发言全文（含承诺），必须喂给投票 AI
  const mySpeeches = visibleMessages
    .filter((msg) => msg.type !== 'system' && msg.type !== 'wolf_chat' && msg.playerName === playerName)
    .map((msg) => msg.content.trim())
    .filter(Boolean);
  const myLatestSpeech = mySpeeches[mySpeeches.length - 1] || '';

  const system = buildSystemPrompt(role, playerName, players);

  let prompt = `【狼人杀游戏 - 投票阶段】\n\n`;
  prompt += `【当前阶段】: 第${day}天 ${gamePhase}\n\n`;

  if (isInTieDebate && tiePlayers.length > 0) {
    const tiePlayerNames = tiePlayers.map(id => players.find(p => p.id === id)?.name).filter(Boolean);
    prompt += `【平票加投阶段 - PK】\n`;
    prompt += `当前是平票加投（PK）阶段的重新投票，你只能在以下玩家中选择:\n`;
    tiePlayerNames.forEach(name => {
      prompt += `- ${name}\n`;
    });
    prompt += `\n`;
  }

  prompt += `【存活玩家】\n`;
  alivePlayers.forEach((p) => {
    const marker = p.name === playerName ? '(你)' : '';
    prompt += `- ${p.name}${marker}\n`;
  });
  prompt += `\n`;

  // v2.4 任务 A-1 + v2.4.5-B X2：自己的最新发言全文，明确提示言行一致 + 承诺优先
  if (myLatestSpeech) {
    prompt += `【你今天的发言（言行一致基准）】\n`;
    prompt += `${playerName}: ${myLatestSpeech}\n`;
    prompt += `你在发言中若承诺了投票对象（如"我投X / 我这票挂X / 我票落X / 我不投X"），优先兑现自己的承诺，按承诺投票。\n`;
    prompt += `若你要改票（投票与承诺不一致），必须给出明确理由（一句具体的话，写在第二行理由中）；无理由改票视为违规。\n\n`;
  }

  if (recentMessages.length > 0) {
    prompt += `【白天发言记录】\n`;
    recentMessages.forEach((msg) => {
      prompt += `${msg.playerName}: ${msg.content}\n`;
    });
    prompt += `\n`;
  }

  prompt += `【投票分析】\n`;
  prompt += `作为${roleInfo.name}，请分析以上发言，判断谁最可能是狼人。\n`;
  prompt += `⚠️ 反偷懒：禁止"随便/无所谓/都行"式投票——即使拿不准，也必须给出明确目标与理由（哪怕"我直觉他可疑"）。\n`;

  if (role === 'wolf') {
    prompt += `你是狼人，请伪装成好人投票，不要投给狼队友！\n`;
  } else {
    prompt += `请找出最可疑的玩家进行投票。\n`;
  }

  if (isInTieDebate) {
    prompt += `⚠️ 平票加投（PK）阶段禁止弃票！你必须从上面的平票玩家中选一个投票！\n`;
    prompt += `⚠️ 你不能投自己！（你是候选人时也不能投自己）\n`;
    prompt += `请根据两位玩家的争辩内容，决定支持谁。\n`;
  }

  prompt += `\n【输出格式 - 重要】\n`;
  prompt += `⚠️ 你必须输出两行，每行一个内容，不能有其他任何内容！\n`;
  prompt += `第一行：一个玩家名字（纯中文，不能有任何符号）；PK 阶段第一行必须是平票玩家之一。\n`;
  // v2.4.5-B X2：理由必填（不允许空理由），承诺优先、改票必须给明确理由
  prompt += `第二行：你的投票理由（必填，一句话，不超过 40 字）。禁止输出空理由；若你的投票与你发言中的承诺不一致，此处必须写明一句具体的改票理由。\n`;
  prompt += `✅ 正确示例:\n小满\n他今天时间线前后矛盾，我改票跟投。\n`;
  prompt += `❌ 错误示例: 我觉得小满可能是狼\n`;
  prompt += `❌ 错误示例（第二行为空）: 小满\n\n`;
  // 任务2：平票加投阶段直接删除"跳过/弃票"选项
  if (!isInTieDebate) {
    prompt += `弃票请在第一行输出: 跳过\n`;
  }
  prompt += `直接输出你的选择:`;

  return { system, user: prompt };
};

const generateNightPrompt = (params: GeneratePromptParams): { system: string; user: string } => {
  const { role, playerName, players, day, nightActions } = params;
  const alivePlayers = players.filter((p) => p.isAlive);

  const system = buildSystemPrompt(role, playerName, players);

  let prompt = `【狼人杀 - 夜晚行动】\n\n`;
  prompt += `【当前夜晚】: 第${day}晚\n\n`;

  prompt += `【存活玩家】\n`;
  alivePlayers.forEach((p) => {
    prompt += `- ${p.name}${p.isAI ? ' [AI]' : ''}\n`;
  });

  if (nightActions && nightActions.length > 0) {
    prompt += `\n【今晚已发生】\n`;
    nightActions.forEach((action) => {
      const target = players.find((p) => p.id === action.targetId);
      // 只展示狼人自己的击杀目标，避免泄漏其他角色的行动
      if (action.action === 'kill' && role === 'wolf') {
        prompt += `🐺 狼人选择了 ${target?.name || '未知'}\n`;
      }
    });
  }

  prompt += `\n【你的决策】\n`;

  switch (role) {
    case 'wolf':
      prompt += `作为狼人，你需要选择今晚要袭击的目标。\n`;
      prompt += `分析局势，选择一个对狼人阵营有利的目标。\n`;
      prompt += `选择一个存活玩家的名字作为目标。\n`;
      prompt += `\n【输出格式 - 重要】\n`;
      prompt += `⚠️ 你必须只输出一个玩家名字，不能有任何其他内容！\n`;
      prompt += `⚠️ 必须是纯中文名字，不能有任何符号或乱码！\n`;
      prompt += `✅ 正确示例: 小明\n`;
      prompt += `✅ 正确示例: 大壮\n`;
      prompt += `❌ 错误示例: 我觉得小明是狼\n`;
      prompt += `❌ 错误示例: 123 或任何乱码\n`;
      prompt += `不杀人请输出: 跳过（空刀是合法策略，如示弱/埋坑，可以跳过）\n`;
      break;
    case 'seer':
      prompt += `作为预言家，你可以查验一个玩家的身份。\n`;
      prompt += `【重要】查验结果只能是"好人"或"狼人"，不能查验具体职业！\n`;
      prompt += `⚠️ 你每晚必须查验一人，不能跳过！\n`;
      {
        // v2.4.8 任务12：注入"已查验名单"（含结果），禁止重复查验同一人
        prompt += `\n${buildSeerCheckedListSection(params.gameHistory, playerName)}`;
      }
      prompt += `选择你认为需要查验的玩家。\n`;
      prompt += `选择一个存活玩家的名字作为查验目标。\n`;
      prompt += `\n【输出格式 - 重要】\n`;
      prompt += `⚠️ 你必须只输出一个玩家名字，不能有任何其他内容！\n`;
      prompt += `⚠️ 必须是纯中文名字，不能有任何符号或乱码！\n`;
      prompt += `✅ 正确格式: 预言家查验: 小明\n`;
      prompt += `✅ 正确示例: 小明\n`;
      prompt += `❌ 错误示例: 我查验小明\n`;
      prompt += `❌ 错误示例: 123 或任何乱码\n`;
      break;
    case 'witch': {
      const hasKill = nightActions?.some((a) => a.action === 'kill') ?? false;

      // N6：解药已用时不再提示被刀者是谁（优先用游戏状态里的持久标志位，历史缺失也不退化）
      const witchSkillUsage = (params.gameHistory?.skillUsage?.[playerName] || {}) as Record<string, SkillUsage>;
      const witchHealUsed = params.witchAntidoteUsed ?? Object.values(witchSkillUsage).some((u) => String(u.result).includes('解药'));

      prompt += `作为女巫，${witchHealUsed ? '你的解药已经用完，还剩一瓶毒药' : '你有解药和毒药'}。\n`;
      let targetName: string | undefined;
      if (hasKill) {
        const killTarget = nightActions?.find((a) => a.action === 'kill')?.targetId;
        targetName = players.find((p) => p.id === killTarget)?.name;

        // v2.3 任务 C4：女巫只知道"谁被袭击了"，不知道守卫是否守护（守护是否成功由白天死讯体现）
        if (witchHealUsed) {
          prompt += `你的解药已经用完，只能选择使用毒药或跳过。\n`;
        } else {
          prompt += `今晚 ${targetName} 被袭击了！\n`;
          prompt += `你可以选择使用解药救他/她，或者使用毒药，或者跳过。\n`;
        }
      } else {
        prompt += `今晚平安夜，没有人被袭击。\n`;
        prompt += `你可以选择使用毒药或跳过。\n`;
      }
      prompt += `谨慎决定是否使用药剂。\n`;
      prompt += `可以跳过并保留药剂；若要跳过，请简单说明理由（如"今晚想留药"）。\n`;
      prompt += `注意：守卫是否守护、狼人是否空刀，你都无法确知——一切以白天公布的死讯为准。\n`;
      prompt += `\n【输出格式 - 重要】\n`;
      prompt += `⚠️ 必须按照指定格式输出，不能有任何乱码或无意义内容！\n`;
      prompt += `⚠️ 第一行必须是以下三种之一（纯中文，不要输出 p1/p2 这类编号或符号）：\n`;
      // v2.4.9 任务7：要求明确输出"用药:解药/毒药/不用 + 目标"，解析器兼容多种写法；乱码会触发默认决策
      prompt += `✅ 用药: 解药 ${targetName || '被刀玩家名'}\n`;
      prompt += `✅ 用药: 毒药 目标名\n`;
      prompt += `✅ 用药: 不用\n`;
      prompt += `（兼容写法：女巫行动: 救人 目标名 / 女巫行动: 毒人 目标名 / 女巫行动: 跳过）\n`;
      prompt += `❌ 错误示例: p1 / p2 / 123 或任何乱码、符号、英文缩写\n`;
      prompt += `❌ 错误示例: 我救人\n`;
      break;
    }
    case 'guardian': {
      // N7：上一晚守护目标从技能记录读取（nightActions 每晚会被清空）
      const guardianSkillUsage = (params.gameHistory?.skillUsage?.[playerName] || {}) as Record<string, SkillUsage>;
      const guardianRecords = Object.entries(guardianSkillUsage).filter(([k]) => k.includes('守护'));
      const guardianLastRecord = guardianRecords[guardianRecords.length - 1];
      let guardianLastTargetName: string | null = null;
      if (guardianLastRecord) {
        const guardMatch = String(guardianLastRecord[1].result).match(/守护了(.+)$/);
        if (guardMatch) guardianLastTargetName = guardMatch[1].trim();
      }

      prompt += `作为守卫，你可以守护一名玩家免受狼人袭击。\n`;
      prompt += `【重要】你不能连续两晚守护同一个人！\n`;
      prompt += `⚠️ 你必须守护一人，不能跳过！\n`;

      if (guardianLastTargetName) {
        prompt += `上一晚你守护了 ${guardianLastTargetName}，今晚不能再守护他/她。\n`;
      }

      prompt += `选择你要守护的玩家。\n`;
      prompt += `\n【输出格式 - 重要】\n`;
      prompt += `⚠️ 你必须只输出一个玩家名字，不能有任何其他内容！\n`;
      prompt += `⚠️ 必须是纯中文名字，不能有任何符号或乱码！\n`;
      prompt += `✅ 正确格式: 守卫守护: 小明\n`;
      prompt += `✅ 正确示例: 小明\n`;
      prompt += `❌ 错误示例: 我守护小明\n`;
      prompt += `❌ 错误示例: 123 或任何乱码\n`;
      break;
    }
    default:
      prompt += `你这个角色在夜晚不需要行动。\n`;
  }

  prompt += `\n⚠️ 重要提示：\n`;
  prompt += `1. 必须只输出玩家名字，不能有任何解释或乱码！\n`;
  prompt += `2. 必须是纯中文名字，例如：小明、大壮\n`;
  prompt += `3. 不能输出：数字、符号、英文、乱码等任何无意义内容！\n`;

  return { system, user: prompt };
};

export const callAIApi = async (
  config: AIConfig,
  role: Role,
  playerName: string,
  players: Player[],
  messages: Message[],
  gamePhase: string,
  day: number,
  nightActions?: NightAction[],
  gameHistory?: GameHistory,
  currentSpeaker?: string,
  speakerOrder?: string[],
  wolfDiscussionRound?: number,
  playerId?: string,
  customUserPrompt?: string // v2.4.5-A A4：局后复盘等场景直接用自定义 user prompt，跳过当轮发言模板
  , isSorter?: boolean // v2.4.10 任务1：今日"捋"人（逻辑梳理，字数放宽到 ≤300）
): Promise<string> => {
  if (isAborted) {
    addLog({
      type: 'warning',
      title: '游戏已中止',
      message: `${playerName} AI调用被中止`,
      playerName,
    });
    return '游戏已中止';
  }

  const player = players.find(p => p.name === playerName);
  const currentPlayerId = playerId || player?.id || '';

  if (thinkingCallback && currentPlayerId) {
    thinkingCallback(currentPlayerId, 20);
  }

  // 根据API类型选择配置
  const isSiliconflow = config.apiType === 'siliconflow';
  const isDeepseek = config.apiType === 'deepseek';
  const siliconflowConfig = config.siliconflow;
  const deepseekConfig = config.deepseek;
  const localConfig = config.local;
  
  // 检查是否使用内置回复（无API Key时）
  const useBuiltinResponses = (isSiliconflow && (!siliconflowConfig.apiKey || siliconflowConfig.apiKey.trim() === '')) ||
                              (isDeepseek && (!deepseekConfig.apiKey || deepseekConfig.apiKey.trim() === ''));

  if (useBuiltinResponses) {
    addLog({
      type: 'info',
      title: '使用模拟回复',
      message: `${playerName}(${getRoleInfo(role).name}) 使用内置回复（无API Key）`,
      playerName,
    });

    const myPrevMessages = messages.filter((m) => m.playerName === playerName);
    const hasSpokenBefore = myPrevMessages.length > 0;

    const randomResponses: Record<Role, string[]> = {
      wolf: hasSpokenBefore
        ? [
            '我之前说的分析，大家可以再想想。',
            '我觉得局势越来越明朗了，大家要冷静分析。',
            '继续听其他人发言，看看有没有破绽。',
          ]
        : [
            '大家好，我是第一次玩，说得不对请见谅。',
            '我觉得今天可以先观察一下，不急着下结论。',
            '我是一个好人，没什么特别的信息。',
          ],
      seer: hasSpokenBefore
        ? [
            '我之前已经说过了，我的判断还是不变的。',
            '大家要相信自己，也要相信我。',
            '继续分析，我相信好人的逻辑。',
          ]
        : [
            '我拿身份了，手里有点信息，合适的时机再公布。',
            '我有些信息，需要合适时机公布。',
            '大家分析得都很有道理。',
          ],
      witch: hasSpokenBefore
        ? [
            '我之前已经说过了。',
            '继续听发言，我也有自己的判断。',
            '我觉得场上需要更多信息。',
          ]
        : [
            '我是好人，我会帮助好人阵营。',
            '先听听其他人怎么说。',
            '我会根据情况做出判断的。',
          ],
      hunter: hasSpokenBefore
        ? [
            '我之前说的大家可以参考一下。',
            '继续分析，我相信大家能找到狼人。',
            '我有些想法，但现在说还早。',
          ]
        : [
            '我是一个平民，我会认真分析。',
            '大家畅所欲言，我来听听。',
            '我觉得今天可以讨论一下。',
          ],
      guardian: hasSpokenBefore
        ? [
            '我之前说的大家可以参考一下。',
            '继续分析，我相信大家能找到狼人。',
            '我会保护关键玩家的。',
          ]
        : [
            '我是一个好人，我会帮助好人阵营。',
            '先听听其他人怎么说。',
            '我会根据情况做出判断的。',
          ],
      villager: hasSpokenBefore
        ? [
            '我再补充一下我的分析...',
            '之前说的不变，继续分析。',
            '我同意之前的判断。',
          ]
        : [
            '大家好，我是平民，请多关照。',
            '我刚拿到身份，还在整理思路。',
            '我先听听其他人的发言。',
          ],
    };

    const responses = randomResponses[role] || randomResponses.villager;
    // v2.4.4 任务 A：内置回复同样限长
    const builtinLimit = getSpeechLimit(gamePhase);
    return truncateSpeech(responses[Math.floor(Math.random() * responses.length)], builtinLimit.max);
  }

  const startTime = Date.now();
  
  // 根据配置选择 API 端点
  let apiUrl: string;
  if (isSiliconflow) {
    apiUrl = 'https://api.siliconflow.cn/v1/chat/completions';
  } else if (isDeepseek) {
    apiUrl = 'https://api.deepseek.com/v1/chat/completions';
  } else {
    if (localConfig.apiUrl.startsWith('http://localhost') || localConfig.apiUrl.startsWith('http://127.0.0.1')) {
      // 本地地址使用代理
      apiUrl = localConfig.apiUrl.replace('http://localhost:1234', '/api/lm-studio').replace('http://127.0.0.1:1234', '/api/lm-studio');
    } else {
      apiUrl = localConfig.apiUrl;
    }
  }

  if (thinkingCallback && currentPlayerId) {
    thinkingCallback(currentPlayerId, 40);
  }

  addLog({
    type: 'api',
    title: '开始API调用',
    message: `${playerName}(${getRoleInfo(role).name}) 正在生成发言`,
    playerName,
    apiEndpoint: apiUrl,
  });

  if (thinkingCallback && currentPlayerId) {
    thinkingCallback(currentPlayerId, 60);
  }

  try {
    // v2.4.5-A A1：抽离"一次生成调用"为 performCall（可携带额外指令，供撞模板后重生成）
    let system = '';
    let user = '';
    if (gamePhase === '狼人讨论') {
      // 狼人讨论阶段，使用专门的提示词
      const built = generateWolfChatPrompt({
        role,
        playerName,
        players,
        messages,
        gamePhase,
        day,
        nightActions,
        gameHistory,
        currentSpeaker,
        speakerOrder,
        wolfDiscussionRound,
      });
      system = built.system;
      user = built.user;
    } else {
      // 普通游戏阶段
      const built = generatePrompt({
        role,
        playerName,
        players,
        messages,
        gamePhase,
        day,
        nightActions,
        gameHistory,
        currentSpeaker,
        speakerOrder,
        isSorter,
      });
      system = built.system;
      user = built.user;
    }

    // v2.4.5-A A4：自定义 prompt（局后复盘）直接覆盖 user，跳过当轮发言模板
    if (customUserPrompt) {
      user = customUserPrompt;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // 根据 API 类型添加授权头
    if (isSiliconflow && siliconflowConfig.apiKey) {
      headers['Authorization'] = `Bearer ${siliconflowConfig.apiKey}`;
    } else if (isDeepseek && deepseekConfig.apiKey) {
      headers['Authorization'] = `Bearer ${deepseekConfig.apiKey}`;
    } else if (localConfig.apiKey) {
      headers['Authorization'] = `Bearer ${localConfig.apiKey}`;
    }

    // 根据 API 类型选择配置
    let currentModel: string;
    let currentTemperature: number;
    let currentMaxTokens: number;
    let currentEffort: string | undefined;
    
    if (isSiliconflow) {
      currentModel = siliconflowConfig.model;
      currentTemperature = siliconflowConfig.temperature;
      currentMaxTokens = siliconflowConfig.maxTokens;
    } else if (isDeepseek) {
      currentModel = deepseekConfig.model;
      currentTemperature = deepseekConfig.temperature;
      currentMaxTokens = deepseekConfig.maxTokens;
    } else {
      currentModel = localConfig.model;
      currentTemperature = localConfig.temperature;
      currentMaxTokens = localConfig.maxTokens;
      currentEffort = 'low'; // luna 用 low effort 更快
    }

    // v2.4.5-A A1：真 AI 调用温度下限提到 0.9（提升句式多样性，配合复读硬拦截）
    currentTemperature = Math.max(currentTemperature || 0, 0.9);

    // 任务4：maxTokens 限制在 200~512，防止旧配置仍为 50000 造成大量消耗
    currentMaxTokens = Math.min(Math.max(currentMaxTokens || 512, 200), 512);

    // v2.4.6 P0-1：单次请求（流式/非流式两种模式可切换），失败交由上层降级/重试
    const performSingleCall = async (extraInstruction: string, stream: boolean): Promise<string> => {
      const promptMessages: Array<{ role: 'system' | 'user'; content: string }> = [
        { role: 'system', content: system },
        { role: 'user', content: extraInstruction ? `${user}\n\n${extraInstruction}` : user },
      ];
      const requestBody = {
        model: currentModel,
        messages: promptMessages,
        temperature: currentTemperature,
        max_tokens: currentMaxTokens,
        ...(currentEffort ? { reasoning_effort: currentEffort } : {}),
        stream,
      };

      // 详细日志
      console.log(`=== ${isSiliconflow ? '硅基流动' : '本地'} API Request（${stream ? '流式' : '非流式'}） ===`);
      console.log('URL:', apiUrl);
      console.log('Model:', currentModel);
      console.log('Body:', JSON.stringify(requestBody, null, 2));

      const response = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`API请求失败，状态码: ${response.status}`);
      }

      // 非流式：一次性 JSON 解析（choices[0].message.content）
      if (!stream) {
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('API 非流式响应缺少内容');
        }
        return content.trim();
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('无法获取响应流');
      }

      const decoder = new TextDecoder('utf-8');
      let result = '';
      let tokenCount = 0;
      const maxTokens = currentMaxTokens;

      // 流式解析：缓冲合并，防止 chunk 把 JSON 截断导致 JSON.parse 失败丢内容
      let buffer = '';
      let streamDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data:')) continue;

          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') {
            streamDone = true;
            break;
          }
          if (!dataStr) continue;

          try {
            const data = JSON.parse(dataStr);
            const content = data.choices?.[0]?.delta?.content;
            if (content) {
              result += content;
              tokenCount++;

              if (thinkingCallback && currentPlayerId && maxTokens > 0) {
                const progress = Math.min(95, 20 + (tokenCount / maxTokens) * 75);
                thinkingCallback(currentPlayerId, Math.round(progress));
              }
            }
          } catch (e) {
            console.warn('解析流式响应失败（已缓冲合并，跳过该行）:', e);
          }
        }

        if (streamDone) break;
      }

      // 处理末尾未换行的残余缓冲
      const tail = buffer.trim();
      if (tail.startsWith('data:')) {
        const dataStr = tail.slice(5).trim();
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const data = JSON.parse(dataStr);
            const content = data.choices?.[0]?.delta?.content;
            if (content) result += content;
          } catch (e) {
            console.warn('解析流式响应失败（末尾缓冲）:', e);
          }
        }
      }

      return result.trim();
    };

    // v2.4.6 P0-1 + v2.4.8 任务4：performCall = 流式（带重试）→ 流式彻底失败则降级非流式重试（2 次）→ 再失败向上抛（外层走 fallback）
    const performCall = async (extraInstruction: string): Promise<string> => {
      try {
        return await withRetry(
          () => performSingleCall(extraInstruction, true),
          AI_RETRY_COUNT,
          (attempt, error) => {
            addLog({
              type: 'warning',
              title: 'AI调用重试',
              message: `${playerName} AI调用失败，第${attempt}次重试: ${error instanceof Error ? error.message : '未知错误'}`,
              playerName,
              apiEndpoint: apiUrl,
              duration: Date.now() - startTime,
            });
          }
        );
      } catch (error) {
        // v2.4.8 任务4：流式彻底失败（502/超时/断流）→ 降级非流式重试 2 次（避免静默回退 fallback 刷屏）
        addLog({
          type: 'warning',
          title: '流式失败，降级非流式重试',
          message: `${playerName} 流式调用失败，降级为非流式请求重试（至多 2 次）: ${error instanceof Error ? error.message : '未知错误'}`,
          playerName,
          apiEndpoint: apiUrl,
          duration: Date.now() - startTime,
        });
        return await withRetry(
          () => performSingleCall(extraInstruction, false),
          1,
          (attempt, e2) => {
            addLog({
              type: 'warning',
              title: '非流式重试',
              message: `${playerName} 非流式请求第${attempt}次失败: ${e2 instanceof Error ? e2.message : '未知错误'}`,
              playerName,
              apiEndpoint: apiUrl,
              duration: Date.now() - startTime,
            });
          }
        );
      }
    };

    let result = await performCall('');

    // v2.4.5-A A1 + v2.4.5-B X1 + v2.4.5-C C2：发言阶段（轮次/自由讨论/遗言/平票争辩）运行时模板比对：
    //   - 阈值 ≥0.75（C2.1，原 0.6 误报高）；整句 verbatim 硬门禁（C2.2，sim≥0.9 且两方骨架均≥15字 → 直接禁发）；
    //   - 重生成 ≤2 次（C2.3，原 1 次）；普通撞模板重生成后仍撞 → 接受（防死循环），verbatim → 返回占位表态
    if (SPEECH_PHASES_FOR_REPEAT.includes(gamePhase)) {
      const names = players.map((p) => p.name);
      let current = result;
      let check = checkSpeechTemplateCollision(current, names, playerName);
      const MAX_REGENS = 2;
      let attempts = 0;
      while (check.collided && attempts < MAX_REGENS) {
        const hard = check.level === 'hard';
        attempts++;
        addLog({
          type: 'warning',
          title: '复读硬拦截',
          message: `${playerName} 发言与【${check.collidedWith}】${hard ? '逐字高度重复' : '撞模板'}（模板：${check.template}），触发重生成（第${attempts}次）`,
          playerName,
          apiEndpoint: apiUrl,
          details: current.substring(0, 120),
        });
        const retryInstruction = hard
          ? `你刚才的发言与【${check.collidedWith}】几乎逐字重复（模板：${check.template}）。必须彻底重写，换一套完全不同的话术；如果实在想不出新说法，直接简短表态即可（例如"我同意前面分析，跟投"），严禁原句复读。`
          : `你刚才的发言句式与【${check.collidedWith}】重复（模板：${check.template}）。请换一种完全不同的表达方式，或简短说"我跟${check.collidedWith}"；严禁套用同一句式。`;
        current = await performCall(retryInstruction);
        check = checkSpeechTemplateCollision(current, names, playerName);
      }
      if (check.collided && check.level === 'hard') {
        // C2.2 硬门禁：重生成 2 次仍整句 verbatim → 直接禁发，返回简略表态
        addLog({
          type: 'warning',
          title: '复读硬拦截',
          message: `${playerName} 重生成 ${MAX_REGENS} 次仍逐字重复 → 已直接禁发，返回简略表态`,
          playerName,
          apiEndpoint: apiUrl,
          details: current.substring(0, 120),
        });
        result = `（与${check.collidedWith}发言高度重复，简略表态）`;
      } else if (check.collided) {
        // 普通撞模板重生成后仍撞 → 接受当前发言（防死循环）
        addLog({
          type: 'warning',
          title: '复读硬拦截',
          message: `${playerName} 重生成 ${MAX_REGENS} 次后仍撞模板，接受当前发言（防死循环）`,
          playerName,
          apiEndpoint: apiUrl,
          details: current.substring(0, 120),
        });
        result = current;
      } else {
        result = current;
      }
    }

    const duration = Date.now() - startTime;

    addLog({
      type: 'success',
      title: 'API调用成功',
      message: `${playerName} 发言生成完成`,
      playerName,
      apiEndpoint: apiUrl,
      duration,
      details: result.substring(0, 80) + (result.length > 80 ? '...' : ''),
    });

    if (thinkingCallback && currentPlayerId) {
      thinkingCallback(currentPlayerId, 100);
    }

    setTimeout(() => {
      if (removeThinkingCallback && currentPlayerId) {
        removeThinkingCallback(currentPlayerId);
      }
    }, 500);

    // v2.4.6 P0-2：统一走 publishSpeech 出口（截断 + 防复读检查 + 记入比对窗口）
    return publishSpeech(playerName, result, gamePhase, day, players.map((p) => p.name), isSorter);
  } catch (error) {
    const duration = Date.now() - startTime;
    addLog({
      type: 'error',
      title: 'API调用异常',
      message: `${playerName} AI调用异常: ${error instanceof Error ? error.message : '未知错误'}`,
      playerName,
      apiEndpoint: apiUrl,
      duration,
      details: error instanceof Error ? error.stack : undefined,
    });
    console.error('AI API调用失败:', error);

    if (removeThinkingCallback && currentPlayerId) {
      removeThinkingCallback(currentPlayerId);
    }

    // v2.4.8 任务4/5：fallback 短句变体池（≥10 种），掉线时不再全员同句；
    // 选取时避开与近期发言重复的变体，避免 fallback 互相撞模板触发"高度重复"门禁。
    const fallbackVariant = pickFallbackVariant(players.map((p) => p.name));
    // v2.4.6 P0-2：fallback 也走 publishSpeech 统一出口（过防复读检查 + 记入比对窗口）
    return publishSpeech(playerName, fallbackVariant, gamePhase, day, players.map((p) => p.name), isSorter);
  }
};

/* ==================== v2.4.5-B X2 投票理由强制 + 承诺绑定 + 理由去重 ==================== */

/** 从最新发言提取承诺目标（我投X / 我这票挂X / 我票落X / 我票给X / 我不投X），返回名字或 null */
const extractVoteCommitment = (text: string, names: string[]): string | null => {
  if (!text) return null;
  for (const n of names) {
    const idx = text.lastIndexOf(n);
    if (idx === -1) continue;
    const pre = text.slice(Math.max(0, idx - 10), idx);
    if (/我\s*(?:这票挂|票落|投给|投定|票给|跟投|投|票|挂|押)\s*$/.test(pre)) return n;
  }
  return null;
};

/** 理由变体池（撞模板/无理由时替换，{P} 为投票目标名）
 *  v2.4.9 任务6：扩到 16 种并加入 PK 专用变体，防"信我XX破绽够多""时间线对不上"跨天/跨玩家复用 */
const REASON_VARIANTS = [
  '综合判断，{P}嫌疑最大。',
  '{P}的发言前后矛盾，我认为他是狼。',
  '{P}一直在带节奏，最可疑。',
  '跟投{P}，理由是他今天逻辑漏洞太多。',
  '按承诺投{P}，发言里我早就点过他。',
  '我改票了，理由：{P}比之前更可疑。',
  '直觉上{P}不对劲，我投他。',
  '{P}的时间线对不上，这票给他。',
  '{P}今天话多但全是空话，最像狼。',
  '{P}总在别人被踩时打圆场，护得太明显。',
  '{P}每轮发言换一个说法，立场跟水一样。',
  '{P}被问到细节就绕圈子，这很狼。',
  '{P}的票型总跟着别人走，没自己的想法。',
  '{P}说自己信息少，盘别人狼坑倒很起劲。',
  '{P}刚才急着打断别人，像在堵嘴。',
  '{P}的话和昨天的对不上，改口太快。',
];

/** v2.4.9 任务6：PK 阶段专用理由变体池（争辩后加投，强调基于本场争辩/票型） */
const PK_REASON_VARIANTS = [
  'PK 争辩里{P}避重就轻，投他。',
  '听了双方争辩，{P}的解释没圆上，投他。',
  '{P}在 PK 里仍拿不出新证据，这票给他。',
  '争辩后我倾向{P}更可疑，投他。',
  '{P}的回答前后打架，PK 这票我给他。',
  'PK 里{P}只挑对自己有利的说，投他。',
  '综合争辩表现，{P}嫌疑最大。',
  '{P}不敢正面回应质疑，投他。',
  '按本轮争辩，{P}的说辞站不住脚。',
  'PK 阶段我看{P}更像狼，投他。',
];

/**
 * v2.4.5-B X2：强制补理由 + 承诺绑定 + 理由去重（撞模板换说法）。
 * - 理由必填：rawReason 为空 → 按承诺/改票/综合判断补一句，不允许空理由；
 * - 承诺优先：承诺了 X 却投 Y 且无理由 → 补"我改票了"明确理由；
 * - 理由去重（X1.4）：理由骨架与 recentVoteReasonWindow 撞模板 → 换 REASON_VARIANTS 里的说法。
 * - v2.4.9 任务6：PK 阶段（isTieDebate）优先用 PK 专用理由池，防"理由说完了/时间线对不上"跨天复用。
 * 返回 ≤40 字理由。
 */
export const ensureVoteReason = (targetName: string, rawReason: string, myLatestSpeech: string, names: string[], isTieDebate: boolean = false): string => {
  const committed = extractVoteCommitment(myLatestSpeech, names);
  let reason = (rawReason || '').trim();
  if (!reason) {
    if (committed && committed === targetName) {
      reason = `按承诺投${targetName}。`;
    } else if (committed) {
      reason = `我改票了，理由：${targetName}比${committed}更可疑。`;
    } else {
      reason = `综合判断，${targetName}嫌疑最大。`;
    }
  }
  const sk = sentenceSkeleton(reason, names);
  if (sk.length >= 4 && recentVoteReasonWindow.includes(sk)) {
    // v2.4.9 任务6：PK 阶段换说法优先用 PK 专用池（都撞再回退通用池）
    const pool = [...(isTieDebate ? PK_REASON_VARIANTS : []), ...REASON_VARIANTS];
    for (const variant of pool) {
      const v = truncateSpeech(variant.replace('{P}', targetName), 40);
      const vsk = sentenceSkeleton(v, names);
      if (!recentVoteReasonWindow.includes(vsk)) {
        reason = v;
        break;
      }
    }
  }
  const finalSk = sentenceSkeleton(reason, names);
  if (finalSk.length >= 4) {
    recentVoteReasonWindow.push(finalSk);
    if (recentVoteReasonWindow.length > 80) recentVoteReasonWindow.shift();
  }
  return truncateSpeech(reason, 40);
};

// v2.4 任务 A-4：投票返回结构 = 目标 + 理由（reason）
export interface VoteDecision {
  targetId: string;
  reason: string;
}

const emptyVote = (): VoteDecision => ({ targetId: '', reason: '' });

export const generateAIVoteDecision = async (
  config: AIConfig,
  role: Role,
  playerName: string,
  players: Player[],
  messages: Message[],
  gamePhase: string,
  day: number,
  tiePlayers: string[] = [],
  isInTieDebate: boolean = false,
  playerId?: string
): Promise<VoteDecision> => {
  if (isAborted) {
    addLog({
      type: 'warning',
      title: '游戏已中止',
      message: `${playerName} AI投票被中止`,
      playerName,
    });
    return emptyVote();
  }

  const player = players.find(p => p.name === playerName);
  const currentPlayerId = playerId || player?.id || '';
  const names = players.map((p) => p.name);

  // v2.4.5-B X2：本人最新发言（承诺绑定基准）——与 generateVotePrompt 的"言行一致"同口径
  const myLatestSpeech = messages
    .filter((m) => m.playerName === playerName && m.type !== 'system' && m.type !== 'wolf_chat')
    .map((m) => m.content.trim())
    .filter(Boolean)
    .pop() || '';

  /** v2.4.5-B X2：真实目标才强制理由（skip/无效目标不强补，qc 只统计真实投票） */
  const applyReason = (target: Player | null | undefined, rawReason: string): string => {
    if (!target) return (rawReason || '').trim();
    return ensureVoteReason(target.name, rawReason, myLatestSpeech, names, isInTieDebate);
  };

  if (thinkingCallback && currentPlayerId) {
    thinkingCallback(currentPlayerId, 30);
  }

  const isSiliconflow = config.apiType === 'siliconflow';
  const isDeepseek = config.apiType === 'deepseek';
  const siliconflowConfig = config.siliconflow;
  const deepseekConfig = config.deepseek;
  const localConfig = config.local;
  
  const useBuiltinResponses = (isSiliconflow && (!siliconflowConfig.apiKey || siliconflowConfig.apiKey.trim() === '')) ||
                              (isDeepseek && (!deepseekConfig.apiKey || deepseekConfig.apiKey.trim() === ''));

  if (useBuiltinResponses) {
    addLog({
      type: 'info',
      title: '使用随机投票',
      message: `${playerName}(${getRoleInfo(role).name}) 使用随机投票`,
      playerName,
    });
    const alivePlayers = players.filter((p) => p.isAlive);
    // v2.4 任务 A-3：PK 阶段也不能投自己（候选人不能投自己）
    const validTargets = isInTieDebate 
      ? alivePlayers.filter(p => tiePlayers.includes(p.id) && p.id !== player?.id)
      : alivePlayers.filter(p => p.id !== player?.id);
    
    if (validTargets.length === 0) return emptyVote();
    const builtinTarget = validTargets[Math.floor(Math.random() * validTargets.length)];
    // v2.4.5-B X2：内置投票同样不产生无理由票
    return { targetId: builtinTarget?.id || '', reason: applyReason(builtinTarget, '') };
  }

  const startTime = Date.now();
  let duration = 0;
  let apiUrl: string;
  if (isSiliconflow) {
    apiUrl = 'https://api.siliconflow.cn/v1/chat/completions';
  } else if (isDeepseek) {
    apiUrl = 'https://api.deepseek.com/v1/chat/completions';
  } else {
    if (localConfig.apiUrl.startsWith('http://localhost') || localConfig.apiUrl.startsWith('http://127.0.0.1')) {
      apiUrl = localConfig.apiUrl.replace('http://localhost:1234', '/api/lm-studio').replace('http://127.0.0.1:1234', '/api/lm-studio');
    } else {
      apiUrl = localConfig.apiUrl;
    }
  }

  addLog({
    type: 'api',
    title: '开始AI投票分析',
    message: `${playerName}(${getRoleInfo(role).name}) 正在分析投票目标`,
    playerName,
    apiEndpoint: apiUrl,
  });

  try {
    const { system, user } = generateVotePrompt({
      role,
      playerName,
      players,
      messages,
      gamePhase,
      day,
      tiePlayers,
      isInTieDebate,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (isSiliconflow && siliconflowConfig.apiKey) {
      headers['Authorization'] = `Bearer ${siliconflowConfig.apiKey}`;
    } else if (isDeepseek && deepseekConfig.apiKey) {
      headers['Authorization'] = `Bearer ${deepseekConfig.apiKey}`;
    } else if (localConfig.apiKey) {
      headers['Authorization'] = `Bearer ${localConfig.apiKey}`;
    }

    const response = await withRetry(
      () => fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: isSiliconflow ? siliconflowConfig.model : isDeepseek ? deepseekConfig.model : localConfig.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: Math.max(isDeepseek ? deepseekConfig.temperature : 0.7, 0.9),
          // v2.4 任务 A-4：投票需要输出目标+理由两行，max_tokens 从 50 提升到 120
          max_tokens: 120,
        }),
      }),
      AI_RETRY_COUNT,
      (attempt, error) => {
        addLog({
          type: 'warning',
          title: 'AI投票重试',
          message: `${playerName} 投票API失败，第${attempt}次重试: ${error instanceof Error ? error.message : '未知错误'}`,
          playerName,
          apiEndpoint: apiUrl,
          duration: Date.now() - startTime,
        });
      }
    );

    duration = Date.now() - startTime;

    if (!response.ok) {
      addLog({
        type: 'error',
        title: 'AI投票分析失败',
        message: `${playerName} 投票API请求失败，状态码: ${response.status}`,
        playerName,
        apiEndpoint: apiUrl,
        duration,
      });
      throw new Error('API请求失败');
    }

    const data = await response.json();
    const rawContent = data.choices[0].message.content.trim();
    const lines = rawContent.split('\n').map((l) => l.trim()).filter(Boolean);
    let targetName = lines[0] || '';
    // v2.4 任务 A-4：第二行起为理由（去掉可能的前缀"理由："）；v2.4.4 任务 A：理由 ≤40 字截断
    const reason = truncateSpeech(lines.slice(1).join('，').replace(/^(理由|原因)[:：]\s*/, '').trim(), 40);
    
    if (targetName === '跳过' || targetName === '弃票') {
      if (isInTieDebate) {
        // 任务2：平票加投（PK）阶段禁止弃票，回退为随机投给平票玩家之一
        addLog({
          type: 'warning',
          title: 'AI投票异常',
          message: `${playerName} 在平票加投阶段输出"跳过"，已改为随机投给平票玩家`,
          playerName,
          apiEndpoint: apiUrl,
          duration,
        });
        const alivePlayers = players.filter((p) => p.isAlive);
        const validTargets = alivePlayers.filter(p => tiePlayers.includes(p.id) && p.id !== player?.id);
        if (removeThinkingCallback && currentPlayerId) {
          removeThinkingCallback(currentPlayerId);
        }
        if (validTargets.length === 0) return emptyVote();
        const pkFallbackTarget = validTargets[Math.floor(Math.random() * validTargets.length)];
        // v2.4.5-B X2：PK 回退同样不产生无理由票
        return { targetId: pkFallbackTarget?.id || '', reason: applyReason(pkFallbackTarget, '') };
      }

      addLog({
        type: 'success',
        title: 'AI投票完成',
        message: `${playerName} 选择弃票`,
        playerName,
        apiEndpoint: apiUrl,
        duration,
      });
      
      if (removeThinkingCallback && currentPlayerId) {
        removeThinkingCallback(currentPlayerId);
      }
      return { targetId: 'skip', reason };
    }

    let target = players.find((p) =>
      p.name === targetName ||
      p.name.includes(targetName) ||
      targetName.includes(p.name)
    );

    // v2.4 任务 A-3：PK 投票排除投自己（候选人不能投自己）
    if (isInTieDebate && target && player && target.id === player.id) {
      addLog({
        type: 'warning',
        title: 'AI投票异常',
        message: `${playerName} 在平票加投阶段投给了自己，已改为随机投给其他平票玩家`,
        playerName,
        apiEndpoint: apiUrl,
        duration,
      });
      const tieOthers = players.filter(p => p.isAlive && tiePlayers.includes(p.id) && p.id !== player.id);
      if (tieOthers.length > 0) {
        target = tieOthers[Math.floor(Math.random() * tieOthers.length)];
        targetName = target.name;
      } else {
        target = null;
      }
    }

    // 任务2：平票加投阶段，AI 不能投给平票玩家之外的任何人
    if (isInTieDebate && target && !tiePlayers.includes(target.id)) {
      addLog({
        type: 'warning',
        title: 'AI投票异常',
        message: `${playerName} 在平票加投阶段投给了非平票玩家，已改为随机投给平票玩家`,
        playerName,
        apiEndpoint: apiUrl,
        duration,
        details: `目标: ${target.name}`,
      });
        const alivePlayers = players.filter((p) => p.isAlive);
        const validTargets = alivePlayers.filter(p => tiePlayers.includes(p.id) && p.id !== player?.id);
        if (removeThinkingCallback && currentPlayerId) {
          removeThinkingCallback(currentPlayerId);
        }
        if (validTargets.length === 0) return emptyVote();
        const tieCorrectionTarget = validTargets[Math.floor(Math.random() * validTargets.length)];
        // v2.4.5-B X2：PK 阶段纠正投错目标后同样不产生无理由票
        return { targetId: tieCorrectionTarget?.id || '', reason: applyReason(tieCorrectionTarget, '') };
      }

    addLog({
      type: 'success',
      title: 'AI投票完成',
      message: `${playerName} 投票给: ${targetName}`,
      playerName,
      apiEndpoint: apiUrl,
      duration,
      details: `目标: ${target?.name || '未匹配到'}${reason ? ` | 理由: ${reason}` : ''}`,
    });

    if (removeThinkingCallback && currentPlayerId) {
      removeThinkingCallback(currentPlayerId);
    }

    // v2.4.5-B X2：最终返回同样保证理由必填 + 去重
    return { targetId: target?.id || '', reason: applyReason(target, reason) };
  } catch (error) {
    const duration = Date.now() - startTime;
    addLog({
      type: 'error',
      title: 'AI投票异常',
      message: `${playerName} 投票异常: ${error instanceof Error ? error.message : '未知错误'}`,
      playerName,
      apiEndpoint: apiUrl,
      duration,
    });
    console.error('AI投票失败:', error);
    
    const alivePlayers = players.filter((p) => p.isAlive);
    const validTargets = isInTieDebate 
      ? alivePlayers.filter(p => tiePlayers.includes(p.id) && p.id !== player?.id)
      : alivePlayers.filter(p => p.id !== player?.id);
    
    if (validTargets.length === 0) return emptyVote();
    const errFallbackTarget = validTargets[Math.floor(Math.random() * validTargets.length)];
    // v2.4.5-B X2：异常回退同样不产生无理由票
    return { targetId: errFallbackTarget?.id || '', reason: applyReason(errFallbackTarget, '') };
  }
};

export const generateAIThought = async (
  config: AIConfig,
  role: Role,
  playerName: string,
  players: Player[],
  messages: Message[],
  gamePhase: string,
  day: number,
  nightActions?: NightAction[],
  gameHistory?: GameHistory,
  playerId?: string,
  witchAntidoteUsed?: boolean // N6：女巫解药是否已使用
): Promise<string> => {
  if (isAborted) {
    addLog({
      type: 'warning',
      title: '游戏已中止',
      message: `${playerName} AI思考被中止`,
      playerName,
    });
    return '';
  }

  const player = players.find(p => p.name === playerName);
  const currentPlayerId = playerId || player?.id || '';
  
  if (thinkingCallback && currentPlayerId) {
    thinkingCallback(currentPlayerId, 30);
  }

  // 根据API类型选择配置
  const isSiliconflow = config.apiType === 'siliconflow';
  const isDeepseek = config.apiType === 'deepseek';
  const siliconflowConfig = config.siliconflow;
  const deepseekConfig = config.deepseek;
  const localConfig = config.local;
  
  // 检查是否使用内置回复（无API Key时）
  const useBuiltinResponses = (isSiliconflow && (!siliconflowConfig.apiKey || siliconflowConfig.apiKey.trim() === '')) ||
                              (isDeepseek && (!deepseekConfig.apiKey || deepseekConfig.apiKey.trim() === ''));

  if (useBuiltinResponses) {
    addLog({
      type: 'info',
      title: '使用随机选择',
      message: `${playerName}(${getRoleInfo(role).name}) 使用随机目标选择`,
      playerName,
    });
    const targets = players.filter((p) => p.isAlive && p.name !== playerName);
    return targets[Math.floor(Math.random() * targets.length)]?.id || '';
  }

  const startTime = Date.now();
  // 根据配置选择 API 端点
  let apiUrl: string;
  if (isSiliconflow) {
    apiUrl = 'https://api.siliconflow.cn/v1/chat/completions';
  } else if (isDeepseek) {
    apiUrl = 'https://api.deepseek.com/v1/chat/completions';
  } else {
    if (localConfig.apiUrl.startsWith('http://localhost') || localConfig.apiUrl.startsWith('http://127.0.0.1')) {
      // 本地地址使用代理
      apiUrl = localConfig.apiUrl.replace('http://localhost:1234', '/api/lm-studio').replace('http://127.0.0.1:1234', '/api/lm-studio');
    } else {
      apiUrl = localConfig.apiUrl;
    }
  }

  addLog({
    type: 'api',
    title: '开始AI思考',
    message: `${playerName}(${getRoleInfo(role).name}) 正在分析局面选择目标`,
    playerName,
    apiEndpoint: apiUrl,
  });

  try {
    const { system, user } = generateNightPrompt({
      role,
      playerName,
      players,
      messages,
      gamePhase,
      day,
      nightActions,
      gameHistory,
      witchAntidoteUsed,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // 如果是硅基流动 API，添加授权头
    if (isSiliconflow && siliconflowConfig.apiKey) {
      headers['Authorization'] = `Bearer ${siliconflowConfig.apiKey}`;
    } else if (isDeepseek && deepseekConfig.apiKey) {
      headers['Authorization'] = `Bearer ${deepseekConfig.apiKey}`;
    } else if (localConfig.apiKey) {
      headers['Authorization'] = `Bearer ${localConfig.apiKey}`;
    }

    const response = await withRetry(
      () => fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: isSiliconflow ? siliconflowConfig.model : localConfig.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.3,
          max_tokens: 30,
        }),
      }),
      AI_RETRY_COUNT,
      (attempt, error) => {
        addLog({
          type: 'warning',
          title: 'AI思考重试',
          message: `${playerName} 思考API失败，第${attempt}次重试: ${error instanceof Error ? error.message : '未知错误'}`,
          playerName,
          apiEndpoint: apiUrl,
        });
      }
    );

    const duration = Date.now() - startTime;

    if (!response.ok) {
      addLog({
        type: 'error',
        title: 'AI思考失败',
        message: `${playerName} 思考API请求失败，状态码: ${response.status}`,
        playerName,
        apiEndpoint: apiUrl,
        duration,
      });
      throw new Error('API请求失败');
    }

    const data = await response.json();
    let targetName = data.choices[0].message.content.trim();
    
    // 根据角色解析不同的输出格式
    if (role === 'seer') {
      // 预言家格式: "预言家查验: 小明"
      const seerMatch = targetName.match(/预言家查验:\s*(\S+)/);
      if (seerMatch) {
        targetName = seerMatch[1];
      } else {
        // 如果没有匹配到格式，取第一行
        targetName = targetName.split('\n')[0].trim();
      }
    } else if (role === 'witch') {
      // 女巫特殊处理：直接返回原始的AI响应，让 GameRoom.tsx 来解析
      // 这样可以避免重复处理的问题
      if (removeThinkingCallback && currentPlayerId) {
        removeThinkingCallback(currentPlayerId);
      }
      return targetName;
    } else {
      // 默认：取第一行
      targetName = targetName.split('\n')[0].trim();
    }
    
    const target = players.find((p) =>
      p.name === targetName ||
      p.name.includes(targetName) ||
      targetName.includes(p.name)
    );

    // 通用的日志（除了女巫以外的角色）
    addLog({
      type: 'success',
      title: 'AI思考完成',
      message: `${playerName} 选择目标: ${targetName}`,
      playerName,
      apiEndpoint: apiUrl,
      duration,
      details: `目标: ${target?.name || '未匹配到'}`,
    });

    if (removeThinkingCallback && currentPlayerId) {
      removeThinkingCallback(currentPlayerId);
    }

    return target?.id || '';
  } catch (error) {
    const duration = Date.now() - startTime;
    addLog({
      type: 'error',
      title: 'AI思考异常',
      message: `${playerName} 思考异常: ${error instanceof Error ? error.message : '未知错误'}`,
      playerName,
      apiEndpoint: apiUrl,
      duration,
    });
    console.error('AI思考失败:', error);
    const targets = players.filter((p) => p.isAlive && p.name !== playerName);
    return targets[Math.floor(Math.random() * targets.length)]?.id || '';
  }
};
