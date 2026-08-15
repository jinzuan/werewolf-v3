/**
 * shared/index.ts — 公共导出入口（server 与新前端统一从这 import）。
 * 阶段 0c 迁入的 8 模块（types/protocol/gameLogic/roleConfig/aiClient/
 * memorySystem/experienceReview/gameLogArchive）+ ringBuffer + config。
 *
 * 注意：aiClient 仅供服务端调用（v3 决策：AI 服务端唯一驱动）；前端不 import 它。
 */

export * from './types';
// protocol.ts re-exports the room contract. Keeping a single public path here
// avoids duplicate RoomCommand/RoomSnapshotMessage symbols in TypeScript.
export * from './protocol';
export * from './events';
export * from './rulesetContract';
export * from './gameLogic';
export * from './roleConfig';
export * from './aiClient';
export * from './memorySystem';
export * from './experienceReview';
export * from './gameLogArchive';
export * from './ringBuffer';
export * from './config/aiDefaults';
export * from './config/mergeDefaults';
export * from './aiProviderCapabilities';
