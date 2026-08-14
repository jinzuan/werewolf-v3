/**
 * scripts/verify-a1.ts — v2.4.5-A A1 复读硬拦截 断言验证（WEREWOLF_FIXES_v2.4.5-A.md）
 *
 * 验证点：
 *  1. 跨玩家同模板（只换名字）→ 判定撞模板
 *  2. 金钻反馈的固定句式「昨天X还说要投别人，今天改口改得飞快」×多人 → 判定撞模板
 *  3. 不同内容 → 不撞模板
 *  4. 短句/常见短语 → 不误报
 *  5. 比对窗口可增长（pushSpeechForRepeatCheck 生效）
 *
 * 运行：npx tsx scripts/verify-a1.ts
 */
import {
  resetSpeechRepeatCache,
  pushSpeechForRepeatCheck,
  checkSpeechTemplateCollision,
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

reset();
// 1. 同模板换名字 → 撞
pushSpeechForRepeatCheck('小满', '我觉得阿澈今天发言有点问题，我怀疑他是狼。');
const r1 = checkSpeechTemplateCollision('我觉得青禾今天发言有点问题，我怀疑他是狼。', NAMES);
assert('同模板换名字判定撞模板（相似度≥0.7）', r1.collided === true && r1.collidedWith === '小满');

// 2. 金钻反馈固定句式 ×2 人 → 撞
reset();
pushSpeechForRepeatCheck('阿澈', '昨天小满还说要投别人，今天改口改得飞快，时间线对不上。');
const r2 = checkSpeechTemplateCollision('昨天青禾还说要投别人，今天改口改得飞快，时间线对不上。', NAMES);
assert('金钻句式（昨天X改口）跨玩家撞模板', r2.collided === true && r2.collidedWith === '阿澈');

// 3. 不同内容 → 不撞
reset();
pushSpeechForRepeatCheck('小满', '我觉得局势越来越明朗了，大家要冷静分析。');
const r3 = checkSpeechTemplateCollision('我昨晚验了知遥，是好人。今天票型我重点关注青禾。', NAMES);
assert('不同内容不撞模板', r3.collided === false);

// 4. 短句/常见短语不误报
reset();
pushSpeechForRepeatCheck('阿澈', '我觉得大家说得都有道理。');
const r4 = checkSpeechTemplateCollision('我再想想，先听听其他人的意见。', NAMES);
assert('短句常见短语不误报', r4.collided === false);

// 5. 窗口可增长（第二条也能被比对到）
reset();
pushSpeechForRepeatCheck('小满', '我信息少，先听别人说吧。');
pushSpeechForRepeatCheck('南枝', '这轮我一直觉得知遥在带节奏，票型很怪。');
const r5 = checkSpeechTemplateCollision('这轮我也觉得知遥在带节奏，票型很怪。', NAMES);
assert('比对窗口可增长（命中窗口内第二条）', r5.collided === true && r5.collidedWith === '南枝');

// 6. 名称最长优先屏蔽（不误伤子串）
reset();
pushSpeechForRepeatCheck('阿澈', '小满今天的发言很怪。');
const r6 = checkSpeechTemplateCollision('青禾今天的发言很怪。', NAMES);
assert('名字屏蔽后纯名字差异判定撞模板', r6.collided === true);

console.log(`\n[verify-a1] ${pass} 断言通过，${fail} 断言失败`);
process.exit(fail > 0 ? 1 : 0);
