/**
 * scripts/verify-248b.ts — v2.4.8 全量任务 2/3/4/5/7/8/9/10/11/12/13/15 断言验证
 * （依据 WEREWOLF_FIXES_v2.4.8.md）
 *
 * 验证点：
 *  2.  经验库内容清洗：无玩家名 / 无"昨天XX还说要投别人"式具体对局例子
 *  3.  test-drive mock 池：不再含"昨天…改口…时间线对不上"式模板（第1天不应出现）
 *  4.  fallback 短句变体池 ≥10 种（掉线不全员同句）
 *  5/13. 防复读门禁定位：遗言已豁免；重生成优先，仅硬门禁才标记"高度重复"
 *  7.  好人团队协作提示词：神职安全时机传信息 / 平民配合
 *  8.  神职藏身份规则：不报信息≠狼面；"见风使舵"类指控必须带依据
 *  9.  qc.py：无依据"见风使舵/改口/不交信息"指责被标记（带依据的不标记）
 *  10. 夜间结算：已死守卫/女巫的行动（残留 save/antidote）一律不生效
 *  11. 女巫决策解析：乱码/"p0" → 默认不用药；正常格式正确解析
 *  12. 预言家记忆：夜间提示词注入"已查验名单"，禁止重复查验
 *  15. 局势摘要：test-drive 每日输出"第N天[局势摘要]"，AI 提示词注入【局势黑板】
 *
 * 运行：npx tsx scripts/verify-248b.ts
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

const {
  buildSystemPrompt,
  getFallbackVariantCount,
  getRepeatCheckedPhases,
  buildSeerCheckedListSection,
} = await import('../src/utils/aiClient');
const { processNightActions, parseWitchDecision } = await import('../src/utils/gameLogic');
import type { Player, Role } from '../src/types';

const ROLES: Role[] = ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager', 'villager', 'villager', 'villager', 'villager'];
const NAMES = ['阿澈', '小满', '青禾', '南枝', '知遥', '听雨', '观棋', '半夏', '云归', '拾壹', '迟迟', '阿岚'];
const players: Player[] = ROLES.map((role, i) => ({
  id: `p${i}`, roomId: 'v', name: NAMES[i], isAI: true, role, isAlive: true, isHost: false, order: i, isReady: true,
}));

/* ---------- 任务 2：经验库内容清洗 ---------- */
const expDir = path.resolve(process.cwd(), 'src', 'data', 'experience_library');
const expFiles = ['common_1', 'common_2', 'guard_1', 'guard_2', 'guard_3', 'hunter_1', 'hunter_2', 'hunter_3',
  'seer_1', 'seer_2', 'seer_3', 'seer_4', 'villager_1', 'villager_2', 'villager_3', 'villager_4', 'villager_5',
  'witch_1', 'witch_2', 'witch_3', 'wolf_1', 'wolf_2', 'wolf_3', 'wolf_4', 'wolf_5'];
let allLibText = '';
expFiles.forEach((f) => { allLibText += readFileSync(path.join(expDir, `${f}.md`), 'utf-8') + '\n'; });
const personaNames = ['阿澈', '小满', '青禾', '南枝', '知遥', '听雨', '观棋', '半夏', '云归', '拾壹', '迟迟', '阿岚'];
const nameHits = personaNames.filter((n) => allLibText.includes(n));
assert('任务2 经验库无玩家名', nameHits.length === 0);
assert('任务2 经验库无"昨天"式具体例子', !/昨天|前天|还说要投别人|票总跟在/.test(allLibText));

/* ---------- 任务 3：test-drive mock 池清洗 ---------- */
const td = readFileSync(path.resolve(process.cwd(), 'test-drive.ts'), 'utf-8');
assert('任务3 mock 池无"昨天X还说要投别人"模板', !td.includes('还说要投别人') && !td.includes('昨天'));
assert('任务3 mock 池无"前两天就在划水"模板', !td.includes('前两天'));

/* ---------- 任务 4/5：fallback 变体池 ---------- */
assert('任务4 fallback 变体池 ≥10 种', getFallbackVariantCount() >= 10);

/* ---------- 任务 13：遗言豁免防复读门禁 ---------- */
const phases = getRepeatCheckedPhases();
assert('任务13 遗言不在防复读门禁阶段内', !phases.includes('遗言'));
assert('任务13 门禁仍覆盖轮次/自由讨论/平票争辩', phases.includes('白天发言') && phases.includes('自由讨论') && phases.includes('平票争辩'));

/* ---------- 任务 7/8：好人团队协作 + 神职藏身份规则（提示词） ---------- */
const sysSeer = buildSystemPrompt('seer', '阿澈', players);
const sysVillager = buildSystemPrompt('villager', '小满', players);
assert('任务7 好人侧含【好人团队协作】', sysSeer.includes('【好人团队协作】'));
assert('任务7 神职安全时机传递信息（验人/遗言报身份）', sysSeer.includes('安全时机') && sysSeer.includes('遗言尽量报身份'));
assert('任务8 含【神职藏身份规则】', sysVillager.includes('【神职藏身份规则】'));
assert('任务8 不报信息≠狼面', sysVillager.includes('不算狼面'));
assert('任务8 见风使舵指控必须带依据', sysVillager.includes('必须有具体行为依据'));

/* ---------- 任务 10：夜间结算——已死守卫/女巫不生效 ---------- */
{
  const g = players.find((p) => p.role === 'guardian')!;
  const w = players.find((p) => p.role === 'witch')!;
  const seer = players.find((p) => p.role === 'seer')!;
  // 守卫与女巫都已死，但 nightActions 里残留了"已死角色"的 guard/heal 行动（round10 平安夜 bug 场景）
  const deadPlayers: Player[] = players.map((p) =>
    p.id === g.id || p.id === w.id ? { ...p, isAlive: false } : p
  );
  const res = processNightActions(deadPlayers, [
    { playerId: g.id, action: 'guard', targetId: seer.id },
    { playerId: w.id, action: 'heal', targetId: seer.id },
    { playerId: 'wolf', action: 'kill', targetId: seer.id },
  ]);
  const seerAfter = res.players.find((p) => p.id === seer.id)!;
  assert('任务10 守卫已死 → 残留守人不生效（狼刀仍致死）', seerAfter.isAlive === false);
  assert('任务10 女巫已死 → 残留救人/毒人不生效', res.healed.length === 0 && res.poisoned.length === 0);
}
{
  // 存活女巫 + 存活守卫：正常保护仍生效（回归不破坏原规则）
  const g = players.find((p) => p.role === 'guardian')!;
  const w = players.find((p) => p.role === 'witch')!;
  const seer = players.find((p) => p.role === 'seer')!;
  const res = processNightActions(players, [
    { playerId: g.id, action: 'guard', targetId: seer.id },
    { playerId: w.id, action: 'heal', targetId: seer.id },
    { playerId: 'wolf', action: 'kill', targetId: seer.id },
  ]);
  const seerAfter = res.players.find((p) => p.id === seer.id)!;
  assert('任务10 存活守卫+女巫（同守同救）仍按规则致死', seerAfter.isAlive === false);
}

/* ---------- 任务 11：女巫决策解析容错（v2.4.9 任务7 升级：乱码 → unclear，由引擎按默认决策处理） ---------- */
{
  const d1 = parseWitchDecision('p0');                       // round10 实锤乱码
  const d2 = parseWitchDecision('女巫行动: 救人 小明');
  const d3 = parseWitchDecision('女巫行动: 毒人 大壮');
  const d4 = parseWitchDecision('女巫行动: 跳过');
  const d5 = parseWitchDecision('我今晚想留药，先不用。');
  const d6 = parseWitchDecision('用药: 解药 小明');          // v2.4.9 主格式
  const d7 = parseWitchDecision('用药: 毒药 大壮');
  const d8 = parseWitchDecision('用药: 不用');
  assert('任务11 乱码"p0" → unclear（由引擎按默认决策，不再永远不用药）', d1.action === 'unclear');
  assert('任务11 正常救人格式解析', d2.action === 'heal' && d2.target === '小明');
  assert('任务11 正常毒人格式解析', d3.action === 'poison' && d3.target === '大壮');
  assert('任务11 跳过格式解析', d4.action === 'skip');
  assert('任务11 无格式文本（留药）→ 默认跳过', d5.action === 'skip');
  assert('任务11 用药:解药 格式解析', d6.action === 'heal' && d6.target === '小明');
  assert('任务11 用药:毒药 格式解析', d7.action === 'poison' && d7.target === '大壮');
  assert('任务11 用药:不用 → 跳过', d8.action === 'skip');
}

/* ---------- 任务 12：预言家记忆（不重复查验） ---------- */
{
  const withHistory = buildSeerCheckedListSection(
    {
      nightResults: [], votes: {}, deadPlayers: [],
      playerKnowledge: { 观棋: { name: '观棋', suspiciousLevel: 0, checkResults: [{ day: 1, result: '好人' }] } },
    },
    '阿澈'
  );
  assert('任务12 注入已查验名单（含结果）', withHistory.includes('观棋') && withHistory.includes('好人'));
  assert('任务12 明确禁止重复查验', withHistory.includes('禁止重复查验同一人'));
  const empty = buildSeerCheckedListSection(undefined, '阿澈');
  assert('任务12 首验提示（无历史）', empty.includes('还没查验过任何人'));
  // 离线单机模式：只写 skillUsage → 兜底解析
  const viaSkill = buildSeerCheckedListSection(
    {
      nightResults: [], votes: {}, deadPlayers: [],
      skillUsage: { 阿澈: { '第1晚查验': { result: '查验了南枝，结果：狼人' } } },
    },
    '阿澈'
  );
  assert('任务12 离线 skillUsage 兜底注入已查验名单', viaSkill.includes('南枝') && viaSkill.includes('狼人'));
}

/* ---------- 任务 9：qc.py 无依据指责检测 ---------- */
{
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'qc-verify-248b-'));
  const events = [
    '# 模式 real（真实AI调用）；模板模式为默认',
    '# 身份表 阿澈:wolf, 小满:villager',
    '第1天 阿澈: 小满一直在见风使舵，太可疑了。',
    '第1天 小满: 阿澈在改口，但他说不清具体时间线，很可疑。',
  ].join('\n');
  const f = path.join(tmpDir, 'events.txt');
  writeFileSync(f, events, 'utf-8');
  const r = spawnSync('python', ['qc.py', f], { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const out = r.stdout || '';
  assert('任务9 qc 标记无依据指责（"见风使舵"无依据）', out.includes('无依据指责 1 处'));
  assert('任务9 qc 带依据指责不标记（只 1 处）', !out.includes('无依据指责 2 处'));
}

/* ---------- 任务 15：局势摘要（test-drive 每日输出） ---------- */
{
  // 从项目根运行（node_modules 在项目内）；npx 是 .cmd shim，spawnSync 无法直接拉起 → 用 node + tsx cli 直接跑
  const tsxCli = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const r = spawnSync(process.execPath, [tsxCli, 'test-drive.ts', '6'],
    { cwd: process.cwd(), encoding: 'utf-8', env: { ...process.env }, timeout: 120000 });
  if (r.status !== 0) {
    console.error('  [test-drive stderr]', (r.stderr || '').slice(0, 400));
    console.error('  [test-drive error]', r.error ? String(r.error).slice(0, 200) : '');
    assert('任务15 test-drive 正常运行生成局势摘要', false);
  } else {
    const lines = readFileSync(path.join(process.cwd(), 'qc_events.txt'), 'utf-8').split('\n');
    const summaries = lines.filter((l) => l.includes('局势摘要'));
    assert('任务15 每日局势摘要写入事件日志', summaries.length >= 1);
    assert('任务15 局势摘要含存活人数', summaries[0].includes('场上存活'));
    assert('任务15 第1天不再出现"昨天"式发言', !lines.some((l) => /昨天/.test(l)));
  }
}

console.log(`\n[verify-248b] ${pass} 断言通过，${fail} 断言失败`);
process.exit(fail > 0 ? 1 : 0);
