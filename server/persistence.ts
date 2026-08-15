import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArchiveRecord, GameTimelineEvent } from '../shared/protocol';
import type { GameState, Message, Player } from '../shared/types';
import { atomicWriteFileSync } from './filePersistence';

export interface PersistedRoom {
  roomId: string; roomCode: string; roomName: string; maxPlayers: number;
  joinToken: string; hostId: string | null; players: Player[];
  spectators: Array<{ id: string; name: string }>; game: GameState | null;
  messages: Message[]; wolfChat: Message[]; gameStarted: boolean;
  timelineEvents?: GameTimelineEvent[];
  winnerTeam: 'wolf' | 'good' | null; aborted: boolean; auto: boolean;
  settings: { hunterShootOnGuardHealDeath: boolean; reviewEnabled: boolean };
  debugMode: boolean; savedAt: number;
}

/**
 * server/persistence.ts — 服务端本地 JSON 持久化（复盘心得 + 复盘存档回看）。
 * 目录：server/data/，运行期自动创建。
 * P2：并发写文件统一走「临时文件 + rename」原子写，避免读半文件 / 写坏 JSON。
 */

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');

const ensureDir = () => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
};

export const serverStorage = {
  get(key: string): string | null {
    ensureDir();
    try {
      return fs.readFileSync(path.join(DATA_DIR, `${key}.json`), 'utf-8');
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    atomicWriteFileSync(path.join(DATA_DIR, `${key}.json`), value);
  },
};

/** 经验心得存储结构（与浏览器端 experienceReview 的 ReviewStore 同构：role -> string[]） */
export type ReviewStore = Record<string, string[]>;

export const loadReviewStore = (): ReviewStore => {
  const raw = serverStorage.get('review-insights');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ReviewStore;
  } catch {
    return {};
  }
};

export const saveReviewStore = (store: ReviewStore): void => {
  serverStorage.set('review-insights', JSON.stringify(store, null, 2));
};

/* ---------- 复盘存档（按局回看） ---------- */

const MAX_ARCHIVES = 50;
const ROOMS_KEY = 'rooms';

export const loadRooms = (): PersistedRoom[] => {
  const raw = serverStorage.get(ROOMS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as PersistedRoom[]; } catch { return []; }
};

export const saveRooms = (rooms: PersistedRoom[]): void => {
  serverStorage.set(ROOMS_KEY, JSON.stringify(rooms, null, 2));
};

export const saveRoom = (room: PersistedRoom): void => {
  const rooms = loadRooms().filter((item) => item.roomCode !== room.roomCode);
  rooms.push(room);
  saveRooms(rooms.slice(-100));
};

export const removeRoom = (roomCode: string): void => {
  saveRooms(loadRooms().filter((room) => room.roomCode !== roomCode));
};

export const loadArchives = (): ArchiveRecord[] => {
  const raw = serverStorage.get('archives');
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ArchiveRecord[];
  } catch {
    return [];
  }
};

export const addArchive = (record: ArchiveRecord): ArchiveRecord[] => {
  const list = loadArchives();
  list.unshift(record);
  const trimmed = list.slice(0, MAX_ARCHIVES);
  serverStorage.set('archives', JSON.stringify(trimmed, null, 2));
  return trimmed;
};

export const clearArchives = (): void => {
  serverStorage.set('archives', JSON.stringify([]));
};
