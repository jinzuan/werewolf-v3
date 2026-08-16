import { ROOM_AI_DEFAULTS } from '../../shared/roomContract';

export interface ServerAIProviderSettings {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiUrl?: string;
}

/** Internal composition-root settings for the V3 HTTP provider. */
export interface ServerAIConfig {
  apiType: 'siliconflow' | 'deepseek' | 'local';
  siliconflow: ServerAIProviderSettings;
  deepseek: ServerAIProviderSettings;
  local: ServerAIProviderSettings & { apiUrl: string };
  defaultBehavior: 'aggressive' | 'conservative' | 'random';
}

export const SERVER_AI_DEFAULTS: ServerAIConfig = {
  apiType: 'local',
  siliconflow: { apiKey: '', ...ROOM_AI_DEFAULTS.siliconflow },
  deepseek: { apiKey: '', ...ROOM_AI_DEFAULTS.deepseek },
  local: { apiKey: '', ...ROOM_AI_DEFAULTS.local, apiUrl: ROOM_AI_DEFAULTS.local.endpoint },
  defaultBehavior: ROOM_AI_DEFAULTS.defaultBehavior,
};

export const AI_TIMEOUT_MS = 30_000;
export const AI_RETRY_ON_HTTP = [429, 500, 502, 503, 504] as const;
export const AI_RETRY_MAX = 1;
