/**
 * test-drive.ts — 狼人杀 AI 对局自动化试跑（QC 数据源，NEXT_VERSION_PLAN_v2.md D 项）
 *
 * v3.0 阶段 0b 改造（审查 §4 坑 13 消除）：
 * 不再「独立复刻规则自跑循环」，改为 **headless 直接驱动真实 server/engine.ts**——
 * 本文件只提供 mock AI（模板回复），规则（夜晚/白天/投票/PK/遗言/猎人/胜负/存档）全由
 * RoomEngine 真实实现驱动。规则一改，test-drive 无需跟改（消除第三套实现）。
 *
 * 事件输出格式与旧版对齐（qc.py 解析不变）：
 *   - 完整发言：第N天 X: 全文（轮次/自由讨论；来源写入结构化日志 source）
 *   - PK 争辩：第N天 PK X: 全文
 *   - 投票：第N天 X 投→Y（理由：...） / 第N天 X PK投→Y（理由：...）
 *   - 遗言：第N天 X 遗言: ...
 *   - 死讯/出局：从 engine 广播的 system 消息透传（【公告】...，格式与 qc.py 对拍）
 *   - 夜晚：第N晚 狼人刀杀 X / 守卫守护 X / 预言家查验 X → 狼|好人 / 女巫解药救 X
 *   - 自由讨论事件：第N天[自由讨论] ...
 *   - 防复读拦截：第N天[防复读拦截] ...
 *
 * 运行（模板模式）：
 *   npm run qc:run          → node scripts/qc-run.mjs（tsx 直跑，驱动真实 engine）
 * 运行（真实 AI 模式，需 tsx）：
 *   npm run qc:real 12      → npx tsx test-drive.ts 12 --real
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { RoomEngine, type EngineAIAdapter, type EngineHub } from './server/engine';
import { getAlivePlayers } from './shared/gameLogic';
import type { AIConfig, Player, Role, Message, NightAction } from './shared/types';
import type { ArchiveRecord } from './shared/protocol';
import { PERSONAS, getPlayerMemory } from './shared/memorySystem';
import { AI_DEFAULTS } from './shared/config/aiDefaults';

const args = process.argv.slice(2);
const REAL = args.includes('--real');
const countArg = args.find((a) => /^\d+$/.test(a));
const PLAYER_COUNT = Math.min(Math.max(Number(countArg) || 12, 4), 12);

// 可复现伪随机（mulberry32）；可用环境变量 WW_SEED 覆盖
const seedEnv = Number(process.env.WW_SEED);
let seed = Number.isFinite(seedEnv) ? seedEnv : 20260811;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pickOne = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;

let players: Player[] = [];
let playerPersona: Record<string, string> = {};

/* ==================== 模板模式内置回复（QC 用） ==================== */
const PERSONA_OPENERS: Record<string, string> = {
  人设1: '按逻辑推，',
  人设2: '嗯，大家别急，',
  人设3: '',
  人设4: '我说直觉啊，',
  人设5: '对一下时间线，',
  人设6: '话到这儿，',
  人设7: '按常理来看，',
  人设8: '这事就像下棋，',
  人设9: '两边都有可能，',
  人设10: '你倒是说说，',
  人设11: '我还是那句，',
  人设12: '别绕了，',
};

let usedTemplatesToday = new Set<number>();
const pickTemplateIndex = (styles: string[]): number => {
  if (usedTemplatesToday.size < styles.length) {
    const available = styles.map((_, i) => i).filter((i) => !usedTemplatesToday.has(i));
    const idx = available[Math.floor(rand() * available.length)];
    usedTemplatesToday.add(idx);
    return idx;
  }
  const idx = Math.floor(rand() * styles.length);
  usedTemplatesToday.add(idx);
  return idx;
};

const PREFIX_QUIRK_RE = /^(我觉得|我觉着|我感觉|个人觉得|说真的|说实话|讲道理|说句实话|坦白说|讲真|总之|反正|毕竟|其实|不过|但是|然而|可是|话说|对了|另外|再者|说起来|简单说|直说|说白了|真的|确实|嗯|唔|诶|呃|哎|唉|哈|呵呵|哈哈)\s*[,，、:：]?\s*/;
let usedSkeletonsToday = new Set<string>();
let templateUsageToday: number[] = [];
const templateNorm = (text: string): string => {
  let t = text.replace(PREFIX_QUIRK_RE, '');
  const names = getAlivePlayers(players).map((p) => p.name);
  [...names].sort((a, b) => b.length - a.length).forEach((n) => { t = t.split(n).join('{P}'); });
  return t.replace(/[\s，。！？、；：（）“”"'·…—\-:：,.!?;《》【】]+/g, '');
};

const skeletonSimilarity = (a: string, b: string): number => {
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

let usedSimSkeletonsToday: string[] = [];
const playerSimSkeletons: Record<string, string[]> = {};

const pickTemplate = (styles: string[]): string => {
  if (usedTemplatesToday.size < styles.length) {
    const idx = pickTemplateIndex(styles);
    templateUsageToday[idx] = (templateUsageToday[idx] || 0) + 1;
    usedSkeletonsToday.add(templateNorm(styles[idx]));
    return styles[idx];
  }
  let bestIdx = 0;
  let bestCount = Infinity;
  for (let i = 0; i < styles.length; i++) {
    if (!usedSkeletonsToday.has(templateNorm(styles[i]))) {
      bestIdx = i;
      bestCount = -1;
      break;
    }
    const cnt = templateUsageToday[i] || 0;
    if (cnt < bestCount) {
      bestCount = cnt;
      bestIdx = i;
    }
  }
  templateUsageToday[bestIdx] = (templateUsageToday[bestIdx] || 0) + 1;
  usedSkeletonsToday.add(templateNorm(styles[bestIdx]));
  return styles[bestIdx];
};

const genSpeech = (p: Player, day: number): string => {
  const aliveOthers = getAlivePlayers(players).filter((x) => x.id !== p.id);
  if (aliveOthers.length === 0) return '我觉得局势已经很清楚了，大家按逻辑来就好。';
  const target = pickOne(aliveOthers);
  const styles = [
    `我觉得${target.name}今天发言有点问题，说他逻辑对不上吧，又说不出个所以然，我怀疑他是狼。`,
    `${target.name}这轮一直绕来绕去，说白了就是在混。我越想越觉得他可疑，建议投他。`,
    `讲道理，${target.name}的票型很怪，一上来就跟着带节奏，这不是嫁祸是什么。`,
    `${target.name}刚才那几句来回变，越听越不对劲，我看他就是狼。`,
    `说不上来哪不对，但${target.name}这两天老躲着话题，我就是觉得他可疑。`,
    `不好说，再看两轮也行。不过${target.name}那发言，我是真不信。`,
    `${target.name}上一轮和这一轮完全两个说法，这逻辑能圆回去？我投他。`,
    `对，我也觉得${target.name}不太对劲，他说投谁我就跟谁。`,
    `我信息少，先听别人说吧。不过${target.name}，别让我抓住你。`,
    `行，我直说了，${target.name}嫌疑最大，这轮带票投他。`,
    `先放放吧，我还没想好。${target.name}那两句倒是让我记下了。`,
    `嗯，${target.name}今天话多但全是空话，这种最像狼。`,
    `我信息太少，这轮我不做判断了，你们看着投吧。`,
    `我先表个态，今天会重点关注${target.name}。他前面的话和现在的票，我得先对一下。`,
    `${target.name}今天的说法和我记的不一样，是记忆出问题还是说谎，你解释一下。`,
    `我不太喜欢${target.name}这种打法，把自己藏得很深，关键时刻一句话都不说。`,
    `要说嫌疑，我第一个想到${target.name}。从发言到投票，他的路线就没干净过。`,
    `${target.name}总在别人被踩的时候插嘴打圆场，护得这么明显，我记下了。`,
    `大家别吵，先把${target.name}刚才说的和他现在说的对一遍，对不上就有意思了。`,
    `我投${target.name}。不是因为他多可疑，是他今天一直在转移话题，这最危险。`,
    `${target.name}的票总跟在某人后面，一点自己的想法都没有，这不正常。`,
    `今天信息不多，但${target.name}刚才那几句，明显在给谁打掩护，我盯上他了。`,
    `我建议先把${target.name}放一放，他状态确实不好说，我主要怀疑刚才那个改口的。`,
    `${target.name}的发言有个毛病，每次被问到细节就绕圈子，这很狼。`,
    `别看我，我还在理时间线。不过${target.name}那票，我是真看不懂。`,
    `${target.name}说自己信息少，可盘起别人的狼坑来头头是道，这不矛盾吗。`,
    `先说结论：${target.name}在装。他答非所问好几次了，装得很明显。`,
    `${target.name}今天一上来就给我扣帽子，说我带节奏，反应比谁都快，有意思。`,
    `我注意到${target.name}对每个人都笑呵呵，从不得罪人，这种谁都不得罪的最可疑。`,
    `要说谁在搅混水，我看就是${target.name}。他每个话题都能插一脚，但从不给结论。`,
    `${target.name}说自己没什么好说的，可投票时倒是很积极，这不是自相矛盾么。`,
    `我今天不打算轻易放过${target.name}，他前面的解释太牵强了，再想想都圆不上。`,
    `盘了一圈，最让我放不下的还是${target.name}。他今天安静得反常。`,
    `我本来没怀疑${target.name}，但他刚才急着打断别人说话，像在堵嘴。`,
    `${target.name}说投谁都行，可自己手里那票掂量得很清楚，这就不对了。`,
    `我承认${target.name}分析得头头是道，但太完美了，反而像提前准备好的。`,
    `别急着投，先把${target.name}那句"我没信息"掰开看看，他真有这么干净？`,
    `我对${target.name}的怀疑不是没有根据的，他这两轮就在划水，今天更不能放过。`,
    `${target.name}每轮发言都换一个说法，立场跟水一样，这种骑墙的最危险。`,
    `大家都盯着${target.name}吧，他刚才那声干笑，心虚得很。`,
  ];
  const myHistory = playerSimSkeletons[p.name] || [];
  let base = pickTemplate(styles);
  for (let attempt = 0; attempt < 2; attempt++) {
    const sk = templateNorm(base);
    const collideToday = usedSimSkeletonsToday.some((u) => skeletonSimilarity(u, sk) >= 0.6);
    const collideSelf = myHistory.some((u) => skeletonSimilarity(u, sk) >= 0.6);
    if (!collideToday && !collideSelf) break;
    const skShow = sk.length > 16 ? `${sk.slice(0, 16)}…` : sk;
    base = pickTemplate(styles);
  }
  const finalSk = templateNorm(base);
  usedSimSkeletonsToday.push(finalSk);
  if (!playerSimSkeletons[p.name]) playerSimSkeletons[p.name] = [];
  playerSimSkeletons[p.name].push(finalSk);
  const opener = PERSONA_OPENERS[playerPersona[p.name] || ''] || '';
  return opener && chance(0.35) ? `${opener}${base}` : base;
};

interface RealHistory {
  nightResults: Array<{ day: number; killed?: string; healed?: string; poisoned?: string; checked?: { target: string; result: string }; guarded?: string }>;
  deadPlayers: Array<{ name: string; role: Role; day: number; reason: string }>;
  skillUsage: Record<string, Record<string, { result: string }>>;
  playerKnowledge?: Record<string, { name: string; suspiciousLevel: number; checkResults?: Array<{ day: number; result: string }>; votes?: Array<{ day: number; target: string }> }>;
  situationSummary?: string;
}

const newRealHistory = (): RealHistory => ({ nightResults: [], deadPlayers: [], skillUsage: {} });

const genSortingSpeech = (p: Player, day: number, rh: RealHistory): string => {
  const dead = (rh.deadPlayers || []).filter((d) => d.day <= day).map((d) => d.name);
  const deadStr = dead.length ? dead.join('、') : '还没有人出局';
  const voterStrs: string[] = [];
  if (rh.playerKnowledge) {
    Object.entries(rh.playerKnowledge).forEach(([name, k]) => {
      if (k.votes && k.votes.length) voterStrs.push(`${name}投→${k.votes.map((v) => v.target).join('/')}`);
    });
  }
  const voteStr = voterStrs.length ? `票型上${voterStrs.slice(0, 3).join('，')}` : '票型还看不出明显的带票节奏';
  const sortTails = [
    `谁之前的话和今天的票对不上、谁一被追问就改口，这些人狼面最大。今天先别急着投，把时间线对一遍再决定，我先不点死谁。`,
    `对照下来，票型和时间线才是硬依据，谁前后矛盾、谁在被问时改口，狼面就往谁身上收。这轮先不锁票，等人把话讲完再归。`,
    `把已知信息拼完，剩下最大的疑点集中在发言前后不一致和带票节奏上。我先不急着定人，等下一轮票型再收窄。`,
  ];
  const tail = sortTails[(day + p.name.length) % sortTails.length];
  return (
    `我给大家捋一下：到现在倒了${deadStr}。${voteStr}。` +
    tail
  );
};

const REASON_COMMIT = [
  '{P}发言破绽明显，我按发言承诺投他。',
  '按承诺投{P}，他今天逻辑漏洞太多。',
  '我早就点了{P}，这票兑现承诺。',
];
const REASON_CHANGE = [
  '综合票型判断，{P}更可疑，我改票跟投。',
  '跟投{P}，理由是他一直在带节奏。',
  '我改票了，{P}的时间线前后矛盾。',
  '直觉上{P}不对劲，我投他。',
  '{P}今天的发言前后不一，我投他。',
];
let usedReasonTemplatesToday = new Set<number>();

const decideVote = (p: Player, speeches: Map<string, string>): { target: string; reason: string } => {
  const aliveOthers = getAlivePlayers(players).filter((x) => x.id !== p.id);
  if (aliveOthers.length === 0) return { target: 'skip', reason: '无存活可投对象' };
  const lastSpeech = speeches.get(p.id) || '';
  const mentioned = aliveOthers.find(
    (x) => /怀疑|像狼|可疑|投|不对劲|嫌疑|逻辑对不上/.test(lastSpeech) && lastSpeech.includes(x.name)
  );
  const t = mentioned && chance(0.65) ? mentioned : pickOne(aliveOthers);
  const followsCommit = mentioned ? (t === mentioned && /投/.test(lastSpeech)) : false;
  const targetName = t.name;
  const pool = followsCommit ? REASON_COMMIT : REASON_CHANGE;
  const avail = pool.map((_, i) => i).filter((i) => !usedReasonTemplatesToday.has(i));
  const idx = avail.length > 0 ? avail[Math.floor(rand() * avail.length)] : Math.floor(rand() * pool.length);
  usedReasonTemplatesToday.add(idx);
  return { target: targetName, reason: pool[idx].replace('{P}', targetName) };
};

const truncateSpeech = (text: string, max: number): string => {
  const t = (text || '').trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const boundary = Math.max(
    slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'),
    slice.lastIndexOf('…'), slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?')
  );
  if (boundary >= max * 0.4) return slice.slice(0, boundary + 1).trim();
  return slice.trim();
};

const genLastWords = async (p: Player, day: number, rh: RealHistory): Promise<string> => {
  if (REAL && ai) {
    try {
      const resp = await ai.callAIApi(aiConfig!, p.role!, p.name, players, [], '遗言', day, [], rh, p.id);
      if (resp && resp.trim() && !/^游戏已中止/.test(resp)) return truncateSpeech(resp.trim(), 80);
    } catch {
      /* 回退模板 */
    }
  }
  const aliveOthers = getAlivePlayers(players).filter((x) => x.id !== p.id);
  const suspect = aliveOthers.length > 0 ? pickOne(aliveOthers).name : '某人';
  const templates = [
    `我是好人，被投错我认了。但${suspect}今天的发言有问题，大家仔细盘他，别让狼人笑到最后。`,
    `最后说一句：${suspect}一直在带节奏，我怀疑他是狼。票型大家自己看，别被牵着走。`,
    `我信息少，但不信${suspect}。我走了之后，谁接棒盘他，好人要团结。`,
  ];
  return truncateSpeech(pickOne(templates), 80);
};

/* ==================== --real 模式：真实 AI 调用（aiClient） ==================== */

type RealAI = {
  callAIApi: (config: AIConfig, role: Role, playerName: string, players: Player[], messages: Message[], gamePhase: string, day: number, nightActions?: NightAction[], gameHistory?: unknown, currentSpeaker?: string, speakerOrder?: string[], wolfDiscussionRound?: number, playerId?: string, customUserPrompt?: string, isSorter?: boolean) => Promise<string>;
  generateAIVoteDecision: (config: AIConfig, role: Role, playerName: string, players: Player[], messages: Message[], gamePhase: string, day: number, tiePlayers?: string[], isInTieDebate?: boolean, playerId?: string) => Promise<{ targetId: string; reason: string }>;
  generateAIThought: (config: AIConfig, role: Role, playerName: string, players: Player[], messages: Message[], gamePhase: string, day: number, nightActions?: NightAction[], gameHistory?: unknown, playerId?: string, witchAntidoteUsed?: boolean) => Promise<string>;
};

let ai: RealAI | null = null;
let aiConfig: AIConfig | null = null;

const TEST_DRIVE_AI_DEFAULTS: AIConfig = {
  ...AI_DEFAULTS,
  siliconflow: { ...AI_DEFAULTS.siliconflow },
  deepseek: { ...AI_DEFAULTS.deepseek },
  local: {
    ...AI_DEFAULTS.local,
    apiKey: '',
    model: 'gpt-5.6-luna',
    apiUrl: 'https://api.lingll.icu/v1/chat/completions',
  },
};

const loadRealConfig = (): AIConfig | null => {
  let cfg: AIConfig | null = null;
  const cfgPath = path.join(process.cwd(), 'test-ai-config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Partial<AIConfig>;
      cfg = {
        ...TEST_DRIVE_AI_DEFAULTS,
        ...raw,
        siliconflow: { ...TEST_DRIVE_AI_DEFAULTS.siliconflow, ...raw.siliconflow },
        deepseek: { ...TEST_DRIVE_AI_DEFAULTS.deepseek, ...raw.deepseek },
        local: { ...TEST_DRIVE_AI_DEFAULTS.local, ...raw.local },
      };
    } catch (e) {
      console.warn('[real] 解析 test-ai-config.json 失败，尝试环境变量:', e);
    }
  }
  const apiType = process.env.WW_API_TYPE || cfg?.apiType;
  const apiKey = process.env.WW_API_KEY;
  if (!cfg && (!apiType || !apiKey)) return null;
  cfg ??= {
    ...TEST_DRIVE_AI_DEFAULTS,
    apiType: apiType as AIConfig['apiType'],
    siliconflow: { ...TEST_DRIVE_AI_DEFAULTS.siliconflow },
    deepseek: { ...TEST_DRIVE_AI_DEFAULTS.deepseek },
    local: { ...TEST_DRIVE_AI_DEFAULTS.local },
  };
  if (apiType) cfg.apiType = apiType as AIConfig['apiType'];
  if (apiKey) {
    if (cfg.apiType === 'deepseek') cfg.deepseek.apiKey = apiKey;
    else if (cfg.apiType === 'siliconflow') cfg.siliconflow.apiKey = apiKey;
    else cfg.local.apiKey = apiKey;
  }
  if (process.env.WW_MODEL) {
    if (cfg.apiType === 'deepseek') cfg.deepseek.model = process.env.WW_MODEL;
    else if (cfg.apiType === 'siliconflow') cfg.siliconflow.model = process.env.WW_MODEL;
    else cfg.local.model = process.env.WW_MODEL;
  }
  const hasActiveKey = cfg.apiType === 'deepseek'
    ? Boolean(cfg.deepseek.apiKey.trim())
    : cfg.apiType === 'siliconflow'
      ? Boolean(cfg.siliconflow.apiKey.trim())
      : Boolean(cfg.local.apiKey.trim());
  const localAllowsAnonymous = cfg.apiType === 'local'
    && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(cfg.local.apiUrl);
  if (!hasActiveKey && !localAllowsAnonymous) return null;
  return cfg;
};

/** 动态加载 aiClient（仅在 --real 下执行） */
const loadRealAI = async (): Promise<RealAI | null> => {
  try {
    const p = path.join(process.cwd(), 'shared', 'aiClient.ts');
    const mod = (await import(pathToFileURL(p).href)) as unknown as RealAI;
    if (mod && typeof mod.callAIApi === 'function') return mod;
    return null;
  } catch (e) {
    console.warn('[real] 无法加载 shared/aiClient.ts，回退模板模式:', e instanceof Error ? e.message : e);
    return null;
  }
};

/* ==================== headless 驱动真实 engine ==================== */

/** 注入给 RoomEngine 的 AI 适配器：模板模式下用内置模板，real 模式下委托真实 aiClient */
const makeAdapter = (): EngineAIAdapter => {
  // 白天发言每天重设防复读/模板采样状态
  let lastDay = -1;
  const speechesToday = new Map<string, string>();

  const ensureDayState = (day: number) => {
    if (day !== lastDay) {
      lastDay = day;
      usedTemplatesToday = new Set();
      usedSkeletonsToday = new Set();
      templateUsageToday = [];
      usedSimSkeletonsToday = [];
      usedReasonTemplatesToday = new Set();
    }
  };

  return {
    resetExperienceCache() {},
    resetSpeechRepeatCache() {},
    source: REAL && ai ? 'real_ai' : 'template',

    async callAIApi(
      config, role, playerName, playersIn, messagesIn, gamePhase, day,
      _nightActions, _gameHistory, _currentSpeaker, _speakerOrder, _wolfRound, _playerId, _customUserPrompt, isSorter
    ) {
      players = playersIn;
      if (players.length && Object.keys(playerPersona).length === 0) {
        playerPersona = {};
        players.forEach((p, i) => {
          if (REAL) {
            const mem = getPlayerMemory(p.name);
            playerPersona[p.name] = mem?.persona.name || '';
          } else {
            playerPersona[p.name] = PERSONAS[(i * 5 + 3) % PERSONAS.length].name;
          }
        });
      }
      ensureDayState(day);

      if (gamePhase === '狼人讨论') {
        // 狼人讨论：真实 AI 走真实调用；模板模式输出含 {目标}（engine aiWolfVoteTarget 解析）
        if (REAL && ai) {
          return await ai.callAIApi(aiConfig ?? config, role, playerName, playersIn, messagesIn, gamePhase, day, _nightActions, _gameHistory, _currentSpeaker, _speakerOrder, _wolfRound, _playerId, _customUserPrompt, isSorter);
        }
        const aliveOthers = getAlivePlayers(playersIn).filter((x) => x.id !== undefined && x.name !== playerName && x.isAlive);
        const target = aliveOthers.length ? pickOne(aliveOthers) : null;
        if (target) {
          return `我觉得{${target.name}}今天的节奏最带偏，建议这轮刀他，理由是他发言和票型都对不上。`;
        }
        return '我信息少，先听大家分析。';
      }

      if (gamePhase === '白天发言' || gamePhase === '自由讨论') {
        if (REAL && ai) {
          const resp = await ai.callAIApi(aiConfig ?? config, role, playerName, playersIn, messagesIn, gamePhase, day, _nightActions, _gameHistory, _currentSpeaker, _speakerOrder, _wolfRound, _playerId, _customUserPrompt, isSorter);
          const text = (resp || '').trim();
          if (text && !/^游戏已中止/.test(text)) {
            speechesToday.set(_playerId || playerName, text);
          }
          return text;
        }
        const p = playersIn.find((x) => x.name === playerName);
        const rh = newRealHistory();
        const speech = isSorter ? genSortingSpeech(p || playersIn[0], day, rh) : genSpeech(p || playersIn[0], day);
        const truncated = truncateSpeech(speech, gamePhase === '自由讨论' ? 150 : isSorter ? 300 : 100);
        speechesToday.set(_playerId || playerName, truncated);
        return truncated;
      }

      if (gamePhase === '遗言') {
        const p = playersIn.find((x) => x.name === playerName);
        if (REAL && ai) {
          return await ai.callAIApi(
            aiConfig ?? config,
            role,
            playerName,
            playersIn,
            messagesIn,
            gamePhase,
            day,
            _nightActions,
            _gameHistory,
            _currentSpeaker,
            _speakerOrder,
            _wolfRound,
            _playerId,
            _customUserPrompt,
            isSorter,
          );
        }
        const text = await genLastWords(p || playersIn[0], day, newRealHistory());
        return text;
      }

      if (gamePhase === '平票争辩') {
        if (REAL && ai) {
          const resp = await ai.callAIApi(aiConfig ?? config, role, playerName, playersIn, messagesIn, gamePhase, day, _nightActions, _gameHistory, _currentSpeaker, _speakerOrder, _wolfRound, _playerId, _customUserPrompt, isSorter);
          return resp;
        }
        const aliveOthers = getAlivePlayers(playersIn).filter((x) => x.name !== playerName);
        const other = aliveOthers.length ? pickOne(aliveOthers).name : '某人';
        const pkStyles = [
          `我坚持${other}是狼，投他。`,
          `${other}刚才的争辩避重就轻，这票我必须给他。`,
          `我这边理由已经说完了，${other}的时间线对不上，就投他。`,
          `信我，${other}今天的破绽够多了，这轮投他没错。`,
          `我不改口，${other}就是最可疑的那个，投他。`,
          `${other}刚才只挑对自己有利的说，关键问题全跳过，这票他逃不掉。`,
          `把话挑明：${other}的解释前后打架，我这一票落他头上。`,
          `${other}不敢正面回应我的问题，心虚成这样，投他。`,
          `我反复盘过${other}的发言，漏洞没补上，这票给他。`,
          `${other}的说辞前后判若两人，这种改口我不能接受，投他。`,
        ];
        const text = truncateSpeech(pickOne(pkStyles), 100);
        return text;
      }

      if (gamePhase === '复盘') {
        if (REAL && ai) {
          return await ai.callAIApi(
            aiConfig ?? config,
            role,
            playerName,
            playersIn,
            messagesIn,
            gamePhase,
            day,
            _nightActions,
            _gameHistory,
            _currentSpeaker,
            _speakerOrder,
            _wolfRound,
            _playerId,
            _customUserPrompt,
            isSorter,
          );
        }
        if (_customUserPrompt?.includes('全场合议')) {
          return '本局关键在于把公开票型和夜间信息对齐；下一局先核对证据链，再决定归票。';
        }
        if (_customUserPrompt?.includes('狼人队内部')) {
          return '狼队应在夜聊明确主刀与备选，并把投票理由和最终刀口对齐，减少分票。';
        }
        if (_customUserPrompt?.includes('好人队内部')) {
          return '好人应及时共享可验证信息，区分事实与猜测，避免重复追逐没有新证据的怀疑。';
        }
        return '复盘时只保留可验证的行动和票型，下一局根据新证据更新判断。';
      }

      // 其它阶段：不产出内容
      return '';
    },

    async generateAIVoteDecision(
      config, role, playerName, playersIn, messagesIn, gamePhase, day, tiePlayers, isInTieDebate, playerId
    ) {
      players = playersIn;
      ensureDayState(day);
      if (REAL && ai) {
        const vd = await ai.generateAIVoteDecision(aiConfig ?? config, role, playerName, playersIn, messagesIn, gamePhase, day, tiePlayers, isInTieDebate, playerId);
        const target = playersIn.find((x) => x.id === vd.targetId && x.isAlive);
        const targetName = target ? target.name : 'skip';
        const reason = truncateSpeech(vd.reason || `综合判断，${targetName}嫌疑最大。`, 40);
        return { targetId: vd.targetId && target ? vd.targetId : 'skip', reason };
      }
      const p = playersIn.find((x) => x.name === playerName) || playersIn[0];
      // PK 阶段优先投平票玩家（不能投自己），与 engine 候选一致
      let dv = decideVote(p, speechesToday);
      if (isInTieDebate && tiePlayers && tiePlayers.length) {
        const tieAlive = tiePlayers
          .map((id) => playersIn.find((x) => x.id === id))
          .filter((x): x is Player => !!x && x.isAlive && x.id !== p.id);
        if (tieAlive.length) {
          const tiePick = tieAlive[Math.floor(rand() * tieAlive.length)];
          dv = { target: tiePick.name, reason: `PK 阶段支持${tiePick.name}，他的争辩更有说服力。` };
        } else {
          dv = { target: 'skip', reason: '无 PK 目标' };
        }
      }
      const target = playersIn.find((x) => x.name === dv.target && x.isAlive);
      const targetId = target ? target.id : 'skip';
      const reason = truncateSpeech(dv.reason, 40);
      return { targetId, reason };
    },

    async generateAIThought(
      config, role, playerName, playersIn, messagesIn, gamePhase, day, nightActions, gameHistory, playerId, witchAntidoteUsed
    ) {
      players = playersIn;
      ensureDayState(day);
      if (REAL && ai) {
        const resp = await ai.generateAIThought(aiConfig ?? config, role, playerName, playersIn, messagesIn, gamePhase, day, nightActions, gameHistory, playerId, witchAntidoteUsed);
        if (role === 'guardian' || role === 'seer' || role === 'hunter') {
          return resp;
        }
        return resp;
      }
      const p = playersIn.find((x) => x.name === playerName);
      const aliveOthers = getAlivePlayers(playersIn).filter((x) => x.id !== p?.id);
      if (role === 'guardian') {
        // 守卫不能连续两晚守同一人（engine 已按 candidates 过滤，直接从中选）
        const target = aliveOthers.length ? pickOne(aliveOthers) : null;
        return target ? target.id : '';
      }
      if (role === 'seer') {
        const target = aliveOthers.length ? pickOne(aliveOthers) : null;
        return target ? target.id : '';
      }
      if (role === 'hunter') {
        const target = aliveOthers.length ? pickOne(aliveOthers) : null;
        return target ? target.id : '';
      }
      if (role === 'witch') {
        // 女巫决策文本：复用 parseWitchDecision 同格式
        const killAction = (nightActions || []).find((a) => a.action === 'kill');
        const killTarget = killAction?.targetId ? playersIn.find((x) => x.id === killAction.targetId) : null;
        const canHeal = !witchAntidoteUsed && !!killTarget;
        if (canHeal && chance(0.5)) {
          return `用药: 解药 ${killTarget!.name}`;
        }
        const poisonCandidates = getAlivePlayers(playersIn).filter((x) => x.id !== p?.id && x.id !== killAction?.targetId);
        if (chance(0.3) && poisonCandidates.length) {
          const pt = pickOne(poisonCandidates);
          return `用药: 毒药 ${pt.name}`;
        }
        return '用药: 不用';
      }
      return '';
    },
  };
};

const waitForGameEnd = (engine: RoomEngine, timeoutMs: number): Promise<void> => {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const reviewDone = !engine.review.enabled || engine.review.stage === 'done';
      if ((engine.winnerTeam && reviewDone) || (Date.now() - start) > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  });
};

const main = async () => {
  if (REAL) {
    aiConfig = loadRealConfig();
    if (aiConfig) {
      ai = await loadRealAI();
    }
    if (aiConfig && ai) {
      console.log(`[test-drive] --real 模式启用：apiType=${aiConfig.apiType}，加载 aiClient 成功`);
    } else {
      console.warn('[test-drive] --real 模式但未找到 test-ai-config.json / WW_API_KEY，或无可用 aiClient → 回退模板模式（内置回复）');
    }
  }

  // 初始化玩家 + 身份（供 qc 解析身份表/人设表）
  const playerNames = ['阿澈', '小满', '青禾', '南枝', '知遥', '听雨', '观棋', '半夏', '云归', '拾壹', '迟迟', '阿岚'];
  const initialPlayers: Player[] = playerNames.slice(0, PLAYER_COUNT).map((name, i) => ({
    id: `p${i}`,
    roomId: 'test',
    name,
    isAI: true,
    role: null,
    isAlive: true,
    isHost: false,
    order: i,
    isReady: true,
  }));

  // 用 engine 真实规则分配身份（assignRoles 在 beginRoles 内部完成）
  players = initialPlayers;
  let archivedRecord: ArchiveRecord | null = null;
  const hub: EngineHub = {
    broadcastRoom() {},
    destroyRoom() {},
    onArchive: (record) => {
      archivedRecord = record;
    },
  };
  const engine = new RoomEngine({
    roomName: 'QC模拟局',
    maxPlayers: PLAYER_COUNT,
    reviewEnabled: true,
    auto: true,
    noArchive: false,
    aiAdapter: makeAdapter(),
    hub,
  });

  // 注入玩家：engine 无"按名添加 AI"公开方法，用 fillAIPlayers（生成 engine 默认 AI 名）。
  // 为保持 qc_events.txt 与身份表一致，直接复用 engine 真实玩家列表驱动。
  engine.fillAIPlayers(PLAYER_COUNT);
  const enginePlayers = engine.players;
  players = enginePlayers;

  // 人设表（模板确定性 / real 读真实分配）
  if (!REAL) {
    playerPersona = {};
    enginePlayers.forEach((p, i) => {
      playerPersona[p.name] = PERSONAS[(i * 5 + 3) % PERSONAS.length].name;
    });
  }

  // auto 模式自动开局（beginRoles → confirmRoles 自动）
  engine.autoStartIfNeeded();

  // 等待对局结束（engine loop 自驱）
  await waitForGameEnd(engine, 180000);

  // 身份表：engine 真实分配的角色
  const identity = engine.players.map((p) => `${p.name}:${p.role}`).join(', ');
  const personaLine = engine.players.map((p) => `${p.name}:${playerPersona[p.name] || '未知'}`).join(', ');

  const header: string[] = [];
  const outputSource = REAL && ai ? 'real_ai' : 'template';
  header.push(`# 人设表 ${personaLine}`);
  header.push(`# 身份表 ${identity}`);
  header.push('# 规则 屠边（神职全死或平民全死 → 狼胜；狼全死 → 好人胜）');
  header.push(`# source ${outputSource}`);
  if (outputSource === 'real_ai') header.push('# 模式 real（真实AI调用）；模板模式为默认');

  const winner = engine.winnerTeam;

  if (!archivedRecord) throw new Error('归档未在完整复盘结束后生成');
  const out = [...header, ...(archivedRecord.gameLogEvents || []).map((event) => event.line)];
  const OUT_FILE = path.join(process.cwd(), 'qc_events.txt');
  fs.writeFileSync(OUT_FILE, out.join('\n') + '\n', 'utf-8');
  console.log(`[test-drive] 已生成 ${OUT_FILE}`);
  console.log(`[test-drive] 玩家数=${PLAYER_COUNT}，模式=${REAL && ai ? 'real' : 'template'}，headless 驱动真实 engine，对局结果=${winner === 'wolf' ? '狼人胜' : winner === 'good' ? '好人胜' : '未分胜负'}，事件行数=${out.length}`);
};

main().catch((e) => {
  console.error('[test-drive] 运行失败:', e);
  process.exit(1);
});
