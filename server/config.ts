import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AIConfig } from '../shared/types';
import { AI_DEFAULTS } from '../shared/config/aiDefaults';
import { mergeDefaults } from '../shared/config/mergeDefaults';

/**
 * server/config.ts — 服务端 AI 配置加载。
 * 读取 test-ai-config.json（或环境变量 WEREWOLF_AI_CONFIG 指向的 json），
 * 输出为 shared/types 的 AIConfig 结构。默认值单源 = shared/config/aiDefaults（雲鵺 A2.5）。
 */

const DEFAULT_CONFIG: AIConfig = AI_DEFAULTS;

/** 服务端不能用浏览器代理 /api/lm-studio，把 localhost 归一为 127.0.0.1 */
const normalizeServerUrl = (url: string): string =>
  url
    .replace(/\/api\/lm-studio\/?$/, '')
    .replace('http://localhost:1234', 'http://127.0.0.1:1234')
    .replace('https://localhost:1234', 'http://127.0.0.1:1234')
    .replace(/^http:\/\/localhost(?::|$)/, 'http://127.0.0.1$1');

export function loadAIConfig(): AIConfig {
  const configPath =
    process.env.WEREWOLF_AI_CONFIG || path.resolve(process.cwd(), 'test-ai-config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const local = (raw.local && typeof raw.local === 'object' ? raw.local : {}) as Record<string, unknown>;
    const cfg: AIConfig = {
      ...DEFAULT_CONFIG,
      apiType: raw.apiType === 'deepseek' || raw.apiType === 'siliconflow' ? raw.apiType : 'local',
      defaultBehavior: (raw.defaultBehavior as AIConfig['defaultBehavior']) || DEFAULT_CONFIG.defaultBehavior,
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
    return cfg;
  } catch (err) {
    console.warn(`[server] AI 配置加载失败（${configPath}），使用默认配置:`, err);
    return DEFAULT_CONFIG;
  }
}
