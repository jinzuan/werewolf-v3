/**
 * mergeDefaults.ts — 配置深合并（雲鵺 A2.6，语义写死，不模糊）。
 *
 * 语义：
 *  - 数组 → **replace，不 concat**（如角色列表/AI 玩家列表，覆盖即替换）；
 *  - 值为 `undefined` → **丢弃**（不写进结果，不触发覆盖）；
 *  - 持久化 → **白名单**：仅白名单字段可持久化（见 persistWhitelist），
 *    删字段靠白名单剔除实现，禁止递归盲合（盲合会污染原型 / 带进已删字段）。
 *
 * 链：建房配置 → 房主单 AI 覆盖 → 引擎运行态。
 */

type AnyRecord = Record<string, unknown>;

const isPlainObject = (v: unknown): v is AnyRecord =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 深合并（无白名单版）：数组 replace、undefined 丢弃、普通对象递归合并。
 * base/overrides 均为普通对象。null 视为"保留 base 值"（不算覆盖）。
 */
export const mergeDefaults = (base: AnyRecord, overrides?: AnyRecord | null): AnyRecord => {
  const out: AnyRecord = { ...base };
  if (!overrides || typeof overrides !== 'object') return out;
  for (const key of Object.keys(overrides)) {
    const v = overrides[key];
    if (v === undefined) continue; // undefined 丢弃
    if (v === null) continue; // null 保留 base
    if (Array.isArray(v)) {
      out[key] = [...v]; // 数组 replace
      continue;
    }
    if (isPlainObject(v)) {
      const baseVal = out[key];
      out[key] = isPlainObject(baseVal) ? mergeDefaults(baseVal, v) : { ...v };
      continue;
    }
    out[key] = v;
  }
  return out;
};

/**
 * 白名单持久化：只保留白名单字段（含嵌套白名单路径），用于"持久化只存可配置项"。
 * 删字段 = 白名单里拿掉该字段 → 结果对象不再含它（自然剔除）。
 *
 * 用法：persistWhitelist(state, { aiConfig: { provider: true, model: true } })
 *  - 顶层 aiConfig 下只留 provider/model；其它（含 apiKey）不落盘。
 *  - 白名单值可为 true（整字段保留）或对象（嵌套白名单）。
 */
export const persistWhitelist = (
  input: AnyRecord,
  whitelist: AnyRecord
): AnyRecord => {
  const out: AnyRecord = {};
  for (const key of Object.keys(whitelist)) {
    if (!(key in input)) continue;
    const rule = whitelist[key];
    const val = input[key];
    if (rule === true) {
      out[key] = val;
    } else if (isPlainObject(rule)) {
      if (isPlainObject(val)) {
        out[key] = persistWhitelist(val, rule as AnyRecord);
      } else if (Array.isArray(val)) {
        out[key] = val.map((item) =>
          isPlainObject(item) ? persistWhitelist(item, rule as AnyRecord) : item
        );
      }
      // 非对象且非数组 → 白名单对象规则不适用，丢弃
    }
  }
  return out;
};
