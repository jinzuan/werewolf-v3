/**
 * scripts/verify-a4.ts — v2.4.5-A A4 复盘→经验库更新 断言验证
 *
 * 验证点：
 *  1. addReviewInsight 判重（同义心得相似度 ≥0.6 不重复写入）
 *  2. 心得清洗（行首"- "标记剥离、超长截断）
 *  3. mergeReviewInsights 追加【局后复盘补充】段 + 免责语气
 *  4. buildReviewPrompt 强制"禁写人名 + ≤100 字"
 *
 * 运行：npx tsx scripts/verify-a4.ts
 */

// Node 无 localStorage → 注入内存 polyfill（必须在动态 import 之前）
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
};

let pass = 0;
let fail = 0;
const assert = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
};

const mod = await import('../src/utils/experienceReview');

// 1. 判重：同义心得不重复写入
mod.clearReviewInsights('wolf');
const first = mod.addReviewInsight('wolf', '- 首夜优先刀明面威胁，别刀藏得深的深水狼。');
const second = mod.addReviewInsight('wolf', '首夜优先刀明面威胁，别刀深水狼。');
const third = mod.addReviewInsight('wolf', '倒钩时跟真预言家票狼队友做身份，攒信任比硬保队友值钱。');
assert('首次写入成功', first === true);
assert('同义心得判重不写入', second === false);
assert('差异化心得可写入', third === true);

// 2. 清洗：剥离行首标记 + 超长截断
const long = mod.addReviewInsight('wolf', '- ' + '悍跳时查验时间线必须编完整并和已公布死讯逐条对上否则当场穿帮。'.repeat(4));
assert('超长心得被截断到 ≤100 字', long === true);

const insights = mod.getReviewInsights('wolf');
assert('存 3 条（second 被去重）', insights.length === 3);
assert('心得无行首标记', insights.every((i) => !i.startsWith('- ') && !i.startsWith('-')));
assert('心得 ≤100 字', insights.every((i) => i.length <= 100));

// 3. merge：追加【局后复盘补充】段 + 免责语气
const merged = mod.mergeReviewInsights('wolf', '> 本库为狼人经验');
assert('合并后包含原经验', merged.includes('> 本库为狼人经验'));
assert('合并后追加复盘补充段', merged.includes('【局后复盘补充】'));
assert('合并后带免责语气', merged.includes('跨局经验，非本局事实') && merged.includes('仅供参考'));
assert('合并后带 - 条目', /-\s/.test(merged));

// 4. 复盘 prompt：禁写人名 + ≤100 字约束
const prompt = mod.buildReviewPrompt('wolf', 'wolf', '第1晚死亡：X；第2天出局：Y');
assert('复盘 prompt 要求禁写人名', prompt.includes('禁止出现任何玩家名字'));
assert('复盘 prompt 要求 ≤100 字', prompt.includes('≤100 字'));
assert('复盘 prompt 带本局结果', prompt.includes('狼人获胜'));

// 5. 清理
mod.clearReviewInsights('wolf');
assert('清理后为空', mod.getReviewInsights('wolf').length === 0);

console.log(`\n[verify-a4] ${pass} 断言通过，${fail} 断言失败`);
process.exit(fail > 0 ? 1 : 0);
