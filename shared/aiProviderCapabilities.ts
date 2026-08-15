import type { RoomAIProvider } from './roomContract';

export type AIEndpointMode = 'fixed' | 'configurable';

export interface AIProviderCapability {
  provider: RoomAIProvider;
  endpointMode: AIEndpointMode;
  defaultEndpoint: string;
  allowedProtocols: readonly ('http' | 'https')[];
  allowedPathPrefixes: readonly string[];
  /** The endpoint path used by the OpenAI-compatible request contract. */
  defaultPath: string;
}

const capabilities: Record<RoomAIProvider, AIProviderCapability> = {
  siliconflow: {
    provider: 'siliconflow',
    endpointMode: 'fixed',
    defaultEndpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    allowedProtocols: ['https'],
    allowedPathPrefixes: ['/v1'],
    defaultPath: '/v1/chat/completions',
  },
  deepseek: {
    provider: 'deepseek',
    endpointMode: 'fixed',
    defaultEndpoint: 'https://api.deepseek.com/v1/chat/completions',
    allowedProtocols: ['https'],
    allowedPathPrefixes: ['/v1'],
    defaultPath: '/v1/chat/completions',
  },
  local: {
    provider: 'local',
    endpointMode: 'configurable',
    defaultEndpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    allowedProtocols: ['http', 'https'],
    allowedPathPrefixes: ['/v1'],
    defaultPath: '/v1/chat/completions',
  },
  custom: {
    provider: 'custom',
    endpointMode: 'configurable',
    defaultEndpoint: '',
    allowedProtocols: ['http', 'https'],
    allowedPathPrefixes: ['/v1'],
    defaultPath: '/v1/chat/completions',
  },
};

export const AI_PROVIDER_CAPABILITIES: Readonly<Record<RoomAIProvider, AIProviderCapability>> =
  Object.freeze(Object.fromEntries(
    Object.entries(capabilities).map(([provider, capability]) => [
      provider,
      Object.freeze({
        ...capability,
        allowedProtocols: Object.freeze([...capability.allowedProtocols]),
        allowedPathPrefixes: Object.freeze([...capability.allowedPathPrefixes]),
      }),
    ]),
  ) as Record<RoomAIProvider, AIProviderCapability>);

export const getAIProviderCapability = (
  provider: RoomAIProvider,
): AIProviderCapability => AI_PROVIDER_CAPABILITIES[provider];

export const endpointMatchesCapability = (
  provider: RoomAIProvider,
  endpoint: string,
): boolean => {
  const capability = getAIProviderCapability(provider);
  if (capability.endpointMode === 'fixed') {
    return endpoint === capability.defaultEndpoint;
  }
  try {
    const parsed = new URL(endpoint);
    const protocolAllowed = capability.allowedProtocols.includes(
      parsed.protocol.slice(0, -1) as 'http' | 'https',
    );
    const pathAllowed = capability.allowedPathPrefixes.some((prefix) =>
      parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`));
    return protocolAllowed && pathAllowed;
  } catch {
    return false;
  }
};
