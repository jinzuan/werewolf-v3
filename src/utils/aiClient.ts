// 阶段 0c：AI 客户端已迁 shared（仅服务端调用，v3 决策：AI 服务端唯一驱动）。
// 本文件为旧前端（本地单机直连 AI 的 GameRoom）兼容 re-export shim（阶段 1 删除旧前端时一并删）。
export * from '../../shared/aiClient';
