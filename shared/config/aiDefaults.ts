import { ROOM_AI_DEFAULTS } from '../roomContract';

/**
 * Compatibility defaults for server-side tests and older in-process imports.
 * New V3 code reads SERVER_AI_DEFAULTS from the server composition root;
 * this shared shape contains no credentials and does not depend on server
 * modules.
 */
export const AI_DEFAULTS = {
  apiType: 'local' as const,
  siliconflow: { apiKey: '', ...ROOM_AI_DEFAULTS.siliconflow },
  deepseek: { apiKey: '', ...ROOM_AI_DEFAULTS.deepseek },
  local: { apiKey: '', ...ROOM_AI_DEFAULTS.local, apiUrl: ROOM_AI_DEFAULTS.local.endpoint },
  defaultBehavior: ROOM_AI_DEFAULTS.defaultBehavior,
};

export type AIConfig = typeof AI_DEFAULTS;
