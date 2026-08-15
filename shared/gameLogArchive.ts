import type { GameLog } from './types';

/**
 * gameLogArchive.ts — 对局日志轮转（WEREWOLF_FIXES_v2.3.md 任务 E）
 *
 * 规则：对局日志默认保存最近 3 局；第 4 局开始自动删除最早的日志。
 * 位置/命名：
 *   - 浏览器端：localStorage 键 `wolf-game-logs`（JSON 数组，每局一条记录）。
 *   - 每局记录结构：{ id, roomId, roomName, startedAt, endedAt, winner, day, logCount, logs }
 *   - Node 端（test-drive / QC）：qc_events.txt（由服务端归档的 canonical gameLogEvents 渲染）。
 */

export interface ArchivedGame {
  id: string;
  roomId: string;
  roomName: string;
  startedAt: string;
  endedAt: string;
  winner: 'wolf' | 'good' | null;
  day: number;
  logCount: number;
  logs: GameLog[];
}

const STORAGE_KEY = 'wolf-game-logs';
const MAX_GAMES = 3;

const safeGet = (): ArchivedGame[] | null => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ArchivedGame[]) : [];
  } catch {
    return [];
  }
};

const safeSet = (games: ArchivedGame[]) => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
  } catch {
    /* storage 不可用时静默降级 */
  }
};

/**
 * 保存一局日志。默认保留最近 3 局，超出自动删除最早的。
 * 相同 roomId 的旧局记录会被本次覆盖（同一房间只留最新一局）。
 */
export const archiveGameLogs = (input: {
  roomId: string;
  roomName: string;
  winner: 'wolf' | 'good' | null;
  day: number;
  logs: GameLog[];
}): void => {
  const games = safeGet() ?? [];
  const entry: ArchivedGame = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    roomId: input.roomId,
    roomName: input.roomName || '未命名房间',
    startedAt: input.logs[0]?.timestamp ? new Date(input.logs[0].timestamp).toISOString() : new Date().toISOString(),
    endedAt: new Date().toISOString(),
    winner: input.winner,
    day: input.day,
    logCount: input.logs.length,
    logs: input.logs.slice(-400), // 单局最多存最近 400 条，防 localStorage 撑爆
  };
  // 同一房间旧记录先移除
  const filtered = games.filter((g) => g.roomId !== input.roomId);
  filtered.push(entry);
  // 按结束时间倒序，只留最近 MAX_GAMES 局（自动删除最早）
  const sorted = filtered.sort((a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime());
  const trimmed = sorted.slice(0, MAX_GAMES);
  safeSet(trimmed);
};

export const loadArchivedGames = (): ArchivedGame[] => {
  return safeGet() ?? [];
};

export const clearArchivedGames = (): void => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
};
