// 旧页面兼容 shim。V3 pages import shared/protocol directly; these legacy
// pages still use the pre-V3 create-room endpoint and are not part of the M6
// transport.
export type {
  ArchiveRecord,
  ClientAction,
  DebugLogEntry,
  DebugSnapshot,
  RoomSummary,
  Snapshot,
} from '../../shared/protocol';

export type RoomCreateOptions = {
  roomName: string;
  maxPlayers: number;
  aiCount: number;
  name: string;
  reviewEnabled?: boolean;
  spectator?: boolean;
  auto?: boolean;
  debugMode?: boolean;
};
