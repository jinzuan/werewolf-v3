#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qc.py — 狼人杀 AI 对局质检 v2.4.9（v2.4.6 P1：real 模式剔除 [mock] 自由讨论 mock 行；v2.4.9 任务8：排除门禁标记行）

输入：test-drive.ts 生成的 events 文件（默认 qc_events.txt，可用参数指定）
输出：
  ① 发言质量：grep 套话模式并统计占比（"我是好人"裸用才判套话，带信息不算）
     - 每玩家套话率 + 全局套话率，>15% 标红警告
     - 同一玩家同一模板重复 ≥2 次 → 加重标记
     - v2.4：多行发言合并为单行（QC 能读全，含承诺）
  ①.9 跨玩家同模板（v2.4.5-B X1.3 升级，消除假阴性）：
     - 句级骨架 = 去前缀口头禅 + 屏蔽所有玩家名→{P} + 去标点/语气词
     - 本轮+上轮窗口内两两比较字符 Jaccard/子串相似度 ≥0.6 → 判同模板（换名/加前缀不再漏）
     - 同玩家跨天：该玩家历史发言窗口同样按句级相似度 ≥0.6 判重复
  ①.9b 投票理由（v2.4.5-B X2）：无理由票 = 0（硬门禁）；理由同模板（骨架相似度 ≥0.6）标黄
  ② 言行一致：按"承诺目标 vs 实际投票"判定——
     - 承诺 = 投票 → 一致 ✅
     - 承诺 ≠ 投票 且有理由 → [合理变更]（金钻定调：言行不一可接受，投票有推理支撑即可）
     - 承诺 ≠ 投票 无理由 → [问题]（硬门禁）
     - 无明确承诺时退回"发言指向 vs 投票"：狼人 → [策略]（合法），好人 → [问题]/[合理变更]
     - v2.4：投票事件解析理由（第N天 X 投→Y（理由：...））；PK 行独立解析，正确排除自投

用法：python qc.py [events文件]
"""
import sys
import re
from collections import defaultdict

EVENTS_FILE = sys.argv[1] if len(sys.argv) > 1 else "qc_events.txt"

# 行格式
# 第N天 PK X: 全文（PK 争辩，独立处理）
PK_SPEECH_RE = re.compile(r"^第(\d+)天\s+PK\s+(.+?)[:：]\s*(.*)$")
# 第N天 X: 全文
SPEECH_RE = re.compile(r"^第(\d+)天\s+(.+?)[:：]\s*(.*)$")
# 第N天 X 投→Y / 第N天 X PK投→Y / 带理由（第N天 X 投→Y（理由：...））
VOTE_RE = re.compile(r"^第(\d+)天\s+(.+?)\s+(?:PK)?投→(.+?)(?:\s*（理由[:：]?\s*(.*)）)?\s*$")
IDENTITY_RE = re.compile(r"^#\s*身份表\s+(.+)$")                 # # 身份表 阿澈:wolf, 小满:villager, ...
PERSONA_RE = re.compile(r"^#\s*人设表\s+(.+)$")                   # # 人设表 阿澈:小满, 青禾:南枝, ...（玩家→人设名，v2.4.2 人设核验）
# v2.4.3 自由讨论事件：第N天[自由讨论] 插话/跳过/配额/全员跳过（test-drive 模拟输出）
FREE_DISCUSS_RE = re.compile(r"^第(\d+)天\[自由讨论\]\s*(.*)$")
# v2.4.4 遗言：第N天 X 遗言: ...（被票出局必留遗言，猎人枪前也有遗言）
LAST_WORDS_RE = re.compile(r"^第(\d+)天\s+(.+?)\s+遗言[:：]\s*(.*)$")
# v2.4.4 死讯公告：/【公告】第N晚 死亡：X（狼刀）|第N天 死亡：X（猎人枪）/
ANNOUNCE_DEATH_RE = re.compile(r"^【公告】第(\d+)(晚|天)\s*死亡[:：]?\s*(.+?)（(.+?)）")
# v2.4.4 出局公告：/【公告】第N天 被投票出局：X/
ANNOUNCE_VOTEOUT_RE = re.compile(r"^【公告】第(\d+)天\s*被投票出局[:：]?\s*(.+)$")
# v2.4.4 重复刀行检测：狼人刀杀行（每晚应仅 1 行；不应再出现旧的"选择击杀"）
WOLF_KILL_RE = re.compile(r"^第(\d+)晚\s+狼人刀杀")
LEGACY_SELECT_KILL_RE = re.compile(r"选择击杀")

# v2.4.5-C C1.1：模式标识。行格式 `# 模式 real（真实AI调用）；模板模式为默认`，
# 必须用 re.match 取模式名——原 `line.split()[-1]` 会取到行尾注释（"为默认"），导致 real 恒判失败（83 处漏报）
MODE_RE = re.compile(r"^#\s*模式\s+([^\s（(]+)")

# v2.4.6 P1 兼容：旧日志自由讨论 mock 标记（新日志使用结构化 source 字段）
MOCK_MARKER = "[mock]"
SOURCE_RE = re.compile(r"^#\s*source\s+(real_ai|template)\s*$")

# v2.4.9 任务8：门禁标记行（aiClient 硬门禁输出"（与XX发言高度重复，简略表态）"）——
# 不是真实发言，是防复读拦截的占位，QC 统计时必须排除（防 ①.5/①.9 把占位当模板计数污染指标）
GATE_MARKER_RE = re.compile(r"高度重复.*简略表态|简略表态.*高度重复")

def strip_mock(text):
    """剥离发言行尾 [mock] 标记。返回 (纯净文本, 是否带标记)。模板模式下保留该行（仅去掉标记）；real 模式下由调用方剔除。"""
    t = text
    is_mock = t.endswith(MOCK_MARKER)
    if is_mock:
        t = t[: -len(MOCK_MARKER)].strip()
    return t, is_mock

# v2.4.5-C C1.2：事实词豁免——含 平安夜/守卫/女巫/解药/验人 且无攻击/双关结构 → 自然推理降权（不判同模板）
FACT_REASONING_WORDS = re.compile(r"平安夜|守卫|女巫|解药|验人")
FACT_ATTACK_MARKERS = re.compile(r"[？?]|难道|还是说|莫不是|你是在|阴阳|反讽|暗示|打掩护|装好人|双关|串通|共边|互踩|保谁|在洗|带节奏")

# 事件行（非发言/非投票）特征：命中即视为对局事件行，不并入发言
META_EVENT_MARKERS = ("平票", "游戏结束", "无人得票", "被投票出局", "被票开枪", "PK 出局", "PK 再平票", "遗言后开枪")

# 有效信息词：一句里有这些就算"带了信息"，不再判为"我是好人"裸用套话
VALID_INFO_PATTERNS = re.compile(
    r"(验人|查验|查杀|金水|银水|第\d+晚|第一晚|昨晚|时间线|票型|号票|投|对跳|"
    r"逻辑|推理|分析|怀疑|像狼|是狼|可疑|带节奏|视角|刀法|遗言|双死|平安夜|矛盾)"
)

# ① 套话模式（"我是好人"裸用 / 空话 / 无信息 / 跟票随大流）
#    注意：本表不含 "我是好人" 直接匹配——"我是好人" 的判定走 SPECIAL_HANDLERS。
TEMPLATE_PATTERNS = [
    ("无信息空话", re.compile(r"(没什么|没有)(特别|太多)?(信息|头绪|想法|线索)")),
    ("万能捧场句", re.compile(r"大家(分析|说得|说)得?都(对|有道理)")),
    ("我再看看/听听", re.compile(r"(再听听|再看看|再想想|继续听听|还在观察|先观察|先听听)")),
    ("不急着下结论", re.compile(r"(别急着|不要急着|不急着)(下结论|做判断)")),
    ("我自己想想", re.compile(r"(我自己想想|先冷静|我还在想)")),
    ("听大家的/跟票", re.compile(r"(听大家的|听组织|跟票|跟风|跟投)")),
    ("说过/过", re.compile(r"(?:^|[，。！？、；：\s])过(?:[，。！？、；：\s吧了]|$)")),
    ("暂时没想法", re.compile(r"暂时(没有|没什么|没|无|还|再)")),
    ("晚上再说", re.compile(r"(晚上|夜里|明天)(再|继续|改天)?(说|聊|谈|商量|讨论)")),
    # v2.4.2 反偷懒：拒绝判断/推卸表态（白天发言专用；含"留药/跳过/空刀"上下文的合法跳过不在此判）
    ("偷懒判断", re.compile(r"(我不做(判断|决定|分析)|不下(判断|结论)|我放弃|别管我|投谁(都|也)(行|可以)|怎么都行|投谁都一样|随便投)")),
    ("推卸表态", re.compile(r"(你们(定|决定|拿主意|看着办|自己投)|听天由命|无所谓|我(这轮)?(弃权|不投了))")),
]

# v2.4.2 反偷懒豁免：含有这些词的发言不算偷懒（合法跳过/留药/空刀等行动性表态）
LAZY_EXEMPT = re.compile(r"留药|药剂|跳过|空刀|不杀人|毒药|解药|保药|守卫|守护|救")

# v2.4.11 QC 误报修正（round13）：推理保护词豁免。
#  "不急着跟票/先别跟票/暂不跟票/不想跟票" 是拒绝随大流的独立思考，不是"听大家的/跟票"套话。
FOLLOW_REFUSAL_RE = re.compile(r"(不急着|别急着|先别|暂不|不打算|不想|先不|不\s*跟)(跟票|跟风|跟投)")
#  "我再看看/再想想/我自己想想/先冷静/不急着下结论" 属于推理过程中的犹豫用语；
#  当发言带实质信息（时间线/票型/验人/逻辑等 VALID_INFO_PATTERNS）时是"先盘再下结论"，不是空话套话。
HEDGE_LABELS = {"我再看看/听听", "不急着下结论", "我自己想想"}

# "我是好人" 特殊处理：整句无其他有效信息 → 裸用套话；带有效信息 → 合法迷惑不算套话
WOSHIGOOD_RE = re.compile(r"我是好人")

# v2.4.8 任务9（对齐任务8）：无依据的"见风使舵/改口/不交信息"类指责。
# 神职藏身份合法、不报信息≠狼面——指控别人"见风使舵/改口/不交信息"必须带具体行为依据
# （时间线/票型/矛盾/验人/第X晚/昨天今天对照 等），否则按"无依据指责"低质发言标记。
ACCUSATION_RE = re.compile(r"见风使舵|改口|不交信息|藏信息|不报身份|不报信息|不出信息|藏身份")
ACCUSATION_BASIS = re.compile(
    r"时间线|票型|矛盾|对不上|验人|查杀|金水|狼坑|投票|投→|第\d+[晚天]|昨天|今天|刚才|前后|口径|昨天.*今天"
)


def is_woshigood_template(text: str) -> bool:
    if not WOSHIGOOD_RE.search(text):
        return False
    # 带有效信息（验人/时间线/票型/推理/点名怀疑等）→ 合法迷惑，不算套话
    return not VALID_INFO_PATTERNS.search(text)


# ② 指向/怀疑关键词（含动词识别：投/出/支持/反对/跟/弃票）
SUSPECT_KEYWORDS = re.compile(r"怀疑|像狼|可疑|嫌疑|不对劲|是狼|投|出|支持|反对|跟|弃票|逻辑对不上|感觉不太好")

# 弃票/跳过 表态：不算点名怀疑，不算言行不一
ABSTAIN_KEYWORDS = re.compile(r"弃票|弃权|跳过|不投|弃")

# v2.4 承诺动词（"我投X / 我这票挂X / 我票落X / 我票给X / 我不投X"）
COMMIT_VERB_RE = re.compile(r"我\s*((?:这票挂|票落|投给|投定|票给|跟投|投|票|挂|押))\s*(?:给)?$")
NEG_COMMIT_VERB_RE = re.compile(r"我\s*(?:不投|不票|不会投|不投给)\s*(?:给)?$")

# 身份 → 阵营
WOLF_ROLES = {"wolf"}
TEMPLATE_RATE_WARN = 15.0  # 套话率门槛：>15% 标红

# v2.4.2 人设核验：12 人设 → 可观察风格信号（关键词/句式）。值可为 None（用长度倾向判断，见 PERSONA_SHORT）
# v2.4.9 任务1：人设集改用占位代号（人设1…人设12），风格信号按代号对应原顺序映射
PERSONA_STYLE = {
    "人设1": re.compile(r"逻辑|分析|判断|结论|线索|排除|推"),
    "人设2": re.compile(r"^((对|嗯|是|同意|认同|说得对|没错)[，,。]?)|相信|好人|别急|大家|慢慢"),
    "人设3": None,  # 寡言：发言短
    "人设4": re.compile(r"[啊呀呗哈]|直觉|直接|直说|我就|我说"),
    "人设5": re.compile(r"时间线|逻辑|对比|上一轮|昨天|前一天|第\d+天|复盘|记录|前后"),
    "人设6": re.compile(r"[？?]|呢|留白|暗示|点到为止|不急着|先看看"),
    "人设7": re.compile(r"常理|按.*来看|少数|多数|冷静|越乱|直觉"),
    "人设8": re.compile(r"像|比喻|比如|好像|一个道理|例子|生活中"),
    "人设9": re.compile(r"可能|要么|两边|也不排除|也许|不排除|或者"),
    "人设10": re.compile(r"[？?]|为什么|凭什么|呢|吗|吧|你倒是|说说"),
    "人设11": re.compile(r"我还是那句|坚持|认定|就投|不改|我说了|反复"),
    "人设12": re.compile(r"投|归票|建议|先投|行动|干脆|别绕|别拖|直接"),
}
# 人设核验阈值：贴合度 < 该值标红「疑似人设漂移」
PERSONA_LOW = 30.0
# "寡言"信号：发言平均长度（字符）低于该值算贴合"青禾/听雨"类人设
SHORT_SPEECH_LEN = 40

RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BOLD = "\033[1m"
RESET = "\033[0m"


def parse_events(path: str):
    speeches = []  # (day, name, text)
    votes = []     # (day, name, target, reason)
    identity = {}  # name -> role
    persona = {}   # name -> persona name (v2.4.2)
    free_discuss = []  # (day, message) v2.4.3 自由讨论事件
    last_words = []    # (day, name, text) v2.4.4 遗言
    deaths = []        # (day, period, name, cause) v2.4.4 死讯公告
    voteouts = []      # (day, name) v2.4.4 出局公告
    wolf_kill_days = []  # v2.4.4 狼人刀杀行（每天/晚）
    mode = "template"    # v2.4.4 E2：real / template（跨玩家复读噪音判定用）
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        print(f"{RED}[QC] 找不到文件: {path}{RESET}")
        sys.exit(1)

    # 预扫结构化 source；旧日志仍回退到模式行。
    for line in lines:
        sm = SOURCE_RE.match(line.strip())
        if sm:
            mode = "real" if sm.group(1) == "real_ai" else "template"
            break
        lm = MODE_RE.match(line.strip())
        if lm:
            mode = lm.group(1).strip() or "template"
            break

    for line in lines:
        line = line.strip()
        if not line:
            continue
        m = IDENTITY_RE.match(line)
        if m:
            for item in m.group(1).split(","):
                item = item.strip()
                if ":" in item:
                    name, role = item.split(":", 1)
                    identity[name.strip()] = role.strip()
            continue
        m = PERSONA_RE.match(line)
        if m:
            for item in m.group(1).split(","):
                item = item.strip()
                if ":" in item:
                    name, pn = item.split(":", 1)
                    persona[name.strip()] = pn.strip()
            continue
        # v2.4.4 E2 + v2.4.5-C C1.1：模式标识（# 模式 real（真实AI调用）；模板模式为默认）
        m = MODE_RE.match(line)
        if m:
            mode = m.group(1).strip() or "template"
            continue
        m = SOURCE_RE.match(line)
        if m:
            mode = "real" if m.group(1) == "real_ai" else "template"
            continue
        if line.startswith("#"):
            continue
        # v2.4.4 死讯公告行（【公告】...），独立收集，不并入发言
        m = ANNOUNCE_DEATH_RE.match(line)
        if m:
            deaths.append((int(m.group(1)), m.group(2), m.group(3).strip(), m.group(4).strip()))
            continue
        m = ANNOUNCE_VOTEOUT_RE.match(line)
        if m:
            voteouts.append((int(m.group(1)), m.group(2).strip()))
            continue
        # v2.4.4 狼人刀杀行（重复检测）
        m = WOLF_KILL_RE.match(line)
        if m:
            wolf_kill_days.append(int(m.group(1)))
            continue
        if line.startswith("【公告】"):
            continue
        # v2.4.3 自由讨论事件行（第N天[自由讨论] ...，独立收集供报告；不以空格分隔故不会被 SPEECH_RE 误判为发言）
        m = FREE_DISCUSS_RE.match(line)
        if m:
            free_discuss.append((int(m.group(1)), m.group(2).strip()))
            continue
        # v2.4.4 遗言行（第N天 X 遗言: ...）
        m = LAST_WORDS_RE.match(line)
        if m:
            last_words.append((int(m.group(1)), m.group(2).strip(), m.group(3).strip()))
            continue
        m = PK_SPEECH_RE.match(line)
        if m and not any(mk in line for mk in META_EVENT_MARKERS):
            # 第N天 PK X: ...（PK 争辩，X 为真实候选人）
            text, is_mock = strip_mock(m.group(3).strip())
            # v2.4.9 任务8：门禁占位行（高度重复/简略表态）不是真实发言，剔除
            if GATE_MARKER_RE.search(text):
                continue
            if not (is_mock and mode == "real"):
                speeches.append((int(m.group(1)), m.group(2).strip(), text))
            continue
        # 注意：投票行可能含全角冒号（理由），必须先于发言行解析，避免被 SPEECH_RE 吞掉
        m = VOTE_RE.match(line)
        if m:
            votes.append((int(m.group(1)), m.group(2).strip(), m.group(3).strip(), (m.group(4) or '').strip()))
            continue
        m = SPEECH_RE.match(line)
        if m and not any(mk in line for mk in META_EVENT_MARKERS):
            # v2.4.6 P1：real 模式剔除 [mock] 行（自由讨论 mock 模板），防污染套话率/①.9；模板模式保留原样
            text, is_mock = strip_mock(m.group(3).strip())
            # v2.4.9 任务8：门禁占位行（高度重复/简略表态）不是真实发言，剔除
            if GATE_MARKER_RE.search(text):
                continue
            if not (is_mock and mode == "real"):
                speeches.append((int(m.group(1)), m.group(2).strip(), text))
            continue
        if line.startswith("第"):
            # 对局事件行（第N晚 死亡/第N天 出局 等），跳过，不并入发言
            continue
        # v2.4 任务 C-1：非结构化 continuation 行 → 合并到上一条发言，拼完整
        if speeches:
            day, name, text = speeches[-1]
            speeches[-1] = (day, name, (text + " " + line).strip())
    return speeches, votes, identity, persona, free_discuss, last_words, deaths, voteouts, wolf_kill_days, mode


def extract_commitments(text: str, names) -> tuple:
    """从发言提取承诺目标：返回 (正向承诺集合, 负向承诺集合)。
    正向："我投X / 我这票挂X / 我票落X / 我票给X / 我投定X"
    负向："我不投X"（承诺不投谁）
    """
    pos = set()
    neg = set()
    for n in names:
        if n not in text:
            continue
        for m in re.finditer(re.escape(n), text):
            pre = text[max(0, m.start() - 10):m.start()]
            if NEG_COMMIT_VERB_RE.search(pre):
                neg.add(n)
            elif COMMIT_VERB_RE.search(pre):
                pos.add(n)
    return pos, neg


def has_judgment(text: str, names, name: str) -> bool:
    """是否"有依据判断"：带有效信息词，或点名了其他玩家（含怀疑/承诺/踩人）。
    v2.4.2 反偷懒：整场有效判断率过低 → 疑似划水。
    """
    if VALID_INFO_PATTERNS.search(text):
        return True
    return any(n != name and n in text for n in names)


def detect_repeats(speeches):
    """v2.4.5-B X1.3 升级：同玩家跨天重复检测（消除假阴性）。
    以"句子骨架"（去前缀口头禅 + 屏蔽玩家名→{P} + 去标点/语气词）做
    字符 Jaccard / 子串相似度 ≥0.6 判定；句级切分（含逗号），长度 ≥8 才判。
    返回 [(day, name, text)] 已复读发言。

    v2.4.11 豁免：捋（逻辑梳理）发言是"把已知情报串起来"的结构化复盘，句式/内容
    天然引用前文公开事实，与本人此前发言重叠属正常复盘而非偷懒复读——
    与 genSortingSpeech 轮换收尾配套，捋发言不参与 ①.5 自复读判定（round13 云归捋误报）。
    """
    names = set(n for _, n, _ in speeches)
    sent_re = re.compile(r"[。！？!?；;，,]")
    prior: dict = {}  # name -> [sentence norms]
    flagged = []
    for day, name, text in speeches:
        # v2.4.11：捋发言豁免（含"捋一下/给大家捋/我捋/复盘/盘一下"这类结构化复盘标记）
        # 注意：不匹配宽泛的"时间线+票型"组合，避免把普通推理发言也豁免掉复读检测。
        if re.search(r"捋一下|给大家捋|我给大家捋|我来捋|复盘|盘一下|捋一捋", text):
            continue
        chunks = [s for s in sent_re.split(text) if s.strip()]
        prevs = prior.setdefault(name, [])
        for chunk in chunks:
            norm = sentence_skeleton(chunk, names)
            if len(norm) < 8:  # 太短不判，避免误报
                continue
            if any(char_similarity(norm, p) >= 0.6 for p in prevs):
                flagged.append((day, name, text))
                break
            prevs.append(norm)
    return flagged


# v2.4.4 E2 + v2.4.5-B X1.3 跨玩家复读：句级骨架（名字屏蔽+前缀剥离+归一化）相似度比对
_TEMPLATE_NORM_RE = re.compile(r"[\s，。！？、；：（）“”\"'·…—\-:：,.!?()（）]+")

# v2.4.5-B X1.3 前缀口头禅/虚词层：剔除句子开头口水话（"我觉得/说真的/讲道理/嗯"等），防"加前缀绕过判重"
PREFIX_QUIRK_RE = re.compile(
    r"^(我觉得|我觉着|我感觉|个人觉得|说真的|说实话|讲道理|说句实话|坦白说|讲真|"
    r"总之|反正|毕竟|其实|不过|但是|然而|可是|话说|对了|另外|再者|说起来|简单说|"
    r"直说|说白了|真的|确实|嗯|唔|诶|呃|哎|唉|哈|呵呵|哈哈)\s*[,，、:：]?\s*"
)


def sentence_skeleton(sent, names):
    """句级骨架：去前缀口头禅（一次）+ 玩家名 → {P} + 去标点/空白。"""
    t = PREFIX_QUIRK_RE.sub("", sent.strip(), count=1)
    for n in sorted(names, key=len, reverse=True):
        t = t.replace(n, "{P}")
    return _TEMPLATE_NORM_RE.sub("", t)


def char_similarity(a, b):
    """字符级相似度：Jaccard 与子串包含取最大（0~1），≥0.6 判撞模板。"""
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    inter = len(sa & sb)
    union = len(sa | sb)
    jaccard = inter / union if union else 0.0
    contained = 0.9 if (a in b or b in a) else 0.0
    return max(jaccard, contained)


def normalize_template(text, names):
    """把玩家名替换为 {P} 占位，再归一化（去前缀口头禅/去空白/去标点），得到"句式骨架"。"""
    return sentence_skeleton(text, names)


def fact_reasoning_downgrade(chunk: str, norm: str) -> bool:
    """事实词豁免（v2.4.5-C）：含 平安夜/守卫/女巫/解药/验人 且无攻击/双关结构 → 自然推理降权，不判同模板。"""
    if not FACT_REASONING_WORDS.search(norm):
        return False
    return not FACT_ATTACK_MARKERS.search(chunk)


def detect_cross_player_repeats(speeches):
    """跨玩家同模板检测（v2.4.5-C 口径收紧，消除虚高）：
    - 整句级：按 。！？！？； 切整句判（逗号残片不再算"处"，消除拆句重复计数）；
    - 短句过滤：骨架长度 ≥12 才参与跨玩家判同模板；
    - 事实词豁免：自然推理（含 平安夜/守卫/女巫/解药/验人 且无攻击/双关结构）降权不判；
    - 高置信：两两相似度 ≥0.8 判同模板；两方骨架均 ≥15 字 → 直接判红；
    - 跨天去重：记录已报骨架集合，同一骨架跨天只报首次（窗口重叠不再重复计数）。
    返回 [(day, users_sorted, sample, norm, severity)]，severity ∈ {"red", "yellow"}。
    """
    names = set(n for _, n, _ in speeches)
    if len(names) < 2:
        return []
    sent_re = re.compile(r"[。！？!?；;]")
    by_day = defaultdict(list)  # day -> [(name, [norms])]
    for day, name, text in speeches:
        chunks = [s for s in sent_re.split(text) if s.strip()]
        norms = []
        for chunk in chunks:
            norm = sentence_skeleton(chunk, names)
            if len(norm) < 12:  # 短句过滤：≥12 字才参与
                continue
            if fact_reasoning_downgrade(chunk, norm):
                continue
            norms.append(norm)
        by_day[day].append((name, norms))
    days = sorted(by_day.keys())
    flagged = []
    reported = set()  # 跨天去重：同一骨架只报首次
    for d in days:
        # 窗口 = 本轮 + 上轮
        window = list(by_day[d]) + list(by_day.get(d - 1, []))
        found = {}  # norm -> (set(names), severity)
        for i in range(len(window)):
            name_i, norms_i = window[i]
            for j in range(i + 1, len(window)):
                name_j, norms_j = window[j]
                if name_i == name_j:
                    continue
                for ni in norms_i:
                    for nj in norms_j:
                        if char_similarity(ni, nj) < 0.8:
                            continue
                        sev = "red" if (len(ni) >= 15 and len(nj) >= 15) else "yellow"
                        cur = found.get(ni)
                        if cur is None:
                            found[ni] = ({name_i, name_j}, sev)
                        else:
                            cur[0].update([name_i, name_j])
                            if sev == "red":
                                found[ni] = (cur[0], "red")
                        break
        for norm, (users, sev) in sorted(found.items()):
            if len(users) >= 2 and norm not in reported:
                reported.add(norm)
                sample = norm.replace("{P}", "XX")
                flagged.append((d, sorted(users), sample, norm, sev))
    return flagged


def main():
    speeches, votes, identity, persona, free_discuss, last_words, deaths, voteouts, wolf_kill_days, mode = parse_events(EVENTS_FILE)
    print("=" * 64)
    print(f"QC 报告 v2.4.9 — 数据源: {EVENTS_FILE}")
    print(f"发言数={len(speeches)}，投票记录数={len(votes)}，身份表解析={len(identity)} 人，人设表解析={len(persona)} 人，遗言={len(last_words)} 条，死讯公告={len(deaths)} 条")
    print("=" * 64)

    # ---------- ① 发言质量：套话 + 偷懒检测 ----------
    print("\n【① 发言质量】套话模式检测")
    total = len(speeches)
    template_hits = []  # (day, name, text, matched_labels)
    for day, name, text in speeches:
        hits = []
        for label, rx in TEMPLATE_PATTERNS:
            if rx.search(text):
                # v2.4.2 跳过规则对齐：偷懒/推卸 相关表态含合法跳过上下文（留药/空刀/跳过等）不判偷懒
                if label in ("偷懒判断", "推卸表态") and LAZY_EXEMPT.search(text):
                    continue
                # v2.4.11 QC 误报修正：推理保护词不算套话
                #   ① "不急着跟票/先别跟票" 是否定式独立思考，不是随大流（听大家的/跟票）；
                #   ② "我自己想想/再想想/先冷静" 当发言带实质信息（时间线/票型/验人/逻辑等）时
                #      是推理过程用语，不是空话套话——与 is_woshigood_template 的 VALID_INFO 豁免同理。
                if label == "听大家的/跟票" and FOLLOW_REFUSAL_RE.search(text):
                    continue
                if label in HEDGE_LABELS and VALID_INFO_PATTERNS.search(text):
                    continue
                hits.append(label)
        if is_woshigood_template(text):
            hits.append("我是好人裸用")
        if hits:
            template_hits.append((day, name, text, hits))

    # 同一玩家同一模板重复 ≥2 次 → 加重标记
    repeat_count = defaultdict(int)
    for _, name, _, labels in template_hits:
        for label in labels:
            repeat_count[(name, label)] += 1

    # v2.4.8 任务9：无依据"见风使舵/改口/不交信息"指责（带依据的不计）
    unfounded_accusations = []  # (day, name, text)
    for day, name, text in speeches:
        if ACCUSATION_RE.search(text) and not ACCUSATION_BASIS.search(text):
            unfounded_accusations.append((day, name, text))
    if unfounded_accusations:
        print(f"  {YELLOW}无依据指责 {len(unfounded_accusations)} 处（见风使舵/改口/不交信息类需带依据，见 v2.4.8 任务9）:{RESET}")
        for day, name, text in unfounded_accusations[:5]:
            print(f"    · 第{day}天 {name}: {text[:60]}")

    template_count = len(template_hits)
    ratio = (template_count / total * 100) if total else 0

    def fmt_ratio(r):
        if r > TEMPLATE_RATE_WARN:
            return f"{RED}{r:.1f}% ⚠ 超 15%{RESET}"
        return f"{r:.1f}%"

    print(f"  套话发言: {template_count}/{total} ({fmt_ratio(ratio)})")

    # 按套话模式统计
    by_label = defaultdict(int)
    for _, _, _, labels in template_hits:
        for label in labels:
            by_label[label] += 1
    for label, n in sorted(by_label.items(), key=lambda kv: -kv[1]):
        print(f"    - {label}: {n} 次")

    # 每玩家套话率表（Markdown 表格）
    per_player_speech = defaultdict(int)
    per_player_hit = defaultdict(int)
    for day, name, text in speeches:
        per_player_speech[name] += 1
    for _, name, _, _ in template_hits:
        per_player_hit[name] += 1

    print(f"\n  每玩家套话率（Markdown 表格，>15% 标红）:")
    print(f"  | 玩家 | 发言数 | 套话数 | 套话率 |")
    print(f"  | --- | --- | --- | --- |")
    for name in sorted(per_player_speech, key=lambda n: -per_player_hit[n] / max(per_player_speech[n], 1)):
        n = per_player_speech[name]
        h = per_player_hit.get(name, 0)
        r = h / n * 100 if n else 0
        rate_cell = f"{r:.1f}% ⚠" if r > TEMPLATE_RATE_WARN else f"{r:.1f}%"
        print(f"  | {name} | {n} | {h} | {rate_cell} |")

    # v2.4.2 反偷懒：每玩家有效判断率（整场不表态 → 疑似划水）
    all_names_set = set(name for _, name, _ in speeches)
    per_player_judge = defaultdict(int)
    for _, name, text in speeches:
        if has_judgment(text, all_names_set, name):
            per_player_judge[name] += 1
    lazy_players = []
    if per_player_speech:
        print(f"\n  每玩家有效判断率（v2.4.2 反偷懒，<50% 标红「疑似划水」）:")
        print(f"  | 玩家 | 发言数 | 有判断数 | 判断率 |")
        print(f"  | --- | --- | --- | --- |")
        for name in sorted(per_player_speech, key=lambda n: -per_player_judge.get(n, 0) / max(per_player_speech[n], 1)):
            n = per_player_speech[name]
            j = per_player_judge.get(name, 0)
            jr = j / n * 100 if n else 0
            cell = f"{jr:.1f}% ⚠ 疑似划水" if jr < 50 else f"{jr:.1f}%"
            if jr < 50:
                lazy_players.append(name)
            print(f"  | {name} | {n} | {j} | {cell} |")

    if template_hits:
        print(f"\n  {YELLOW}示例（前 5 条）:{RESET}")
        for day, name, text, labels in template_hits[:5]:
            heavy = " [重复]" if any(repeat_count[(name, label)] >= 2 for label in labels) else ""
            print(f"    {YELLOW}第{day}天 {name}: {text}  [{', '.join(labels)}]{heavy}{RESET}")
    else:
        print(f"  {GREEN}未检测到明显套话 ✓{RESET}")

    # ---------- ①.5 防复读（v2.4.2） ----------
    print("\n【①.5 防复读】同一玩家跨天重复自己发言")
    repeats = detect_repeats(speeches)
    if repeats:
        repeat_names = sorted({name for _, name, _ in repeats})
        print(f"  {YELLOW}复读发言 {len(repeats)} 条，涉及玩家: {', '.join(repeat_names)}{RESET}")
        print(f"  | 天数 | 玩家 | 发言（与前文重复） |")
        print(f"  | --- | --- | --- |")
        for day, name, text in repeats[:8]:
            print(f"  | 第{day}天 | {name} | {text[:48]} |")
    else:
        print(f"  {GREEN}未检测到复读 ✓{RESET}")

    # ---------- ①.6 人设核验（v2.4.2） ----------
    print("\n【①.6 人设核验】每人设风格信号命中率（<30% 标红「疑似人设漂移」）")
    if not persona:
        print(f"  {YELLOW}未找到 `# 人设表`，跳过人设核验（test-drive 需输出该行）{RESET}")
    else:
        speech_by_name = defaultdict(list)
        for _, name, text in speeches:
            speech_by_name[name].append(text)
        persona_rows = []
        for name, pname in persona.items():
            texts = speech_by_name.get(name, [])
            if not texts:
                continue
            style_rx = PERSONA_STYLE.get(pname)
            hits = 0
            if style_rx is not None:
                hits = sum(1 for t in texts if style_rx.search(t))
            else:
                # 寡言型人设（人设3/人设6）：以平均发言长度衡量
                avg_len = sum(len(t) for t in texts) / len(texts)
                hits = 1 if avg_len <= SHORT_SPEECH_LEN else 0
            score = hits / len(texts) * 100
            persona_rows.append((name, pname, len(texts), hits, score))
        if not persona_rows:
            print(f"  {YELLOW}人设表与发言无交集，无法核验{RESET}")
        else:
            print(f"  | 玩家 | 人设 | 发言数 | 风格命中 | 贴合度 |")
            print(f"  | --- | --- | --- | --- | --- |")
            drifted = []
            for name, pname, n, hits, score in sorted(persona_rows, key=lambda r: r[4]):
                cell = f"{score:.1f}% ⚠ 疑似人设漂移" if score < PERSONA_LOW else f"{score:.1f}%"
                if score < PERSONA_LOW:
                    drifted.append(name)
                print(f"  | {name} | {pname} | {n} | {hits} | {cell} |")
            if drifted:
                print(f"\n  {YELLOW}贴合度偏低玩家（模板模式人设信号较弱属预期，--real 模式应更贴合）: {', '.join(drifted)}{RESET}")
            else:
                print(f"  {GREEN}无人设漂移 ✓{RESET}")

    # ---------- ①.7 自由讨论事件（v2.4.3） ----------
    print("\n【①.7 自由讨论阶段】插话 / 跳过 / 配额（v2.4.3）")
    if not free_discuss:
        print(f"  {YELLOW}未找到自由讨论事件（test-drive 需输出 `第N天[自由讨论] ...` 行）{RESET}")
    else:
        interject = sum(1 for _, msg in free_discuss if msg.startswith("插话"))
        skip = sum(1 for _, msg in free_discuss if msg.startswith("跳过") or msg.startswith("配额满强制跳过"))
        force_skip = sum(1 for _, msg in free_discuss if msg.startswith("配额满强制跳过"))
        all_skip = sum(1 for _, msg in free_discuss if msg.startswith("全员跳过"))
        rounds = sum(1 for _, msg in free_discuss if "轮开始" in msg)
        print(f"  自由讨论事件行: {len(free_discuss)}")
        print(f"  讨论轮次: {rounds} 轮；插话: {interject} 次；跳过: {skip} 次（其中配额满强制跳过 {force_skip} 次）；全员跳过→提前投票: {all_skip} 次")
        print(f"  {GREEN}自由讨论阶段可正常推进（插话/跳过/配额均有产出，不卡死）✓{RESET}")

    # ---------- ①.8 遗言与死讯完整性（v2.4.4） ----------
    print("\n【①.8 遗言与死讯】被票出局必留遗言 / 死讯公告完整 / 无重复刀行 / 发言限长（v2.4.4）")
    if not deaths and not voteouts:
        print(f"  {YELLOW}未找到 `【公告】...` 死讯/出局行（test-drive 需输出公告事件）{RESET}")
    else:
        if voteouts:
            print(f"  出局公告 {len(voteouts)} 条：{', '.join(f'{n}(第{d}天)' for d, n in voteouts)}")
        if deaths:
            print(f"  死讯公告 {len(deaths)} 条：")
            for d, period, n, cause in deaths:
                print(f"    · 第{d}{period} 死亡：{n}（{cause}）")

    # ①.8a 被票出局必有遗言
    missing_lw = [n for d, n in voteouts if not any(lw[0] == d and lw[1] == n for lw in last_words)]
    if last_words:
        print(f"  遗言 {len(last_words)} 条：")
        for d, n, t in last_words:
            mark = f"{RED} ⚠ 超过80字({len(t)}){RESET}" if len(t) > 80 else ""
            print(f"    · 第{d}天 {n}：{t[:40]}{'...' if len(t) > 40 else ''}{mark}")
    if missing_lw:
        print(f"  {RED}⚠ 以下玩家被票出局但没有遗言（硬门禁）：{', '.join(missing_lw)}{RESET}")
    else:
        print(f"  {GREEN}被票出局者均有遗言 ✓{RESET}")

    # ①.8b 重复刀行 / 旧格式残留
    dup_days = sorted({d for d in wolf_kill_days if wolf_kill_days.count(d) > 1})
    if dup_days:
        print(f"  {RED}⚠ 以下夜晚出现重复的狼人刀杀行（应合并为一行）：第{', '.join(str(d) for d in dup_days)}晚{RESET}")
    else:
        print(f"  {GREEN}无重复狼人刀杀行（每晚单行）✓{RESET}")
    legacy = []
    with open(EVENTS_FILE, encoding="utf-8") as f:
        for line in f:
            if LEGACY_SELECT_KILL_RE.search(line):
                legacy.append(line.strip()[:50])
    if legacy:
        print(f"  {RED}⚠ 检测到旧的'选择击杀'冗余行 {len(legacy)} 处（应已合并）：{legacy[0]}{RESET}")
    else:
        print(f"  {GREEN}无'选择击杀'冗余格式 ✓{RESET}")

    # ①.8c 发言限长校验（轮次发言≤100 / 自由讨论≤150 / 理由≤40 / 遗言≤80）
    free_days = {d for d, _ in free_discuss}
    over_free = [f"第{d}天 {n}({len(t)})" for d, n, t in speeches if d in free_days and len(t) > 150]
    over_round1 = [f"第{d}天 {n}({len(t)})" for d, n, t in speeches if d not in free_days and len(t) > 100]
    over_reason = [f"第{d}天 {n}({len(r)})" for d, n, _, r in votes if len(r) > 40]
    over_lw = [f"第{d}天 {n}({len(t)})" for d, n, t in last_words if len(t) > 80]
    length_ok = True
    if over_free:
        length_ok = False
        print(f"  {RED}⚠ 自由讨论超 150 字：{', '.join(over_free[:5])}{RESET}")
    if over_round1:
        length_ok = False
        print(f"  {RED}⚠ 轮次发言超 100 字：{', '.join(over_round1[:5])}{RESET}")
    if over_reason:
        length_ok = False
        print(f"  {RED}⚠ 投票理由超 40 字：{', '.join(over_reason[:5])}{RESET}")
    if over_lw:
        length_ok = False
        print(f"  {RED}⚠ 遗言超 80 字：{', '.join(over_lw[:5])}{RESET}")
    if length_ok:
        print(f"  {GREEN}发言长度均符合限长（轮次≤100 / 自由讨论≤150 / 理由≤40 / 遗言≤80）✓{RESET}")

    # ---------- ①.9 跨玩家同模板检测（v2.4.5-C 口径收紧） ----------
    print("\n【①.9 跨玩家复读】整句级 高置信同模板（相似度≥0.8；两方骨架≥15字直接判红；跨天去重；事实推理豁免，v2.4.5-C）")
    cross_repeats = detect_cross_player_repeats(speeches)
    if cross_repeats:
        if mode == "real":
            print(f"  {RED}⚠ 检测到跨玩家同模板复读 {len(cross_repeats)} 处（整句级，相似度≥0.8）:{RESET}")
        else:
            print(f"  {YELLOW}检测到跨玩家同模板 {len(cross_repeats)} 处 —— 模板模式有限模板池复用属预期（test-drive mock），--real 模式为真实目标{RESET}")
        for day, users, sample, _, sev in cross_repeats[:8]:
            mark = f" {RED}[直接判红]{RESET}" if sev == "red" else ""
            print(f"    · 第{day}天 {', '.join(users)} 使用同款句式「{sample[:40]}」{mark}")
    else:
        print(f"  {GREEN}未检测到跨玩家同模板复读（整句级，相似度≥0.8，本轮+上轮窗口）✓{RESET}")

    # ---------- ①.9b 投票理由质检（v2.4.5-B X2） ----------
    print("\n【①.9b 投票理由】无理由票（硬门禁，应=0）+ 理由同模板")
    real_votes = [(d, n, t, r) for d, n, t, r in votes if t and t != "skip"]
    no_reason = [(d, n, t) for d, n, t, r in real_votes if not (r or '').strip()]
    if no_reason:
        print(f"  {RED}⚠ 无理由票 {len(no_reason)} 条（硬门禁）：{', '.join(f'{n}投→{t}(第{d}天)' for d, n, t in no_reason[:5])}{RESET}")
    else:
        print(f"  {GREEN}无理由票 = 0（全部真实投票均带理由）✓{RESET}")
    all_names = set(n for _, n, _ in speeches) or set(n for _, n, _, _ in votes)
    reason_map = defaultdict(set)  # norm -> set((day,name,target))
    for d, n, t, r in real_votes:
        norm = sentence_skeleton(r, all_names)
        if len(norm) < 4:
            continue
        reason_map[norm].add((d, n, t))
    dup_reasons = [(norm, sorted(users)) for norm, users in reason_map.items() if len(users) >= 2]
    if dup_reasons:
        print(f"  {YELLOW}投票理由同模板 {len(dup_reasons)} 处（屏蔽名字后骨架相似，≥2 人同款理由）:{RESET}")
        for norm, users in dup_reasons[:5]:
            print(f"    · 「{norm.replace('{P}', 'XX')}」← {', '.join(f'{n}(第{d}天投{t})' for d, n, t in users)}")
    else:
        print(f"  {GREEN}投票理由无同模板 ✓{RESET}")


    # ---------- ② 言行一致（承诺目标 vs 实际投票，v2.4 升级） ----------
    print("\n【② 言行一致】发言承诺 vs 实际投票（含投票理由）")

    speech_by_day_name = defaultdict(list)
    for day, name, text in speeches:
        speech_by_day_name[(day, name)].append(text)

    # 取每个玩家每天的最终投票（含 PK 覆盖）与理由
    vote_by_day_name = {}
    reason_by_day_name = {}
    for day, name, target, reason in votes:
        if target == "skip":
            continue
        vote_by_day_name[(day, name)] = target
        reason_by_day_name[(day, name)] = reason

    all_names = set(name for _, name, _ in speeches)

    def suspects_of(day: int, name: str):
        found = set()
        for text in speech_by_day_name.get((day, name), []):
            if not SUSPECT_KEYWORDS.search(text):
                continue
            # 弃票/跳过 表态不算点名怀疑（弃票不算言行不一）
            if ABSTAIN_KEYWORDS.search(text):
                continue
            for other in all_names:
                if other != name and other in text:
                    found.add(other)
        return found

    checked = 0
    consistent = 0
    reasonable_change = []   # (day, name, committed, vote, reason, tag) [合理变更]
    inconsistent = []        # (day, name, committed, vote, tag) [问题] 硬门禁
    strategy_inconsistent = []  # (day, name, suspects, vote, tag) [策略] 狼人
    no_stance = 0
    unknown_identity = 0

    for (day, name), vote in sorted(vote_by_day_name.items()):
        texts = " ".join(speech_by_day_name.get((day, name), []))
        commits_pos, commits_neg = extract_commitments(texts, all_names)
        reason = reason_by_day_name.get((day, name), '')
        role = identity.get(name, "")

        # ① 有明确承诺：以承诺判定
        if commits_pos or commits_neg:
            checked += 1
            committed = sorted(commits_pos | commits_neg)
            violated_pos = [c for c in commits_pos if vote != c]
            violated_neg = [c for c in commits_neg if vote == c]
            if not violated_pos and not violated_neg:
                consistent += 1
                continue
            # 承诺被违背
            if reason:
                reasonable_change.append((day, name, committed, vote, reason, "[合理变更]"))
            else:
                inconsistent.append((day, name, committed, vote, "[问题]"))
            continue

        # ② 无明确承诺：退回"发言指向 vs 投票"
        suspects = suspects_of(day, name)
        if not suspects:
            no_stance += 1
            continue
        checked += 1
        if vote in suspects:
            consistent += 1
        elif role in WOLF_ROLES:
            # 狼人策略性不一致：发言指向别人却投他处 → 合法策略
            strategy_inconsistent.append((day, name, sorted(suspects), vote, "[策略]"))
        else:
            if not role:
                unknown_identity += 1
            if reason:
                reasonable_change.append((day, name, sorted(suspects), vote, reason, "[合理变更]"))
            else:
                inconsistent.append((day, name, sorted(suspects), vote, "[问题]"))

    logic_inconsistent = inconsistent

    print(f"  可判定发言数: {checked}（未点名未承诺未投票者不计）")
    print(f"  {GREEN}言行一致: {consistent}{RESET}   "
          f"{YELLOW}未表态: {no_stance}{RESET}")
    print(f"  {BOLD}合理变更（承诺≠投票但有理由）: {len(reasonable_change)}{RESET}   "
          f"{YELLOW}策略性不一致（狼人·合法）: {len(strategy_inconsistent)}{RESET}   "
          f"{RED}逻辑性不一致（无理由·硬门禁）: {len(logic_inconsistent)}{RESET}"
          + (f"   {YELLOW}身份未知按好人从严: {unknown_identity}{RESET}" if unknown_identity else ""))

    if reasonable_change:
        print(f"\n  {BOLD}【合理变更】投票与发言承诺/指向不一致，但给出了明确理由 —— 金钻定调：言行不一可接受，不算问题:{RESET}")
        print(f"  | 天数 | 玩家 | 承诺/指向 | 实际投票 | 理由 | 标记 |")
        print(f"  | --- | --- | --- | --- | --- | --- |")
        for day, name, committed, vote, reason, tag in reasonable_change:
            print(f"  | 第{day}天 | {name} | {', '.join(committed)} | {vote} | {reason[:40]} | {tag} |")
    else:
        print(f"  {GREEN}无合理变更（所有改票均未说明理由）✓{RESET}")

    if strategy_inconsistent:
        print(f"\n  {YELLOW}【策略性不一致】狼人发言指向别人却投他处 —— 属于狼队带节奏合法策略，不算失败:{RESET}")
        print(f"  | 天数 | 玩家 | 发言指向 | 实际投票 | 标记 |")
        print(f"  | --- | --- | --- | --- | --- |")
        for day, name, suspects, vote, tag in strategy_inconsistent:
            print(f"  | 第{day}天 | {name} | {', '.join(suspects)} | {vote} | {tag} |")
    else:
        print(f"  {GREEN}无策略性不一致 ✓{RESET}")

    if logic_inconsistent:
        print(f"\n  {RED}⚠ 以下玩家投票与发言承诺/指向不一致，且未给出理由（逻辑性不一致，硬门禁）:{RESET}")
        print(f"  | 天数 | 玩家 | 承诺/指向 | 实际投票 | 标记 |")
        print(f"  | --- | --- | --- | --- | --- |")
        for day, name, committed, vote, tag in logic_inconsistent:
            print(f"  | 第{day}天 | {name} | {', '.join(committed)} | {vote} | {tag} |")
    else:
        print(f"  {GREEN}全部言行一致（含合理变更）✓{RESET}")

    print("\n" + "=" * 64)
    # 汇总（v2.4.4：并入遗言缺失 / 重复刀行 / 超长发言 / 跨玩家同模板）
    problem_total = len(logic_inconsistent)
    missing_lw_all = [n for d, n in voteouts if not any(lw[0] == d and lw[1] == n for lw in last_words)]
    dup_days_all = sorted({d for d in wolf_kill_days if wolf_kill_days.count(d) > 1})
    over_length = over_free + over_round1 + over_reason + over_lw
    cross_players_all = detect_cross_player_repeats(speeches)
    # 模板模式有限模板池复用属预期 mock 噪音，不计入"发现的问题"（--real 才计）
    cross_players_warn = cross_players_all if mode == "real" else []
    # v2.4.5-B X2：无理由票为硬门禁（任何模式都计）；理由同模板为黄标
    no_reason_total = len(no_reason)
    dup_reason_total = len(dup_reasons)
    # v2.4.8 任务9：无依据指责（黄标）
    unfounded_total = len(unfounded_accusations)
    if template_count > 0 or problem_total > 0 or repeats or lazy_players or missing_lw_all or dup_days_all or over_length or cross_players_warn or no_reason_total > 0 or unfounded_total > 0:
        warns = []
        if template_count > 0:
            warns.append(f"{template_count} 条套话")
        if lazy_players:
            warns.append(f"{len(lazy_players)} 名玩家疑似划水（有效判断率<50%）")
        if repeats:
            warns.append(f"{len(repeats)} 处复读")
        if cross_players_warn:
            warns.append(f"{len(cross_players_warn)} 处跨玩家同模板复读")
        if no_reason_total > 0:
            warns.append(f"{no_reason_total} 条无理由票（硬门禁）")
        if unfounded_total > 0:
            warns.append(f"{unfounded_total} 处无依据指责（见风使舵/改口/不交信息类）")
        if problem_total > 0:
            warns.append(f"{problem_total} 处无理由的言行不一")
        if missing_lw_all:
            warns.append(f"{len(missing_lw_all)} 人被票出局缺遗言")
        if dup_days_all:
            warns.append(f"第{', '.join(str(d) for d in dup_days_all)}晚重复刀行")
        if over_length:
            warns.append(f"{len(over_length)} 处超限长发言")
        if dup_reason_total > 0:
            warns.append(f"{dup_reason_total} 处投票理由同模板")
        print(f"结论：发现 {', '.join(warns)}，建议人工抽样复核。"
              f"（狼人策略性不一致 {len(strategy_inconsistent)} 处为合法玩法；"
              f"合理变更 {len(reasonable_change)} 处有理由支撑，不计失败。）")
    else:
        print("结论：发言质量与言行一致均通过。")
    print("=" * 64)


if __name__ == "__main__":
    main()
