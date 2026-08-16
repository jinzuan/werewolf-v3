import { io, Socket } from 'socket.io-client';
import type { ClientAction, RoomCreateOptions, Snapshot, ArchiveRecord, RoomSummary } from './protocol';
import {
  getServerUrl,
  setServerUrl,
  validateSocketUrl,
} from './serverEndpoint';

export {
  getServerUrl,
  setServerUrl,
  SocketConfigurationError,
  validateSocketUrl,
} from './serverEndpoint';

/**
 * src/net/socket.ts — 联机模式 socket.io 客户端单例。
 * V3 生产连接只允许 HTTPS/WSS；开发 HTTP 例外仅允许 loopback。
 */

let socket: Socket | null = null;

export function connect(url?: string): Socket {
  const target = url ? validateSocketUrl(url) : getServerUrl();
  if (socket && socket.connected && target === getServerUrl()) return socket;
  if (url) setServerUrl(target);
  if (socket) socket.disconnect();
  socket = io(target, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnect(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

type Ack<T> = (res: T) => void;

export interface RoomJoinResult {
  ok: boolean;
  message?: string;
  roomCode?: string;
  playerId?: string;
  spectatorId?: string;
  /** 进入令牌（建房时生成；房主/创建者需凭令牌邀请他人加入） */
  token?: string;
  snapshot?: Snapshot;
}

export async function createOnlineRoom(opts: RoomCreateOptions): Promise<RoomJoinResult> {
  const s = connect();
  return new Promise((resolve) => {
    s.emit('create-room', opts, (res: RoomJoinResult) => resolve(res));
  });
}

export async function joinOnlineRoom(
  roomCode: string,
  name: string,
  spectator?: boolean,
  token?: string
): Promise<RoomJoinResult> {
  const s = connect();
  return new Promise((resolve) => {
    s.emit('join-room', { roomCode, name, spectator, token }, (res: RoomJoinResult) => resolve(res));
  });
}

export function subscribeToConnection(onChange: (connected: boolean) => void): () => void {
  const s = connect();
  const onConnect = () => onChange(true);
  const onDisconnect = () => onChange(false);
  s.on('connect', onConnect);
  s.on('disconnect', onDisconnect);
  onChange(s.connected);
  return () => { s.off('connect', onConnect); s.off('disconnect', onDisconnect); };
}

export async function reconnectOnlineRoom(
  roomCode: string,
  playerId: string,
  token?: string
): Promise<RoomJoinResult> {
  const s = connect();
  return new Promise((resolve) => {
    s.emit('reconnect-room', { roomCode, playerId, token }, (res: RoomJoinResult) => resolve(res));
  });
}

export function sendAction(roomCode: string, playerId: string, action: ClientAction): void {
  socket?.emit('action', { roomCode, playerId, action });
}

export function requestDebug(roomCode: string, event: 'debug:snapshot' | 'debug:log'): void {
  socket?.emit(event, { roomCode });
}

export async function fetchArchives(): Promise<ArchiveRecord[]> {
  const s = connect();
  return new Promise((resolve) => {
    s.emit('get-archives', {}, (res: { ok: boolean; archives?: ArchiveRecord[] }) => resolve(res.archives || []));
  });
}

export async function fetchRoomSummaries(): Promise<RoomSummary[]> {
  const s = connect();
  return new Promise((resolve) => {
    s.emit('get-rooms', {}, (res: { ok: boolean; rooms?: RoomSummary[] }) => resolve(res.rooms || []));
  });
}

export async function clearServerArchives(): Promise<boolean> {
  const s = connect();
  return new Promise((resolve) => {
    s.emit('clear-archives', {}, (res: { ok: boolean }) => resolve(!!res.ok));
  });
}

export type { Ack };
