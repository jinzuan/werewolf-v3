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

/** Actual event anchors from the game being reviewed. */
export interface ReviewEvidence {
  tags: string[];
}

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
    let raw: string | null = null;
    if (storageBackend) {
      raw = storageBackend.get(STORAGE_KEY);
    } else {
      if (typeof localStorage === 'undefined') return {};
      raw = localStorage.getItem(STORAGE_KEY);
    }
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const migrated = migrateReviewStore(parsed);
    if (!storesEqual(parsed as ReviewStore, migrated)) safeSet(migrated);
    return migrated;
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

/**
 * A transferable lesson still has to point at an observable event.  Generic
 * advice such as "review the evidence next game" is deliberately rejected:
 * it is not useful training data and usually means the review prompt lost its
 * game context.
 */
const hasVerifiableEventReference = (
  insight: string,
  evidence?: ReviewEvidence,
): boolean => {
  // A bare mention of “票型/新证据/行动” is still generic.  Require a
  // concrete round, outcome, or action/result pair so old template prose
  // cannot survive a restart merely because it contains a domain word.
  const specificReference = /第\d+[晚天]|首夜|昨晚|被(?:投票出局|票出|狼刀|毒杀)|(?:查验|验人)(?:到|出|结果)|查杀|金水|票狼|投狼|跟票(?:给|投)|狼刀(?:到|杀)|刀口(?:是|为)|毒杀(?:了|到)|守过|守护(?:成功|失败)|解药(?:救|未)|猎人开枪|平票(?:后|时)/;
  if (!specificReference.test(insight)) return false;

  if (!evidence || evidence.tags.length === 0) return true;
  return evidence.tags.some((tag) => tag.length > 0 && insight.includes(tag));
};

/** Shared evidence gate for server and browser review consumers. */
export const isEvidenceBackedInsight = (
  insight: string,
  evidenceTags: string[] = [],
): boolean => hasVerifiableEventReference(insight, { tags: evidenceTags });

/**
 * Runtime review data predates the event-reference gate and is intentionally
 * stored as plain strings.  Normalize that old shape on read and remove only
 * entries that cannot point to a concrete game event; evidence-backed lessons
 * remain untouched.
 */
const migrateReviewStore = (value: unknown): ReviewStore => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const migrated: ReviewStore = {};
  Object.entries(value as Record<string, unknown>).forEach(([role, raw]) => {
    if (!Array.isArray(raw)) return;
    const insights = raw
      .filter((item): item is string => typeof item === 'string')
      .map(cleanInsight)
      .filter((item) => item.length > 0 && hasVerifiableEventReference(item));
    if (insights.length > 0) migrated[role] = insights.slice(-MAX_INSIGHTS_PER_ROLE);
  });
  return migrated;
};

const storesEqual = (left: ReviewStore, right: ReviewStore): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** 取该职业待归并的复盘心得 */
export const getReviewInsights = (role: Role): string[] => {
  const store = safeGet();
  return store[role] || [];
};

/** 追加一条复盘心得：去重（相似度 ≥0.6 判重复不写入）、上限 8 条 */
export const addReviewInsight = (role: Role, raw: string, evidence?: ReviewEvidence): boolean => {
  const insight = cleanInsight(raw);
  if (!insight || !hasVerifiableEventReference(insight, evidence)) {
    console.warn(`[experience-review] 丢弃无可验证事件引用的心得（${role}）`);
    return false;
  }
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
    `- 必须在句中引用至少一个本局事件锚点（如“查验到狼人”“被投票出局”“狼刀目标”“公开票型”）；只写“重视证据/及时沟通/认真复盘”等泛化原则将被丢弃`,
    `- 必须是可迁移经验：禁止出现任何玩家名字/昵称，无具体天数例子，用身份或位置代称`,
    `- 一条即可，≤100 字`,
    `- 只输出这一条心得本身，以"- "开头，不要多余解释`,
  ].join('\n');
};
