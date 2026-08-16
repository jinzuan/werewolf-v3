import { io, type Socket } from 'socket.io-client';
import type {
  CommandReceipt,
  CommandReceiptAck,
  GameEventsMessage,
  GameSnapshotMessage,
  RoomSnapshotMessage,
  V3ServerMessage,
  RoomClosedMessage,
} from '../../shared/protocol';
import type {
  CreateRoomAck,
  CreateRoomOptionsV31,
  GameCommand,
  GameCommandAck,
  GameEventsAck,
  JoinRoomAck,
  ProtocolAck,
  ProtocolAckError,
  ResumeRoomAck,
  ReviewViewAck,
  ReviewInsightsAck,
  RoomAIConfigAck,
  RoomAIConfigPatch,
  RoomAIConfigUpdateAck,
  RoomListAck,
  RoomListQuery,
  RoomMutationCommand,
  RoomReadCommand,
  RoomViewAck,
  SnapshotAck,
  SpectatorCommand,
  V3Command,
} from '../../shared/protocol';
import { getServerUrl } from './serverEndpoint';

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

type RoomCommandAck = ProtocolAck<{
  room?: RoomSnapshotMessage['room'];
  receipt: CommandReceipt;
  summary?: import('../../shared/roomContract').RoomAIConfigSummary | null;
  roomRevision?: number;
}>;

export type TransportFailureCode =
  | 'TRANSPORT_REPLACED'
  | 'TRANSPORT_UNAVAILABLE'
  | 'CONNECT_TIMEOUT'
  | 'ACK_TIMEOUT'
  | 'CANCELLED';

export interface TransportFailure {
  ok: false;
  kind: 'transport';
  code: TransportFailureCode;
  message: string;
  /** True once Socket.IO accepted the command for transmission. */
  sent?: boolean;
}

export type ClientAck<TPayload extends object = Record<string, never>> =
  | ProtocolAck<TPayload>
  | TransportFailure;

let publicSocket: Socket | null = null;
let roomSocket: Socket | null = null;
let roomAuthKey = '';
let currentAuth: SocketAuth = {};

const connectionListeners = new Set<(connected: boolean) => void>();
const roomListeners = new Set<(message: RoomSnapshotMessage) => void>();
const eventListeners = new Set<(message: GameEventsMessage) => void>();
const snapshotListeners = new Set<(message: GameSnapshotMessage) => void>();
const messageListeners = new Set<(message: V3ServerMessage) => void>();
const errorListeners = new Set<(error: ProtocolAckError) => void>();
const transportRequests = new Map<Socket, Set<(failure: TransportFailure) => void>>();

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
  } else if (message.type === 'room.closed') {
    // Room close is delivered through the generic message subscription so the
    // authority store can leave a resolver immediately.
  } else if (message.type === 'game.events') {
    for (const listener of eventListeners) listener(message);
  } else if (message.type === 'game.snapshot') {
    for (const listener of snapshotListeners) listener(message);
  }
};

const isRoomClosedMessage = (message: unknown): message is RoomClosedMessage =>
  isRecord(message) &&
  message.type === 'room.closed' &&
  typeof message.roomCode === 'string' &&
  typeof message.roomId === 'string' &&
  message.reason === 'dissolved';

const notifyConnection = (): void => {
  const connected = Boolean(publicSocket?.connected || roomSocket?.connected);
  for (const listener of connectionListeners) listener(connected);
};

const attachPublicListeners = (active: Socket): void => {
  active.on('connect', notifyConnection);
  active.on('disconnect', notifyConnection);
};

const attachRoomListeners = (active: Socket): void => {
  active.on('connect', notifyConnection);
  active.on('disconnect', (reason: string) => {
    const pending = transportRequests.get(active);
    if (pending && pending.size > 0) {
      const failure: TransportFailure = {
        ok: false,
        kind: 'transport',
        code: reason === 'io client disconnect' ? 'TRANSPORT_REPLACED' : 'TRANSPORT_UNAVAILABLE',
        message: reason,
      };
      for (const cancel of [...pending]) cancel(failure);
    }
    notifyConnection();
  });
  active.on('v3:room', (message: unknown) => {
    if (isRoomSnapshotMessage(message)) emitMessage(message);
  });
  active.on('v3:room.closed', (message: unknown) => {
    if (isRoomClosedMessage(message)) emitMessage(message);
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

const openPublicConnection = (): Socket => {
  if (publicSocket) return publicSocket;
  publicSocket = io(getServerUrl(), {
    auth: {},
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    ...(typeof window === 'undefined' ? { autoUnref: true } : {}),
  });
  attachPublicListeners(publicSocket);
  return publicSocket;
};

const cancelSocketRequests = (active: Socket, failure: TransportFailure): void => {
  const pending = transportRequests.get(active);
  if (!pending) return;
  for (const cancel of [...pending]) cancel(failure);
};

const openRoomConnection = (auth?: SocketAuth, forceFresh = false): Socket => {
  if (roomSocket && auth === undefined && !forceFresh) return roomSocket;
  const nextAuth = auth ?? currentAuth;
  const nextKey = keyFor(nextAuth);
  if (roomSocket && !forceFresh && roomAuthKey === nextKey) return roomSocket;

  if (roomSocket) {
    cancelSocketRequests(roomSocket, {
      ok: false,
      kind: 'transport',
      code: 'TRANSPORT_REPLACED',
      message: 'Room transport was replaced.',
    });
    roomSocket.removeAllListeners();
    roomSocket.disconnect();
  }
  roomAuthKey = nextKey;
  currentAuth = { ...nextAuth };
  roomSocket = io(getServerUrl(), {
    auth: nextAuth,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000,
    ...(typeof window === 'undefined' ? { autoUnref: true } : {}),
  });
  attachRoomListeners(roomSocket);
  return roomSocket;
};

export const resetRoomTransport = (): void => {
  if (roomSocket) {
    cancelSocketRequests(roomSocket, {
      ok: false,
      kind: 'transport',
      code: 'TRANSPORT_REPLACED',
      message: 'Room transport was reset.',
    });
    roomSocket.removeAllListeners();
    roomSocket.disconnect();
  }
  roomSocket = null;
  roomAuthKey = '';
  currentAuth = {};
  notifyConnection();
};

/** Compatibility alias; callers should use the room-scoped name. */
export const resetV3Connection = resetRoomTransport;

export const adoptV3Identity = (resumeToken: string): void => {
  const auth = { resumeToken };
  currentAuth = auth;
  roomAuthKey = keyFor(auth);
  if (roomSocket) roomSocket.auth = auth;
};

const commandMeta = (actorId: string, roomId?: string) => ({
  commandId: crypto.randomUUID(),
  actorId,
  sentAt: Date.now(),
  ...(roomId ? { roomId } : {}),
});

const transportFailure = (
  code: TransportFailureCode,
  message: string,
  sent = false,
): TransportFailure => ({ ok: false, kind: 'transport', code, message, sent });

const isAck = (value: unknown): value is { ok: boolean } =>
  isRecord(value) && typeof value.ok === 'boolean';

const emitAck = <TAck extends object>(
  active: Socket,
  event: string,
  payload: unknown,
): Promise<ClientAck<TAck>> =>
  new Promise((resolve) => {
    let settled = false;
    let requestSent = false;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    const connectTimer: { value?: ReturnType<typeof setTimeout> } = {};

    const unregister = (): void => {
      const pending = transportRequests.get(active);
      pending?.delete(cancel);
      if (pending?.size === 0) transportRequests.delete(active);
    };

    const finish = (response: ClientAck<TAck>): void => {
      if (settled) return;
      settled = true;
      if (requestTimer) clearTimeout(requestTimer);
      if (connectTimer.value) clearTimeout(connectTimer.value);
      active.off('connect', onConnect);
      active.off('disconnect', onDisconnect);
      active.off('connect_error', onConnectError);
      unregister();
      resolve(response);
    };

    const cancel = (failure: TransportFailure): void =>
      finish({ ...failure, sent: failure.sent ?? requestSent });

    const onDisconnect = (): void =>
      finish(transportFailure('TRANSPORT_UNAVAILABLE', 'Socket disconnected.', requestSent));
    const onConnectError = (error: Error): void =>
      finish(transportFailure('TRANSPORT_UNAVAILABLE', error.message, requestSent));

    const send = (): void => {
      if (settled || requestSent) return;
      requestSent = true;
      requestTimer = setTimeout(
        () => finish(transportFailure('ACK_TIMEOUT', 'The server did not acknowledge the request.', true)),
        ACK_TIMEOUT_MS,
      );
      active.emit(event, payload, (response: TAck) => {
        finish(
          isAck(response)
            ? (response as ClientAck<TAck>)
            : transportFailure('TRANSPORT_UNAVAILABLE', 'Invalid server acknowledgement.', true),
        );
      });
    };

    function onConnect(): void {
      active.off('connect', onConnect);
      send();
    }

    active.on('disconnect', onDisconnect);
    active.on('connect_error', onConnectError);
    const pending = transportRequests.get(active) ?? new Set();
    pending.add(cancel);
    transportRequests.set(active, pending);

    if (active.connected) {
      send();
      return;
    }

    active.once('connect', onConnect);
    connectTimer.value = setTimeout(
      () => finish(transportFailure('CONNECT_TIMEOUT', 'The server connection timed out.', requestSent)),
      ACK_TIMEOUT_MS,
    );
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
  commandId?: string,
): ClientCommand => ({
  meta: {
    ...commandMeta(actorId, roomId),
    ...(commandId ? { commandId } : {}),
    expectedRoomRevision,
  },
  command,
});

export const subscribeV3Connection = (
  onChange: (connected: boolean) => void,
): (() => void) => {
  connectionListeners.add(onChange);
  const active = openPublicConnection();
  onChange(Boolean(active.connected || roomSocket?.connected));
  return () => connectionListeners.delete(onChange);
};

export const subscribeV3Messages = (
  onMessage: (message: V3ServerMessage) => void,
): (() => void) => {
  messageListeners.add(onMessage);
  openRoomConnection();
  return () => messageListeners.delete(onMessage);
};

export const subscribeV3RoomSnapshots = (
  onMessage: (message: RoomSnapshotMessage) => void,
): (() => void) => {
  roomListeners.add(onMessage);
  openRoomConnection();
  return () => roomListeners.delete(onMessage);
};

export const subscribeV3Events = (
  onMessage: (message: GameEventsMessage) => void,
): (() => void) => {
  eventListeners.add(onMessage);
  openRoomConnection();
  return () => eventListeners.delete(onMessage);
};

export const subscribeV3Snapshots = (
  onMessage: (message: GameSnapshotMessage) => void,
): (() => void) => {
  snapshotListeners.add(onMessage);
  openRoomConnection();
  return () => snapshotListeners.delete(onMessage);
};

export const subscribeV3Errors = (
  onError: (error: ProtocolAckError) => void,
): (() => void) => {
  errorListeners.add(onError);
  openRoomConnection();
  return () => errorListeners.delete(onError);
};

const isRetryableTransport = <TPayload extends object>(
  response: ClientAck<TPayload>,
): response is TransportFailure =>
  response.ok === false &&
  'kind' in response &&
  response.kind === 'transport' &&
  (response.code === 'TRANSPORT_REPLACED' || response.code === 'TRANSPORT_UNAVAILABLE');

const publicRead = async <TAck extends object>(
  event: string,
  payload: unknown,
): Promise<ClientAck<TAck>> => {
  let response = await emitAck<TAck>(openPublicConnection(), event, payload);
  for (let attempt = 0; attempt < 2 && isRetryableTransport(response); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    response = await emitAck<TAck>(openPublicConnection(), event, payload);
  }
  return response;
};

export const listV3Rooms = async (
  query: RoomListQuery = {},
): Promise<ClientAck<RoomListAck extends ProtocolAck<infer P> ? P : never>> =>
  publicRead('v3:rooms', query);

export const getV3Catalog = async (): Promise<ClientAck<{ catalog: import('../../shared/roomContract').RoomCreationCatalog }>> =>
  publicRead('v3:command', {
    ...roomReadRequest('catalog-reader', {
      type: 'catalog.get',
      payload: {},
    }),
  });

export const createV3Room = (
  actorId: string,
  actorName: string,
  options: CreateRoomOptionsV31,
  createRequestId: string,
): Promise<ClientAck<CreateRoomAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:command',
    roomReadRequest(
      actorId,
      { type: 'room.create', payload: { createRequestId, options } },
      actorName,
    ),
  );

export const joinV3Room = (
  actorId: string,
  actorName: string,
  roomCode: string,
  joinToken: string,
): Promise<ClientAck<JoinRoomAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
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
): Promise<ClientAck<JoinRoomAck extends ProtocolAck<infer P> ? P : never>> => {
  const command: SpectatorCommand = {
    type: 'spectator.join',
    payload: { roomCode, omniscientToken },
  };
  const request: ClientCommand = {
    meta: commandMeta(actorId),
    command,
    actorName,
  } as ClientCommand;
  return emitAck(
    openRoomConnection({ joinToken }, true),
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
): Promise<ClientAck<ResumeRoomAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection({ resumeToken }, true),
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
): Promise<ClientAck<RoomViewAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:command',
    {
      meta: commandMeta(actorId, roomId),
      command: { type: 'room.get', payload: { roomCode } },
    } satisfies ClientCommand,
  );

export const getV3AIConfig = (
  actorId: string,
  roomId?: string,
): Promise<ClientAck<RoomAIConfigAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:command',
    {
      meta: commandMeta(actorId, roomId),
      command: { type: 'room.ai_config.get', payload: {} },
    } satisfies ClientCommand,
  );

export const getV3Review = (
  actorId: string,
  roomCode: string,
  roomId?: string,
): Promise<ClientAck<ReviewViewAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:command',
    {
      meta: commandMeta(actorId, roomId),
      command: { type: 'review.get', payload: { roomCode } },
    } satisfies ClientCommand,
  );

export const clearV3ReviewInsights = (
  actorId: string,
  roomId: string,
  expectedRoomRevision: number,
  role?: import('../../shared/types').Role,
): Promise<ClientAck<ReviewInsightsAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:command',
    roomMutationRequest(
      actorId,
      roomId,
      expectedRoomRevision,
      { type: 'review.insights.clear', payload: role ? { role } : {} },
    ),
  );

export const sendV3RoomCommand = (
  actorId: string,
  roomId: string,
  expectedRoomRevision: number,
  command: RoomMutationCommand,
  commandId?: string,
): Promise<ClientAck<RoomCommandAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:command',
    roomMutationRequest(
      actorId,
      roomId,
      expectedRoomRevision,
      command,
      commandId,
    ),
  );

export const getV3CommandReceipt = (
  actorId: string,
  roomId: string,
  commandId: string,
): Promise<ClientAck<CommandReceiptAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:command',
    {
      meta: commandMeta(actorId, roomId),
      command: { type: 'room.command_receipt', payload: { commandId } },
    } satisfies ClientCommand,
  );

export const updateV3AIConfig = (
  actorId: string,
  roomId: string,
  expectedRoomRevision: number,
  patch: RoomAIConfigPatch,
): Promise<ClientAck<RoomAIConfigUpdateAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:command',
    roomMutationRequest(
      actorId,
      roomId,
      expectedRoomRevision,
      { type: 'room.update_ai_config', payload: { patch } },
    ),
  );

export const startV3Game = (
  actorId: string,
  roomId: string,
  expectedRoomRevision: number,
): Promise<ClientAck<RoomViewAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
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
): Promise<ClientAck<GameCommandAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
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
): Promise<ClientAck<SnapshotAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:snapshot',
    { roomCode, actorId },
  );

/** Read the authoritative, viewer-projected event stream during recovery. */
export const fetchV3Events = (
  roomCode: string,
  actorId: string,
  afterSequence = 0,
): Promise<ClientAck<GameEventsAck extends ProtocolAck<infer P> ? P : never>> =>
  emitAck(
    openRoomConnection(),
    'v3:events',
    { roomCode, actorId, afterSequence },
  );
