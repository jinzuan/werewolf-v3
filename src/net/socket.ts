import { io, Socket } from 'socket.io-client';
import type { ClientAction, RoomCreateOptions, Snapshot, ArchiveRecord, RoomSummary } from './protocol';

/**
 * src/net/socket.ts — 联机模式 socket.io 客户端单例。
 * 默认连接地址：<页面 host>:3001（手机/电脑同房时通过访问 PC 的页面地址自动命中），
 * 可在 OnlineLobby 里手动改成局域网 IP。
 */

const SERVER_URL_KEY = 'wolf-server-url';
let socket: Socket | null = null;
let serverUrl = getStoredServerUrl();

function getStoredServerUrl(): string {
  try {
    const saved = localStorage.getItem(SERVER_URL_KEY);
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  const hostname = window.location.hostname || 'localhost';
  return `http://${hostname}:3001`;
}

export function getServerUrl(): string {
  return serverUrl;
}

export function setServerUrl(url: string): void {
  serverUrl = url;
  try {
    localStorage.setItem(SERVER_URL_KEY, url);
  } catch {
    /* ignore */
  }
}

export function connect(url?: string): Socket {
  if (socket && socket.connected && (!url || url === serverUrl)) return socket;
  serverUrl = url || serverUrl;
  if (socket) socket.disconnect();
  socket = io(serverUrl, {
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
