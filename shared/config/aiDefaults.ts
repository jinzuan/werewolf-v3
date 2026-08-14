import type { AIConfig } from '../types';

/**
 * aiDefaults.ts — AI 配置单源默认值（shared/config，服务端与前端共用同一份，雲鵺 A2.5）。
 * 收敛三处漂移：server/config.ts（原 DEFAULT_CONFIG）/ gameStore.ts / Settings.tsx
 * —— 新前端只从本模块取值；apiKey 只留服务端（前端不存 key，决策⑤ + 坑5）。
 *
 * 说明：server/config.ts 现仍按"运行态覆盖"加载 test-ai-config.json，
 * 本文件为"无覆盖时的默认值"单源。gameStore/Settings 的旧默认值在阶段 1 删除（旧前端）。
 */

/** 单源默认 AI 配置（与旧 server/config.ts DEFAULT_CONFIG 逐字段一致） */
export const AI_DEFAULTS: AIConfig = {
  apiType: 'local',
  siliconflow: {
    apiKey: '',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    temperature: 0.9,
    maxTokens: 512,
  },
  deepseek: {
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.9,
    maxTokens: 512,
  },
  local: {
    apiKey: '',
    model: 'qwen/qwen3.6-35b-a3b',
    temperature: 0.9,
    maxTokens: 512,
    apiUrl: 'http://127.0.0.1:1234/v1/chat/completions',
  },
  defaultBehavior: 'random',
};

/** AI 玩家行为默认值（建房 AI 补全用） */
export const AI_BEHAVIORS = ['aggressive', 'conservative', 'random'] as const;

/** 自由讨论发言配额（每人每白天上限，引擎现状 usedCount<5） */
export const AI_SPEECH_QUOTA = 5;

/** 单 AI 超时策略默认值（阶段 0d 落引擎规格） */
export const AI_TIMEOUT_MS = 30_000;
export const AI_RETRY_ON_HTTP = [429, 500, 502, 503, 504];
export const AI_RETRY_MAX = 1;
