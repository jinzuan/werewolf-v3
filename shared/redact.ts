/**
 * redact.ts — 日志层统一脱敏（雲鵺 A4.14，P0）。
 * 服务端 console 日志与 debug:log 共用同一份脱敏函数。
 * 调试环形缓冲**不录** AI 请求头原始值（apiKey 只在服务端，任何日志/缓冲只出现 Bearer ***后4位）。
 */

/** Bearer <key> → Bearer ***<后4位>；非 Authorization 形态原样返回 */
export const redactAuthorization = (text: string): string => {
  if (!text) return text;
  return text.replace(
    /Bearer\s+([A-Za-z0-9._-]+)/gi,
    (_, token: string) => `Bearer ***${token.length > 4 ? token.slice(-4) : '****'}`
  );
};

/** 通用敏感值脱敏：key 出现即脱敏（含对象序列化后的字符串、URL query 里的 key=...） */
export const redactSensitive = (text: string): string => {
  if (!text) return text;
  let t = redactAuthorization(text);
  t = t.replace(/(api[_-]?key|apikey|authorization|token|secret)\s*[:=]\s*"?[A-Za-z0-9._-]+"?/gi, '$1=***');
  return t;
};

/** 递归脱敏任意 JSON 结构（日志对象/快照字段用；返回新对象，不改入参） */
export const redactJson = (value: unknown): unknown => {
  if (typeof value === 'string') return redactSensitive(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && /authorization|api[_-]?key|token|secret/i.test(k)) {
        out[k] = redactSensitive(v);
      } else {
        out[k] = redactJson(v);
      }
    }
    return out;
  }
  return value;
};
