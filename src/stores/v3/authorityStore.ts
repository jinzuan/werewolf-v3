import { create } from 'zustand';
import type {
  DomainEvent,
  ProjectedSnapshot,
} from '../../../shared/events';
import type {
  CreateRoomOptionsV31,
  GameCommand,
  GameEventsMessage,
  ProtocolErrorCode,
  RoomCreationCatalog,
  RoomMutationCommand,
  RoomSummary,
  RoomView,
  V3ServerMessage,
} from '../../../shared/protocol';
import {
  adoptV3Identity,
  createV3Room,
  fetchV3Snapshot,
  getV3Catalog,
  getV3Room,
  joinV3Room,
  listV3Rooms,
  resetV3Connection,
  resumeV3Room,
  sendGameCommand,
  sendV3RoomCommand,
  spectateV3Room,
  startV3Game,
  subscribeV3Connection,
  subscribeV3Errors,
  subscribeV3Events,
  subscribeV3RoomSnapshots,
  subscribeV3Snapshots,
} from '../../net/v3Socket';
import { getErrorMessage } from '../../v3/presentation';
import {
  mergeEventEnvelope,
  type EventStreamState,
} from '../../v3/eventStream';
import { containsSensitiveKeys } from '../../v3/session';
import {
  createEmptyAuthorityState,
  createV3Session,
  isPublicRoomViewSafe,
  isSnapshotSafeForViewer,
  acceptsRoomRevision,
  readV3Session,
  roomViewMatchesSession,
  snapshotMatchesSession,
  writeV3Session,
  type V3Session,
} from '../../v3/session';

const storage = (): Storage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

const loadSession = (): V3Session | null => {
  const target = storage();
  return target ? readV3Session(target) : null;
};

const persistSession = (session: V3Session | null): void => {
  const target = storage();
  if (!target) return;
  try {
    writeV3Session(target, session);
  } catch {
    // Storage is a cache for recovery credentials, never the authority.
  }
};

const newActorId = (): string => crypto.randomUUID();

const isRoomStatusWithGame = (status: RoomView['status']): boolean =>
  status === 'playing' || status === 'ended';

const roomActions = (room: RoomView): string[] => {
  return room.viewer.allowedRoomActions;
};

const buildDefaultOptions = (
  catalog: RoomCreationCatalog,
  name: string,
  roomName: string,
  auto: boolean,
): CreateRoomOptionsV31 | null => {
  const preset = catalog.rolePresets.find(
    (candidate) => candidate.enabled,
  );
  if (!preset) return null;
  return {
    catalogVersion: catalog.catalogVersion,
    roomName: roomName.trim(),
    creator: { name: name.trim(), avatarId: 'avatar-player' },
    mode: auto ? 'quick_computer' : 'human',
    visibility: 'invite_only',
    maxPlayers: preset.playerCount,
    minHumanPlayers: auto ? 0 : preset.playerCount,
    computerSeats: 0,
    aiFillPolicy: auto ? 'fill_to_max' : 'none',
    roleSetup: { ...preset.roleSetup },
    rolePresetId: preset.id,
    rulesetId: preset.rulesetId,
    rulesetVersion: preset.rulesetVersion,
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    reviewEnabled: true,
  };
};

export interface V3Store {
  connected: boolean;
  loading: boolean;
  recovering: boolean;
  /** Explicit three-state recovery status for route guards and shells. */
  authorityStatus: 'resolving' | 'authorized' | 'unauthorized';
  error: string | null;
  pendingRoomCommand: string | null;
  rooms: RoomSummary[];
  catalog: RoomCreationCatalog | null;
  room: RoomView | null;
  session: V3Session | null;
  snapshot: ProjectedSnapshot | null;
  events: DomainEvent[];
  initialize: () => () => void;
  refreshCatalog: () => Promise<boolean>;
  refreshRooms: () => Promise<void>;
  refreshRoom: () => Promise<boolean>;
  createRoom: (
    name: string,
    roomName: string,
    auto: boolean,
  ) => Promise<boolean>;
  joinRoom: (
    name: string,
    roomCode: string,
    joinToken: string,
  ) => Promise<boolean>;
  spectateRoom: (
    name: string,
    roomCode: string,
    joinToken: string,
    omniscientToken?: string,
  ) => Promise<boolean>;
  resumeSession: () => Promise<boolean>;
  refreshSnapshot: () => Promise<boolean>;
  beginReadyCheck: () => Promise<boolean>;
  cancelReadyCheck: () => Promise<boolean>;
  setReady: (ready: boolean) => Promise<boolean>;
  startGame: () => Promise<boolean>;
  dispatch: (command: GameCommand) => Promise<boolean>;
  leaveRoom: () => void;
  clearAuthority: (reason?: string | null) => void;
  clearError: () => void;
}

let recoveryPromise: Promise<boolean> | null = null;
let roomRefreshPromise: Promise<void> | null = null;
let transportCleanup: (() => void) | null = null;

/** Events can arrive before the matching snapshot during reconnect. */
let bufferedGameMessages: GameEventsMessage[] = [];

export const useV3Store = create<V3Store>()((set, get) => {
  const setSession = (session: V3Session | null): void => {
    persistSession(session);
    set({ session });
  };

  const setCursor = (
    session: V3Session,
    gameId: string | undefined,
    lastSeenSeq: number,
  ): V3Session => ({
    ...session,
    gameId,
    lastSeenSeq,
  });

  const clearAuthority = (reason: string | null = null): void => {
    resetV3Connection();
    bufferedGameMessages = [];
    persistSession(null);
    set({
      ...createEmptyAuthorityState(),
      connected: false,
      loading: false,
      pendingRoomCommand: null,
      recovering: false,
      authorityStatus: 'unauthorized',
      error: reason,
      // A room list is a separate lobby projection. Never carry it across
      // identity changes, otherwise a new room can render stale room cards.
      rooms: [],
      catalog: get().catalog,
    });
  };

  const acceptRoom = (room: RoomView): boolean =>
    isPublicRoomViewSafe(room);

  const applyRoomView = (room: RoomView): boolean => {
    const current = get();
    if (!acceptRoom(room)) return false;
    if (current.session && !roomViewMatchesSession(room, current.session)) return false;

    const previousRoom = current.room;
    if (
      previousRoom &&
      (previousRoom.id !== room.id || previousRoom.code !== room.code)
    ) {
      return false;
    }
    if (!acceptsRoomRevision(room, previousRoom)) return false;

    const previousSession = current.session;
    const previousGameId = previousSession?.gameId;
    const nextGameId = room.gameId;
    const gameChanged = previousGameId !== nextGameId;
    const nextSession = previousSession
      ? {
          ...previousSession,
          mode: room.viewer.kind,
          gameId: nextGameId,
          ...(gameChanged ? { lastSeenSeq: 0 } : {}),
        }
      : null;

    if (gameChanged) bufferedGameMessages = [];
    persistSession(nextSession);
    set({
      room,
      session: nextSession,
      ...(gameChanged ? { snapshot: null, events: [] } : {}),
      authorityStatus: previousSession ? 'authorized' : current.authorityStatus,
      error: null,
    });
    return true;
  };

  const establish = (
    room: RoomView,
    credentials: V3Session['credentials'],
    actorName: string,
  ): boolean => {
    if (!acceptRoom(room)) return false;
    const session = createV3Session(room, credentials, actorName);
    adoptV3Identity(session.credentials.resumeToken);
    bufferedGameMessages = [];
    persistSession(session);
    set({
      room,
      session,
      snapshot: null,
      events: [],
      loading: false,
      recovering: false,
      authorityStatus: 'authorized',
      error: null,
    });
    return true;
  };

  const streamFor = (
    session: V3Session,
    events: DomainEvent[],
  ): EventStreamState | null =>
    session.gameId
      ? {
          roomId: session.roomId,
          gameId: session.gameId,
          lastSeenSeq: session.lastSeenSeq,
          events,
        }
      : null;

  const acceptEnvelope = (envelope: GameEventsMessage): boolean => {
    const current = get();
    const session = current.session;
    if (
      !session ||
      envelope.roomId !== session.roomId ||
      (session.gameId !== undefined && envelope.gameId !== session.gameId) ||
      containsSensitiveKeys(envelope)
    ) {
      return false;
    }
    if (!current.snapshot) {
      if (!bufferedGameMessages.some((item) => item === envelope)) {
        bufferedGameMessages.push(envelope);
      }
      return true;
    }
    const viewer = current.snapshot.viewer;
    const stream = streamFor(session, current.events);
    if (!stream) return false;
    const result = mergeEventEnvelope(stream, envelope, viewer);
    if (!result.accepted) return false;
    const nextSession = setCursor(
      session,
      result.gameId,
      result.lastSeenSeq,
    );
    persistSession(nextSession);
    set({ session: nextSession, events: result.events, error: null });
    return true;
  };

  const acceptSnapshot = (
    incoming: ProjectedSnapshot,
    preserveCursor = false,
  ): boolean => {
    const current = get();
    const session = current.session;
    if (
      !session ||
      !snapshotMatchesSession(incoming, session) ||
      !isSnapshotSafeForViewer(incoming)
    ) {
      return false;
    }
    if (session.gameId !== undefined && incoming.gameId !== session.gameId) {
      return false;
    }
    const nextSession = setCursor(
      session,
      incoming.gameId,
      preserveCursor
        ? session.lastSeenSeq
        : Math.max(session.lastSeenSeq, incoming.lastSequence),
    );
    persistSession(nextSession);
    set({
      session: nextSession,
      snapshot: incoming,
      error: null,
      authorityStatus: 'authorized',
    });

    const pending = bufferedGameMessages;
    bufferedGameMessages = [];
    for (const message of pending) acceptEnvelope(message);
    return true;
  };

  const recoverGameProjection = async (): Promise<boolean> => {
    const current = get();
    if (
      !current.session ||
      !current.room ||
      !isRoomStatusWithGame(current.room.status) ||
      !current.room.gameId
    ) {
      return true;
    }
    const response = await fetchV3Snapshot(
      current.session.roomCode,
      current.session.actorId,
    );
    if (response.ok === false) {
      set({ error: getErrorMessage(response.code) });
      return false;
    }
    return acceptSnapshot(
      response.snapshot,
      current.session.gameId === response.snapshot.gameId,
    );
  };

  const recover = async (): Promise<boolean> => {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const before = get().session;
      if (!before) {
        set({ authorityStatus: 'unauthorized', recovering: false });
        return false;
      }
      set({ recovering: true, authorityStatus: 'resolving', error: null });
      resetV3Connection();
      const response = await resumeV3Room(
        before.actorId,
        before.actorName,
        before.roomCode,
        before.roomId,
        before.credentials.resumeToken,
        before.lastSeenSeq,
      );
      if (response.ok === false) {
        const message = getErrorMessage(response.code);
        if (
          response.code === 'UNAUTHENTICATED' ||
          response.code === 'IDENTITY_MISMATCH' ||
          response.code === 'ROOM_NOT_FOUND'
        ) {
          clearAuthority(message);
        } else {
          set({ recovering: false, authorityStatus: 'unauthorized', error: message });
        }
        return false;
      }
      if (!acceptRoom(response.room)) {
        clearAuthority('房间响应未通过安全校验，已拒绝载入。');
        return false;
      }

      // Apply the room revision through the same path used by broadcasts.
      if (!applyRoomView(response.room)) {
        set({ recovering: false, authorityStatus: 'unauthorized' });
        return false;
      }
      const current = get();
      const credentials = {
        ...before.credentials,
        ...response.credentials,
      };
      const nextSession = current.session
        ? {
            ...current.session,
            credentials,
            actorName: before.actorName,
            mode: response.room.viewer.kind,
            gameId: response.room.gameId,
            ...(current.session.gameId === response.room.gameId
              ? {}
              : { lastSeenSeq: 0 }),
          }
        : createV3Session(response.room, credentials, before.actorName);
      adoptV3Identity(nextSession.credentials.resumeToken);
      persistSession(nextSession);
      set({
        room: response.room,
        session: nextSession,
        snapshot: null,
        events:
          before.gameId && before.gameId === response.room.gameId
            ? current.events
            : [],
      });

      const projected = await recoverGameProjection();
      set({
        recovering: false,
        authorityStatus: projected ? 'authorized' : 'resolving',
        error: projected ? null : get().error,
      });
      return projected;
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };

  const ensureTransportSubscriptions = (): void => {
    if (transportCleanup) return;
    const cleanups = [
      subscribeV3Connection((connected) => {
        set({ connected });
        if (connected && get().session && !get().recovering) void recover();
      }),
      subscribeV3RoomSnapshots((message) => {
        const accepted = applyRoomView(message.room);
        if (
          accepted &&
          isRoomStatusWithGame(message.room.status) &&
          message.room.gameId &&
          !get().snapshot
        ) {
          void recoverGameProjection();
        }
      }),
      subscribeV3Events((message) => {
        const accepted = acceptEnvelope(message);
        if (!accepted) {
          const current = get();
          const matchesCurrentRoom =
            current.session?.roomId === message.roomId &&
            (current.session.gameId === undefined ||
              current.session.gameId === message.gameId);
          if (matchesCurrentRoom && !current.recovering) void recover();
        }
      }),
      subscribeV3Snapshots((message) => {
        const accepted = acceptSnapshot(message.snapshot);
        if (!accepted) {
          const current = get();
          if (
            current.session?.roomId === message.snapshot.roomId &&
            !current.recovering
          ) {
            void recover();
          }
        }
      }),
      subscribeV3Errors((response) => {
        const message = getErrorMessage(response.code);
        set({ error: message });
        if (response.code === 'PUSH_FAILED' && !get().recovering) {
          void recover();
        }
      }),
    ];
    transportCleanup = () => {
      for (const cleanup of cleanups) cleanup();
      transportCleanup = null;
    };
  };

  const refreshRoom = async (): Promise<boolean> => {
    const current = get();
    if (!current.session) return false;
    ensureTransportSubscriptions();
    const response = await getV3Room(
      current.session.actorId,
      current.session.roomCode,
      current.session.roomId,
    );
    if (response.ok === false) {
      set({ error: getErrorMessage(response.code) });
      return false;
    }
    return applyRoomView(response.room);
  };

  const runRoomMutation = async (
    command: RoomMutationCommand,
  ): Promise<boolean> => {
    const current = get();
    if (!current.session || !current.room) return false;
    const action = command.type === 'room.ready'
      ? 'set_ready'
      : command.type === 'room.start_game'
        ? 'start_game'
        : command.type === 'room.begin_ready_check'
          ? 'begin_ready_check'
          : command.type === 'room.cancel_ready_check'
            ? 'cancel_ready_check'
            : undefined;
    if (action && !roomActions(current.room).includes(action)) return false;
    set({ loading: true, error: null });
    set({ pendingRoomCommand: command.type });
    const response = await sendV3RoomCommand(
      current.session.actorId,
      current.session.roomId,
      current.room.roomRevision,
      command,
    );
    if (response.ok === false) {
      if (response.room) applyRoomView(response.room);
      set({ loading: false, pendingRoomCommand: null, error: getErrorMessage(response.code) });
      return false;
    }
    if (response.room) applyRoomView(response.room);
    set({ loading: false, pendingRoomCommand: null });
    if (command.type === 'room.start_game') await recoverGameProjection();
    return true;
  };

  return {
    connected: false,
    loading: false,
    recovering: false,
    authorityStatus: loadSession() ? 'resolving' : 'unauthorized',
    error: null,
    pendingRoomCommand: null,
    rooms: [],
    catalog: null,
    room: null,
    session: loadSession(),
    snapshot: null,
    events: [],

    initialize: () => {
      ensureTransportSubscriptions();
      const current = get();
      if (current.session) void recover();
      void get().refreshCatalog();
      void get().refreshRooms();
      return () => {
        transportCleanup?.();
      };
    },

    refreshCatalog: async () => {
      const response = await getV3Catalog();
      if (response.ok === false) {
        set({ error: getErrorMessage(response.code) });
        return false;
      }
      set({ catalog: response.catalog });
      return true;
    },

    refreshRooms: async () => {
      if (roomRefreshPromise) return roomRefreshPromise;
      roomRefreshPromise = (async () => {
        const response = await listV3Rooms();
        if (response.ok === false) {
          set({ error: getErrorMessage(response.code) });
          return;
        }
        set({ rooms: response.rooms, error: null });
      })().finally(() => {
        roomRefreshPromise = null;
      });
      return roomRefreshPromise;
    },

    createRoom: async (name, roomName, auto) => {
      ensureTransportSubscriptions();
      clearAuthority();
      set({ loading: true, authorityStatus: 'resolving' });
      const catalogResponse = await getV3Catalog();
      if (catalogResponse.ok === false) {
        set({ loading: false, error: getErrorMessage(catalogResponse.code) });
        return false;
      }
      set({ catalog: catalogResponse.catalog });
      const options = buildDefaultOptions(
        catalogResponse.catalog,
        name,
        roomName,
        auto,
      );
      if (!options) {
        set({ loading: false, error: '当前没有可用的房间规则。' });
        return false;
      }
      const actorName = name.trim() || '玩家';
      const response = await createV3Room(
        newActorId(),
        actorName,
        options,
      );
      if (response.ok === false) {
        set({ loading: false, error: getErrorMessage(response.code) });
        return false;
      }
      const accepted = establish(
        response.room,
        response.credentials,
        actorName,
      );
      if (accepted && isRoomStatusWithGame(response.room.status)) {
        await recoverGameProjection();
      }
      await get().refreshRooms();
      return accepted;
    },

    joinRoom: async (name, roomCode, joinToken) => {
      ensureTransportSubscriptions();
      clearAuthority();
      set({ loading: true, authorityStatus: 'resolving' });
      const actorName = name.trim() || '玩家';
      const response = await joinV3Room(
        newActorId(),
        actorName,
        roomCode.trim().toUpperCase(),
        joinToken,
      );
      if (response.ok === false) {
        set({ loading: false, error: getErrorMessage(response.code) });
        return false;
      }
      return establish(response.room, response.credentials, actorName);
    },

    spectateRoom: async (name, roomCode, joinToken, omniscientToken) => {
      ensureTransportSubscriptions();
      clearAuthority();
      set({ loading: true, authorityStatus: 'resolving' });
      const actorName = name.trim() || '观战者';
      const response = await spectateV3Room(
        newActorId(),
        actorName,
        roomCode.trim().toUpperCase(),
        joinToken,
        omniscientToken,
      );
      if (response.ok === false) {
        set({ loading: false, error: getErrorMessage(response.code) });
        return false;
      }
      const accepted = establish(response.room, response.credentials, actorName);
      if (accepted && isRoomStatusWithGame(response.room.status)) {
        await recoverGameProjection();
      }
      return accepted;
    },

    resumeSession: recover,

    refreshSnapshot: async () => recoverGameProjection(),

    beginReadyCheck: () =>
      runRoomMutation({
        type: 'room.begin_ready_check',
        payload: {},
      }),

    cancelReadyCheck: () =>
      runRoomMutation({
        type: 'room.cancel_ready_check',
        payload: {},
      }),

    setReady: (ready) =>
      runRoomMutation({
        type: 'room.ready',
        payload: { ready },
      }),

    startGame: async () => {
      const current = get();
      if (!current.session || !current.room) return false;
      set({ loading: true, error: null });
      set({ pendingRoomCommand: 'room.start_game' });
      const response = await startV3Game(
        current.session.actorId,
        current.session.roomId,
        current.room.roomRevision,
      );
      if (response.ok === false) {
        if (response.room) applyRoomView(response.room);
        set({ loading: false, pendingRoomCommand: null, error: getErrorMessage(response.code) });
        return false;
      }
      applyRoomView(response.room);
      set({ loading: false, pendingRoomCommand: null });
      return recoverGameProjection();
    },

    dispatch: async (command) => {
      const current = get();
      const snapshot = current.snapshot;
      if (!current.session || !snapshot) return false;
      set({ loading: true, error: null });
      const response = await sendGameCommand(
        current.session.actorId,
        current.session.roomId,
        snapshot.gameId,
        snapshot.gameState.stageRevision ?? 0,
        command,
      );
      set({ loading: false });
      if (response.ok === false) {
        set({ error: getErrorMessage(response.code) });
        if (
          response.code === 'STALE_STAGE_REVISION' ||
          response.code === 'EXPIRED_COMMAND'
        ) {
          await recoverGameProjection();
        } else if (
          response.code === 'ROOM_MISMATCH' ||
          response.code === 'GAME_MISMATCH' ||
          response.code === 'IDENTITY_MISMATCH' ||
          response.code === 'UNAUTHENTICATED'
        ) {
          await recover();
        }
        return false;
      }
      const session = get().session;
      if (session) {
        acceptEnvelope({
          type: 'game.events',
          roomId: session.roomId,
          gameId: snapshot.gameId,
          afterSequence: session.lastSeenSeq,
          events: response.events,
        });
      }
      return recoverGameProjection();
    },

    leaveRoom: () => clearAuthority(),
    clearAuthority,
    clearError: () => set({ error: null }),
    refreshRoom,
  };
});

export type { V3Session };

/** Useful to non-React callers that need a snapshot without a hook. */
export const authorityStore = useV3Store;

// Keep this import in the module's public type surface while allowing
// type-aware callers to narrow protocol errors without importing socket.io.
export type { ProtocolErrorCode };
