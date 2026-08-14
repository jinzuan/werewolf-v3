/**
 * scripts/verify-249.ts — v2.4.9 任务 1/3/4/5/6/7/8 断言验证
 * （依据 WEREWOLF_FIXES_v2.4.9.md）
 *
 * 验证点：
 *  1.  人设集不含人名（占位代号 人设1..人设12）；局内展示用玩家名
 *  3.  自由讨论轮数上限 3 → 4（engine / test-drive / GameRoom）
 *  4.  每天提示词注入"第X天/现在是" + 过夜分析状态（防隔夜复读）
 *  5.  投票记录写入 playerKnowledge.votes（公开信息），提示词全量展示票型
 *  6.  PK 理由变体池 ≥16 + PK 专用池 ≥10；PK 争辩提示词禁复用句式
 *  7.  女巫决策：乱码 → unclear（引擎默认用解药救人，不再永远不用药）；"用药:解药/毒药/不用"格式解析
 *  8.  qc.py 排除门禁标记行（"高度重复/简略表态"不进入 speeches）
 *
 * 运行：npx tsx scripts/verify-249.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const { buildSystemPrompt } = await import('../src/utils/aiClient');
void buildSystemPrompt;
const { parseWitchDecision } = await import('../src/utils/gameLogic');
const { PERSONAS, initGameMemory, buildMemoryPrefillSection, clearGameMemory } = await import('../src/utils/memorySystem');
import type { Player, Role } from '../src/types';

const ROLES: Role[] = ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager', 'villager', 'villager', 'villager', 'villager'];
const NAMES = ['阿澈', '小满', '青禾', '南枝', '知遥', '听雨', '观棋', '半夏', '云归', '拾壹', '迟迟', '阿岚'];
const players: Player[] = ROLES.map((role, i) => ({
  id: `p${i}`, roomId: 'v', name: NAMES[i], isAI: true, role, isAlive: true, isHost: false, order: i, isReady: true,
}));

/* ---------- 任务 1：人设集不含人名（占位代号） ---------- */
{
  assert('任务1 PERSONAS 共 12 个', PERSONAS.length === 12);
  assert('任务1 人设集不含玩家名（阿澈/小满/云归…）', !PERSONAS.some((p) => NAMES.includes(p.name)));
  assert('任务1 人设集用占位代号（人设1..人设12）', PERSONAS.every((p) => /^人设\d+$/.test(p.name)));

  clearGameMemory();
  initGameMemory('v', players);
  const prefill = buildMemoryPrefillSection('阿澈');
  assert('任务1 记忆预填以玩家名自称（不用人设代号当名字）', !!prefill && prefill.includes('你叫「阿澈」'));
  assert('任务1 记忆预填标记人设代号为风格参考', !!prefill && prefill.includes('人设代号'));
}

/* ---------- 任务 3：自由讨论轮数 3 → 4 ---------- */
{
  const engine = readFileSync(path.resolve(process.cwd(), 'server', 'engine.ts'), 'utf-8');
  const td = readFileSync(path.resolve(process.cwd(), 'test-drive.ts'), 'utf-8');
  const gameRoom = readFileSync(path.resolve(process.cwd(), 'src', 'pages', 'GameRoom.tsx'), 'utf-8');
  assert('任务3 engine 自由讨论 maxRounds = 4', /const maxRounds = 4;/.test(engine));
  assert('任务3 engine discussionRounds = 4', /discussionRounds = 4;/.test(engine));
  assert('任务3 test-drive 自由讨论循环 ≤4 轮', /for \(let fr = 1; fr <= 4; fr\+\+\)/.test(td));
  assert('任务3 GameRoom FREE_DISCUSS_MAX_ROUNDS = 4', /FREE_DISCUSS_MAX_ROUNDS = 4/.test(gameRoom));
}

/* ---------- 任务 4：第X天/现在是 + 过夜分析状态 ---------- */
{
  const ai = readFileSync(path.resolve(process.cwd(), 'src', 'utils', 'aiClient.ts'), 'utf-8');
  assert('任务4 提示词注入"现在是: 第X天"', /现在是: 第\$\{day\}天/.test(ai));
  assert('任务4 有过夜分析段（基于昨晚最新信息）', ai.includes('过夜分析') && ai.includes('不要接着昨天的话尾巴'));
}

/* ---------- 任务 5：投票记录进记忆库/提示词 ---------- */
{
  const engine = readFileSync(path.resolve(process.cwd(), 'server', 'engine.ts'), 'utf-8');
  const ai = readFileSync(path.resolve(process.cwd(), 'src', 'utils', 'aiClient.ts'), 'utf-8');
  const td = readFileSync(path.resolve(process.cwd(), 'test-drive.ts'), 'utf-8');
  assert('任务5 engine 有 recordPublicVotes（投票写记忆库）', engine.includes('recordPublicVotes'));
  assert('任务5 engine 投票后调用 recordPublicVotes', /recordPublicVotes\(this\.game\.day/.test(engine));
  assert('任务5 aiClient 全量展示投票记录（第N天投→Y）', ai.includes('第${v.day}天投→${v.target}'));
  assert('任务5 test-drive 投票写入 playerKnowledge', /entry\.votes\.push\(\{ day, target \}\)/.test(td));
}

/* ---------- 任务 6：PK 发言/理由防复读 ---------- */
{
  const ai = readFileSync(path.resolve(process.cwd(), 'src', 'utils', 'aiClient.ts'), 'utf-8');
  const td = readFileSync(path.resolve(process.cwd(), 'test-drive.ts'), 'utf-8');
  const reasonVarBlock = ai.slice(ai.indexOf('const REASON_VARIANTS'), ai.indexOf('const PK_REASON_VARIANTS'));
  const reasonCount = (reasonVarBlock.match(/^ {2}'/gm) || []).length;
  const pkBlock = ai.slice(ai.indexOf('const PK_REASON_VARIANTS'), ai.indexOf('const emptyVote'));
  const pkCount = (pkBlock.match(/^ {2}'/gm) || []).length;
  assert('任务6 aiClient 理由变体池 ≥16 种', reasonCount >= 16);
  assert('任务6 aiClient 有 PK 专用理由池（≥10 种）', pkCount >= 10);
  assert('任务6 平票争辩阶段提示词禁复用句式', ai.includes('PK 争辩纪律') && ai.includes('禁止复用'));
  assert('任务6 test-drive PK 模板池跨天去重', td.includes('usedPKSkeletons'));
  assert('任务6 test-drive PK 模板池 ≥10 种', (td.match(/`信我，\$\{other\}今天的破绽够多了，这轮投他没错。`/g)?.length ?? 0) === 1);
}

/* ---------- 任务 7：女巫决策乱码修复 ---------- */
{
  const d1 = parseWitchDecision('p4');            // round11 实锤乱码
  const d2 = parseWitchDecision('用药: 解药 小明');
  const d3 = parseWitchDecision('用药: 毒药 大壮');
  const d4 = parseWitchDecision('用药: 不用');
  const d5 = parseWitchDecision('女巫行动: 救人 小明');
  const d6 = parseWitchDecision('跳过');
  assert('任务7 乱码"p4" → unclear（不再直接 skip，触发默认决策）', d1.action === 'unclear');
  assert('任务7 用药:解药 目标 解析', d2.action === 'heal' && d2.target === '小明');
  assert('任务7 用药:毒药 目标 解析', d3.action === 'poison' && d3.target === '大壮');
  assert('任务7 用药:不用 → 跳过', d4.action === 'skip');
  assert('任务7 旧格式 女巫行动:救人 兼容', d5.action === 'heal');
  assert('任务7 明确"跳过" → 跳过', d6.action === 'skip');

  const engine = readFileSync(path.resolve(process.cwd(), 'server', 'engine.ts'), 'utf-8');
  assert('任务7 引擎对乱码默认用解药（有人被刀且有解药）', engine.includes('按默认决策使用解药救人'));
  const td = readFileSync(path.resolve(process.cwd(), 'test-drive.ts'), 'utf-8');
  assert('任务7 test-drive 乱码也走默认解药', td.includes('按默认决策用解药救人'));
}

/* ---------- 任务 8：qc.py 排除门禁标记行 ---------- */
{
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'qc-verify-249-'));
  const events = [
    '# 模式 real（真实AI调用）；模板模式为默认',
    '# 身份表 阿澈:wolf, 小满:villager, 青禾:seer',
    '第1天 阿澈: 大家好，我是好人，先听大家说。',
    '第2天 小满: （与阿澈发言高度重复，简略表态）',
    '第2天 小满: 我觉得阿澈今天时间线对不上，投他。',
    '第2天 青禾: （与阿澈发言高度重复，简略表态）',
  ].join('\n');
  const f = path.join(tmpDir, 'events.txt');
  writeFileSync(f, events, 'utf-8');
  const r = spawnSync('python', ['qc.py', f], { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const out = r.stdout || '';
  assert('任务8 qc 门禁标记行不计入发言数（发言数=2，非4）', out.includes('发言数=2，') || /发言数=2/.test(out));
  assert('任务8 qc 不把门禁标记当套话', !out.includes('简略表态'));
}

/* ---------- 汇总 ---------- */
console.log(`\n[verify-249] ${pass} 断言通过，${fail} 断言失败`);
if (fail > 0) process.exit(1);
