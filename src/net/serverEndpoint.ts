/**
 * Client-side server endpoint policy.
 *
 * The production app is deployed next to its V3 server (or receives one
 * explicit build-time endpoint). Only development and test builds expose a
 * local diagnostic override; a value from browser storage must never turn
 * into a production connection target.
 */

const SERVER_URL_KEY = 'wolf-server-url';

const clientEnv: Record<string, unknown> = (import.meta as ImportMeta & {
  env?: Record<string, unknown>;
}).env ?? {};
const buildMode = String(clientEnv.MODE ?? 'development');
const explicitEnvironment = clientEnv.VITE_WW_ENV;
const configuredServerUrl = clientEnv.VITE_V3_SERVER_URL;
const allowPublicDevelopmentHttp = clientEnv.VITE_WW_ALLOW_PUBLIC_HTTP === '1';

export type ClientEnvironment = 'production' | 'test' | 'development';

export const clientEnvironment = (): ClientEnvironment => {
  // An explicit deployment environment must override Vite's build mode.
  // Development deployments are often served by `vite build` + `vite preview`,
  // whose MODE is `production` even though the server is intentionally a
  // public development instance.
  if (explicitEnvironment === 'production') return 'production';
  if (explicitEnvironment === 'test') return 'test';
  if (explicitEnvironment === 'development') return 'development';
  return buildMode === 'production' ? 'production' : 'development';
};

export const endpointDiagnosticsEnabled = (): boolean =>
  clientEnvironment() !== 'production';

const isLoopback = (hostname: string): boolean =>
  ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());

export class SocketConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketConfigurationError';
  }
}

export const validateSocketUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SocketConfigurationError('服务器地址无效');
  }

  const pageProtocol = typeof window === 'undefined' ? 'http:' : window.location.protocol;
  const environment = clientEnvironment();
  if (environment === 'production' || pageProtocol === 'https:') {
    if (parsed.protocol !== 'https:') {
      throw new SocketConfigurationError('HTTPS 页面不能连接明文 HTTP/WS 服务');
    }
  } else if (
    parsed.protocol === 'http:' &&
    environment === 'development' &&
    !isLoopback(parsed.hostname) &&
    !(
      allowPublicDevelopmentHttp &&
      typeof window !== 'undefined' &&
      parsed.hostname === window.location.hostname
    )
  ) {
    throw new SocketConfigurationError('开发环境公网明文服务必须显式开启，且只能连接当前页面所在主机');
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SocketConfigurationError('服务器地址必须使用 HTTPS 或 HTTP');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new SocketConfigurationError('服务器地址不能包含用户信息或片段');
  }
  return parsed.origin;
};

const readStoredEndpoint = (): string | null => {
  if (!endpointDiagnosticsEnabled()) return null;
  try {
    return localStorage.getItem(SERVER_URL_KEY);
  } catch {
    return null;
  }
};

const defaultEndpoint = (): string => {
  const pageProtocol = typeof window === 'undefined' ? 'http:' : window.location.protocol;
  const pageOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  if (pageProtocol === 'https:' && pageOrigin) return pageOrigin;
  const hostname = typeof window === 'undefined' ? 'localhost' : window.location.hostname || 'localhost';
  return `http://${hostname}:3001`;
};

const configuredEndpoint = (): string | null =>
  typeof configuredServerUrl === 'string' && configuredServerUrl.trim()
    ? validateSocketUrl(configuredServerUrl.trim())
    : null;

const initialEndpoint = (): string => {
  const configured = configuredEndpoint();
  if (configured) return configured;

  const stored = readStoredEndpoint();
  if (stored) return validateSocketUrl(stored);

  return validateSocketUrl(defaultEndpoint());
};

let serverUrl = initialEndpoint();

export function getServerUrl(): string {
  return serverUrl;
}

/**
 * Change the diagnostic endpoint in development/test only. Production uses
 * the build/deployment endpoint and intentionally has no arbitrary editor.
 */
export function setServerUrl(url: string): void {
  if (!endpointDiagnosticsEnabled()) {
    throw new SocketConfigurationError('生产环境的服务地址由部署配置提供');
  }
  serverUrl = validateSocketUrl(url);
  try {
    localStorage.setItem(SERVER_URL_KEY, serverUrl);
  } catch {
    /* Storage is a diagnostic cache, never the connection authority. */
  }
}

// Compatibility names retained for callers from the cleanup branch. They use
// the same production-safe policy as the V3 names above.
export const ServerEndpointError = SocketConfigurationError;
export const validateServerEndpoint = validateSocketUrl;
export const getServerEndpoint = getServerUrl;
export const setServerEndpoint = setServerUrl;
