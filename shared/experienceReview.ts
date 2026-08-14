import type { Role } from './types';

/**
 * experienceReview.ts — 局后复盘 → 经验库更新（WEREWOLF_FIXES_v2.4.5-A.md 任务 A4）
 *
 * 机制（运行时落地，localStorage 持久化）：
 *  经验库源文件由 Vite 编译期打包，浏览器端不可写，"更新进库"以【局后复盘补充】段
 *  在下一局该角色经验注入时追加，效果等价"复盘改库"。
 *  1. 局后复盘（GameRoom 对局结束触发）为每个职业生成一条"有效经验"
 *  2. addReviewInsight 判重（与同角色已有条目相似度 ≥0.6 不写入）+ 禁写人名（复盘 prompt 强制）
 *  3. 下一局 loadExperience 注入时经 mergeReviewInsights 追加进该角色经验文本
 *  4. 本地持久化，只能手动清理（clearReviewInsights），与"经验库只能玩家手动清理"原则一致
 */

const STORAGE_KEY = 'wolf-exp-review-v1';
const MAX_INSIGHTS_PER_ROLE = 8;
const SIM_THRESHOLD = 0.6;

type ReviewStore = Record<string, string[]>;

/**
 * 存储后端可注入（B批联机：服务端注入文件后端，浏览器保持 localStorage 默认）。
 * 结构兼容：get/set 一个字符串键值。
 */
export interface ReviewStorageBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

let storageBackend: ReviewStorageBackend | null = null;

export const setReviewStorageBackend = (backend: ReviewStorageBackend | null): void => {
  storageBackend = backend;
};

const safeGet = (): ReviewStore => {
  try {
    if (storageBackend) {
      const raw = storageBackend.get(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ReviewStore) : {};
    }
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ReviewStore) : {};
  } catch {
    return {};
  }
};

const safeSet = (store: ReviewStore) => {
  try {
    if (storageBackend) {
      storageBackend.set(STORAGE_KEY, JSON.stringify(store));
      return;
    }
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage 不可用时静默降级 */
  }
};

/** 简单相似度：字符级 Jaccard（短句判重用） */
const charSimilarity = (a: string, b: string): number => {
  if (!a || !b) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  sa.forEach((c) => { if (sb.has(c)) inter++; });
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
};

/** 复盘心得清洗：去行首标记/引号、压缩空白、≤100 字（超长截到句末） */
const cleanInsight = (raw: string): string => {
  const t = (raw || '')
    .replace(/^[-*•]?\s*/, '')
    .replace(/^["'“”]|["'“”]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (t.length > 100) {
    const slice = t.slice(0, 100);
    const boundary = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('；'), slice.lastIndexOf('，'));
    return (boundary >= 40 ? slice.slice(0, boundary + 1) : slice).trim();
  }
  return t;
};

/** 取该职业待归并的复盘心得 */
export const getReviewInsights = (role: Role): string[] => {
  const store = safeGet();
  return store[role] || [];
};

/** 追加一条复盘心得：去重（相似度 ≥0.6 判重复不写入）、上限 8 条 */
export const addReviewInsight = (role: Role, raw: string): boolean => {
  const insight = cleanInsight(raw);
  if (!insight) return false;
  const store = safeGet();
  const list = store[role] || [];
  const duplicated = list.some((item) => charSimilarity(item, insight) >= SIM_THRESHOLD);
  if (duplicated) return false;
  list.push(insight);
  store[role] = list.slice(-MAX_INSIGHTS_PER_ROLE);
  safeSet(store);
  return true;
};

/** 合并复盘心得进该角色经验文本（追加【局后复盘补充】段，带免责语气） */
export const mergeReviewInsights = (role: Role, baseText: string): string => {
  const insights = getReviewInsights(role);
  if (insights.length === 0) return baseText;
  const section = [
    `【局后复盘补充】（历史对局复盘归并；跨局经验，非本局事实；已去除玩家名；仅供参考）`,
    ...insights.map((i) => `- ${i}`),
  ].join('\n');
  return `${baseText}\n\n${section}`;
};

/** 手动清理复盘归并池（单职业或全部） */
export const clearReviewInsights = (role?: Role): void => {
  const store = safeGet();
  if (role) {
    delete store[role];
  } else {
    Object.keys(store).forEach((k) => delete store[k]);
  }
  safeSet(store);
};

/** 复盘 prompt：请求模型输出一条本职业最有效的局后心得（禁写人名，≤100 字） */
export const buildReviewPrompt = (
  role: Role,
  winner: 'wolf' | 'good' | null,
  summary: string
): string => {
  const roleName: Record<Role, string> = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', guardian: '守卫', villager: '平民' };
  const result = winner === 'wolf' ? '狼人获胜' : winner === 'good' ? '好人获胜' : '未分胜负';
  return [
    `【狼人杀 局后复盘】`,
    `你刚打完一局「${roleName[role]}」，本局结果：${result}。`,
    `对局要点：${summary}`,
    ``,
    `请输出 1 条本局对你这个职业最有价值的复盘心得，用于更新该职业的经验库：`,
    `- 只能基于本局真实事件（死亡/查验/投票/关键转折）复盘，禁止捏造——不得出现"我记得XX说过"式虚构`,
    `- 具体可执行（战术/判断/时机），不要空话套话`,
    `- 必须是可迁移经验：禁止出现任何玩家名字/昵称，无具体天数例子，用身份或位置代称`,
    `- 一条即可，≤100 字`,
    `- 只输出这一条心得本身，以"- "开头，不要多余解释`,
  ].join('\n');
};
