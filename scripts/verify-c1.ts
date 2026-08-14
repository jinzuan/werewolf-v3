/**
 * scripts/verify-c1.ts — v2.4.5-C 复读拦截加强 断言验证（WEREWOLF_FIXES_v2.4.5-C.md 任务 C1/C2）
 *
 * 验证点：
 *  1. 整句 verbatim（sim≥0.9 且两方骨架均≥15字）→ level='hard'（运行时硬门禁触发条件）
 *  2. 换名/加前缀同模板 → 判定撞模板（阈值提高为 ≥0.75 后仍拦得住）
 *  3. 短句 verbatim（<15字）→ 只判 soft（不误禁短自然句）
 *  4. 不同内容 / 短句常见短语 → 不撞
 *  5. 同玩家跨天 → 命中该玩家历史窗口（跨天仍拦）
 *  6. qc.py 模式解析：`# 模式 real（真实AI调用）；模板模式为默认` → 结论计入跨玩家复读（real 标红）
 *  7. qc.py ①.9 口径：整句级 verbatim 判红、跨天去重只报首次、逗号残片不算处、模板模式不计入结论
 *
 * 运行：npx tsx scripts/verify-c1.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// ---------- 1~5：aiClient 运行时模板比对 ----------

// 1. 整句 verbatim（≥15字）→ hard 硬门禁
reset();
pushSpeechForRepeatCheck('阿澈', '我觉得小满今天发言有点问题，我怀疑他是狼。', 1);
const h1 = checkSpeechTemplateCollision('我觉得青禾今天发言有点问题，我怀疑他是狼。', NAMES, '迟迟');
assert('整句 verbatim（≥15字）→ level=hard（直接禁发条件）', h1.collided === true && h1.level === 'hard');

// 2. 金钻句式（昨天X改口，换名）→ 仍撞，verbatim 硬门禁
reset();
pushSpeechForRepeatCheck('阿澈', '昨天小满还说要投别人，今天改口改得飞快，时间线对不上。', 1);
const h2 = checkSpeechTemplateCollision('昨天青禾还说要投别人，今天改口改得飞快，时间线对不上。', NAMES, '迟迟');
assert('金钻句式（昨天X改口）跨玩家撞模板 → level=hard', h2.collided === true && h2.level === 'hard');

// 3. 短句 verbatim（<15字）→ 只判 soft，不误禁
reset();
pushSpeechForRepeatCheck('阿澈', '其实我觉得小满今天的发言特别奇怪，前后矛盾，很可疑。', 1);
const h3 = checkSpeechTemplateCollision('小满今天的发言特别奇怪', NAMES, '迟迟');
assert('短句 verbatim（<15字）→ level=soft（不触发硬门禁）', h3.collided === true && h3.level === 'soft');

// 4. 不同内容 / 短句常见短语 → 不撞
reset();
pushSpeechForRepeatCheck('阿澈', '我昨晚验了知遥，是好人，今天重点关注票型。', 1);
const h4 = checkSpeechTemplateCollision('我听了一圈，大家先别急着归票，我还在理时间线。', NAMES, '小满');
assert('不同内容不撞模板', h4.collided === false);
reset();
pushSpeechForRepeatCheck('南枝', '我觉得大家说得都有道理。', 1);
const h4b = checkSpeechTemplateCollision('我再想想，先听听其他人的意见。', NAMES, '青禾');
assert('短句/常见短语不误报', h4b.collided === false);

// 5. 同玩家跨天 → 命中历史窗口（近期窗口被挤掉仍拦）
reset();
pushSpeechForRepeatCheck('云归', '这事就像下棋，我觉得阿澈今天的说法前后矛盾。', 1);
for (let i = 0; i < 62; i++) {
  pushSpeechForRepeatCheck(`旁白${i % 9}`, `第${i}号发言，内容完全无关的背景填充句子。`, 2);
}
const h5 = checkSpeechTemplateCollision('这事就像下棋，我觉得青禾今天的说法前后矛盾。', NAMES, '云归');
assert('同玩家跨天重复被拦截（历史窗口命中）', h5.collided === true && h5.collidedWith === '云归');

// ---------- 6~7：qc.py 模式解析 + ①.9 口径 ----------

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'qc-verify-c1-'));

const runQc = (eventsContent: string): string => {
  const eventsFile = path.join(tmpDir, `events-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(eventsFile, eventsContent, 'utf-8');
  const r = spawnSync('python', ['qc.py', eventsFile], { encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.status !== 0) {
    console.error('  [qc.py stderr]', r.stderr);
  }
  return r.stdout || '';
};

const REAL_LINE = '# 模式 real（真实AI调用）；模板模式为默认';

// 6. 模式解析：real 注释行被正确解析 → ①.9 标红 + 结论计入（回归：原 line.split()[-1] 取到"为默认"）
const verbatimCrossDay = [
  '第1天 阿澈: 我觉得青禾今天发言有点问题，我怀疑他是狼。',
  '第1天 青禾: 我觉得阿澈今天发言有点问题，我怀疑他是狼。',
  '第2天 南枝: 我觉得阿岚今天发言有点问题，我怀疑他是狼。',
  '第2天 阿岚: 我觉得南枝今天发言有点问题，我怀疑他是狼。',
].join('\n');

const outReal = runQc(`${REAL_LINE}\n${verbatimCrossDay}\n`);
assert('qc 模式解析 real：①.9 标红检测到复读 1 处', outReal.includes('检测到跨玩家同模板复读 1 处'));
assert('qc 模式解析 real：跨天去重只报首次（第1天阿澈/青禾）', outReal.includes('第1天 阿澈, 青禾'));
assert('qc 结论计入跨玩家复读（real 模式）', outReal.includes('1 处跨玩家同模板复读'));

// 7a. 模板模式（无 模式 real 行）：跨玩家同模板属预期 mock 噪音，不计入结论
const outTpl = runQc(`${verbatimCrossDay}\n`);
assert('qc 模板模式：①.9 提示模板池复用（不计入）', outTpl.includes('模板模式有限模板池复用属预期'));
assert('qc 模板模式：结论不计入跨玩家复读', !outTpl.includes('跨玩家同模板复读'));

// 7b. 逗号残片共享但整句不同 → 不算"处"（消除拆句虚高）
const commaFragmentOnly = [
  '第1天 阿澈: 我今天心情不错，想去买个奶茶。',
  '第1天 青禾: 我今天心情不错，去爬了个山。',
].join('\n');
const outFrag = runQc(`${REAL_LINE}\n${commaFragmentOnly}\n`);
assert('qc 逗号残片不算"处"（整句级判一次）', outFrag.includes('未检测到跨玩家同模板复读'));

// 7c. 事实推理豁免：平安夜/女巫 自然推理（无攻击结构）→ 不判同模板
const factReasoning = [
  '第1天 阿澈: 昨晚平安夜，女巫肯定用了解药，守卫也守了一手。',
  '第1天 青禾: 昨晚平安夜，女巫肯定用了解药，大家都能想到。',
].join('\n');
const outFact = runQc(`${REAL_LINE}\n${factReasoning}\n`);
assert('qc 事实词豁免（平安夜/女巫自然推理不判）', outFact.includes('未检测到跨玩家同模板复读'));

console.log(`\n[verify-c1] ${pass} 断言通过，${fail} 断言失败`);
process.exit(fail > 0 ? 1 : 0);
