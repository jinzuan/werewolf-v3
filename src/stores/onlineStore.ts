import { create } from 'zustand';
import type { DebugLogEntry, DebugSnapshot, RoomSummary, Snapshot } from '../net/protocol';

interface OnlineStore {
  connected: boolean;
  connecting: boolean;
  roomCode: string | null;
  playerId: string | null;
  spectatorId: string | null;
  snapshot: Snapshot | null;
  serverError: string | null;
  connectionNotice: string | null;
  debugSnapshot: DebugSnapshot | null;
  debugLogs: DebugLogEntry[];
  roomSummaries: RoomSummary[];
  setConnecting: (v: boolean) => void;
  setConnected: (v: boolean) => void;
  setJoined: (roomCode: string, playerId: string | null, spectatorId: string | null) => void;
  setSnapshot: (s: Snapshot) => void;
  setServerError: (m: string | null) => void;
  setConnectionNotice: (m: string | null) => void;
  setDebugSnapshot: (s: DebugSnapshot | null) => void;
  setDebugLogs: (logs: DebugLogEntry[]) => void;
  setRoomSummaries: (rooms: RoomSummary[]) => void;
  reset: () => void;
}

export const useOnlineStore = create<OnlineStore>()((set) => ({
  connected: false,
  connecting: false,
  roomCode: null,
  playerId: null,
  spectatorId: null,
  snapshot: null,
  serverError: null,
  connectionNotice: null,
  debugSnapshot: null,
  debugLogs: [],
  roomSummaries: [],
  setConnecting: (v) => set({ connecting: v }),
  setConnected: (v) => set({ connected: v }),
  setJoined: (roomCode, playerId, spectatorId) => set({ roomCode, playerId, spectatorId }),
  setSnapshot: (s) => set({ snapshot: s }),
  setServerError: (m) => set({ serverError: m }),
  setConnectionNotice: (connectionNotice) => set({ connectionNotice }),
  setDebugSnapshot: (debugSnapshot) => set({ debugSnapshot }),
  setDebugLogs: (debugLogs) => set({ debugLogs }),
  setRoomSummaries: (roomSummaries) => set({ roomSummaries }),
  reset: () =>
    set({ connected: false, connecting: false, roomCode: null, playerId: null, spectatorId: null, snapshot: null, serverError: null, connectionNotice: null, debugSnapshot: null, debugLogs: [], roomSummaries: [] }),
}));
