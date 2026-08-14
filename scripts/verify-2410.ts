/**
 * scripts/verify-2410.ts — v2.4.10 任务 1/2/3 断言验证
 * （依据 WEREWOLF_FIXES_v2.4.10.md）
 *
 * 验证点：
 *  1.  逻辑梳理机制：aiClient 提示词新增【逻辑梳理】段（捋配额/禁止纯感觉怀疑）；
 *      engine 每日指定捋人（sorterId）+ 轮换（lastSorterId）；捋人字数放宽到 ≤300
 *  2.  局势摘要时序：第N天摘要 = 第N-1晚及之前的死亡（engine 过滤 day ≤ N-1，test-drive 过滤 day ≤ N）；
 *      模拟局第N天摘要含 night-N 死亡（round13 off-by-one 修正：night-N 与 day-N 共用同一 day，day-N 摘要须含 night-N 死亡）
 *  3.  小项确认：守卫守护事件日志行补齐（test-drive 第N晚 守卫守护 X；engine 人类守卫日志）
 *
 * 运行：npx tsx scripts/verify-2410.ts
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const { SORTER_MAX } = await import('../src/utils/aiClient');

/* ---------- 任务 1：逻辑梳理机制（提示词 + 配额 + 捋人轮换） ---------- */
{
  const ai = readFileSync(path.resolve(process.cwd(), 'src', 'utils', 'aiClient.ts'), 'utf-8');
  const engine = readFileSync(path.resolve(process.cwd(), 'server', 'engine.ts'), 'utf-8');
  const types = readFileSync(path.resolve(process.cwd(), 'src', 'types', 'index.ts'), 'utf-8');
  const gl = readFileSync(path.resolve(process.cwd(), 'src', 'utils', 'gameLogic.ts'), 'utf-8');

  assert('任务1 捋人字数上限 SORTER_MAX = 300', SORTER_MAX === 300);
  assert('任务1 提示词含【逻辑梳理】段', ai.includes('【逻辑梳理】'));
  assert('任务1 提示词鼓励"我给大家捋一下"', ai.includes('我给大家捋一下'));
  assert('任务1 禁止纯感觉怀疑（必须有推理链）', ai.includes('禁止纯感觉怀疑') && ai.includes('推理链'));
  assert('任务1 捋配额：每天最多 1 人做捋', ai.includes('每天最多 1 人做捋'));
  assert('任务1 捋人不连天同一人（轮换）', ai.includes('不连天同一人'));
  assert('任务1 捋人提示词放宽到 ≤300 字', ai.includes('≤300 字'));
  assert('任务1 buildSystemPrompt 含捋配额规则', ai.includes('v2.4.10 捋配额'));
  assert('任务1 engine 每日指定捋人（sorterId）', engine.includes('sorterId'));
  assert('任务1 engine 捋人轮换（lastSorterId 排除上一天捋人）', engine.includes('lastSorterId') && engine.includes('prevSorter'));
  assert('任务1 engine callDaySpeech 传 isSorter', engine.includes('dayPhase.sorterId === p.id'));
  assert('任务1 DayPhaseState 含 sorterId', types.includes('sorterId: string | null'));
  assert('任务1 GameState 含 lastSorterId', types.includes('lastSorterId: string | null'));
  assert('任务1 createInitialGameState 初始化捋人字段', gl.includes('sorterId: null') && gl.includes('lastSorterId: null'));
}

/* ---------- 任务 2：局势摘要时序修复 ---------- */
{
  const engine = readFileSync(path.resolve(process.cwd(), 'server', 'engine.ts'), 'utf-8');
  const td = readFileSync(path.resolve(process.cwd(), 'test-drive.ts'), 'utf-8');

  assert('任务2 engine 摘要只含上一晚结束前死亡（cutoffDay 过滤）', engine.includes('cutoffDay') && engine.includes('d.day <= cutoffDay'));
  assert('任务2 engine 摘要标签含"截至上一晚结束"', engine.includes('截至上一晚结束已出局'));
  assert('任务2 test-drive 摘要过滤 d.day <= day', td.includes('d.day <= day'));
  assert('任务2 test-drive 摘要标签含"截至上一晚结束"', td.includes('截至上一晚结束已出局'));
  assert('任务2 test-drive real 模式注入 situationSummary', td.includes('realHistory.situationSummary = summary'));
}

/* ---------- 任务 3：守卫守护日志 + 女巫缺失确认 ---------- */
{
  const td = readFileSync(path.resolve(process.cwd(), 'test-drive.ts'), 'utf-8');
  const engine = readFileSync(path.resolve(process.cwd(), 'server', 'engine.ts'), 'utf-8');

  assert('任务3 test-drive 守卫守护事件落日志', td.includes('第${day}晚 守卫守护') && td.includes('守卫空守'));
  assert('任务3 engine 人类守卫行动落日志', engine.includes('守卫守护了 ${target.name}'));
}

/* ---------- 模拟局实测：捋发言 + 摘要时序 + 守卫日志 ---------- */
{
  const tsxCli = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  // 固定种子保证多天对局（12 人 + seed 20260812 → 第5晚结束，跨多天）
  const r = spawnSync(process.execPath, [tsxCli, 'test-drive.ts', '12'],
    { cwd: process.cwd(), encoding: 'utf-8', env: { ...process.env, WW_SEED: '20260812' }, timeout: 120000 });
  if (r.status !== 0) {
    console.error('  [test-drive stderr]', (r.stderr || '').slice(0, 400));
    console.error('  [test-drive error]', r.error ? String(r.error).slice(0, 200) : '');
    assert('实测 模拟局正常运行', false);
  } else {
    const lines = readFileSync(path.join(process.cwd(), 'qc_events.txt'), 'utf-8').split('\n');

    // —— 任务1：出现"捋一下"式梳理发言 + 每天最多 1 人做捋（配额） ——
    const sortLines = lines.filter((l) => l.includes('捋一下'));
    assert('任务1 模拟局出现"捋一下"式梳理发言', sortLines.length >= 1);
    const sortDays = sortLines.map((l) => {
      const m = l.match(/^第(\d+)天/);
      return m ? Number(m[1]) : null;
    }).filter((d): d is number => d !== null);
    const sortByDay = new Map<number, number>();
    sortDays.forEach((d) => sortByDay.set(d, (sortByDay.get(d) || 0) + 1));
    const quotaOk = [...sortByDay.values()].every((c) => c <= 1);
    assert('任务1 每白天至多 1 人做捋（配额）', sortDays.length === 0 || quotaOk);

    // —— 任务3：守卫守护事件日志行出现 ——
    assert('任务3 模拟局出现守卫守护事件行', lines.some((l) => /守卫守护|守卫空守/.test(l)));

    // —— 任务2（v2.4.11 修正语义）：第N天摘要 = 截至 night-N 结束的公开死亡 ——
    //   · 须包含 night-N 死亡（round13 要求 day-1 含 night-1 死亡，修复 off-by-one）；
    //   · 不得包含 day-N 投票/枪杀死亡（发生在摘要生成之后，属"当天信息"，不应提前注入）；
    //   · 不得包含 night-(N+1) 死亡（尚未发生）。
    const summaryRe = /^第(\d+)天\[局势摘要\].*已出局 (\d+) 人（([^）]*)）/;
    const summaries: Array<{ day: number; names: string[] }> = [];
    lines.forEach((l) => {
      const m = l.match(summaryRe);
      if (m) summaries.push({ day: Number(m[1]), names: m[3] === '无' ? [] : m[3].split('、') });
    });
    assert('任务2 模拟局生成 ≥1 天局势摘要', summaries.length >= 1);

    // 分别收集：night-N 死亡（第N晚 死亡）、day-N 投票/枪杀死亡（第N天 被投票出局/死亡）
    const nightDeadOnDay: Record<number, string[]> = {};
    const voteDeadOnDay: Record<number, string[]> = {};
    lines.forEach((l) => {
      const night = l.match(/【公告】第(\d+)晚 死亡：([^（\s]+)/);
      const dayD = l.match(/【公告】第(\d+)天 (?:被投票出局|死亡)：([^（\s]+)/);
      if (night) {
        const d = Number(night[1]);
        (nightDeadOnDay[d] = nightDeadOnDay[d] || []).push(night[2]);
      }
      if (dayD) {
        const d = Number(dayD[1]);
        (voteDeadOnDay[d] = voteDeadOnDay[d] || []).push(dayD[2]);
      }
    });

    let timingOk = true;
    summaries.forEach((s) => {
      // 1) 必须含 night-s.day 死亡（off-by-one 修复：day-1 摘要须含 night-1 死亡）
      const missingNight = (nightDeadOnDay[s.day] || []).filter((n) => !s.names.includes(n));
      if (missingNight.length > 0) {
        timingOk = false;
        console.error(`  [摘要时序] 第${s.day}天摘要缺 night-${s.day} 死亡：${missingNight.join('、')}`);
      }
      // 2) 不得含 day-s.day 投票/枪杀死亡（当天信息，摘要生成于投票前）
      const leakedVote = (voteDeadOnDay[s.day] || []).filter((n) => s.names.includes(n));
      if (leakedVote.length > 0) {
        timingOk = false;
        console.error(`  [摘要时序] 第${s.day}天摘要泄漏当天投票/枪杀死亡：${leakedVote.join('、')}`);
      }
      // 3) 不得含 night-(s.day+1) 死亡（尚未发生）
      const leakedNextNight = (nightDeadOnDay[s.day + 1] || []).filter((n) => s.names.includes(n));
      if (leakedNextNight.length > 0) {
        timingOk = false;
        console.error(`  [摘要时序] 第${s.day}天摘要泄漏次晚死亡：${leakedNextNight.join('、')}`);
      }
    });
    assert('任务2 第N天摘要含 night-N 死亡、不含当天投票/枪杀及次晚死亡', timingOk);
  }
}

console.log(`\n[verify-2410] ${pass} 断言通过，${fail} 断言失败`);
process.exit(fail > 0 ? 1 : 0);
