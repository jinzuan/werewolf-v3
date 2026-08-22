import { create } from 'zustand';
import { safeUuid } from '../../lib/uuid';
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
  RoomAccess,
  RoomAIConfigPatch,
  RoomAIConfigSummary,
  AllowedRoomAction,
  RoomListQuery,
} from '../../../shared/protocol';
import type { PostGameReviewView } from '../../../shared/reviewContract';
import {
  adoptV3Identity,
  createV3Room,
  fetchV3Snapshot,
  fetchV3Events,
  getV3Catalog,
  getV3Room,
  getV3CommandReceipt,
  getV3Review,
  clearV3ReviewInsights,
  joinV3Room,
  listV3Rooms,
  resetV3Connection,
  getV3AIConfig,
  resumeV3Room,
  sendGameCommand,
  sendV3RoomCommand,
  spectateV3Room,
  subscribeV3Connection,
  subscribeV3Messages,
  subscribeV3Errors,
  subscribeV3Events,
  subscribeV3RoomSnapshots,
  subscribeV3Snapshots,
} from '../../net/v3Socket';
import type { ClientAck, TransportFailure } from '../../net/v3Socket';
import { getErrorMessage } from '../../v3/presentation';
import {
  CommandOutcomeRegistry,
  type CommandOutcome,
} from '../../v3/commandOutcome';
import {
  mergeEventEnvelope,
  type EventStreamState,
} from '../../v3/eventStream';
import { containsSensitiveKeys } from '../../../shared/redact';
import {
  createEmptyAuthorityState,
  createV3Session,
  isPublicRoomViewSafe,
  isSnapshotSafeForViewer,
  acceptsRoomRevision,
  readV3Session,
  roomViewMatchesSession,
  roomViewProjectionBoundary,
  snapshotMatchesSession,
  sessionIdentityChanged,
  type V3Session,
} from '../../v3/session';
import { gameActionsReady } from '../../v3/actions';
import { getSessionPersistence } from '../../runtime/sessionPersistence';
import { subscribeV3ReconnectLifecycle } from '../../runtime/reconnectLifecycle';

const storage = (): Storage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

// A stale room session can be discovered while the user is simply opening the
// lobby. Keep that cleanup silent there; room-scoped routes still receive the
// actionable recovery message.
const shouldExposeRoomError = (): boolean =>
  typeof window === 'undefined' || window.location.pathname.startsWith('/rooms');

const loadSession = (): V3Session | null => {
  const target = storage();
  return target ? readV3Session(target) : null;
};

const sessionPersistence = getSessionPersistence();

const persistSessionIdentity = (session: V3Session | null): void => {
  sessionPersistence.persistIdentity(session);
};

const scheduleSessionCursor = (session: V3Session): void => {
  sessionPersistence.scheduleCursor(session);
};

const newActorId = (): string => safeUuid();

const PENDING_CREATE_KEY = 'werewolf-v3-pending-create';
export const PENDING_CREATE_TTL_MS = 2 * 60 * 1000;
export type PendingCreate = {
  createRequestId: string;
  actorId: string;
  createdAt: number;
};

const pendingCreateStorage = (): Storage | null =>
  typeof sessionStorage === 'undefined' ? null : sessionStorage;

export const readPendingCreate = (now = Date.now()): PendingCreate | null => {
  const target = pendingCreateStorage();
  if (!target) return null;
  try {
    const parsed = JSON.parse(target.getItem(PENDING_CREATE_KEY) ?? 'null') as Partial<PendingCreate> | null;
    if (
      !parsed ||
      typeof parsed.createRequestId !== 'string' ||
      typeof parsed.actorId !== 'string' ||
      !Number.isSafeInteger(parsed.createdAt) ||
      parsed.createdAt > now ||
      now - parsed.createdAt >= PENDING_CREATE_TTL_MS
    ) {
      target.removeItem(PENDING_CREATE_KEY);
      return null;
    }
    return parsed as PendingCreate;
  } catch {
    try { target.removeItem(PENDING_CREATE_KEY); } catch { /* cache only */ }
    return null;
  }
};

export const writePendingCreate = (pending: PendingCreate): void => {
  try { pendingCreateStorage()?.setItem(PENDING_CREATE_KEY, JSON.stringify(pending)); } catch { /* cache only */ }
};

export const clearPendingCreate = (): void => {
  try { pendingCreateStorage()?.removeItem(PENDING_CREATE_KEY); } catch { /* cache only */ }
};

const PENDING_JOIN_KEY = 'werewolf-v3-pending-join';
export const PENDING_JOIN_TTL_MS = 2 * 60 * 1000;
export type PendingJoin = {
  joinRequestId: string;
  actorId: string;
  roomCode: string;
  actorName: string;
  mode: 'player' | 'spectator';
  createdAt: number;
};

const validPendingJoin = (value: Partial<PendingJoin> | null, now: number): value is PendingJoin =>
  Boolean(
    value &&
    typeof value.joinRequestId === 'string' &&
    typeof value.actorId === 'string' &&
    typeof value.roomCode === 'string' &&
    typeof value.actorName === 'string' &&
    (value.mode === 'player' || value.mode === 'spectator') &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt <= now &&
    now - value.createdAt < PENDING_JOIN_TTL_MS,
  );

export const readPendingJoin = (now = Date.now()): PendingJoin | null => {
  const target = pendingCreateStorage();
  if (!target) return null;
  try {
    const parsed = JSON.parse(target.getItem(PENDING_JOIN_KEY) ?? 'null') as Partial<PendingJoin> | null;
    if (!validPendingJoin(parsed, now)) {
      target.removeItem(PENDING_JOIN_KEY);
      return null;
    }
    return parsed;
  } catch {
    try { target.removeItem(PENDING_JOIN_KEY); } catch { /* cache only */ }
    return null;
  }
};

export const writePendingJoin = (pending: PendingJoin): void => {
  try { pendingCreateStorage()?.setItem(PENDING_JOIN_KEY, JSON.stringify(pending)); } catch { /* cache only */ }
};

export const clearPendingJoin = (joinRequestId?: string): void => {
  const target = pendingCreateStorage();
  if (!target) return;
  try {
    if (joinRequestId) {
      const raw = target.getItem(PENDING_JOIN_KEY);
      const current = JSON.parse(raw ?? 'null') as Partial<PendingJoin> | null;
      if (current?.joinRequestId !== joinRequestId) return;
    }
    target.removeItem(PENDING_JOIN_KEY);
  } catch { /* cache only */ }
};

const isTransportFailure = (response: ClientAck): response is TransportFailure =>
  response.ok === false && 'kind' in response && response.kind === 'transport';

const responseMessage = (response: ClientAck): string =>
  isTransportFailure(response)
    ? response.message || '连接暂时不可用，请重试。'
    : getErrorMessage(response.code);

const recoveryExceptionMessage = (error: unknown): string =>
  error instanceof Error && error.message
    ? `房间恢复失败：${error.message}`
    : getErrorMessage('UNKNOWN_ERROR');

const commandOutcomeRegistry = new CommandOutcomeRegistry();
const commandRequests = new Map<string, {
  roomId: string;
  expectedRoomRevision: number;
  command: RoomMutationCommand;
}>();

const isRoomStatusWithGame = (status: RoomView['status']): boolean =>
  status === 'playing' || status === 'ended';

const roomActions = (room: RoomView): string[] => {
  return room.viewer.allowedRoomActions;
};

const roomActionForCommand = (
  command: RoomMutationCommand,
): AllowedRoomAction | undefined => {
  switch (command.type) {
    case 'room.update_config': return 'update_config';
    case 'room.update_ai_config': return 'update_ai_config';
    case 'room.begin_ready_check': return 'begin_ready_check';
    case 'room.cancel_ready_check': return 'cancel_ready_check';
    case 'room.ready': return 'set_ready';
    case 'room.start_game': return 'start_game';
    case 'room.leave': return 'leave';
    case 'room.transfer_host': return 'transfer_host';
    case 'room.dissolve': return 'dissolve';
    case 'room.claim_seat': return 'claim_seat';
    case 'room.become_spectator': return 'become_spectator';
    case 'room.add_ai': return 'add_ai';
    case 'room.kick_player': return 'kick_player';
    case 'room.request_seat': return 'request_seat';
    case 'room.respond_seat_request': return 'respond_seat_request';
  }
};

const buildDefaultOptions = (
  catalog: RoomCreationCatalog,
  name: string,
  roomName: string,
  mode: 'human' | 'mixed' | 'quick_computer',
): CreateRoomOptionsV31 | null => {
  const preset = catalog.rolePresets.find(
    (candidate) => candidate.enabled,
  );
  if (!preset) return null;
  return {
    catalogVersion: catalog.catalogVersion,
    roomName: roomName.trim(),
    creator: { name: name.trim(), avatarId: 'avatar-player' },
    // The default lobby action always enters a waiting room. `auto` means
    // AI fills vacant seats at start; it no longer means an immediate all-AI
    // monitor session.
    mode,
    visibility: 'invite_only',
    maxPlayers: preset.playerCount,
    minHumanPlayers: mode === 'quick_computer' ? 0 : mode === 'mixed' ? 1 : preset.playerCount,
    computerSeats: 0,
    aiFillPolicy: mode === 'human' ? 'none' : 'fill_to_max',
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
  syncStatus: 'idle' | 'syncing' | 'synced' | 'error';
  syncError: string | null;
  /** Explicit recovery state for route guards and retryable resolver errors. */
  authorityStatus: 'resolving' | 'authorized' | 'unauthorized' | 'error';
  error: string | null;
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error';
  catalogError: string | null;
  pendingRoomCommand: string | null;
  commandOutcomes: Record<string, CommandOutcome>;
  lastCommandOutcome: CommandOutcome | null;
  rooms: RoomSummary[];
  roomsNextCursor: string | null;
  roomsLoading: boolean;
  catalog: RoomCreationCatalog | null;
  room: RoomView | null;
  session: V3Session | null;
  snapshot: ProjectedSnapshot | null;
  events: DomainEvent[];
  review: PostGameReviewView | null;
  /** Host-only, memory-resident AI settings projection. */
  aiConfigSummary: RoomAIConfigSummary | null;
  aiConfigStatus: 'idle' | 'loading' | 'ready' | 'updating' | 'error';
  aiConfigError: string | null;
  initialize: () => () => void;
  refreshCatalog: (options?: { force?: boolean }) => Promise<boolean>;
  refreshRooms: () => Promise<void>;
  /** Fetch the next bounded page; the current page is replaced to cap DOM. */
  loadMoreRooms: () => Promise<void>;
  refreshRoom: () => Promise<boolean>;
  createRoom: (
    name: string,
    roomName: string,
    auto: boolean,
  ) => Promise<boolean>;
  createQuickComputerRoom: (name: string, roomName: string) => Promise<boolean>;
  /** Full V3.1 create action used by the four-step room wizard. */
  createRoomWithOptions: (options: CreateRoomOptionsV31) => Promise<ClientAck<RoomAccess>>;
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
  refreshReview: () => Promise<boolean>;
  clearReviewInsights: () => Promise<boolean>;
  loadAIConfig: () => Promise<boolean>;
  updateAIConfig: (patch: RoomAIConfigPatch) => Promise<boolean>;
  clearAIConfig: () => Promise<boolean>;
  beginReadyCheck: () => Promise<boolean>;
  cancelReadyCheck: () => Promise<boolean>;
  setReady: (ready: boolean) => Promise<boolean>;
  startGame: () => Promise<boolean>;
  updateRoomConfig: (config: RoomView['config']) => Promise<boolean>;
  claimSeat: (seatIndex?: number) => Promise<boolean>;
  becomeSpectator: () => Promise<boolean>;
  addAISeat: (seatIndex?: number) => Promise<boolean>;
  kickPlayer: (memberId: string) => Promise<boolean>;
  requestSeat: () => Promise<boolean>;
  respondSeatRequest: (requestId: string, approved: boolean) => Promise<boolean>;
  transferHost: (targetMemberId: string) => Promise<boolean>;
  leaveRoomMutation: () => Promise<boolean>;
  dissolveRoom: () => Promise<boolean>;
  mutateRoom: (command: RoomMutationCommand) => Promise<boolean>;
  reconcileCommand: (commandId: string) => Promise<CommandOutcome | null>;
  dispatch: (command: GameCommand) => Promise<boolean>;
  leaveRoom: () => void;
  clearAuthority: (reason?: string | null) => void;
  clearError: () => void;
}

let recoveryPromise: Promise<boolean> | null = null;
let roomRefreshPromise: Promise<void> | null = null;
let catalogRefreshPromise: Promise<boolean> | null = null;

/** Events can arrive before the matching snapshot during reconnect. */
let bufferedGameMessages: GameEventsMessage[] = [];

export const useV3Store = create<V3Store>()((set, get) => {
  let subscriptionCleanup: (() => void) | null = null;

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
    persistSessionIdentity(null);
    set({
      ...createEmptyAuthorityState(),
      connected: get().connected,
      loading: false,
      pendingRoomCommand: null,
      recovering: false,
      syncStatus: 'idle',
      syncError: null,
      authorityStatus: 'unauthorized',
      error: reason && shouldExposeRoomError() ? reason : null,
      // A room list is a separate lobby projection. Never carry it across
      // identity changes, otherwise a new room can render stale room cards.
      rooms: [],
      roomsNextCursor: null,
      roomsLoading: false,
      catalog: get().catalog,
      review: null,
      aiConfigSummary: null,
      aiConfigStatus: 'idle',
      aiConfigError: null,
    });
  };

  const publishOutcome = (outcome: CommandOutcome): void => {
    set({
      commandOutcomes: commandOutcomeRegistry.all(),
      lastCommandOutcome: outcome,
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
    const projectionBoundary = roomViewProjectionBoundary(
      previousRoom,
      room,
      previousGameId,
    );
    const nextSession = previousSession
      ? {
          ...previousSession,
          mode: room.viewer.kind,
          gameId: nextGameId,
          ...(projectionBoundary ? { lastSeenSeq: 0 } : {}),
        }
      : null;

    if (projectionBoundary) bufferedGameMessages = [];
    if (sessionIdentityChanged(previousSession, nextSession)) {
      persistSessionIdentity(nextSession);
    } else if (
      nextSession &&
      previousSession &&
      nextSession.lastSeenSeq !== previousSession.lastSeenSeq
    ) {
      scheduleSessionCursor(nextSession);
    }
    set({
      room,
      session: nextSession,
      ...(projectionBoundary ? { snapshot: null, events: [] } : {}),
      review: projectionBoundary || room.status !== 'ended' ? null : current.review,
      ...(projectionBoundary
        ? { aiConfigSummary: null, aiConfigStatus: 'idle', aiConfigError: null }
        : {}),
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
    persistSessionIdentity(session);
    set({
      room,
      session,
      snapshot: null,
      events: [],
      review: null,
      aiConfigSummary: null,
      aiConfigStatus: 'idle',
      aiConfigError: null,
      loading: false,
      recovering: false,
      // The create/join ACK is already an authoritative room projection. Do
      // not leave the waiting room in an artificial "syncing" state while the
      // newly adopted socket is finishing its auth hand-off.
      syncStatus: 'synced',
      syncError: null,
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
    // A live push can have been produced from a newer server-side cursor
    // while the browser was suspended or while another push was in flight.
    // Do not commit that future cursor locally: the caller will recover from
    // the durable watermark and fetch the missing range.
    if (result.needsRecovery) return false;
    const nextSession = setCursor(
      session,
      result.gameId,
      result.lastSeenSeq,
    );
    scheduleSessionCursor(nextSession);
    set({ session: nextSession, events: result.events, error: null });
    return true;
  };

  const acceptSnapshot = (incoming: ProjectedSnapshot): boolean => {
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
    const pending = bufferedGameMessages.filter((message) =>
      message.roomId === incoming.roomId && message.gameId === incoming.gameId,
    );
    const nextSession = setCursor(
      session,
      incoming.gameId,
      // A snapshot describes state at `lastSequence`; it does not prove that
      // the client has received the event history leading to that state. The
      // event replay below is the only operation allowed to advance the
      // watermark. Pending pushes are also kept at the local cursor because
      // their transport `afterSequence` may belong to a different socket
      // push that the browser never observed.
      session.lastSeenSeq,
    );
    if (sessionIdentityChanged(session, nextSession)) {
      persistSessionIdentity(nextSession);
    } else {
      scheduleSessionCursor(nextSession);
    }
    set({
      session: nextSession,
      snapshot: incoming,
      error: null,
      authorityStatus: 'authorized',
    });

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
    set({ syncStatus: 'syncing', syncError: null });
    const response = await fetchV3Snapshot(
      current.session.roomCode,
      current.session.actorId,
    );
    if (response.ok === false) {
      const message = responseMessage(response);
      set({ error: message, syncStatus: 'error', syncError: message });
      return false;
    }
    const accepted = acceptSnapshot(
      response.snapshot,
    );
    if (!accepted) {
      set({ syncStatus: 'error', syncError: '服务端快照未通过校验。' });
      return false;
    }

    const session = get().session;
    if (!session) return false;
    let afterSequence = session.lastSeenSeq;
    for (;;) {
      const eventsResponse = await fetchV3Events(
        session.roomCode,
        session.actorId,
        afterSequence,
      );
      if (eventsResponse.ok === false) {
        const message = responseMessage(eventsResponse);
        set({ error: message, syncStatus: 'error', syncError: message });
        return false;
      }
      const merged = acceptEnvelope({
        type: 'game.events',
        roomId: eventsResponse.roomId,
        gameId: eventsResponse.gameId,
        afterSequence: eventsResponse.afterSequence,
        lastSequence: eventsResponse.lastSequence,
        limit: eventsResponse.limit,
        hasMore: eventsResponse.hasMore,
        nextAfterSequence: eventsResponse.nextAfterSequence,
        nextBeforeSequence: eventsResponse.nextBeforeSequence,
        events: eventsResponse.events,
      });
      if (!merged) {
        set({ syncStatus: 'error', syncError: '事件同步未通过校验。' });
        return false;
      }
      if (eventsResponse.hasMore !== true) break;

      const nextAfterSequence = eventsResponse.nextAfterSequence;
      const currentAfterSequence = get().session?.lastSeenSeq ?? afterSequence;
      if (
        nextAfterSequence === null ||
        nextAfterSequence === undefined ||
        nextAfterSequence <= afterSequence && currentAfterSequence <= afterSequence
      ) {
        const message = '事件补拉游标未前进，已停止自动重试。';
        set({ error: message, syncStatus: 'error', syncError: message });
        return false;
      }
      afterSequence = Math.max(nextAfterSequence, currentAfterSequence);
    }
    if (get().room?.status === 'ended') await refreshReview();
    set({ syncStatus: 'synced', syncError: null });
    return true;
  };

  const recover = async (): Promise<boolean> => {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const before = get().session;
      if (!before) {
        set({ authorityStatus: 'unauthorized', recovering: false });
        return false;
      }
      set({ recovering: true, authorityStatus: 'resolving', error: null, syncStatus: 'syncing', syncError: null });
      try {
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
          const message = responseMessage(response);
          if (response.code === 'UNAUTHENTICATED' || response.code === 'ROOM_NOT_FOUND') {
            clearAuthority(message);
          } else {
            set({ recovering: false, authorityStatus: 'error', error: message, syncStatus: 'error', syncError: message });
          }
          return false;
        }
        if (!acceptRoom(response.room)) {
          clearAuthority('房间响应未通过安全校验，已拒绝载入。');
          return false;
        }

        // Apply the room revision through the same path used by broadcasts.
        if (!applyRoomView(response.room)) {
          clearAuthority('恢复返回的房间身份与本地会话不一致，请重新输入房间口令。');
          return false;
        }
        const current = get();
        const sameGame =
          before.gameId !== undefined && before.gameId === response.room.gameId;
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
        persistSessionIdentity(nextSession);
        set({
          room: response.room,
          session: nextSession,
          // Keep the last authoritative projection on screen while the new
          // one is fetched. Automatic AI turns must not turn a transient
          // reconnect into a full-page loading interruption.
          snapshot: sameGame ? current.snapshot : null,
          events:
            sameGame ? current.events : [],
        });

        const projected = await recoverGameProjection();
        set({
          recovering: false,
          authorityStatus: projected ? 'authorized' : 'error',
          error: projected ? null : get().error,
          syncStatus: projected ? 'synced' : 'error',
          syncError: projected ? null : get().syncError ?? get().error,
        });
        return projected;
      } catch (error) {
        const message = recoveryExceptionMessage(error);
        set({ recovering: false, authorityStatus: 'error', error: message, syncStatus: 'error', syncError: message });
        return false;
      }
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };

  const ensureTransportSubscriptions = (): void => {
    if (subscriptionCleanup) return;
    const cleanups = [
      subscribeV3Connection((connected) => {
        set({ connected, ...(connected ? {} : { syncStatus: 'syncing', syncError: null }) });
        if (connected && get().session && !get().recovering) void recover();
      }),
      subscribeV3ReconnectLifecycle(() => {
        const current = get();
        // Room creation/joining intentionally replaces the transport. That
        // is not a user-visible reconnect and must not start a competing
        // recovery against the previous identity.
        if (current.loading || current.authorityStatus === 'resolving') return;
        set({ syncStatus: 'syncing', syncError: null });
        if (current.session && !current.recovering) void recover();
      }),
      subscribeV3Messages((message) => {
        if (message.type !== 'room.closed') return;
        const current = get();
        if (current.session?.roomCode !== message.roomCode) return;
        const causal = message.causeCommandId
          ? commandOutcomeRegistry.markCommitted(message.causeCommandId)
          : [...Object.keys(commandOutcomeRegistry.all())]
            .map((commandId) => commandOutcomeRegistry.get(commandId))
            .find((outcome) => outcome?.status === 'unknown' && outcome.commandType === 'room.dissolve');
        if (causal) publishOutcome(causal);
        clearAuthority('房间已解散。');
      }),
      subscribeV3RoomSnapshots((message) => {
        if (message.causeCommandId) {
          const outcome = commandOutcomeRegistry.markCommitted(message.causeCommandId);
          publishOutcome(outcome);
        }
        const accepted = applyRoomView(message.room);
        if (
          accepted &&
          isRoomStatusWithGame(message.room.status) &&
          message.room.gameId &&
          !get().snapshot
        ) {
          void recoverGameProjection();
        }
        if (accepted && message.room.status === 'ended') void refreshReview();
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
        const before = get();
        const beforeCursor = before.session?.lastSeenSeq ?? 0;
        const hadSnapshot = before.snapshot !== null;
        const accepted = acceptSnapshot(message.snapshot);
        if (!accepted) {
          const current = get();
          if (
            current.session?.roomId === message.snapshot.roomId &&
            !current.recovering
          ) {
            void recover();
          }
          return;
        }
        const current = get();
        if (
          current.session &&
          current.room &&
          isRoomStatusWithGame(current.room.status) &&
          current.room.gameId &&
          !current.recovering &&
          (!hadSnapshot || message.snapshot.lastSequence > beforeCursor)
        ) {
          // A snapshot is state, not history. Always reconcile when it is the
          // first projection after a reconnect or advertises a stream cursor
          // beyond the locally covered watermark.
          void recoverGameProjection();
        }
      }),
      subscribeV3Errors((response) => {
        const message = getErrorMessage(response.code);
        if (
          (response.code === 'PUSH_FAILED' || response.code === 'IDENTITY_MISMATCH') &&
          get().session &&
          !get().recovering &&
          !get().loading
        ) {
          set({ error: null, syncStatus: 'syncing', syncError: null });
          void recover();
          return;
        }
        set({ error: message });
      }),
    ];
    subscriptionCleanup = () => {
      for (const cleanup of cleanups) cleanup();
      subscriptionCleanup = null;
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
      set({ error: responseMessage(response) });
      return false;
    }
    return applyRoomView(response.room);
  };

  const refreshReview = async (): Promise<boolean> => {
    const current = get();
    if (!current.session || !current.room || current.room.status !== 'ended') {
      set({ review: null });
      return false;
    }
    const response = await getV3Review(
      current.session.actorId,
      current.session.roomCode,
      current.session.roomId,
      true,
    );
    if (response.ok === false) {
      set({ error: responseMessage(response) });
      return false;
    }
    set({ review: response.review, error: null });
    return true;
  };

  const clearReviewInsights = async (): Promise<boolean> => {
    const current = get();
    if (!current.session) return false;
    const response = await clearV3ReviewInsights(
      current.session.actorId,
      current.session.roomId,
      current.room?.roomRevision ?? 1,
    );
    if (response.ok === false) {
      set({ error: responseMessage(response) });
      return false;
    }
    await refreshReview();
    return true;
  };

  const runRoomMutation = async (
    command: RoomMutationCommand,
  ): Promise<boolean> => {
    let current = get();
    if (!current.session || !current.room) return false;
    // Never send a room mutation while the browser is still changing socket
    // identity. In particular, a freshly-created host must wait for the
    // authoritative room state instead of receiving a misleading auth error.
    if (
      current.authorityStatus !== 'authorized' ||
      current.recovering ||
      current.syncStatus === 'syncing' ||
      current.syncStatus === 'error'
    ) {
      if (!current.recovering) await recover();
      current = get();
      if (
        !current.session ||
        !current.room ||
        current.authorityStatus !== 'authorized' ||
        current.recovering ||
        current.syncStatus === 'error'
      ) return false;
    }
    const action = roomActionForCommand(command);
    if (action && !roomActions(current.room).includes(action)) return false;
    const commandId = safeUuid();
    commandRequests.set(commandId, {
      roomId: current.session.roomId,
      expectedRoomRevision: current.room.roomRevision,
      command,
    });
    publishOutcome(commandOutcomeRegistry.begin(commandId, command.type));
    set({ loading: true, error: null });
    set({ pendingRoomCommand: command.type });
    const response = await sendV3RoomCommand(
      current.session.actorId,
      current.session.roomId,
      current.room.roomRevision,
      command,
      commandId,
    );
    if (response.ok === false) {
      const alreadyCommitted = isTransportFailure(response) &&
        commandOutcomeRegistry.get(commandId)?.status === 'committed';
      if (alreadyCommitted) {
        set({ loading: false, pendingRoomCommand: null });
        return true;
      }
      if (!isTransportFailure(response) && response.room) applyRoomView(response.room);
      if (
        !isTransportFailure(response) &&
        (response.code === 'IDENTITY_MISMATCH' || response.code === 'UNAUTHENTICATED')
      ) {
        // The command was rejected before it reached the room state machine.
        // Recover the durable identity, then replay the same command id once
        // with the fresh room revision so a transient socket race is invisible
        // to the user and remains idempotent.
        set({ loading: false, pendingRoomCommand: null, error: null, syncStatus: 'syncing' });
        if (await recover()) {
          const recovered = get();
          if (recovered.session && recovered.room) {
            const retry = await sendV3RoomCommand(
              recovered.session.actorId,
              recovered.session.roomId,
              recovered.room.roomRevision,
              command,
              commandId,
            );
            if (retry.ok === true) {
              const retryOutcome = commandOutcomeRegistry.markCommitted(commandId, retry.receipt);
              publishOutcome(retryOutcome);
              if (retry.room) applyRoomView(retry.room);
              set({ loading: false, pendingRoomCommand: null, error: null, syncStatus: 'synced' });
              if (command.type === 'room.start_game') await recoverGameProjection();
              return true;
            }
          }
        }
      }
      const outcome = isTransportFailure(response)
        ? response.sent
          ? commandOutcomeRegistry.markUnknown(commandId, command.type)
          : commandOutcomeRegistry.markNotSent(commandId, command.type)
        : commandOutcomeRegistry.markRejected(commandId, response.code, response.receipt);
      publishOutcome(outcome);
      set({
        loading: false,
        pendingRoomCommand: null,
        error: outcome.status === 'unknown' ? '正在确认结果，请勿重复操作。' : responseMessage(response),
      });
      return false;
    }
    const outcome = commandOutcomeRegistry.markCommitted(commandId, response.receipt);
    publishOutcome(outcome);
    if (response.room) applyRoomView(response.room);
    if ('summary' in response && response.summary !== undefined) {
      set({ aiConfigSummary: response.summary });
    }
    set({ loading: false, pendingRoomCommand: null, error: null });
    if (command.type === 'room.start_game') await recoverGameProjection();
    return true;
  };

  const reconcileCommand = async (commandId: string): Promise<CommandOutcome | null> => {
    const current = get();
    const request = commandRequests.get(commandId);
    if (!current.session || !request) return commandOutcomeRegistry.get(commandId) ?? null;
    const queried = await getV3CommandReceipt(
      current.session.actorId,
      request.roomId,
      commandId,
    );
    if (queried.ok === true && queried.receipt) {
      const outcome = queried.receipt.status === 'committed'
        ? commandOutcomeRegistry.markCommitted(commandId, queried.receipt)
        : commandOutcomeRegistry.markRejected(commandId, queried.receipt.errorCode, queried.receipt);
      publishOutcome(outcome);
      if (outcome.status === 'committed') await get().refreshRoom();
      return outcome;
    }
    if (queried.ok === false) {
      const outcome = commandOutcomeRegistry.markUnknown(commandId, request.command.type);
      publishOutcome(outcome);
      return outcome;
    }

    // No receipt yet: replay the exact commandId. A new commandId would turn
    // an unknown into a duplicate room mutation.
    const replay = await sendV3RoomCommand(
      current.session.actorId,
      request.roomId,
      request.expectedRoomRevision,
      request.command,
      commandId,
    );
    if (replay.ok === true) {
      const outcome = commandOutcomeRegistry.markCommitted(commandId, replay.receipt);
      publishOutcome(outcome);
      if (replay.room) applyRoomView(replay.room);
      return outcome;
    }
    const outcome = isTransportFailure(replay)
      ? replay.sent
        ? commandOutcomeRegistry.markUnknown(commandId, request.command.type)
        : commandOutcomeRegistry.markNotSent(commandId, request.command.type)
      : commandOutcomeRegistry.markRejected(commandId, replay.code, replay.receipt);
    publishOutcome(outcome);
    return outcome;
  };

  return {
    connected: false,
    loading: false,
    recovering: false,
    syncStatus: 'idle',
    syncError: null,
    authorityStatus: loadSession() ? 'resolving' : 'unauthorized',
    error: null,
    catalogStatus: 'idle',
    catalogError: null,
    pendingRoomCommand: null,
    commandOutcomes: commandOutcomeRegistry.all(),
    lastCommandOutcome: null,
    rooms: [],
    roomsNextCursor: null,
    roomsLoading: false,
    catalog: null,
    room: null,
    session: loadSession(),
    snapshot: null,
    events: [],
    review: null,
    aiConfigSummary: null,
    aiConfigStatus: 'idle',
    aiConfigError: null,

    initialize: () => {
      ensureTransportSubscriptions();
      const current = get();
      if (current.session) void recover();
      void get().refreshCatalog();
      void get().refreshRooms();
      return () => {
        subscriptionCleanup?.();
      };
    },

    refreshCatalog: async (refreshOptions = {}) => {
      if (catalogRefreshPromise && !refreshOptions.force) return catalogRefreshPromise;
      set({ catalogStatus: 'loading', catalogError: null });
      catalogRefreshPromise = (async () => {
        const response = await getV3Catalog();
        if (response.ok === false) {
          const message = responseMessage(response);
          set({ catalogStatus: 'error', catalogError: message });
          return false;
        }
        set({ catalog: response.catalog, catalogStatus: 'ready', catalogError: null });
        return true;
      })().finally(() => {
        catalogRefreshPromise = null;
      });
      return catalogRefreshPromise;
    },

    refreshRooms: async () => {
      if (roomRefreshPromise) return roomRefreshPromise;
      set({ roomsLoading: true });
      roomRefreshPromise = (async () => {
        const query: RoomListQuery = {};
        const response = await listV3Rooms(query);
        if (response.ok === false) {
          set({ error: responseMessage(response) });
          return;
        }
        set({
          rooms: response.rooms,
          roomsNextCursor: response.nextCursor,
          roomsLoading: false,
          error: null,
        });
      })().finally(() => {
        roomRefreshPromise = null;
        if (get().roomsLoading) set({ roomsLoading: false });
      });
      return roomRefreshPromise;
    },

    loadMoreRooms: async () => {
      if (roomRefreshPromise) return roomRefreshPromise;
      const cursor = get().roomsNextCursor;
      if (!cursor) return;
      set({ roomsLoading: true });
      roomRefreshPromise = (async () => {
        const response = await listV3Rooms({ cursor });
        if (response.ok === false) {
          set({ error: responseMessage(response) });
          return;
        }
        // Keep one server-sized page in memory/DOM. This is intentionally
        // pagination rather than unbounded "load all" accumulation.
        set({
          rooms: response.rooms,
          roomsNextCursor: response.nextCursor,
          roomsLoading: false,
          error: null,
        });
      })().finally(() => {
        roomRefreshPromise = null;
        if (get().roomsLoading) set({ roomsLoading: false });
      });
      return roomRefreshPromise;
    },

    createRoom: async (name, roomName, auto) => {
      const catalogResponse = await getV3Catalog();
      if (catalogResponse.ok === false) {
        set({ error: responseMessage(catalogResponse) });
        return false;
      }
      set({ catalog: catalogResponse.catalog, catalogStatus: 'ready' });
      const options = buildDefaultOptions(
        catalogResponse.catalog,
        name,
        roomName,
        auto ? 'mixed' : 'human',
      );
      if (!options) {
        set({ error: '当前没有可用的房间规则。', authorityStatus: 'error' });
        return false;
      }
      return (await get().createRoomWithOptions(options)).ok;
    },

    createQuickComputerRoom: async (name, roomName) => {
      const catalogResponse = await getV3Catalog();
      if (catalogResponse.ok === false) {
        set({ error: responseMessage(catalogResponse) });
        return false;
      }
      set({ catalog: catalogResponse.catalog, catalogStatus: 'ready' });
      const options = buildDefaultOptions(
        catalogResponse.catalog,
        name,
        roomName,
        'quick_computer',
      );
      if (!options) {
        set({ error: '当前没有可用的房间规则。', authorityStatus: 'error' });
        return false;
      }
      return (await get().createRoomWithOptions(options)).ok;
    },

    createRoomWithOptions: async (options) => {
      const pending = readPendingCreate() ?? {
        createRequestId: newActorId(),
        actorId: newActorId(),
        createdAt: Date.now(),
      };
      writePendingCreate(pending);
      clearAuthority();
      ensureTransportSubscriptions();
      set({ loading: true, authorityStatus: 'resolving' });
      const actorName = options.creator.name.trim() || '玩家';
      try {
        const response = await createV3Room(
          pending.actorId,
          actorName,
          options,
          pending.createRequestId,
        );
        if (response.ok === false) {
          if (!isTransportFailure(response)) clearPendingCreate();
          set({ loading: false, authorityStatus: 'error', error: responseMessage(response) });
          return response;
        }
        clearPendingCreate();
        const accepted = establish(response.room, response.credentials, actorName);
        if (accepted && isRoomStatusWithGame(response.room.status)) {
          await recoverGameProjection();
        }
        return response;
      } catch (error) {
        // An exception that escapes the transport adapter is not safely
        // replayable. Do not let it poison the next room creation attempt.
        clearPendingCreate();
        const message = error instanceof Error && error.message
          ? error.message
          : '创建房间失败，请重试。';
        const response = {
          ok: false as const,
          code: 'UNKNOWN_ERROR' as const,
          message,
        };
        set({ authorityStatus: 'error', error: responseMessage(response) });
        return response;
      } finally {
        set({ loading: false });
      }
    },

    joinRoom: async (name, roomCode, joinToken) => {
      clearAuthority();
      ensureTransportSubscriptions();
      set({ loading: true, authorityStatus: 'resolving' });
      const actorName = name.trim() || '玩家';
      const normalizedRoomCode = roomCode.trim().toUpperCase();
      const existingPending = readPendingJoin();
      const pending = existingPending &&
        existingPending.roomCode === normalizedRoomCode &&
        existingPending.actorName === actorName &&
        existingPending.mode === 'player'
        ? existingPending
        : {
            joinRequestId: newActorId(),
            actorId: newActorId(),
            roomCode: normalizedRoomCode,
            actorName,
            mode: 'player' as const,
            createdAt: Date.now(),
          };
      writePendingJoin(pending);
      try {
        const response = await joinV3Room(
          pending.actorId,
          actorName,
          normalizedRoomCode,
          joinToken,
          pending.joinRequestId,
        );
        if (response.ok === false) {
          if (!isTransportFailure(response)) clearPendingJoin(pending.joinRequestId);
          set({ authorityStatus: 'error', error: responseMessage(response) });
          return false;
        }
        clearPendingJoin(pending.joinRequestId);
        return establish(response.room, response.credentials, actorName);
      } finally {
        set({ loading: false });
      }
    },

    spectateRoom: async (name, roomCode, joinToken, omniscientToken) => {
      clearAuthority();
      ensureTransportSubscriptions();
      set({ loading: true, authorityStatus: 'resolving' });
      const actorName = name.trim() || '观战者';
      const normalizedRoomCode = roomCode.trim().toUpperCase();
      const existingPending = readPendingJoin();
      const pending = existingPending &&
        existingPending.roomCode === normalizedRoomCode &&
        existingPending.actorName === actorName &&
        existingPending.mode === 'spectator'
        ? existingPending
        : {
            joinRequestId: newActorId(),
            actorId: newActorId(),
            roomCode: normalizedRoomCode,
            actorName,
            mode: 'spectator' as const,
            createdAt: Date.now(),
          };
      writePendingJoin(pending);
      try {
        const response = await spectateV3Room(
          pending.actorId,
          actorName,
          normalizedRoomCode,
          joinToken,
          pending.joinRequestId,
          omniscientToken,
        );
        if (response.ok === false) {
          if (!isTransportFailure(response)) clearPendingJoin(pending.joinRequestId);
          set({ authorityStatus: 'error', error: responseMessage(response) });
          return false;
        }
        clearPendingJoin(pending.joinRequestId);
        const accepted = establish(response.room, response.credentials, actorName);
        if (accepted && isRoomStatusWithGame(response.room.status)) {
          await recoverGameProjection();
        }
        return accepted;
      } finally {
        set({ loading: false });
      }
    },

    resumeSession: recover,

    refreshSnapshot: async () => recoverGameProjection(),
    refreshReview,
    clearReviewInsights,

    loadAIConfig: async () => {
      const current = get();
      if (
        !current.session ||
        !current.room ||
        !roomActions(current.room).includes('update_ai_config')
      ) return false;
      set({ aiConfigStatus: 'loading', aiConfigError: null });
      const response = await getV3AIConfig(
        current.session.actorId,
        current.session.roomId,
      );
      if (response.ok === false) {
        set({ aiConfigStatus: 'error', aiConfigError: responseMessage(response) });
        return false;
      }
      set({
        aiConfigSummary: response.summary,
        aiConfigStatus: 'ready',
        aiConfigError: null,
      });
      return true;
    },

    updateAIConfig: async (patch) => {
      const current = get();
      if (
        !current.session ||
        !current.room ||
        !roomActions(current.room).includes('update_ai_config')
      ) return false;
      set({ aiConfigStatus: 'updating', aiConfigError: null });
      const success = await runRoomMutation({
        type: 'room.update_ai_config',
        payload: { patch },
      });
      if (!success) {
        set({ aiConfigStatus: 'error', aiConfigError: get().error });
        if (get().lastCommandOutcome?.status !== 'unknown') await get().refreshRoom();
        return false;
      }
      set({
        aiConfigStatus: 'ready',
        aiConfigError: null,
      });
      await get().refreshRoom();
      return true;
    },

    clearAIConfig: () => get().updateAIConfig({
      clearApiKey: true,
      clearToken: true,
    }),

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
      return runRoomMutation({
        type: 'room.start_game',
        payload: {},
      });
    },

    updateRoomConfig: (config) =>
      runRoomMutation({
        type: 'room.update_config',
        payload: { config },
      }),

    claimSeat: (seatIndex) =>
      runRoomMutation({
        type: 'room.claim_seat',
        payload: seatIndex === undefined ? {} : { seatIndex },
      }),

    becomeSpectator: () =>
      runRoomMutation({
        type: 'room.become_spectator',
        payload: {},
      }),

    addAISeat: (seatIndex) =>
      runRoomMutation({
        type: 'room.add_ai',
        payload: seatIndex === undefined ? {} : { seatIndex },
      }),

    kickPlayer: (memberId) =>
      runRoomMutation({
        type: 'room.kick_player',
        payload: { memberId },
      }),

    requestSeat: () =>
      runRoomMutation({
        type: 'room.request_seat',
        payload: {},
      }),

    respondSeatRequest: (requestId, approved) =>
      runRoomMutation({
        type: 'room.respond_seat_request',
        payload: { requestId, approved },
      }),

    transferHost: (targetMemberId) =>
      runRoomMutation({
        type: 'room.transfer_host',
        payload: { targetMemberId },
      }),

    leaveRoomMutation: async () => {
      const current = get();
      const viewer = current.room?.members.find((member) => member.id === current.session?.actorId);
      if (current.room && viewer?.isHost) {
        const otherHumanPlayers = current.room.members.filter((member) =>
          member.kind === 'player' && !member.isAI && member.id !== viewer.id,
        );
        // A host leaving an AI-only room must close it rather than leaving an
        // orphaned host id behind. With other human players, pass ownership to
        // a connected player first; the server also has a safe fallback for an
        // offline human when the leave command is committed.
        if (otherHumanPlayers.length === 0) return get().dissolveRoom();
        const nextHost = otherHumanPlayers.find((member) => member.connected);
        if (nextHost && !await get().transferHost(nextHost.id)) return false;
      }
      const success = await runRoomMutation({
        type: 'room.leave',
        payload: {},
      });
      if (success) clearAuthority();
      return success;
    },

    dissolveRoom: async () => {
      const success = await runRoomMutation({
        type: 'room.dissolve',
        payload: { confirm: true },
      });
      if (success) clearAuthority();
      return success;
    },

    mutateRoom: runRoomMutation,
    reconcileCommand,

    dispatch: async (command) => {
      const current = get();
      const snapshot = current.snapshot;
      if (!current.session || !snapshot) return false;
      if (!gameActionsReady({
        connected: current.connected,
        recovering: current.recovering,
        syncStatus: current.syncStatus,
        authorityStatus: current.authorityStatus,
        hasSnapshot: true,
      })) {
        // Recovery is not an authentication failure. Keep the durable identity
        // and wait for the authoritative snapshot before sending an action.
        return false;
      }
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
        set({ error: responseMessage(response) });
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

    leaveRoom: () => {
      clearPendingCreate();
      clearAuthority();
    },
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
