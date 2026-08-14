import { io, type Socket } from 'socket.io-client';
import type {
  GameEventsMessage,
  GameSnapshotMessage,
} from '../../shared/protocol';
import type {
  CreateRoomAck,
  GameCommand,
  GameCommandAck,
  JoinRoomAck,
  ProtocolAck,
  ResumeRoomAck,
  RoomCommand,
  RoomCreateOptions,
  RoomListAck,
  RoomViewAck,
  SnapshotAck,
  SpectatorCommand,
  V3Command,
} from '../../shared/protocol';
import { getServerUrl } from './socket';

type SocketAuth = {
  joinToken?: string;
  resumeToken?: string;
};

type ErrorMessage = Extract<
  ProtocolAck,
  { ok: false }
>;

let socket: Socket | null = null;
let authKey = '';
let currentAuth: SocketAuth = {};
const connectionListeners = new Set<(connected: boolean) => void>();
const eventListeners = new Set<(message: GameEventsMessage) => void>();
const snapshotListeners = new Set<
  (snapshot: GameSnapshotMessage['snapshot']) => void
>();
const errorListeners = new Set<(error: ErrorMessage) => void>();

const keyFor = (auth: SocketAuth): string =>
  JSON.stringify({
    joinToken: auth.joinToken ?? '',
    resumeToken: auth.resumeToken ?? '',
  });

const attachListeners = (active: Socket): void => {
  active.on('connect', () => {
    for (const listener of connectionListeners) listener(true);
  });
  active.on('disconnect', () => {
    for (const listener of connectionListeners) listener(false);
  });
  active.on(
    'v3:events',
    (message: Omit<GameEventsMessage, 'type'>) => {
      const normalized: GameEventsMessage = {
        type: 'game.events',
        ...message,
      };
      for (const listener of eventListeners) listener(normalized);
    },
  );
  active.on(
    'v3:snapshot',
    (message: Omit<GameSnapshotMessage, 'type'>) => {
      for (const listener of snapshotListeners) {
        listener(message.snapshot);
      }
    },
  );
  active.on('v3:error', (error: ErrorMessage) => {
    for (const listener of errorListeners) listener(error);
  });
};

const openConnection = (
  auth?: SocketAuth,
  forceFresh = false,
): Socket => {
  if (socket && auth === undefined && !forceFresh) return socket;
  const nextAuth = auth ?? currentAuth;
  const nextKey = keyFor(nextAuth);
  if (socket && !forceFresh && authKey === nextKey) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  authKey = nextKey;
  currentAuth = nextAuth;
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
  if (!socket) return;
  const auth = { resumeToken };
  socket.auth = auth;
  currentAuth = auth;
  authKey = keyFor(auth);
};

const commandMeta = (actorId: string, roomId?: string) => ({
  commandId: crypto.randomUUID(),
  actorId,
  sentAt: Date.now(),
  roomId,
});

const emitAck = <TAck extends { ok: boolean }>(
  active: Socket,
  event: string,
  payload: unknown,
): Promise<TAck> =>
  new Promise((resolve) => {
    active.emit(event, payload, (response: TAck) => resolve(response));
  });

export const subscribeV3Connection = (
  onChange: (connected: boolean) => void,
): (() => void) => {
  connectionListeners.add(onChange);
  const active = openConnection();
  onChange(active.connected);
  return () => connectionListeners.delete(onChange);
};

export const subscribeV3Events = (
  onMessage: (message: GameEventsMessage) => void,
): (() => void) => {
  eventListeners.add(onMessage);
  return () => eventListeners.delete(onMessage);
};

export const subscribeV3Snapshots = (
  onSnapshot: (snapshot: GameSnapshotMessage['snapshot']) => void,
): (() => void) => {
  snapshotListeners.add(onSnapshot);
  return () => snapshotListeners.delete(onSnapshot);
};

export const subscribeV3Errors = (
  onError: (error: ErrorMessage) => void,
): (() => void) => {
  errorListeners.add(onError);
  return () => errorListeners.delete(onError);
};

export const listV3Rooms = async (): Promise<RoomListAck> =>
  emitAck<RoomListAck>(openConnection(), 'v3:rooms', {});

const roomRequest = (
  actorId: string,
  actorName: string,
  command: RoomCommand,
): V3Command & { actorName: string } => ({
  meta: commandMeta(actorId),
  command,
  actorName,
});

export const createV3Room = (
  actorId: string,
  actorName: string,
  options: RoomCreateOptions,
): Promise<CreateRoomAck> =>
  emitAck<CreateRoomAck>(
    openConnection({}, true),
    'v3:command',
    roomRequest(actorId, actorName, {
      type: 'room.create',
      payload: options,
    }),
  );

export const joinV3Room = (
  actorId: string,
  actorName: string,
  roomCode: string,
  joinToken: string,
): Promise<JoinRoomAck> =>
  emitAck<JoinRoomAck>(
    openConnection({}, true),
    'v3:command',
    roomRequest(actorId, actorName, {
      type: 'room.join',
      payload: { roomCode, joinToken },
    }),
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
  const request: V3Command & { actorName: string } = {
    meta: commandMeta(actorId),
    command,
    actorName,
  };
  return emitAck<JoinRoomAck>(
    openConnection({ joinToken }, true),
    'v3:command',
    request,
  );
};

export const resumeV3Room = (
  actorId: string,
  actorName: string,
  roomCode: string,
  roomId: string,
  resumeToken: string,
  afterSequence: number,
): Promise<ResumeRoomAck> => {
  const command: SpectatorCommand = {
    type: 'spectator.resume',
    payload: { roomCode, afterSequence },
  };
  const request: V3Command & { actorName: string } = {
    meta: commandMeta(actorId, roomId),
    command,
    actorName,
  };
  return emitAck<ResumeRoomAck>(
    openConnection({ resumeToken }),
    'v3:command',
    request,
  );
};

export const startV3Game = (
  actorId: string,
  roomId: string,
): Promise<RoomViewAck> => {
  const request: V3Command = {
    meta: commandMeta(actorId, roomId),
    command: { type: 'room.start_game', payload: {} },
  };
  return emitAck<RoomViewAck>(
    openConnection(),
    'v3:command',
    request,
  );
};

export const sendGameCommand = (
  actorId: string,
  roomId: string,
  gameId: string,
  expectedStageRevision: number,
  command: GameCommand,
): Promise<GameCommandAck> => {
  const request: V3Command = {
    meta: {
      ...commandMeta(actorId, roomId),
      roomId,
      gameId,
      expectedStageRevision,
    },
    command,
  };
  return emitAck<GameCommandAck>(
    openConnection(),
    'v3:command',
    request,
  );
};

export const fetchV3Snapshot = (
  roomCode: string,
  actorId: string,
): Promise<SnapshotAck> =>
  emitAck<SnapshotAck>(
    openConnection(),
    'v3:snapshot',
    { roomCode, actorId },
  );
