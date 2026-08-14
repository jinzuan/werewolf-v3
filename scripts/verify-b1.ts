/**
 * scripts/verify-b1.ts — v2.4.5-B 复读拦截升级 + 投票理由硬门禁 断言验证（WEREWOLF_FIXES_v2.4.5-B.md 任务 X1/X2）
 *
 * 验证点：
 *  1. 换名/加前缀的同模板 → 判定撞模板（句级相似度 ≥0.6 + 前缀口头禅剥离，不再假阴性）
 *  2. 同玩家跨天重复 → 判定撞模板（溢出近期窗口后仍命中该玩家历史窗口）
 *  3. 无理由票 → 强制补理由（按承诺 / 改票必须给明确理由）
 *  4. 投票理由撞模板 → 换说法（理由去重）
 *  5. 不同内容 / 短句 → 不误报
 *
 * 运行：npx tsx scripts/verify-b1.ts
 */
import {
  resetSpeechRepeatCache,
  pushSpeechForRepeatCheck,
  checkSpeechTemplateCollision,
  ensureVoteReason,
} from '../src/utils/aiClient';

const NAMES = ['阿澈', '小满', '青禾', '南枝', '知遥', '听雨', '观棋', '半夏', '云归', '拾壹', '迟迟', '阿岚'];
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

const reset = () => {
  resetSpeechRepeatCache();
};

// 1. 换名 + 加前缀的同模板 → 拦截（背景 4 组假阴性样本之一：X对每个人都笑呵呵…最可疑）
reset();
pushSpeechForRepeatCheck('阿澈', '我对每个人都笑呵呵，从不得罪人，这种谁都不得罪的最可疑。', 1);
const r1 = checkSpeechTemplateCollision('我觉得对每个人都笑呵呵，从不得罪人，这种谁都不得罪的最可疑。', NAMES, '迟迟');
assert('换名+加前缀同模板被拦截（≥0.6 + 前缀剥离）', r1.collided === true && r1.collidedWith === '阿澈');

// 1b. "我信息太少，这轮我不做判断了" ×多人（背景样本）
reset();
pushSpeechForRepeatCheck('小满', '我信息太少，这轮我不做判断了，你们看着投吧。', 1);
const r1b = checkSpeechTemplateCollision('说真的，我信息太少，这轮我不做判断了。', NAMES, '拾壹');
assert('"我信息太少…不做判断"同模板（加前缀）被拦截', r1b.collided === true && r1b.collidedWith === '小满');

// 2. 同玩家跨天 → 拦截：先灌 62 条别的发言把近期窗口挤掉，该玩家历史仍在历史窗口可查
reset();
pushSpeechForRepeatCheck('云归', '这事就像下棋，我觉得阿澈今天的说法前后矛盾。', 1);
for (let i = 0; i < 62; i++) {
  pushSpeechForRepeatCheck(`旁白${i % 9}`, `第${i}号发言，内容完全无关的背景填充句子。`, 2);
}
const r2 = checkSpeechTemplateCollision('这事就像下棋，我觉得青禾今天的说法前后矛盾。', NAMES, '云归');
assert('同玩家跨天重复被拦截（近期窗口被挤掉后仍命中自己历史）', r2.collided === true && r2.collidedWith === '云归');

// 3. 投票理由强制 + 承诺绑定
const re1 = ensureVoteReason('半夏', '', '我投迟迟，这轮就他了。', NAMES);
assert('承诺投迟迟却投半夏且无理由 → 强制补改票理由', re1.includes('改票') && re1.includes('迟迟') && re1.length > 0);
const re2 = ensureVoteReason('迟迟', '', '我投迟迟，这轮就他了。', NAMES);
assert('按承诺投迟迟无理由 → 补承诺理由', re2.includes('按承诺投迟迟'));
const re3 = ensureVoteReason('阿澈', '', '', NAMES);
assert('完全无理由无承诺 → 补综合判断理由', re3.includes('阿澈') && re3.length > 0);

// 4. 投票理由撞模板 → 换说法（理由去重）
reset();
const r4a = ensureVoteReason('阿澈', '综合判断，阿澈嫌疑最大。', '', NAMES);
const r4b = ensureVoteReason('小满', '综合判断，小满嫌疑最大。', '', NAMES);
assert('理由撞模板后换说法（不再复用同款句式）', r4a !== r4b && r4a.includes('阿澈') && r4b.includes('小满') && !r4b.includes('综合判断'));

// 5. 不同内容 / 短句 → 不误报
reset();
pushSpeechForRepeatCheck('阿澈', '我昨晚验了知遥，是好人，今天重点关注票型。', 1);
const r5 = checkSpeechTemplateCollision('我听了一圈，大家先别急着归票，我还在理时间线。', NAMES, '小满');
assert('不同内容不撞模板', r5.collided === false);
reset();
pushSpeechForRepeatCheck('南枝', '我觉得大家说得都有道理。', 1);
const r6 = checkSpeechTemplateCollision('我再想想，先听听其他人的意见。', NAMES, '青禾');
assert('短句/常见短语不误报', r6.collided === false);

console.log(`\n[verify-b1] ${pass} 断言通过，${fail} 断言失败`);
process.exit(fail > 0 ? 1 : 0);
