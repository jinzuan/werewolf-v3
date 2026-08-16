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
  snapshotMatchesSession,
  sessionIdentityChanged,
  type V3Session,
} from '../../v3/session';
import { getSessionPersistence } from '../../runtime/sessionPersistence';

const storage = (): Storage | null =>
  typeof localStorage === 'undefined' ? null : localStorage;

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
type PendingCreate = { createRequestId: string; actorId: string };

const pendingCreateStorage = (): Storage | null =>
  typeof sessionStorage === 'undefined' ? null : sessionStorage;

const readPendingCreate = (): PendingCreate | null => {
  const target = pendingCreateStorage();
  if (!target) return null;
  try {
    const parsed = JSON.parse(target.getItem(PENDING_CREATE_KEY) ?? 'null') as Partial<PendingCreate> | null;
    return parsed && typeof parsed.createRequestId === 'string' && typeof parsed.actorId === 'string'
      ? parsed as PendingCreate
      : null;
  } catch {
    return null;
  }
};

const writePendingCreate = (pending: PendingCreate): void => {
  try { pendingCreateStorage()?.setItem(PENDING_CREATE_KEY, JSON.stringify(pending)); } catch { /* cache only */ }
};

const clearPendingCreate = (): void => {
  try { pendingCreateStorage()?.removeItem(PENDING_CREATE_KEY); } catch { /* cache only */ }
};

const isTransportFailure = (response: ClientAck): response is TransportFailure =>
  response.ok === false && 'kind' in response && response.kind === 'transport';

const responseMessage = (response: ClientAck): string =>
  isTransportFailure(response)
    ? response.message || '连接暂时不可用，请重试。'
    : getErrorMessage(response.code);

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
  }
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
      authorityStatus: 'unauthorized',
      error: reason,
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
      ...(gameChanged ? { snapshot: null, events: [] } : {}),
      review: gameChanged || room.status !== 'ended' ? null : current.review,
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
    scheduleSessionCursor(nextSession);
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
    const pending = bufferedGameMessages.filter((message) =>
      message.roomId === incoming.roomId && message.gameId === incoming.gameId,
    );
    const pendingStart = pending.length > 0
      ? Math.min(...pending.map((message) => message.afterSequence))
      : undefined;
    const nextSession = setCursor(
      session,
      incoming.gameId,
      preserveCursor
        ? session.lastSeenSeq
        : pendingStart === undefined
          ? Math.max(session.lastSeenSeq, incoming.lastSequence)
          : Math.max(session.lastSeenSeq, pendingStart),
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
    const response = await fetchV3Snapshot(
      current.session.roomCode,
      current.session.actorId,
    );
    if (response.ok === false) {
      set({ error: responseMessage(response) });
      return false;
    }
    const accepted = acceptSnapshot(
      response.snapshot,
      current.session.gameId === response.snapshot.gameId,
    );
    if (!accepted) return false;

    const session = get().session;
    if (!session) return false;
    const eventsResponse = await fetchV3Events(
      session.roomCode,
      session.actorId,
      session.lastSeenSeq,
    );
    if (eventsResponse.ok === false) {
      set({ error: responseMessage(eventsResponse) });
      return false;
    }
    const merged = acceptEnvelope({
      type: 'game.events',
      roomId: eventsResponse.roomId,
      gameId: eventsResponse.gameId,
      afterSequence: eventsResponse.afterSequence,
      lastSequence: eventsResponse.lastSequence,
      events: eventsResponse.events,
    });
    if (!merged) return false;
    if (get().room?.status === 'ended') await refreshReview();
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
        const message = responseMessage(response);
        if (
          response.code === 'UNAUTHENTICATED' ||
          response.code === 'IDENTITY_MISMATCH' ||
          response.code === 'ROOM_NOT_FOUND'
        ) {
          clearAuthority(message);
        } else {
          set({ recovering: false, authorityStatus: 'error', error: message });
        }
        return false;
      }
      if (!acceptRoom(response.room)) {
        clearAuthority('房间响应未通过安全校验，已拒绝载入。');
        return false;
      }

      // Apply the room revision through the same path used by broadcasts.
      if (!applyRoomView(response.room)) {
        set({ recovering: false, authorityStatus: 'error' });
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
      persistSessionIdentity(nextSession);
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
        authorityStatus: projected ? 'authorized' : 'error',
        error: projected ? null : get().error,
      });
      return projected;
    })().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };

  const ensureTransportSubscriptions = (): void => {
    if (subscriptionCleanup) return;
    const cleanups = [
      subscribeV3Connection((connected) => {
        set({ connected });
        if (connected && get().session && !get().recovering) void recover();
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
    const current = get();
    if (!current.session || !current.room) return false;
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
        auto,
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
      } finally {
        set({ loading: false });
      }
    },

    joinRoom: async (name, roomCode, joinToken) => {
      clearAuthority();
      ensureTransportSubscriptions();
      set({ loading: true, authorityStatus: 'resolving' });
      const actorName = name.trim() || '玩家';
      try {
        const response = await joinV3Room(
          newActorId(),
          actorName,
          roomCode.trim().toUpperCase(),
          joinToken,
        );
        if (response.ok === false) {
          set({ authorityStatus: 'error', error: responseMessage(response) });
          return false;
        }
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
      try {
        const response = await spectateV3Room(
          newActorId(),
          actorName,
          roomCode.trim().toUpperCase(),
          joinToken,
          omniscientToken,
        );
        if (response.ok === false) {
          set({ authorityStatus: 'error', error: responseMessage(response) });
          return false;
        }
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

    transferHost: (targetMemberId) =>
      runRoomMutation({
        type: 'room.transfer_host',
        payload: { targetMemberId },
      }),

    leaveRoomMutation: async () => {
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
