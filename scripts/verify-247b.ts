/**
 * scripts/verify-247b.ts — v2.4.7b 好人单数提前终局 断言验证（WEREWOLF_FIXES_v2.4.7b.md）
 *
 * 验证点：
 *  1. 白天票完好人剩 1（1 平民 + 3 狼）→ checkGoodOneLeftWin 判狼胜（终局进复盘）
 *  2. 正常局（好人 >1，如 2 平民 + 2 狼）→ 不提前终局
 *  3. 好人剩 1 但狼人 0 → 不判（正常局好人胜），checkWinCondition 仍判 good
 *  4. 好人 0 + 狼 ≥1 → checkWinCondition 屠边判狼胜（不受本批跳过影响）
 *  5. 夜晚语义：checkWinCondition 在好人剩 1 时返回 wolf，但引擎层 checkWinner 会跳过该
 *     判定（保留白天抢救空间）——此处用 checkGoodOneLeftWin + 引擎 skip 语义对照验证
 *
 * 运行：npx tsx scripts/verify-247b.ts
 */
import { checkWinCondition, checkGoodOneLeftWin } from '../src/utils/gameLogic';
import type { Player, Role } from '../src/types';

let pass = 0;
let fail = 0;

const assert = (name: string, cond: boolean) => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}`);
  }
};

let seq = 0;
const mk = (name: string, role: Role, alive = true): Player => ({
  id: `p${++seq}`,
  roomId: 'r-test',
  name,
  isAI: true,
  role,
  isAlive: alive,
  isHost: false,
  order: seq,
});

const alive = (players: Player[]) => players.filter((p) => p.isAlive);

// 1. 好人剩 1（1 平民 + 3 狼）→ 白天票完直接判狼胜
{
  const players = [mk('张三', 'villager'), mk('狼1', 'wolf'), mk('狼2', 'wolf'), mk('狼3', 'wolf')];
  assert('好人剩1+狼≥1 → 判狼胜（白天票完终局）', checkGoodOneLeftWin(alive(players)) === 'wolf');
}

// 2. 正常局（好人 >1）不提前终局
{
  const players = [mk('张三', 'villager'), mk('李四', 'seer'), mk('狼1', 'wolf'), mk('狼2', 'wolf')];
  assert('好人2+狼2 → 不提前终局', checkGoodOneLeftWin(alive(players)) === null);
}

// 3. 好人剩 1 但狼人 0 → 好人胜（checkWinCondition 仍判 good）
{
  const players = [mk('张三', 'villager'), mk('狼1', 'wolf', false), mk('狼2', 'wolf', false)];
  assert('好人1+狼0 → 不判提前终局', checkGoodOneLeftWin(alive(players)) === null);
  assert('好人1+狼0 → 好人胜', checkWinCondition(alive(players)) === 'good');
}

// 4. 好人 0 + 狼 ≥1 → 屠边狼胜（不受跳过影响）
{
  const players = [mk('狼1', 'wolf'), mk('狼2', 'wolf'), mk('狼3', 'wolf')];
  assert('好人0+狼3 → 屠边判狼胜', checkWinCondition(alive(players)) === 'wolf');
  assert('好人0 → 不触发提前终局分支', checkGoodOneLeftWin(alive(players)) === null);
}

// 5. 夜晚语义对照：checkWinCondition 会判 wolf（屠边），但该情形即引擎 checkWinner 的跳过对象
{
  const players = [mk('张三', 'seer'), mk('狼1', 'wolf'), mk('狼2', 'wolf')];
  const w = checkWinCondition(alive(players));
  const skipNight = w === 'wolf' && checkGoodOneLeftWin(alive(players)) === 'wolf';
  assert('好人1+狼2：checkWinCondition=wolf 且被引擎夜晚路径跳过（保留白天）', skipNight === true);
}

// 6. 平票 PK 后语义：PK 结果同为"白天票完"，仍走同一判定（好人剩1判狼胜）
{
  const players = [mk('张三', 'hunter'), mk('狼1', 'wolf'), mk('狼2', 'wolf')];
  assert('PK 后好人剩1 → 判狼胜', checkGoodOneLeftWin(alive(players)) === 'wolf');
}

console.log(`\n[verify-247b] ${pass} 断言通过，${fail} 断言失败`);
process.exit(fail > 0 ? 1 : 0);
