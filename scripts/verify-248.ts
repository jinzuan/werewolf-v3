/**
 * scripts/verify-248.ts — v2.4.8 经验库文件系统加载修复 + 提示词记忆边界 断言验证
 * （依据 WEREWOLF_FIXES_v2.4.8.md 任务 1/2）
 *
 * 验证点：
 *  1. loadExperienceFiles 在 tsx/node 运行时走文件系统加载成功（无 .glob 报错），返回 25 份 .md
 *  2. 按职业过滤正确：wolf 5 份 + common 2 份
 *  3. 加载期间控制台不出现 "加载经验库失败"（round10 实锤日志）
 *  4. buildSystemPrompt 注入【通用战术参考】（经验库真正进 prompt）
 *  5. buildSystemPrompt 发言规则含"记忆边界"防捏造约束
 *  6. 记忆库预填（memorySystem.buildMemoryPrefillSection）含"记忆边界 + 禁凭空捏造"
 *
 * 运行：npx tsx scripts/verify-248.ts
 */

// Node 无 localStorage → 注入内存 polyfill（memorySystem / experienceReview 需要，必须在 import 之前）
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

const { loadExperienceFiles, buildSystemPrompt, resetExperienceCache } = await import('../src/utils/aiClient');
const { initGameMemory, buildMemoryPrefillSection, clearGameMemory } = await import('../src/utils/memorySystem');
import type { Player, Role } from '../src/types';

// 12 人标准局：狼3 预言家1 女巫1 猎人1 守卫1 平民5
const ROLES: Role[] = ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager', 'villager', 'villager', 'villager', 'villager'];
const NAMES = ['阿澈', '小满', '青禾', '南枝', '知遥', '听雨', '观棋', '半夏', '云归', '拾壹', '迟迟', '阿岚'];
const players: Player[] = ROLES.map((role, i) => ({
  id: `p${i}`,
  roomId: 'verify',
  name: NAMES[i],
  isAI: true,
  role,
  isAlive: true,
  isHost: false,
  order: i,
  isReady: true,
}));

// 1. 文件系统加载成功 + 条数
resetExperienceCache();
const files = loadExperienceFiles();
assert('loadExperienceFiles 非空（不再回退 null）', files !== null);
assert('经验库共 25 份 .md', files !== null && Object.keys(files).length === 25);
assert('全部为 .md 文件', files !== null && Object.keys(files).every((k) => k.endsWith('.md')));
assert('不含失败回退哨兵', files !== null && !Object.keys(files).some((k) => k.includes('失败')));

// 2. 按职业过滤
const wolfFiles = files ? Object.entries(files).filter(([k]) => k.split(/[/\\]/).pop()!.startsWith('wolf_')) : [];
const commonFiles = files ? Object.entries(files).filter(([k]) => k.split(/[/\\]/).pop()!.startsWith('common_')) : [];
assert('wolf 经验库 5 份', wolfFiles.length === 5);
assert('common 风格库 2 份', commonFiles.length === 2);

// 3. 加载期间无"加载经验库失败"警告（round10 实锤日志；缓存命中后不再重复打印，仅首轮监听）
const warned: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => { warned.push(String(args[0] ?? '')); };
resetExperienceCache();
loadExperienceFiles();
console.warn = origWarn;
assert('无"加载经验库失败"警告', warned.every((w) => !w.includes('加载经验库失败')));

// 4/5. buildSystemPrompt：经验库注入 + 记忆边界
const sys = buildSystemPrompt('wolf', '阿澈', players);
assert('system prompt 含【通用战术参考】（经验库真实注入）', sys.includes('【通用战术参考】'));
assert('system prompt 含跨局免责声明', sys.includes('跨局经验，非本局事实'));
assert('system prompt 发言规则含记忆边界约束', sys.includes('记忆边界'));
assert('system prompt 禁止凭空捏造记忆', sys.includes('凭空捏造') && sys.includes('我记得'));

// 6. 记忆库预填含防捏造约束
initGameMemory('verify', players);
const prefill = buildMemoryPrefillSection('阿澈') || '';
assert('记忆预填含记忆边界行', prefill.includes('记忆边界'));
assert('记忆预填禁止凭空捏造', prefill.includes('凭空捏造') && prefill.includes('我信息不多'));
assert('记忆预填保留身份信息行', prefill.includes('狼队友'));
clearGameMemory();

console.log(`\n[verify-248] ${pass} 断言通过，${fail} 断言失败`);
process.exit(fail > 0 ? 1 : 0);
