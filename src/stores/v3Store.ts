import { create } from 'zustand';
import type {
  DomainEvent,
  ProjectedSnapshot,
} from '../../shared/events';
import type {
  GameCommand,
  GameEventsMessage,
  ProtocolErrorCode,
  RoomCreateOptions,
  RoomSummary,
  RoomView,
} from '../../shared/protocol';
import {
  adoptV3Identity,
  createV3Room,
  fetchV3Snapshot,
  joinV3Room,
  listV3Rooms,
  resetV3Connection,
  resumeV3Room,
  sendGameCommand,
  spectateV3Room,
  startV3Game,
  subscribeV3Connection,
  subscribeV3Errors,
  subscribeV3Events,
  subscribeV3Snapshots,
} from '../net/v3Socket';
import {
  mergeEventEnvelope,
  type EventStreamState,
} from '../v3/eventStream';
import {
  createV3Session,
  createEmptyAuthorityState,
  isPublicRoomViewSafe,
  isSnapshotSafeForViewer,
  readV3Session,
  snapshotMatchesSession,
  writeV3Session,
  type V3Session,
} from '../v3/session';
import {
  projectWaitingRoomSummary,
  waitingRoomNeedsRefresh,
} from '../v3/waitingRoom';

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
    // The live session remains usable when storage is unavailable.
  }
};

const newActorId = (): string => crypto.randomUUID();

const messageFor = (code?: ProtocolErrorCode): string => {
  const labels: Partial<Record<ProtocolErrorCode, string>> = {
    UNAUTHENTICATED: '身份凭据已失效，请重新加入房间。',
    IDENTITY_MISMATCH: '当前连接身份与命令不一致，正在恢复。',
    ROOM_MISMATCH: '房间已经变化，旧房间状态已丢弃。',
    GAME_MISMATCH: '对局已经变化，正在读取最新对局。',
    SPECTATOR_READ_ONLY: '观战身份不能提交玩家命令。',
    DUPLICATE_COMMAND: '该命令已经处理。',
    STALE_STAGE_REVISION: '阶段已经变化，已刷新到最新状态。',
    EXPIRED_COMMAND: '行动时间已结束，正在读取最新阶段。',
    ACTION_NOT_ALLOWED: '当前阶段不允许该行动。',
    INVALID_TARGET: '该目标当前不可选择。',
    ROOM_NOT_FOUND: '未找到该房间。',
    ROOM_TOKEN_INVALID: '房间邀请令牌无效。',
    ROOM_FULL: '房间已满。',
    HOST_REQUIRED: '只有房主可以开始对局。',
    GAME_ALREADY_STARTED: '对局已经开始。',
    GAME_NOT_STARTED: '对局尚未开始。',
    IDENTITY_ALREADY_BOUND: '连接已绑定其他身份，请重新进入。',
    IDENTITY_ALREADY_EXISTS: '该身份已经存在。',
    PUSH_FAILED: '实时推送失败，正在恢复权威状态。',
  };
  return labels[code ?? 'UNKNOWN_ERROR'] ?? code ?? '服务端请求失败。';
};

interface V3Store {
  connected: boolean;
  loading: boolean;
  recovering: boolean;
  error: string | null;
  rooms: RoomSummary[];
  room: RoomView | null;
  session: V3Session | null;
  snapshot: ProjectedSnapshot | null;
  events: DomainEvent[];
  initialize: () => () => void;
  refreshRooms: () => Promise<void>;
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
  startGame: () => Promise<boolean>;
  dispatch: (command: GameCommand) => Promise<boolean>;
  leaveRoom: () => void;
  clearError: () => void;
}

let recoveryPromise: Promise<boolean> | null = null;
let roomRefreshPromise: Promise<void> | null = null;

const WAITING_ROOM_PROBE_MS = 1_000;

export const useV3Store = create<V3Store>()((set, get) => {
  const save = (session: V3Session | null): void => {
    persistSession(session);
    set({ session });
  };

  const clearAuthority = (
    options: { clearSession?: boolean; error?: string | null } = {},
  ): void => {
    resetV3Connection();
    if (options.clearSession !== false) persistSession(null);
    set({
      ...createEmptyAuthorityState(),
      loading: false,
      recovering: false,
      error: options.error ?? null,
    });
  };

  const setSessionCursor = (
    session: V3Session,
    gameId: string | undefined,
    lastSeenSeq: number,
  ): V3Session => {
    const next = {
      ...session,
      gameId,
      lastSeenSeq,
    };
    persistSession(next);
    return next;
  };

  const acceptRoom = (room: RoomView): boolean => {
    if (isPublicRoomViewSafe(room)) return true;
    clearAuthority({
      error: '服务端房间响应包含不应公开的敏感字段，已拒绝载入。',
    });
    return false;
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

  const acceptSnapshot = (
    snapshot: ProjectedSnapshot,
    options: { preserveCursor?: boolean } = {},
  ): boolean => {
    const current = get().session;
    if (
      !current ||
      !snapshotMatchesSession(snapshot, current) ||
      !isSnapshotSafeForViewer(snapshot)
    ) {
      return false;
    }

    const isNewGame =
      current.gameId !== undefined && current.gameId !== snapshot.gameId;
    if (isNewGame) return false;

    const nextCursor = options.preserveCursor
      ? current.lastSeenSeq
      : Math.max(current.lastSeenSeq, snapshot.lastSequence);
    const nextSession = setSessionCursor(
      current,
      snapshot.gameId,
      nextCursor,
    );
    const currentRoom = get().room;
    const nextRoom =
      currentRoom && currentRoom.id === snapshot.roomId
        ? {
            ...currentRoom,
            status:
              snapshot.gameState.phase === 'ended'
                ? 'ended' as const
                : 'playing' as const,
            gameId: snapshot.gameId,
            viewer: {
              ...currentRoom.viewer,
              canStart: false,
              canSubmitGameCommands:
                currentRoom.viewer.kind === 'player' &&
                snapshot.gameState.phase !== 'ended',
              allowedActions: [
                ...(snapshot.gameState.allowedActions ?? []),
              ],
            },
          }
        : currentRoom;
    set({
      session: nextSession,
      snapshot,
      room: nextRoom,
      events: current.gameId ? get().events : [],
      error: null,
    });
    return true;
  };

  const acceptEnvelope = (envelope: GameEventsMessage): boolean => {
    const current = get().session;
    const viewer = get().snapshot?.viewer;
    const stream = current ? streamFor(current, get().events) : null;
    if (!current || !viewer || !stream) return false;

    const result = mergeEventEnvelope(stream, envelope, viewer);
    if (!result.accepted) return false;
    const nextSession = setSessionCursor(
      current,
      result.gameId,
      result.lastSeenSeq,
    );
    set({
      session: nextSession,
      events: result.events,
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
    persistSession(session);
    set({
      room,
      session,
      snapshot: null,
      events: [],
      error: null,
    });
    return true;
  };

  const recover = async (): Promise<boolean> => {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const current = get().session;
      if (!current) return false;
      const replayAfter =
        get().events.length > 0 ? current.lastSeenSeq : 0;
      set({ recovering: true, error: null });
      resetV3Connection();
      const response = await resumeV3Room(
        current.actorId,
        current.actorName,
        current.roomCode,
        current.roomId,
        current.credentials.resumeToken,
        replayAfter,
      );
      if (response.ok === false) {
        const error = messageFor(response.code);
        if (
          response.code === 'UNAUTHENTICATED' ||
          response.code === 'IDENTITY_MISMATCH'
        ) {
          clearAuthority({ error });
        } else {
          set({ recovering: false, error });
        }
        return false;
      }
      if (!acceptRoom(response.room)) return false;

      const credentials = {
        ...current.credentials,
        ...response.credentials,
      };
      const nextSession = createV3Session(
        response.room,
        credentials,
        current.actorName,
        {
          gameId: current.gameId,
          lastSeenSeq: replayAfter,
        },
      );
      adoptV3Identity(nextSession.credentials.resumeToken);
      persistSession(nextSession);
      set({
        room: response.room,
        session: nextSession,
        snapshot: null,
        events:
          current.gameId && current.gameId === response.room.gameId
            ? get().events
            : [],
      });

      if (response.room.status !== 'waiting') {
        const snapshotAck = await fetchV3Snapshot(
          nextSession.roomCode,
          nextSession.actorId,
        );
        if (snapshotAck.ok === false) {
          set({
            recovering: false,
            error: messageFor(snapshotAck.code),
          });
          return false;
        }
        if (!acceptSnapshot(snapshotAck.snapshot, { preserveCursor: true })) {
          clearAuthority({
            error: '恢复快照与当前身份不匹配，已拒绝载入。',
          });
          return false;
        }
        const resumed = get().session;
        if (resumed?.gameId) {
          const lastEventSequence =
            response.events?.at(-1)?.sequence ?? resumed.lastSeenSeq;
          acceptEnvelope({
            type: 'game.events',
            roomId: resumed.roomId,
            gameId: resumed.gameId,
            afterSequence: Math.max(
              resumed.lastSeenSeq,
              lastEventSequence,
            ),
            events: response.events ?? [],
          });
          const afterReplay = get().session;
          if (afterReplay) {
            save(
              setSessionCursor(
                afterReplay,
                snapshotAck.snapshot.gameId,
                Math.max(
                  afterReplay.lastSeenSeq,
                  snapshotAck.snapshot.lastSequence,
                ),
              ),
            );
          }
        }
      }
      set({ recovering: false, error: null });
      return true;
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };

  const recoverWaitingRoom = async (
    summary: RoomSummary,
  ): Promise<boolean> => {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const current = get().session;
      const currentRoom = get().room;
      if (!current || !currentRoom || currentRoom.status !== 'waiting') {
        return false;
      }

      set({ recovering: true, error: null });
      resetV3Connection();
      const response = await resumeV3Room(
        current.actorId,
        current.actorName,
        current.roomCode,
        current.roomId,
        current.credentials.resumeToken,
        0,
      );
      if (response.ok === false) {
        if (response.code === 'GAME_NOT_STARTED') {
          adoptV3Identity(current.credentials.resumeToken);
          set({
            room: projectWaitingRoomSummary(currentRoom, summary),
            recovering: false,
            error: null,
          });
          return true;
        }

        const error = messageFor(response.code);
        if (
          response.code === 'UNAUTHENTICATED' ||
          response.code === 'IDENTITY_MISMATCH'
        ) {
          clearAuthority({ error });
        } else {
          set({ recovering: false, error });
        }
        return false;
      }
      if (!acceptRoom(response.room)) return false;

      const nextSession = createV3Session(
        response.room,
        {
          ...current.credentials,
          ...response.credentials,
        },
        current.actorName,
        {
          gameId: current.gameId,
          lastSeenSeq: current.lastSeenSeq,
        },
      );
      adoptV3Identity(nextSession.credentials.resumeToken);
      persistSession(nextSession);
      set({
        room: response.room,
        session: nextSession,
        snapshot: null,
        events: [],
        recovering: false,
        error: null,
      });
      return true;
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };

  return {
    connected: false,
    loading: false,
    recovering: false,
    error: null,
    rooms: [],
    room: null,
    session: loadSession(),
    snapshot: null,
    events: [],

    initialize: () => {
      const unsubscribeConnection = subscribeV3Connection((connected) => {
        set({ connected });
        if (connected && get().session && !get().recovering) {
          void recover();
        }
      });
      const unsubscribeEvents = subscribeV3Events((message) => {
        if (!acceptEnvelope(message) && get().session && !get().recovering) {
          void recover();
        }
      });
      const unsubscribeSnapshots = subscribeV3Snapshots((snapshot) => {
        if (!acceptSnapshot(snapshot) && get().session && !get().recovering) {
          void recover();
        }
      });
      const unsubscribeErrors = subscribeV3Errors((response) => {
        set({ error: messageFor(response.code) });
        if (response.code === 'PUSH_FAILED' && !get().recovering) {
          void recover();
        }
      });
      if (get().session) {
        void recover().finally(() => get().refreshRooms());
      } else {
        void get().refreshRooms();
      }
      const waitingRoomTimer = window.setInterval(() => {
        const current = get();
        if (
          !current.connected ||
          current.loading ||
          current.recovering ||
          current.room?.status !== 'waiting' ||
          !current.session
        ) {
          return;
        }
        void current.refreshRooms();
      }, WAITING_ROOM_PROBE_MS);
      return () => {
        window.clearInterval(waitingRoomTimer);
        unsubscribeConnection();
        unsubscribeEvents();
        unsubscribeSnapshots();
        unsubscribeErrors();
      };
    },

    refreshRooms: async () => {
      if (roomRefreshPromise) return roomRefreshPromise;
      roomRefreshPromise = (async () => {
        const response = await listV3Rooms();
        if (response.ok === false) {
          set({ error: messageFor(response.code) });
          return;
        }

        set({ rooms: response.rooms, error: null });
        const current = get();
        if (
          !current.room ||
          !current.session ||
          current.room.status !== 'waiting' ||
          current.recovering
        ) {
          return;
        }
        const summary = response.rooms.find(
          (room) => room.roomCode === current.room?.code,
        );
        if (waitingRoomNeedsRefresh(current.room, summary)) {
          if (summary?.status === 'waiting') {
            await recoverWaitingRoom(summary);
          } else {
            await recover();
          }
        }
      })().finally(() => {
        roomRefreshPromise = null;
      });
      return roomRefreshPromise;
    },

    createRoom: async (name, roomName, auto) => {
      clearAuthority();
      set({ loading: true });
      const options: RoomCreateOptions = {
        roomName,
        maxPlayers: 12,
        aiCount: auto ? 12 : 0,
        name,
        spectator: auto,
        reviewEnabled: true,
        auto,
        debugMode: auto,
      };
      const response = await createV3Room(
        newActorId(),
        name,
        options,
      );
      if (response.ok === false) {
        set({ loading: false, error: messageFor(response.code) });
        return false;
      }
      if (!establish(response.room, response.credentials, name)) {
        set({ loading: false });
        return false;
      }
      set({ loading: false });
      if (response.room.status !== 'waiting') await recover();
      await get().refreshRooms();
      return true;
    },

    joinRoom: async (name, roomCode, joinToken) => {
      clearAuthority();
      set({ loading: true });
      const response = await joinV3Room(
        newActorId(),
        name,
        roomCode.trim().toUpperCase(),
        joinToken,
      );
      if (response.ok === false) {
        set({ loading: false, error: messageFor(response.code) });
        return false;
      }
      const accepted = establish(
        response.room,
        response.credentials,
        name,
      );
      set({ loading: false });
      if (accepted && response.room.status !== 'waiting') await recover();
      return accepted;
    },

    spectateRoom: async (
      name,
      roomCode,
      joinToken,
      omniscientToken,
    ) => {
      clearAuthority();
      set({ loading: true });
      const response = await spectateV3Room(
        newActorId(),
        name,
        roomCode.trim().toUpperCase(),
        joinToken,
        omniscientToken,
      );
      if (response.ok === false) {
        set({ loading: false, error: messageFor(response.code) });
        return false;
      }
      const accepted = establish(
        response.room,
        response.credentials,
        name,
      );
      set({ loading: false });
      if (accepted && response.room.status !== 'waiting') await recover();
      return accepted;
    },

    resumeSession: recover,

    refreshSnapshot: async () => {
      const current = get().session;
      if (!current || get().room?.status === 'waiting') return false;
      const response = await fetchV3Snapshot(
        current.roomCode,
        current.actorId,
      );
      if (response.ok === false) {
        set({ error: messageFor(response.code) });
        return false;
      }
      return acceptSnapshot(response.snapshot);
    },

    startGame: async () => {
      const current = get().session;
      const room = get().room;
      if (!current || !room?.viewer.canStart) return false;
      set({ loading: true, error: null });
      const response = await startV3Game(
        current.actorId,
        current.roomId,
      );
      if (response.ok === false) {
        set({ loading: false, error: messageFor(response.code) });
        return false;
      }
      if (!acceptRoom(response.room)) {
        set({ loading: false });
        return false;
      }
      const nextSession = setSessionCursor(
        current,
        response.room.gameId,
        0,
      );
      set({
        loading: false,
        room: response.room,
        session: nextSession,
        snapshot: null,
        events: [],
      });
      return recover();
    },

    dispatch: async (command) => {
      const current = get().session;
      const snapshot = get().snapshot;
      if (!current || !snapshot) return false;
      set({ loading: true, error: null });
      const response = await sendGameCommand(
        current.actorId,
        current.roomId,
        snapshot.gameId,
        snapshot.gameState.stageRevision ?? 0,
        command,
      );
      set({ loading: false });
      if (response.ok === false) {
        set({ error: messageFor(response.code) });
        if (
          response.code === 'STALE_STAGE_REVISION' ||
          response.code === 'EXPIRED_COMMAND'
        ) {
          await get().refreshSnapshot();
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
      const lastSequence =
        response.events.at(-1)?.sequence ?? current.lastSeenSeq;
      acceptEnvelope({
        type: 'game.events',
        roomId: current.roomId,
        gameId: snapshot.gameId,
        afterSequence: Math.max(current.lastSeenSeq, lastSequence),
        events: response.events,
      });
      await get().refreshSnapshot();
      return true;
    },

    leaveRoom: () => clearAuthority(),
    clearError: () => set({ error: null }),
  };
});

export type { V3Session };
