import { io, Socket } from 'socket.io-client';
import type { ClientAction, RoomCreateOptions, Snapshot, ArchiveRecord, RoomSummary } from './protocol';

/**
 * src/net/socket.ts — 联机模式 socket.io 客户端单例。
 * V3 生产连接只允许 HTTPS/WSS；开发 HTTP 例外仅允许 loopback。
 */

const SERVER_URL_KEY = 'wolf-server-url';
let socket: Socket | null = null;
let serverUrl = getStoredServerUrl();

const buildMode = String((import.meta.env as Record<string, unknown>).MODE ?? 'development');
const configuredServerUrl = (import.meta.env as Record<string, unknown>).VITE_V3_SERVER_URL;

const isLoopback = (hostname: string): boolean =>
  ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase());

export class SocketConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketConfigurationError';
  }
}

export const validateSocketUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SocketConfigurationError('服务器地址无效');
  }
  const pageProtocol = window.location.protocol;
  const explicitDevelopment = (import.meta.env as Record<string, unknown>).VITE_WW_ENV;
  const environment = explicitDevelopment === 'production' || buildMode === 'production'
    ? 'production'
    : explicitDevelopment === 'test' ? 'test' : 'development';
  if (environment === 'production' || pageProtocol === 'https:') {
    if (parsed.protocol !== 'https:') {
      throw new SocketConfigurationError('HTTPS 页面不能连接明文 HTTP/WS 服务');
    }
  } else if (parsed.protocol === 'http:' && (!isLoopback(parsed.hostname) || !['development', 'test'].includes(environment))) {
    throw new SocketConfigurationError('开发/测试明文服务只能使用 loopback 地址');
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SocketConfigurationError('服务器地址必须使用 HTTPS 或 HTTP');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new SocketConfigurationError('服务器地址不能包含用户信息或片段');
  }
  return parsed.origin;
};

function getStoredServerUrl(): string {
  if (typeof configuredServerUrl === 'string' && configuredServerUrl.trim()) {
    return validateSocketUrl(configuredServerUrl.trim());
  }
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(SERVER_URL_KEY);
  } catch {
    /* ignore */
  }
  if (saved) return validateSocketUrl(saved);
  const page = window.location;
  if (page.protocol === 'https:') return page.origin;
  const hostname = page.hostname || 'localhost';
  return validateSocketUrl(`http://${isLoopback(hostname) ? hostname : '127.0.0.1'}:3001`);
}

export function getServerUrl(): string {
  return serverUrl;
}

export function setServerUrl(url: string): void {
  serverUrl = validateSocketUrl(url);
  try {
    localStorage.setItem(SERVER_URL_KEY, serverUrl);
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
