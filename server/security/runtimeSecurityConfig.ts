import type { SecurityEnvironment } from './endpointPolicy';
import {
  effectiveRequestProtocol as resolveTrustedRequestProtocol,
  parseTrustedProxySources,
  TrustedProxyPolicy,
  type RequestLike,
  type TrustedProxyPolicyConfig,
} from './trustedProxyPolicy';

export interface RuntimeSecurityConfig {
  environment: SecurityEnvironment;
  publicOrigin: string;
  corsOrigins: readonly string[];
  trustProxy: TrustedProxyPolicyConfig;
  bindHost: string;
  allowPrivateAIEndpoints: boolean;
  aiEndpointAllowlist: readonly string[];
  secretStore: 'encrypted_file' | 'memory';
  secretKey?: string;
  secretKeyId: string;
}

export class RuntimeSecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSecurityConfigError';
  }
}

const bool = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const trustedProxyValue = (env: NodeJS.ProcessEnv): string | undefined =>
  env.WW_TRUST_PROXY_CIDRS ??
  env.WW_TRUST_PROXY_CIDR ??
  env.WW_TRUST_PROXY_ADDRESSES ??
  env.WW_TRUSTED_PROXY_CIDRS ??
  env.WW_TRUSTED_PROXY_CIDR ??
  env.WW_TRUSTED_PROXY_ADDRESSES;

const hasValidSecretKeyShape = (value: string | undefined): boolean => {
  if (!value) return false;
  if (Buffer.byteLength(value, 'utf8') === 32) return true;
  if (/^[0-9a-f]{64}$/i.test(value)) return true;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
};

const environmentOf = (env: NodeJS.ProcessEnv): SecurityEnvironment => {
  const value = env.WW_ENV ?? (env.NODE_ENV === 'test' ? 'test' : 'development');
  if (value !== 'production' && value !== 'development' && value !== 'test') {
    throw new RuntimeSecurityConfigError('WW_ENV must be production, development, or test');
  }
  return value;
};

const exactOrigin = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeSecurityConfigError('WW_PUBLIC_ORIGIN must be an absolute origin');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new RuntimeSecurityConfigError('WW_PUBLIC_ORIGIN must contain only scheme, host, and port');
  }
  return parsed.origin;
};

export const parseRuntimeSecurityConfig = (
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSecurityConfig => {
  const environment = environmentOf(env);
  const rawTrustProxy = env.WW_TRUST_PROXY?.trim();
  const trustProxyFlag = rawTrustProxy === undefined ||
    ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'].includes(rawTrustProxy.toLowerCase());
  const trustProxyEnabled = trustProxyFlag ? bool(rawTrustProxy) : true;
  const configuredProxyValue = trustedProxyValue(env) ?? (!trustProxyFlag ? rawTrustProxy : undefined);
  const configuredBindHost = env.WW_BIND_HOST?.trim() || undefined;
  let trustedProxySources;
  try {
    trustedProxySources = parseTrustedProxySources(configuredProxyValue);
  } catch (error) {
    throw new RuntimeSecurityConfigError(
      error instanceof Error ? error.message : 'invalid trusted proxy configuration',
    );
  }
  if (trustProxyEnabled && (!configuredBindHost || trustedProxySources.length === 0)) {
    throw new RuntimeSecurityConfigError(
      'WW_TRUST_PROXY requires WW_TRUST_PROXY_CIDRS/ADDRESSES and WW_BIND_HOST',
    );
  }
  const defaultOrigin = environment === 'production' ? undefined : 'http://127.0.0.1:3001';
  const explicitPublicOrigin = env.WW_PUBLIC_ORIGIN;
  const publicOriginValue = explicitPublicOrigin ?? defaultOrigin;
  if (!publicOriginValue) {
    throw new RuntimeSecurityConfigError('WW_PUBLIC_ORIGIN is required in production');
  }
  const publicOrigin = exactOrigin(publicOriginValue);
  if (environment === 'production' && !publicOrigin.startsWith('https://')) {
    throw new RuntimeSecurityConfigError('production WW_PUBLIC_ORIGIN must use https');
  }
  if (environment !== 'production' && publicOrigin.startsWith('http://')) {
    const hostname = new URL(publicOrigin).hostname;
    if (!explicitPublicOrigin && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
      throw new RuntimeSecurityConfigError('development/test HTTP public origin must be loopback');
    }
  }

  const corsOrigins = [...new Set(
    (env.WW_CORS_ORIGINS ?? publicOrigin)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map(exactOrigin),
  )];
  if (corsOrigins.some((origin) => origin === '*' || origin.includes('*'))) {
    throw new RuntimeSecurityConfigError('WW_CORS_ORIGINS must be an exact origin allowlist');
  }
  if (environment === 'production' && corsOrigins.some((origin) => origin.startsWith('http://'))) {
    throw new RuntimeSecurityConfigError('production CORS origins must use https');
  }

  const secretStore = env.WW_SECRET_STORE === 'memory' ? 'memory' : 'encrypted_file';
  if (environment === 'production' && secretStore !== 'encrypted_file') {
    throw new RuntimeSecurityConfigError('production requires an encrypted secret store');
  }
  if (environment === 'production' && !hasValidSecretKeyShape(env.WW_SECRET_KEY)) {
    throw new RuntimeSecurityConfigError('production requires a valid 32-byte WW_SECRET_KEY');
  }
  const config: RuntimeSecurityConfig = {
    environment,
    publicOrigin,
    corsOrigins,
    trustProxy: {
      enabled: trustProxyEnabled,
      sources: trustedProxySources,
      bindHost: configuredBindHost ?? '127.0.0.1',
    },
    bindHost: configuredBindHost ?? '127.0.0.1',
    allowPrivateAIEndpoints: bool(env.WW_ALLOW_PRIVATE_AI_ENDPOINTS),
    aiEndpointAllowlist: (env.WW_AI_ENDPOINT_ALLOWLIST ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    secretStore,
    ...(env.WW_SECRET_KEY ? { secretKey: env.WW_SECRET_KEY } : {}),
    secretKeyId: env.WW_SECRET_KEY_ID?.trim() || 'default',
  };
  return Object.freeze({
    ...config,
    corsOrigins: Object.freeze([...config.corsOrigins]),
    trustProxy: Object.freeze({
      ...config.trustProxy,
      sources: Object.freeze([...config.trustProxy.sources]),
    }),
  });
};

export const loadRuntimeSecurityConfig = parseRuntimeSecurityConfig;

export const isAllowedOrigin = (
  origin: string | undefined,
  config: Pick<RuntimeSecurityConfig, 'corsOrigins'>,
): boolean => origin === undefined || config.corsOrigins.includes(origin);

export const effectiveRequestProtocol = (
  headers: Pick<Headers, 'get'> | Record<string, string | string[] | undefined>,
  trustProxy: boolean | TrustedProxyPolicyConfig | TrustedProxyPolicy,
  directProtocol: 'http' | 'https' = 'http',
  remoteAddress?: string,
): 'http' | 'https' => {
  // Keep the small legacy helper usable by existing test adapters. All
  // production call sites pass a peer-aware TrustedProxyPolicy below.
  if (typeof trustProxy === 'boolean') {
    if (!trustProxy) return directProtocol;
    const forwarded = typeof (headers as Pick<Headers, 'get'>).get === 'function'
      ? (headers as Pick<Headers, 'get'>).get('x-forwarded-proto')
      : (headers as Record<string, string | string[] | undefined>)['x-forwarded-proto'];
    if (Array.isArray(forwarded)) return 'http';
    const value = String(forwarded ?? directProtocol).trim().toLowerCase();
    return value === 'https' ? 'https' : 'http';
  }
  const policy = trustProxy instanceof TrustedProxyPolicy
    ? trustProxy
    : new TrustedProxyPolicy(trustProxy);
  return resolveTrustedRequestProtocol({
    headers,
    socket: { remoteAddress, encrypted: directProtocol === 'https' },
  }, policy);
};

export const trustedProxyPolicyFor = (
  config: Pick<RuntimeSecurityConfig, 'trustProxy'>,
): TrustedProxyPolicy => new TrustedProxyPolicy(config.trustProxy);

export const isSecureRequest = (
  request: RequestLike,
  config: Pick<RuntimeSecurityConfig, 'trustProxy'>,
): boolean => {
  return trustedProxyPolicyFor(config).isSecureRequest(request);
};
