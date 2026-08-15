import { io, type Socket } from 'socket.io-client';
import type {
  GameEventsMessage,
  GameSnapshotMessage,
  RoomSnapshotMessage,
  V3ServerMessage,
} from '../../shared/protocol';
import type {
  CreateRoomAck,
  CreateRoomOptionsV31,
  GameCommand,
  GameCommandAck,
  JoinRoomAck,
  ProtocolAck,
  ProtocolAckError,
  ResumeRoomAck,
  RoomCommand,
  RoomListAck,
  RoomMutationCommand,
  RoomReadCommand,
  RoomViewAck,
  SnapshotAck,
  SpectatorCommand,
  V3Command,
} from '../../shared/protocol';
import { getServerUrl } from './socket';

/**
 * The V3 socket adapter is deliberately the only place that knows socket.io
 * event names.  Server pushes keep their discriminant all the way to the
 * store; the discriminant is preserved on every incoming envelope.
 */

type SocketAuth = {
  joinToken?: string;
  resumeToken?: string;
};

type ClientCommand = V3Command & {
  actorName?: string;
  avatarId?: string;
};

type RoomCommandAck = ProtocolAck<{ room?: RoomSnapshotMessage['room'] }>;

let socket: Socket | null = null;
let authKey = '';
let currentAuth: SocketAuth = {};

const connectionListeners = new Set<(connected: boolean) => void>();
const roomListeners = new Set<(message: RoomSnapshotMessage) => void>();
const eventListeners = new Set<(message: GameEventsMessage) => void>();
const snapshotListeners = new Set<(message: GameSnapshotMessage) => void>();
const messageListeners = new Set<(message: V3ServerMessage) => void>();
const errorListeners = new Set<(error: ProtocolAckError) => void>();

/**
 * Socket.IO queues emits while it is connecting, but an ACK callback is never
 * called if the connection was replaced in that small window.  That turned a
 * perfectly healthy lobby connection into an infinite "连接中" wizard. Keep
 * the transport responsible for waiting for the active socket and make every
 * request finite.
 */
const ACK_TIMEOUT_MS = 15_000;

const keyFor = (auth: SocketAuth): string =>
  JSON.stringify({
    joinToken: auth.joinToken ?? '',
    resumeToken: auth.resumeToken ?? '',
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isRoomSnapshotMessage = (
  message: unknown,
): message is RoomSnapshotMessage =>
  isRecord(message) && message.type === 'room.snapshot' && 'room' in message;

const isGameEventsMessage = (
  message: unknown,
): message is GameEventsMessage =>
  isRecord(message) &&
  message.type === 'game.events' &&
  typeof message.roomId === 'string' &&
  typeof message.gameId === 'string' &&
  Array.isArray(message.events);

const isGameSnapshotMessage = (
  message: unknown,
): message is GameSnapshotMessage =>
  isRecord(message) &&
  message.type === 'game.snapshot' &&
  'snapshot' in message;

const emitMessage = (message: V3ServerMessage): void => {
  for (const listener of messageListeners) listener(message);
  if (message.type === 'room.snapshot') {
    for (const listener of roomListeners) listener(message);
  } else if (message.type === 'game.events') {
    for (const listener of eventListeners) listener(message);
  } else if (message.type === 'game.snapshot') {
    for (const listener of snapshotListeners) listener(message);
  }
};

const attachListeners = (active: Socket): void => {
  active.on('connect', () => {
    for (const listener of connectionListeners) listener(true);
  });
  active.on('disconnect', () => {
    for (const listener of connectionListeners) listener(false);
  });
  active.on('v3:room', (message: unknown) => {
    if (isRoomSnapshotMessage(message)) emitMessage(message);
  });
  active.on('v3:events', (message: unknown) => {
    if (isGameEventsMessage(message)) emitMessage(message);
  });
  active.on('v3:snapshot', (message: unknown) => {
    if (isGameSnapshotMessage(message)) emitMessage(message);
  });
  active.on('v3:error', (error: unknown) => {
    if (!isRecord(error) || error.ok !== false) return;
    for (const listener of errorListeners) {
      listener(error as unknown as ProtocolAckError);
    }
  });
};

const openConnection = (auth?: SocketAuth, forceFresh = false): Socket => {
  if (socket && auth === undefined && !forceFresh) return socket;
  const nextAuth = auth ?? currentAuth;
  const nextKey = keyFor(nextAuth);
  if (socket && !forceFresh && authKey === nextKey) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  authKey = nextKey;
  currentAuth = { ...nextAuth };
  socket = io(getServerUrl(), {
    auth: nextAuth,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
  });
  attachListeners(socket);
  return socket;
};

export const resetV3Connection = (): void => {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socket = null;
  authKey = '';
  currentAuth = {};
  for (const listener of connectionListeners) listener(false);
};

export const adoptV3Identity = (resumeToken: string): void => {
  const auth = { resumeToken };
  currentAuth = auth;
  authKey = keyFor(auth);
  if (socket) socket.auth = auth;
};

const commandMeta = (actorId: string, roomId?: string) => ({
  commandId: crypto.randomUUID(),
  actorId,
  sentAt: Date.now(),
  ...(roomId ? { roomId } : {}),
});

const unavailableAck = <TAck extends { ok: boolean }>(): TAck => ({
  ok: false,
  code: 'UNKNOWN_ERROR',
} as unknown as TAck);

const emitAck = <TAck extends { ok: boolean }>(
  active: Socket,
  event: string,
  payload: unknown,
): Promise<TAck> =>
  new Promise((resolve) => {
    let settled = false;
    let requestSent = false;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (response: TAck): void => {
      if (settled) return;
      settled = true;
      if (requestTimer) clearTimeout(requestTimer);
      if (connectTimer) clearTimeout(connectTimer);
      active.off('connect', onConnect);
      resolve(response);
    };

    const send = (): void => {
      if (settled || requestSent) return;
      requestSent = true;
      requestTimer = setTimeout(() => finish(unavailableAck<TAck>()), ACK_TIMEOUT_MS);
      active.emit(event, payload, (response: TAck) => finish(response));
    };

    function onConnect(): void {
      active.off('connect', onConnect);
      send();
    }

    if (active.connected) {
      send();
      return;
    }

    active.once('connect', onConnect);
    connectTimer = setTimeout(() => finish(unavailableAck<TAck>()), ACK_TIMEOUT_MS);
    // A socket that was just created auto-connects. Calling connect here also
    // covers a socket that was left disconnected by a previous auth switch.
    if (!active.active) active.connect();
  });

const roomReadRequest = (
  actorId: string,
  command: RoomReadCommand,
  actorName?: string,
): ClientCommand => ({
  meta: commandMeta(actorId),
  command,
  ...(actorName ? { actorName } : {}),
});

const roomMutationRequest = (
  actorId: string,
  roomId: string,
  expectedRoomRevision: number,
  command: RoomMutationCommand,
): ClientCommand => ({
  meta: {
    ...commandMeta(actorId, roomId),
    expectedRoomRevision,
  },
  command,
});

export const subscribeV3Connection = (
  onChange: (connected: boolean) => void,
): (() => void) => {
  connectionListeners.add(onChange);
  const active = openConnection();
  onChange(active.connected);
  return () => connectionListeners.delete(onChange);
};

export const subscribeV3Messages = (
  onMessage: (message: V3ServerMessage) => void,
): (() => void) => {
  messageListeners.add(onMessage);
  openConnection();
  return () => messageListeners.delete(onMessage);
};

export const subscribeV3RoomSnapshots = (
  onMessage: (message: RoomSnapshotMessage) => void,
): (() => void) => {
  roomListeners.add(onMessage);
  openConnection();
  return () => roomListeners.delete(onMessage);
};

export const subscribeV3Events = (
  onMessage: (message: GameEventsMessage) => void,
): (() => void) => {
  eventListeners.add(onMessage);
  openConnection();
  return () => eventListeners.delete(onMessage);
};

export const subscribeV3Snapshots = (
  onMessage: (message: GameSnapshotMessage) => void,
): (() => void) => {
  snapshotListeners.add(onMessage);
  openConnection();
  return () => snapshotListeners.delete(onMessage);
};

export const subscribeV3Errors = (
  onError: (error: ProtocolAckError) => void,
): (() => void) => {
  errorListeners.add(onError);
  openConnection();
  return () => errorListeners.delete(onError);
};

export const listV3Rooms = async (): Promise<RoomListAck> =>
  emitAck<RoomListAck>(openConnection(), 'v3:rooms', {});

export const getV3Catalog = async (): Promise<
  ProtocolAck<{ catalog: import('../../shared/roomContract').RoomCreationCatalog }>
> =>
  emitAck(openConnection(), 'v3:command', {
    ...roomReadRequest('catalog-reader', {
      type: 'catalog.get',
      payload: {},
    }),
  });

export const createV3Room = (
  actorId: string,
  actorName: string,
  options: CreateRoomOptionsV31,
): Promise<CreateRoomAck> =>
  emitAck<CreateRoomAck>(
    openConnection(),
    'v3:command',
    roomReadRequest(
      actorId,
      { type: 'room.create', payload: options },
      actorName,
    ),
  );

export const joinV3Room = (
  actorId: string,
  actorName: string,
  roomCode: string,
  joinToken: string,
): Promise<JoinRoomAck> =>
  emitAck<JoinRoomAck>(
    openConnection(),
    'v3:command',
    roomReadRequest(
      actorId,
      {
        type: 'room.join',
        payload: { roomCode, joinToken },
      },
      actorName,
    ),
  );

export const spectateV3Room = (
  actorId: string,
  actorName: string,
  roomCode: string,
  joinToken: string,
  omniscientToken?: string,
): Promise<JoinRoomAck> => {
  const command: SpectatorCommand = {
    type: 'spectator.join',
    payload: { roomCode, omniscientToken },
  };
  const request: ClientCommand = {
    meta: commandMeta(actorId),
    command,
    actorName,
  } as ClientCommand;
  return emitAck<JoinRoomAck>(
    openConnection({ joinToken }, true),
    'v3:command',
    request,
  );
};

/** Room recovery is room-scoped. It never borrows the spectator game replay command. */
export const resumeV3Room = (
  actorId: string,
  actorName: string,
  roomCode: string,
  _roomId?: string,
  resumeToken?: string,
  _afterSequence?: number,
): Promise<ResumeRoomAck> =>
  emitAck<ResumeRoomAck>(
    openConnection({ resumeToken }, true),
    'v3:command',
    roomReadRequest(
      actorId,
      { type: 'room.resume', payload: { roomCode } },
      actorName,
    ),
  );

export const getV3Room = (
  actorId: string,
  roomCode: string,
  roomId?: string,
): Promise<RoomViewAck> =>
  emitAck<RoomViewAck>(
    openConnection(),
    'v3:command',
    {
      meta: commandMeta(actorId, roomId),
      command: { type: 'room.get', payload: { roomCode } },
    } satisfies ClientCommand,
  );

export const sendV3RoomCommand = (
  actorId: string,
  roomId: string,
  expectedRoomRevision: number,
  command: RoomMutationCommand,
): Promise<RoomCommandAck> =>
  emitAck<RoomCommandAck>(
    openConnection(),
    'v3:command',
    roomMutationRequest(
      actorId,
      roomId,
      expectedRoomRevision,
      command,
    ),
  );

export const startV3Game = (
  actorId: string,
  roomId: string,
  expectedRoomRevision: number,
): Promise<RoomViewAck> =>
  emitAck<RoomViewAck>(
    openConnection(),
    'v3:command',
    roomMutationRequest(
      actorId,
      roomId,
      expectedRoomRevision,
      { type: 'room.start_game', payload: {} },
    ),
  );

export const sendGameCommand = (
  actorId: string,
  roomId: string,
  gameId: string,
  expectedStageRevision: number,
  command: GameCommand,
): Promise<GameCommandAck> =>
  emitAck<GameCommandAck>(
    openConnection(),
    'v3:command',
    {
      meta: {
        ...commandMeta(actorId, roomId),
        roomId,
        gameId,
        expectedStageRevision,
      },
      command,
    } satisfies ClientCommand,
  );

export const fetchV3Snapshot = (
  roomCode: string,
  actorId: string,
): Promise<SnapshotAck> =>
  emitAck<SnapshotAck>(
    openConnection(),
    'v3:snapshot',
    { roomCode, actorId },
  );
