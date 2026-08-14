import type { Player, Role } from './types';
import { getRoleInfo } from './roleConfig';

/**
 * memorySystem.ts — 记忆库预填（WEREWOLF_FIXES_v2.3.md 任务 B）
 *
 * 依据 EXP_SYSTEM_DESIGN.md（记忆库 v0.3）：
 * - 开局：系统分配人设 → 预填记忆库（初始内容 = 系统模板）
 * - 局中：AI 自己读取、写日记（appendMemoryNote 预留）
 * - 局后：复盘结束后清空（clearGameMemory）
 *
 * 预填内容（严格"知道/不知道"边界，防上帝视角）：
 *  1. 公共信息：本局人数、职业列表、狼数量
 *  2. 身份信息：狼人 → 自己身份 + 全部狼队友；好人 → 自己身份（不知道其他人）
 *  3. 人格：随机分配的人设（12 人设名）
 *  4. 经验库链接：按职业对应经验库（wolf/seer/witch/hunter/guard/villager）
 *
 * 浏览器为内存存储 + localStorage 持久化（键 wolf-memory-<roomId>，局后清除），
 * 文件形态的 src/data/memory/<game_id>/<agent_id>.md 由后端/复盘阶段扩展。
 */

export interface Persona {
  name: string;
  personality: string;
  speechStyle: string;
  background: string;
}

/**
 * 12 人设（中性无狼感，EXP_SYSTEM_DESIGN.md 〇 定稿名单）
 * v2.4.9 任务1：人设集【不含人名】，用占位代号（【人设1】…【人设12】）——
 * 避免"听雨配云归人设"式把玩家名当人设名造成的混淆；局内展示一律用玩家名，
 * 人设仅决定性格/说话风格（角色分配用途），说话风格在 aiClient 中按代号注入。
 */
export const PERSONAS: Persona[] = [
  { name: '人设1', personality: '冷静理性，重逻辑，不轻易下结论，喜欢列点分析', speechStyle: '简洁、条理清晰，先摆事实再讲推断', background: '习惯把每一条线索在脑子里过一遍再开口' },
  { name: '人设2', personality: '温和乐观，亲和力强，愿意倾听别人', speechStyle: '语气平缓，先肯定再补充，善于安抚场面', background: '相信大多数人都是好人，但会留意反常之处' },
  { name: '人设3', personality: '观察细致，沉默寡言但看得准', speechStyle: '发言不多，但每句都点到关键信息', background: '比起说话更喜欢观察座位和票型的规律' },
  { name: '人设4', personality: '活泼直率，想到什么说什么', speechStyle: '随性直接，偶尔冒失但想法真实', background: '直觉很准，但经常要先说出来才能想清楚' },
  { name: '人设5', personality: '心思缜密，重证据，喜欢事后复盘', speechStyle: '喜欢用"时间线""逻辑"这类词，反复比对前后发言', background: '习惯把每一天的发言和票型记下来对比' },
  { name: '人设6', personality: '文艺内敛，说话含蓄，喜欢留白', speechStyle: '话不多，常用暗示和反问，点到为止', background: '不急着表态，先看看风向再决定怎么站队' },
  { name: '人设7', personality: '沉稳，喜欢旁观全局，节奏慢', speechStyle: '发言稳重，常以"按常理来看"开头', background: '信奉少数人的直觉，多数人的盲从，越乱越冷静' },
  { name: '人设8', personality: '机智，反应快，爱用比喻打比方', speechStyle: '金句多，喜欢把复杂局势比喻成生活中的事', background: '擅长从最不起眼的一句话里嗅出异常' },
  { name: '人设9', personality: '随和包容，中立口吻，不爱树敌', speechStyle: '语气温和，经常给出两边的可能性再选一边', background: '希望局势清晰，最怕大家无意义地互相猜忌' },
  { name: '人设10', personality: '好奇，爱提问，探索型思维', speechStyle: '连环提问，用问题逼别人把话讲明白', background: '相信话说得越多破绽越多，问题是最好的工具' },
  { name: '人设11', personality: '慢性子，说话慢，但坚持己见', speechStyle: '语速慢，会反复强调自己认定的结论', background: '一旦认定方向就不轻易被带偏，除非证据反转' },
  { name: '人设12', personality: '果断干练，直接，行动派', speechStyle: '干脆利落，经常给结论和行动建议', background: '讨厌拖泥带水，认为分析完就该及时归票' },
];

interface PlayerMemory {
  playerName: string;
  persona: Persona;
  prefill: string;
  notes: string[];
}

interface GameMemory {
  roomId: string;
  players: Map<string, PlayerMemory>;
}

const STORAGE_PREFIX = 'wolf-memory-';
let currentGame: GameMemory | null = null;

const safePersist = (key: string, value: string) => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* storage 不可用时降级为纯内存 */
  }
};

const buildPrefill = (player: Player, persona: Persona, players: Player[]): string => {
  const role = player.role;
  const roleInfo = role ? getRoleInfo(role) : null;
  const total = players.length;
  const wolfCount = players.filter((p) => p.role === 'wolf').length;

  // 公共信息：职业列表（按配置描述，不含具体玩家身份归属）
  const roleLabels: string[] = [];
  const count = (r: Role) => players.filter((p) => p.role === r).length;
  if (count('wolf') > 0) roleLabels.push(`狼人 x${count('wolf')}`);
  if (count('seer') > 0) roleLabels.push(`预言家 x${count('seer')}`);
  if (count('witch') > 0) roleLabels.push(`女巫 x${count('witch')}`);
  if (count('hunter') > 0) roleLabels.push(`猎人 x${count('hunter')}`);
  if (count('guardian') > 0) roleLabels.push(`守卫 x${count('guardian')}`);
  if (count('villager') > 0) roleLabels.push(`平民 x${count('villager')}`);

  const lines: string[] = [];
  lines.push(`【记忆库 · 本局笔记（开局预填）】`);
  // v2.4.9 任务1：人设集不含人名（占位代号），局内一律用玩家名展示；人设仅决定性格/说话风格
  lines.push(`- 本局你叫「${player.name}」（玩家名，局内大家都用玩家名互称）。`);
  lines.push(`- 人设代号：${persona.name}（仅供分配性格/说话风格，不是你的名字）。性格：${persona.personality}。说话风格：${persona.speechStyle}。`);
  lines.push(`- 说话要求：发言就按上面这个风格来，长短随自己脾气，别跟别的玩家一个模子；该话痨就话痨，该寡言就寡言。`);
  lines.push(`- 公共信息：本局共 ${total} 人；职业配置：${roleLabels.join('、')}；其中狼人 ${wolfCount} 人。`);
  if (role && roleInfo) {
    if (role === 'wolf') {
      const teammates = players
        .filter((p) => p.role === 'wolf' && p.name !== player.name)
        .map((p) => p.name);
      lines.push(`- 身份信息（仅你可见）：你是狼人，你的狼队友是：${teammates.join('、') || '（仅你一个狼人）'}。`);
    } else {
      lines.push(`- 身份信息（仅你可见）：你是${roleInfo.name}（${roleInfo.team === 'wolf' ? '狼人阵营' : '好人阵营'}）。你不知道其他玩家的身份。`);
    }
    lines.push(`- 经验库链接：本局已按职业「${roleInfo.name}」加载通用战术参考（跨局经验，非本局事实，见【通用战术参考】）。`);
  }
  lines.push(`- 边界提醒：以上是"你知道的"，不要把别人的查验/行动/身份当成已知信息。`);
  lines.push(`- 记忆边界（v2.4.8 防捏造记忆）：只能引用【记忆库】与【当轮信息】里实际写到的内容（验人结果/自己的发言/公开事件）。禁止"我记得XX今天说过…"式凭空捏造——没写的就是不知道，宁可说"我信息不多/再听听"。`);
  return lines.join('\n');
};

/**
 * 开局预填：为每个玩家分配人设并生成记忆库预填。
 * 人设只分配给 AI 玩家（真人玩家用自己的头脑），AI 数量 ≤12 时人设不重复。
 */
export const initGameMemory = (roomId: string, players: Player[]): void => {
  const map = new Map<string, PlayerMemory>();
  const aiPlayers = players.filter((p) => p.isAI);
  const shuffled = [...PERSONAS].sort(() => Math.random() - 0.5);

  aiPlayers.forEach((p, i) => {
    const persona = shuffled[i % shuffled.length];
    map.set(p.name, {
      playerName: p.name,
      persona,
      prefill: buildPrefill(p, persona, players),
      notes: [],
    });
  });

  currentGame = { roomId, players: map };
  try {
    const serialized = JSON.stringify(
      [...map.entries()].map(([name, m]) => ({ name, persona: m.persona, prefill: m.prefill }))
    );
    safePersist(STORAGE_PREFIX + roomId, serialized);
  } catch {
    /* 持久化失败不影响内存 */
  }
};

export const getPlayerMemory = (playerName: string): PlayerMemory | undefined => {
  if (!currentGame) return undefined;
  return currentGame.players.get(playerName);
};

/** 取记忆库预填段（供 buildSystemPrompt 注入），无则返回 null */
export const buildMemoryPrefillSection = (playerName: string): string | null => {
  const mem = getPlayerMemory(playerName);
  return mem ? mem.prefill : null;
};

/** 局中写日记（预留，EXP_SYSTEM_DESIGN 4.3；本批暂未在轮询中自动调用） */
export const appendMemoryNote = (playerName: string, note: string): void => {
  const mem = getPlayerMemory(playerName);
  if (mem) {
    mem.notes.push(note);
    if (mem.notes.length > 20) mem.notes.shift();
  }
};

/** 局后清空（restartGame / leaveRoom / 对局结束调用） */
export const clearGameMemory = (): void => {
  if (currentGame) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_PREFIX + currentGame.roomId);
    } catch {
      /* ignore */
    }
  }
  currentGame = null;
};
