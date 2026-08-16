/** Shared recursive redaction boundary for logs, diagnostics and debug buffers. */

const SENSITIVE_KEY_NAMES = new Set([
  'ai_config',
  'api_key',
  'apikey',
  'access_token',
  'accesstoken',
  'authorization',
  'credential',
  'credential_ref',
  'join_token',
  'omniscient_token',
  'password',
  'resume_token',
  'secret',
  'session',
  'token',
]);

/** Canonical key form shared by every sensitive-data boundary. */
export const normalizeSensitiveKey = (key: string): string => key
  .trim()
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[-\s]+/g, '_')
  .toLowerCase();

/** Match exact names and credential/token suffixes, including aliases. */
export const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizeSensitiveKey(key);
  return SENSITIVE_KEY_NAMES.has(normalized) ||
    normalized.endsWith('_api_key') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('_access_token') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('_credential_ref') ||
    normalized.endsWith('_token');
};

export interface SensitiveKeyScanOptions {
  /** A narrow structural exception, used only by the session credential shape. */
  allowKey?: (key: string, path: readonly string[]) => boolean;
}

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
  options: SensitiveKeyScanOptions = {},
  path: readonly string[] = [],
  seen = new Set<object>(),
): boolean => {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item, index) =>
      containsSensitiveKeys(item, options, [...path, String(index)], seen));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    (!options.allowKey?.(key, path) && isSensitiveKey(key)) ||
    containsSensitiveKeys(child, options, [...path, normalizeSensitiveKey(key)], seen));
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
