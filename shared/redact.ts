/** Shared recursive redaction boundary for logs, diagnostics and debug buffers. */

export const SENSITIVE_KEYS = new Set([
  'aiconfig',
  'apikey',
  'api_key',
  'access_token',
  'accesstoken',
  'authorization',
  'credential',
  'credentialref',
  'join_token',
  'jointoken',
  'omniscient_token',
  'omniscienttoken',
  'password',
  'resume_token',
  'resumetoken',
  'secret',
  'token',
]);

const normalizedKey = (key: string): string => key.replace(/[-\s]/g, '_').toLowerCase();
const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith('apikey') || normalized.endsWith('accesstoken');
};

/** Bearer <key> → Bearer ***<后4位>; raw values are never retained by key-aware redaction. */
export const redactAuthorization = (text: string): string => {
  if (!text) return text;
  return text.replace(
    /Bearer\s+([^\s,;]+)/gi,
    (_, token: string) => `Bearer ***${token.length > 4 ? token.slice(-4) : '****'}`,
  );
};

/** Redact common key=value/JSON forms without echoing the complete URL query. */
export const redactSensitive = (text: string): string => {
  if (!text) return text;
  let result = redactAuthorization(text);
  result = result.replace(
    /([?&](?:api[_-]?key|access[_-]?token|authorization|credential|secret|token|password)=)([^&#\s,;]+)/gi,
    '$1***',
  );
  result = result.replace(
    /(["']?(?:api[_-]?key|apikey|access[_-]?token|authorization|credential(?:ref)?|secret|token|password|joinToken|resumeToken|omniscientToken)["']?\s*[:=]\s*["']?)([^"'&\s,}]+)/gi,
    '$1***',
  );
  return result;
};

export const containsSensitiveKeys = (
  value: unknown,
  seen = new Set<object>(),
): boolean => {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKeys(item, seen));
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    isSensitiveKey(key) || containsSensitiveKeys(child, seen));
};

/**
 * Sensitive values are replaced at the key boundary, including aliases that
 * are easy to miss in nested provider/config payloads. The input is cloned.
 */
export const redactJson = (value: unknown, seen = new Map<object, unknown>()): unknown => {
  if (typeof value === 'string') return redactSensitive(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(redactJson(item, seen));
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : redactJson(child, seen);
  }
  return out;
};
