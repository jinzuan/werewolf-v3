const SERVER_URL_KEY = 'wolf-server-url';

const clientEnv: Record<string, unknown> = (import.meta as ImportMeta & {
  env?: Record<string, unknown>;
}).env ?? {};
const buildMode = String(clientEnv.MODE ?? 'development');
const configuredServerUrl = clientEnv.VITE_V3_SERVER_URL;

const isLoopback = (hostname: string): boolean =>
  ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());

export class ServerEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerEndpointError';
  }
}

export const validateServerEndpoint = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServerEndpointError('服务器地址无效');
  }
  const pageProtocol = typeof window === 'undefined' ? 'http:' : window.location.protocol;
  const explicitEnvironment = clientEnv.VITE_WW_ENV;
  const environment = explicitEnvironment === 'production' || buildMode === 'production'
    ? 'production'
    : explicitEnvironment === 'test' ? 'test' : 'development';
  if (environment === 'production' || pageProtocol === 'https:') {
    if (parsed.protocol !== 'https:') {
      throw new ServerEndpointError('HTTPS 页面不能连接明文 HTTP/WS 服务');
    }
  } else if (
    parsed.protocol === 'http:' &&
    (!isLoopback(parsed.hostname) || !['development', 'test'].includes(environment))
  ) {
    throw new ServerEndpointError('开发/测试明文服务只能使用 loopback 地址');
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ServerEndpointError('服务器地址必须使用 HTTPS 或 HTTP');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new ServerEndpointError('服务器地址不能包含用户信息或片段');
  }
  return parsed.origin;
};

const initialServerEndpoint = (): string => {
  if (typeof configuredServerUrl === 'string' && configuredServerUrl.trim()) {
    return validateServerEndpoint(configuredServerUrl.trim());
  }
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SERVER_URL_KEY);
  } catch {
    // Browser storage is only a connection preference.
  }
  if (saved) return validateServerEndpoint(saved);
  const pageProtocol = typeof window === 'undefined' ? 'http:' : window.location.protocol;
  const pageOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  if (pageProtocol === 'https:') return pageOrigin;
  const hostname = typeof window === 'undefined' ? 'localhost' : window.location.hostname || 'localhost';
  return validateServerEndpoint(`http://${isLoopback(hostname) ? hostname : '127.0.0.1'}:3001`);
};

let serverEndpoint = initialServerEndpoint();

export const getServerEndpoint = (): string => serverEndpoint;

export const setServerEndpoint = (value: string): void => {
  serverEndpoint = validateServerEndpoint(value);
  try {
    localStorage.setItem(SERVER_URL_KEY, serverEndpoint);
  } catch {
    // Browser storage is only a connection preference.
  }
};
