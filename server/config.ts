import * as fs from 'node:fs';
import * as path from 'node:path';
import { SERVER_AI_DEFAULTS, type ServerAIConfig } from './ai/config';
import { mergeDefaults } from './ai/mergeDefaults';

/**
 * server/config.ts — 服务端 AI 配置加载。
 * 读取 test-ai-config.json（或环境变量 WEREWOLF_AI_CONFIG 指向的 json），
 * 输出为 V3 server AI provider 的内部配置结构。
 */

const DEFAULT_CONFIG: ServerAIConfig = SERVER_AI_DEFAULTS;

/** 服务端不能用浏览器代理 /api/lm-studio，把 localhost 归一为 127.0.0.1 */
const normalizeServerUrl = (url: string): string =>
  url
    .replace(/\/api\/lm-studio\/?$/, '')
    .replace('http://localhost:1234', 'http://127.0.0.1:1234')
    .replace(/^http:\/\/localhost(?::|$)/, 'http://127.0.0.1$1');

export function loadAIConfig(): ServerAIConfig {
  const configPath =
    process.env.WEREWOLF_AI_CONFIG || path.resolve(process.cwd(), 'test-ai-config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const local = (raw.local && typeof raw.local === 'object' ? raw.local : {}) as Record<string, unknown>;
    const cfg: ServerAIConfig = {
      ...DEFAULT_CONFIG,
      apiType: raw.apiType === 'deepseek' || raw.apiType === 'siliconflow' ? raw.apiType : 'local',
      defaultBehavior: (raw.defaultBehavior as ServerAIConfig['defaultBehavior']) || DEFAULT_CONFIG.defaultBehavior,
    };
    if (raw.siliconflow && typeof raw.siliconflow === 'object') {
      cfg.siliconflow = mergeDefaults(cfg.siliconflow as unknown as Record<string, unknown>, raw.siliconflow as Record<string, unknown>) as unknown as typeof cfg.siliconflow;
    }
    if (raw.deepseek && typeof raw.deepseek === 'object') {
      cfg.deepseek = mergeDefaults(cfg.deepseek as unknown as Record<string, unknown>, raw.deepseek as Record<string, unknown>) as unknown as typeof cfg.deepseek;
    }
    cfg.local = {
      ...cfg.local,
      ...(local as unknown as Partial<typeof cfg.local>),
      apiUrl: normalizeServerUrl((local.apiUrl as string) || cfg.local.apiUrl),
      model: (local.model as string) || cfg.local.model,
    };
    // Deployment-level credentials are intentionally read only on the server.
    // They are also used by the optional post-game review generator.
    const envType = process.env.WW_API_TYPE;
    const apiType = envType === 'siliconflow' || envType === 'deepseek' || envType === 'local'
      ? envType
      : cfg.apiType;
    const envKey = process.env.WW_API_KEY?.trim();
    const envModel = process.env.WW_MODEL?.trim();
    const envUrl = process.env.WW_API_URL?.trim();
    cfg.apiType = apiType;
    if (apiType === 'local') {
      cfg.local = {
        ...cfg.local,
        ...(envKey ? { apiKey: envKey } : {}),
        ...(envModel ? { model: envModel } : {}),
        ...(envUrl ? { apiUrl: normalizeServerUrl(envUrl) } : {}),
      };
    } else if (apiType === 'siliconflow') {
      cfg.siliconflow = {
        ...cfg.siliconflow,
        ...(envKey ? { apiKey: envKey } : {}),
        ...(envModel ? { model: envModel } : {}),
      };
    } else {
      cfg.deepseek = {
        ...cfg.deepseek,
        ...(envKey ? { apiKey: envKey } : {}),
        ...(envModel ? { model: envModel } : {}),
      };
    }
    return cfg;
  } catch (err) {
    console.warn(`[server] AI 配置加载失败（${configPath}），使用默认配置:`, err);
    return DEFAULT_CONFIG;
  }
}
