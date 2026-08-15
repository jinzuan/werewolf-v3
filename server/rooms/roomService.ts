import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { EventStore, ViewerContext } from '../../shared/events';
import type {
  CreateRoomOptionsV31,
  GameCommand,
  GameCommandMeta,
  ProtocolErrorCode,
  RoomConfigIssue,
  RoomConfigView,
  RoomSnapshotReason,
  RoomSummary,
  RoomView,
} from '../../shared/protocol';
import { AI_DEFAULTS } from '../../shared/config/aiDefaults';
import type { RoomAIConfig, RoomAIProviderConfig } from '../../shared/roomContract';
import type { AIConfig, GameAction, Player, Role } from '../../shared/types';
import { AIOrchestrator } from '../ai/orchestrator';
import { DeterministicAIProvider } from '../ai/deterministicProvider';
import { HttpAIProvider } from '../ai/httpProvider';
import { buildAIRuntimeContext } from '../ai/runtimeContext';
import type { AIProvider } from '../ai/types';
import { GameSession } from '../session/gameSession';
import type { SessionOptions } from '../session/types';
import { RoomCatalogService, defaultRoomCatalogService } from './roomCatalogService';
import { RoomConfigValidationError } from './roomConfigValidator';
import { GameStartCoordinator, GameStartError } from './gameStartCoordinator';
import { nextSeatIndex } from './seatAllocator';
import { RoomPolicy, RoomPolicyError, roomCounts } from './roomPolicy';
import { RoomProjector, assertIdentityRoom } from './roomProjector';
import type { RoomRepository } from './repository';
import { RoomRevisionConflictError } from './repository';
import type { RuntimeEnvironment } from '../runtimeConfig';
import {
  EndpointPolicy,
  EndpointPolicyError,
} from '../security/endpointPolicy';
import {
  InMemoryCredentialStore,
  type RoomCredentialStore,
} from '../security/roomCredentialStore';
import type {
  CreateRoomRequest,
  JoinRoomRequest,
  RoomConfigRecord,
  RoomMember,
  RoomRecord,
  RoomAccess,
  SocketIdentity,
} from './types';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const token = () => randomBytes(24).toString('base64url');
const code = () =>
  Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

const clone = <T>(value: T): T => structuredClone(value);

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const createFingerprint = (options: CreateRoomOptionsV31): string => {
  const nonSecret = { ...options } as Record<string, unknown>;
  // Credentials are deliberately not part of the request identity, while
  // provider/model/endpoint tuning remains part of the frozen create input.
  if (options.aiConfig) {
    const { apiKey: _apiKey, token: _token, ...providerConfig } = options.aiConfig;
    nonSecret.aiConfig = providerConfig;
  }
  return JSON.stringify(stableValue(nonSecret));
};

const makePlayer = (
  roomId: string,
  member: Pick<RoomMember, 'id' | 'name' | 'isAI' | 'seatIndex'>,
  hostId: string,
): Player => ({
  id: member.id,
  roomId,
  name: member.name,
  isAI: member.isAI === true,
  role: null,
  isAlive: true,
  isHost: member.id === hostId,
  order: (member.seatIndex ?? 0) + 1,
  isReady: member.isAI === true || false,
});

export interface RoomServiceErrorOptions {
  code: ProtocolErrorCode;
  messageKey: string;
  params?: Record<string, string | number>;
  issues?: RoomConfigIssue[];
}

/** Errors crossing the socket boundary have stable, UI-safe fields. */
export class RoomServiceError extends Error {
  readonly code: ProtocolErrorCode;
  readonly messageKey: string;
  readonly params?: Record<string, string | number>;
  readonly issues?: RoomConfigIssue[];

  constructor(options: RoomServiceErrorOptions) {
    super(options.code);
    this.name = 'RoomServiceError';
    this.code = options.code;
    this.messageKey = options.messageKey;
    this.params = options.params;
    this.issues = options.issues;
  }
}

export interface RoomServiceOptions {
  session?: Omit<SessionOptions, 'onChanged'>;
  aiProvider?: AIProvider;
  aiTimeoutMs?: number;
  autoDrive?: boolean;
  catalog?: RoomCatalogService;
  policy?: RoomPolicy;
  projector?: RoomProjector;
  startCoordinator?: GameStartCoordinator;
  startLeaseMs?: number;
  environment?: RuntimeEnvironment;
  deploymentNamespace?: string;
  waitingRoomTtlMs?: number;
  endedRoomTtlMs?: number;
  roomSweepIntervalMs?: number;
  clock?: () => number;
  sweepLogger?: (entry: {
    environment?: RuntimeEnvironment;
    deploymentNamespace: string;
    roomCode: string;
    reason: string;
    lastActivityAt?: number;
  }) => void;
  credentialStore?: RoomCredentialStore;
  credentialNamespace?: string;
  endpointPolicy?: EndpointPolicy;
}

export class RoomService {
  private readonly sessions = new Map<string, GameSession>();
  private readonly aiRuns = new Map<string, Promise<void>>();
  private readonly roomAIProviders = new Map<string, AIProvider>();
  private readonly fastAutoRooms = new Set<string>();
  private readonly roomChangeListeners = new Set<
    (roomCode: string, reason: RoomSnapshotReason) => void | Promise<void>
  >();
  private readonly roomDissolvedListeners = new Set<
    (roomCode: string, roomId: string) => void | Promise<void>
  >();
  private readonly connectionLeases = new Map<string, Set<string>>();
  private readonly aiProvider: AIProvider;
  private readonly catalog: RoomCatalogService;
  private readonly policy: RoomPolicy;
  private readonly projector: RoomProjector;
  private readonly starter: GameStartCoordinator;
  private readonly credentialStore: RoomCredentialStore;
  private readonly credentialNamespace: string;
  private readonly endpointPolicy: EndpointPolicy;
  private readonly legacyRoomCodes = new Set<string>();
  private legacyCompatibility = false;
  private legacyCreatePending = false;
  private closed = false;
  private readonly environment: RuntimeEnvironment;
  private readonly deploymentNamespace: string;
  private readonly waitingRoomTtlMs: number;
  private readonly endedRoomTtlMs: number;
  private readonly roomSweepIntervalMs: number;
  private readonly now: () => number;
  private readonly sweepLogger?: RoomServiceOptions['sweepLogger'];
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly repository: RoomRepository,
    private readonly eventStore: EventStore,
    private readonly options: RoomServiceOptions = {},
  ) {
    if (process.env.WW_ENV === 'production' && !options.credentialStore) {
      throw new Error('production RoomService requires an injected encrypted RoomCredentialStore');
    }
    this.aiProvider = options.aiProvider ?? new DeterministicAIProvider();
    const repositoryScope = repository as RoomRepository & {
      environment?: RuntimeEnvironment;
      deploymentNamespace?: string;
    };
    this.environment =
      options.environment ?? repositoryScope.environment ?? 'development';
    this.deploymentNamespace =
      options.deploymentNamespace ?? repositoryScope.deploymentNamespace ?? 'default';
    this.waitingRoomTtlMs = options.waitingRoomTtlMs ?? 30 * 60 * 1000;
    this.endedRoomTtlMs = options.endedRoomTtlMs ?? 24 * 60 * 60 * 1000;
    this.roomSweepIntervalMs = options.roomSweepIntervalMs ?? 60 * 1000;
    this.now = options.clock ?? Date.now;
    this.sweepLogger = options.sweepLogger;
    this.catalog = options.catalog ?? defaultRoomCatalogService;
    this.policy = options.policy ?? new RoomPolicy({ registry: this.catalog.registry });
    this.projector =
      options.projector ??
      new RoomProjector({
        policy: this.policy,
        registry: this.catalog.registry,
      });
    this.credentialStore = options.credentialStore ?? new InMemoryCredentialStore();
    this.credentialNamespace = options.credentialNamespace ?? process.env.WW_DEPLOYMENT_NAMESPACE ?? 'development';
    this.endpointPolicy = options.endpointPolicy ?? new EndpointPolicy();
    this.starter =
      options.startCoordinator ??
      new GameStartCoordinator(repository, {
        eventStore,
        evaluateStartCheck: (room) => this.policy.evaluateStartCheck(room),
        sessionOptions: options.session,
        randomIndex: (maxExclusive) =>
          this.legacyCompatibility ? 0 : randomInt(maxExclusive),
        onRoomChange: (room, reason) => this.notifyRoomChange(room.code, reason),
        startLeaseMs: options.startLeaseMs,
        sessionFactory: ({ room, players, eventStore, snapshot }) =>
          this.createSession(room, players, eventStore, snapshot),
      });
  }

  async restore(): Promise<number> {
    this.closed = false;
    await this.sweepExpiredRooms();
    this.startSweepTimer();
    const rooms = await this.repository.list();
    for (const room of rooms) {
      if (!room.config?.credentialRef) continue;
      try {
        await this.credentialStore.assertAvailable?.(
          { namespace: this.credentialNamespace, roomCode: room.code },
          room.config.credentialRef,
        );
      } catch {
        throw this.error('SECRET_STORE_UNAVAILABLE', 'room.error.secret_store_unavailable');
      }
    }
    for (const room of rooms) {
      if (room.status === 'starting') {
        await this.recoverStartingRoom(room.code);
      }
    }
    const restoredRooms = await this.repository.list();
    for (const room of restoredRooms) {
      if (!room.session || (room.status !== 'playing' && room.status !== 'ended')) {
        continue;
      }
      if (this.sessions.has(room.code)) {
        this.startAI(room.code, room.config?.mode === 'quick_computer');
        continue;
      }
      const recoverySnapshot = clone(room.session);
      const existingEvents = await this.eventStore.read(
        `game:${recoverySnapshot.state.gameId}`,
      );
      if (existingEvents.length === 0) recoverySnapshot.state.streamVersion = 0;
      const session = this.createSession(room, room.players, this.eventStore, recoverySnapshot);
      if (existingEvents.length === 0) await session.initialize();
      session.restoreScheduling();
      this.sessions.set(room.code, session);
      this.startAI(room.code, room.config?.mode === 'quick_computer');
    }
    return this.sessions.size;
  }

  async create(request: CreateRoomRequest): Promise<RoomAccess> {
    // One release of compatibility for callers compiled against the old
    // socket adapter. V3.1-shaped input never enters this branch.
    const options = this.normalizeCreateOptions(request.options);
    const config = this.normalizeCreateConfig(options);
    const createRequestId = request.createRequestId?.trim() || randomUUID();
    if (!createRequestId || !request.actorId.trim()) {
      throw this.error('INVALID_COMMAND', 'room.error.invalid_command');
    }
    const fingerprint = createFingerprint(options);
    const roomId = randomUUID();
    const roomCode = await this.uniqueCode();
    let candidateCredentialRef: string | undefined;
    if (options.aiConfig) {
      const aiConfig = this.normalizeRoomAIConfig(options.aiConfig);
      if (!aiConfig) throw this.error('INVALID_ROOM_CONFIG', 'room.error.invalid_ai_config');
      try {
        await this.endpointPolicy.validate(aiConfig.endpoint, {
          provider: aiConfig.provider,
        });
        candidateCredentialRef = await this.credentialStore.put(
          { namespace: this.credentialNamespace, roomCode },
          { apiKey: options.aiConfig.apiKey, token: options.aiConfig.token },
        );
        config.credentialRef = candidateCredentialRef;
      } catch (error) {
        if (candidateCredentialRef) {
          await this.credentialStore.delete(
            { namespace: this.credentialNamespace, roomCode },
            candidateCredentialRef,
          ).catch(() => undefined);
        }
        if (error instanceof EndpointPolicyError) {
          throw this.error('AI_ENDPOINT_NOT_ALLOWED', 'room.error.ai_endpoint_not_allowed', undefined, [{
            path: 'aiConfig.endpoint',
            messageKey: 'room.error.ai_endpoint_not_allowed',
            errorCode: error.code,
          }]);
        }
        throw this.error('SECRET_STORE_UNAVAILABLE', 'room.error.secret_store_unavailable');
      }
    }
    if (this.legacyCreatePending) {
      this.legacyRoomCodes.add(roomCode);
      this.legacyCreatePending = false;
    }
    const creatorName = options.creator.name.trim();
    const resumeToken = token();
    const host: RoomMember = {
      id: request.actorId,
      name: creatorName,
      // A quick computer room is observed by its creator.  The creator must
      // not consume a human seat or receive a player projection.
      kind: config.mode === 'quick_computer' ? 'spectator' : 'player',
      connected: true,
      omniscient: config.mode === 'quick_computer',
      resumeToken,
      seatIndex: config.mode === 'quick_computer' ? null : 0,
      isAI: false,
      ready: config.mode === 'quick_computer' ? null : false,
      avatarId: options.creator.avatarId,
    };
    let claim: Awaited<ReturnType<RoomRepository['createOrGetByRequest']>>;
    try {
      claim = await this.repository.createOrGetByRequest(
        createRequestId,
        request.actorId,
        fingerprint,
        () => ({
          id: roomId,
          code: roomCode,
          name: options.roomName.trim(),
          joinToken: token(),
          omniscientToken: token(),
          hostId: request.actorId,
          maxPlayers: config.maxPlayers,
          status: 'waiting',
          auto: config.mode === 'quick_computer',
          debugMode: false,
          config,
          configLocked: false,
          roomRevision: 1,
          configRevision: 1,
          schemaVersion: 1,
          members: [host],
          players: config.mode === 'quick_computer'
            ? []
            : [makePlayer(roomId, host, request.actorId)],
          recentRoomCommands: [],
          environment: this.environment,
          deploymentNamespace: this.deploymentNamespace,
          createdAt: this.now(),
          updatedAt: this.now(),
          lastActivityAt: this.now(),
          expiresAt: this.now() + this.waitingRoomTtlMs,
        }),
      );
    } catch (error) {
      if (candidateCredentialRef) {
        await this.credentialStore.delete(
          { namespace: this.credentialNamespace, roomCode },
          candidateCredentialRef,
        ).catch(() => undefined);
      }
      throw error;
    }
    if (!claim.created && candidateCredentialRef && claim.room.config?.credentialRef !== candidateCredentialRef) {
      await this.credentialStore.delete(
        { namespace: this.credentialNamespace, roomCode },
        candidateCredentialRef,
      ).catch(() => undefined);
    }

    if (claim.room.config?.mode === 'quick_computer') {
      await this.resumeQuickCreate(claim.room.code, request.actorId, createRequestId);
    }

    const current = await this.requireRoom(claim.room.code);
    this.startAI(current.code, current.config?.mode === 'quick_computer');
    return this.createdAccess(current, request.actorId);
  }

  async join(request: JoinRoomRequest): Promise<RoomAccess> {
    const room = await this.requireRoom(request.roomCode);
    const config = room.config;
    if (!config) throw this.error('INVALID_ROOM_CONFIG', 'room.error.config_missing');
    if (room.members.some((member) => member.id === request.actorId)) {
      throw this.error('IDENTITY_ALREADY_EXISTS', 'room.error.identity_exists');
    }

    const spectator = request.spectator === true;
    const publicSpectator = spectator && config.allowPublicSpectators === true;
    if (!publicSpectator && room.joinToken !== request.joinToken) {
      throw this.error('ROOM_TOKEN_INVALID', 'room.error.invalid_join_token');
    }
    if (spectator) {
      if (
        roomCounts(room).spectators >= this.catalog.getCatalog().limits.maxSpectators
      ) {
        throw this.error('ROOM_FULL', 'room.error.spectator_limit');
      }
      if (!config.allowPublicSpectators && room.joinToken !== request.joinToken) {
        throw this.error('ROOM_TOKEN_INVALID', 'room.error.invalid_join_token');
      }
      if (room.status === 'waiting' || room.status === 'ready_check') {
        // Spectators may watch a lobby only when explicitly allowed; this is
        // still a member fact and is committed through the same CAS path.
      }
    } else {
      if (room.status !== 'waiting' && room.status !== 'ready_check') {
        throw this.error('GAME_ALREADY_STARTED', 'room.error.game_already_started');
      }
      // Fixed computer seats are reserved capacity, so they cannot be
      // silently taken by human joins before the start transaction.
      const humanCapacity = config.maxPlayers - config.computerSeats;
      if (roomCounts(room).humanPlayers >= humanCapacity) {
        throw this.error('ROOM_FULL', 'room.error.room_full');
      }
    }

    const resumeToken = token();
    const seatIndex = spectator ? null : nextSeatIndex(room.members, config.maxPlayers);
    await this.repository.mutate(room.code, (draft) => {
      if (draft.members.some((member) => member.id === request.actorId)) {
        throw this.error('IDENTITY_ALREADY_EXISTS', 'room.error.identity_exists');
      }
      const currentConfig = draft.config;
      if (!currentConfig) throw this.error('INVALID_ROOM_CONFIG', 'room.error.config_missing');
      const humanCapacity = currentConfig.maxPlayers - currentConfig.computerSeats;
      if (!spectator && roomCounts(draft).humanPlayers >= humanCapacity) {
        throw this.error('ROOM_FULL', 'room.error.room_full');
      }
      const member: RoomMember = {
        id: request.actorId,
        name: request.name.trim().slice(0, 32) || '玩家',
        kind: spectator ? 'spectator' : 'player',
        connected: true,
        omniscient:
          spectator && request.omniscientToken !== undefined &&
          request.omniscientToken === draft.omniscientToken,
        resumeToken,
        seatIndex,
        isAI: false,
        ready: spectator ? null : false,
        avatarId: request.avatarId ?? '',
      };
      draft.members.push(member);
      if (!spectator) {
        draft.players.push(makePlayer(draft.id, member, draft.hostId));
      }
      this.touchActivity(draft);
    });
    const current = await this.requireRoom(room.code);
    return { room: this.projectRoom(current, request.actorId), credentials: { resumeToken } };
  }

  async resume(roomCode: string, actorId: string, resumeToken?: string): Promise<RoomAccess> {
    if (!resumeToken) throw this.error('UNAUTHENTICATED', 'room.error.unauthenticated');
    let accepted = false;
    await this.repository.mutate(roomCode, (room) => {
      const member = room.members.find((item) => item.id === actorId);
      if (!member || member.resumeToken !== resumeToken) {
        throw this.error('UNAUTHENTICATED', 'room.error.unauthenticated');
      }
      accepted = true;
      member.connected = true;
      this.touchActivity(room);
    });
    if (!accepted) throw this.error('UNAUTHENTICATED', 'room.error.unauthenticated');
    const room = await this.requireRoom(roomCode);
    return { room: this.projectRoom(room, actorId), credentials: { resumeToken } };
  }

  /** Bind one physical socket to a logical member lease. */
  async bindConnection(identity: SocketIdentity, connectionId: string): Promise<void> {
    const room = await this.requireRoom(identity.roomCode);
    const member = assertIdentityRoom(identity, room);
    const key = `${room.code}:${member.id}`;
    const leases = this.connectionLeases.get(key) ?? new Set<string>();
    leases.add(connectionId);
    this.connectionLeases.set(key, leases);
    if (!member.connected) {
      await this.repository.mutate(room.code, (draft) => {
        const current = assertIdentityRoom(identity, draft);
        current.connected = true;
        this.touchActivity(draft);
      });
    }
  }

  async identity(roomCode: string, actorId: string, resumeToken: string): Promise<SocketIdentity> {
    const room = await this.requireRoom(roomCode);
    const member = room.members.find(
      (item) => item.id === actorId && item.resumeToken === resumeToken,
    );
    if (!member) throw this.error('UNAUTHENTICATED', 'room.error.unauthenticated');
    return {
      actorId,
      roomCode: room.code,
      roomId: room.id,
      kind: member.kind,
      omniscient: Boolean(member.omniscient),
      resumeToken,
      gameId: room.gameId ?? room.session?.state.gameId,
    };
  }

  async disconnect(identity: SocketIdentity, connectionId?: string): Promise<void> {
    const key = `${identity.roomCode.toUpperCase()}:${identity.actorId}`;
    const leases = this.connectionLeases.get(key);
    if (connectionId && leases) {
      leases.delete(connectionId);
      if (leases.size > 0) return;
      this.connectionLeases.delete(key);
    } else if (connectionId) {
      // A disconnect can race a process restart. The persisted connected bit
      // is still corrected when no live lease is known.
      this.connectionLeases.delete(key);
    }
    await this.repository.mutate(identity.roomCode, (room) => {
      const member = assertIdentityRoom(identity, room);
      if (member.connected) member.connected = false;
      this.touchActivity(room);
    });
  }

  subscribeRoomDissolved(
    listener: (roomCode: string, roomId: string) => void | Promise<void>,
  ): () => void {
    this.roomDissolvedListeners.add(listener);
    return () => this.roomDissolvedListeners.delete(listener);
  }

  async listPublicRooms(): Promise<RoomSummary[]> {
    return (await this.repository.list())
      .filter((room) => this.isPubliclyVisible(room))
      .map((room) => {
      const config = room.config;
      const counts = roomCounts(room);
      return {
        roomCode: room.code,
        roomName: room.name,
        status: room.status,
        mode: config?.mode ?? 'human',
        minHumanPlayers: config?.minHumanPlayers ?? 0,
        playerCount: counts.playerSeats,
        maxPlayers: config?.maxPlayers ?? room.maxPlayers,
        onlinePlayers: counts.onlineHumanPlayers,
        onlineCount: counts.onlineHumanPlayers,
        readyCount: counts.readyHumanPlayers,
        spectatorCount: counts.spectators,
      };
      });
  }

  async list(): Promise<RoomSummary[]> {
    const publicRooms = await this.listPublicRooms();
    // Preserve the pre-V3.1 direct service compatibility surface. Socket
    // callers use listPublicRooms(), so an old invite-only fixture cannot
    // weaken the public catalogue policy.
    const visibleCodes = new Set(publicRooms.map((room) => room.roomCode));
    const legacyRooms = (await this.repository.list()).filter(
      (room) =>
        this.legacyRoomCodes.has(room.code) &&
        !visibleCodes.has(room.code) &&
        !this.isExpired(room),
    );
    return [
      ...publicRooms,
      ...legacyRooms.map((room) => this.toSummary(room)),
    ];
  }

  /** Return expired records without changing repository state. */
  async listExpiredRooms(): Promise<RoomRecord[]> {
    return (await this.repository.list()).filter((room) => this.isExpired(room));
  }

  /** Remove only rooms covered by the frozen retention policy. */
  async sweepExpiredRooms(): Promise<
    Array<{ roomCode: string; reason: string; lastActivityAt?: number }>
  > {
    const expired = await this.listExpiredRooms();
    const removed: Array<{
      roomCode: string;
      reason: string;
      lastActivityAt?: number;
    }> = [];
    for (const room of expired) {
      const reason = this.expiryReason(room);
      await this.repository.remove(room.code);
      this.connectionLeases.forEach((_leases, key) => {
        if (key.startsWith(`${room.code}:`)) this.connectionLeases.delete(key);
      });
      const entry = {
        roomCode: room.code,
        reason,
        ...(room.lastActivityAt !== undefined
          ? { lastActivityAt: room.lastActivityAt }
          : {}),
      };
      removed.push(entry);
      try {
        this.sweepLogger?.({
          environment: room.environment,
          deploymentNamespace: room.deploymentNamespace ?? this.deploymentNamespace,
          ...entry,
        });
      } catch {
        // Audit logging cannot make a safe cleanup fail.
      }
    }
    return removed;
  }

  /** Short alias used by administrative tooling. */
  async sweep() {
    return this.sweepExpiredRooms();
  }

  private startSweepTimer(): void {
    if (this.sweepTimer || this.roomSweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredRooms().catch((error) => {
        // A future interval can retry after a transient repository failure.
        console.error('[server:rooms] scheduled sweep failed', error);
      });
    }, this.roomSweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  private isPubliclyVisible(room: RoomRecord): boolean {
    const config = room.config;
    if (
      room.environment !== this.environment ||
      room.deploymentNamespace !== this.deploymentNamespace ||
      config?.visibility !== 'listed' ||
      this.isExpired(room)
    ) {
      return false;
    }
    if (room.status === 'waiting' || room.status === 'ready_check') return true;
    return room.status === 'playing' && config.allowPublicSpectators === true;
  }

  private isExpired(room: RoomRecord): boolean {
    const now = this.now();
    const lastActivity = room.lastActivityAt ?? room.updatedAt ?? room.createdAt;
    if (!Number.isFinite(lastActivity)) return false;
    if (room.status === 'waiting' || room.status === 'ready_check') {
      const hasOnlineHuman = room.members.some(
        (member) => member.kind === 'player' && !member.isAI && member.connected,
      );
      return !hasOnlineHuman && now - lastActivity >= this.waitingRoomTtlMs;
    }
    if (room.status === 'ended') {
      const closedAt = room.closedAt ?? lastActivity;
      return now - closedAt >= this.endedRoomTtlMs;
    }
    return false;
  }

  private expiryReason(room: RoomRecord): string {
    return room.status === 'ended' ? 'ended_room_ttl' : 'offline_waiting_room_ttl';
  }

  private touchActivity(room: RoomRecord): void {
    const now = this.now();
    room.lastActivityAt = now;
    if (room.status === 'waiting' || room.status === 'ready_check') {
      room.expiresAt = now + this.waitingRoomTtlMs;
    } else if (room.status === 'ended') {
      room.expiresAt = now + this.endedRoomTtlMs;
    } else {
      delete room.expiresAt;
    }
  }

  private toSummary(room: RoomRecord): RoomSummary {
    const config = room.config;
    const counts = roomCounts(room);
    return {
      roomCode: room.code,
      roomName: room.name,
      status: room.status,
      mode: config?.mode ?? 'human',
      minHumanPlayers: config?.minHumanPlayers ?? 0,
      playerCount: counts.playerSeats,
      maxPlayers: config?.maxPlayers ?? room.maxPlayers,
      onlinePlayers: counts.onlineHumanPlayers,
      onlineCount: counts.onlineHumanPlayers,
      readyCount: counts.readyHumanPlayers,
      spectatorCount: counts.spectators,
    };
  }

  getCatalog() {
    return this.catalog.getCatalog();
  }

  subscribeRoomChanges(
    listener: (roomCode: string, reason: RoomSnapshotReason) => void | Promise<void>,
  ): () => void {
    this.roomChangeListeners.add(listener);
    return () => this.roomChangeListeners.delete(listener);
  }

  async get(roomCode: string, actorId: string): Promise<RoomView> {
    return this.projectRoom(await this.requireRoom(roomCode), actorId);
  }

  async updateConfig(
    identity: SocketIdentity,
    config: RoomConfigView,
    expectedRoomRevision: number,
  ): Promise<RoomView> {
    const existing = await this.requireRoom(identity.roomCode);
    const input = {
      ...config,
      roomName: existing.name,
      creator: { name: '房主', avatarId: 'avatar-default' },
    };
    const result = this.catalog.validator.validate(input);
    if (result.ok === false) throw this.validationError(result);
    await this.mutateRoom(identity, expectedRoomRevision, 'update_config', (room) => {
      const next = result.config as RoomConfigRecord;
      room.config = {
        ...clone(next),
        ...(next.mode !== 'human' && room.config?.aiProviderConfig
          ? { aiProviderConfig: clone(room.config.aiProviderConfig) }
          : {}),
        ...(next.mode !== 'human' && room.config?.credentialRef
          ? { credentialRef: room.config.credentialRef }
          : {}),
      };
      room.maxPlayers = next.maxPlayers;
      room.configLocked = false;
      room.auto = next.mode === 'quick_computer';
      room.members.forEach((member) => {
        if (member.kind === 'player' && !member.isAI) member.ready = false;
      });
    });
    const updated = await this.requireRoom(identity.roomCode);
    if (existing.config?.credentialRef && !updated.config?.credentialRef) {
      await this.deleteRoomCredential(existing);
    }
    return this.get(identity.roomCode, identity.actorId);
  }

  async beginReadyCheck(identity: SocketIdentity, expectedRoomRevision: number): Promise<RoomView> {
    await this.mutateRoom(identity, expectedRoomRevision, 'begin_ready_check', (room) => {
      room.status = 'ready_check';
      room.configLocked = true;
      room.members.forEach((member) => {
        if (member.kind === 'player' && !member.isAI) member.ready = false;
      });
    });
    return this.get(identity.roomCode, identity.actorId);
  }

  async cancelReadyCheck(identity: SocketIdentity, expectedRoomRevision: number): Promise<RoomView> {
    await this.mutateRoom(identity, expectedRoomRevision, 'cancel_ready_check', (room) => {
      room.status = 'waiting';
      room.configLocked = false;
      room.members.forEach((member) => {
        if (member.kind === 'player' && !member.isAI) member.ready = false;
      });
    });
    return this.get(identity.roomCode, identity.actorId);
  }

  async setReady(
    identity: SocketIdentity,
    ready: boolean,
    expectedRoomRevision: number,
  ): Promise<RoomView> {
    await this.mutateRoom(identity, expectedRoomRevision, 'set_ready', (room) => {
      const member = room.members.find((item) => item.id === identity.actorId);
      if (!member || member.kind !== 'player' || member.isAI) {
        throw this.error('ACTION_NOT_ALLOWED', 'room.error.ready_not_allowed');
      }
      member.ready = ready;
    });
    return this.get(identity.roomCode, identity.actorId);
  }

  async startGame(
    identity: SocketIdentity,
    command?: { commandId: string; expectedRoomRevision: number } | number,
  ): Promise<RoomView> {
    assertIdentityRoom(identity, await this.requireRoom(identity.roomCode));
    const current = await this.requireRoom(identity.roomCode);
    if (command === undefined) {
      // Compatibility for the pre-V3.1 direct service API. Socket commands
      // always provide the explicit CAS revision and use ready_check.
      if (current.status === 'waiting') {
        await this.beginReadyCheck(identity, current.roomRevision!);
        const ready = await this.requireRoom(identity.roomCode);
        await this.repository.mutate(identity.roomCode, ready.roomRevision!, (room) => {
          room.members.forEach((member) => {
            if (member.kind === 'player' && !member.isAI) member.ready = true;
          });
        });
      }
      const ready = await this.requireRoom(identity.roomCode);
      return this.startWithRevision(identity.roomCode, identity.actorId, token(), ready.roomRevision!);
    }
    const expectedRoomRevision =
      typeof command === 'number' ? command : command.expectedRoomRevision;
    const commandId = typeof command === 'number' ? token() : command.commandId;
    return this.startWithRevision(identity.roomCode, identity.actorId, commandId, expectedRoomRevision);
  }

  async leave(identity: SocketIdentity, expectedRoomRevision: number): Promise<RoomView | undefined> {
    const room = await this.requireRoom(identity.roomCode);
    this.policy.assertAllowed(room, identity.actorId, 'leave');
    await this.repository.mutate(identity.roomCode, expectedRoomRevision, (draft) => {
      assertIdentityRoom(identity, draft);
      draft.members = draft.members.filter((member) => member.id !== identity.actorId);
      draft.players = draft.players.filter((player) => player.id !== identity.actorId);
      if (draft.hostId === identity.actorId) {
        const nextHost = draft.members.find(
          (member) => member.kind === 'player' && !member.isAI,
        );
        if (nextHost) draft.hostId = nextHost.id;
      }
      this.touchActivity(draft);
    });
    const current = await this.repository.get(identity.roomCode);
    if (!current || current.members.length === 0) {
      if (current?.config?.credentialRef) {
        await this.deleteRoomCredential(current);
      }
      await this.repository.remove(identity.roomCode);
      return undefined;
    }
    return this.projectRoom(current, current.hostId);
  }

  async transferHost(
    identity: SocketIdentity,
    targetMemberId: string,
    expectedRoomRevision: number,
  ): Promise<RoomView> {
    await this.mutateRoom(identity, expectedRoomRevision, 'transfer_host', (room) => {
      const target = room.members.find((member) => member.id === targetMemberId);
      if (!target || target.kind !== 'player' || target.isAI || !target.connected) {
        throw this.error('MEMBER_NOT_FOUND', 'room.error.host_target_not_found');
      }
      room.hostId = target.id;
    });
    return this.get(identity.roomCode, identity.actorId);
  }

  async dissolve(identity: SocketIdentity, confirm: boolean, expectedRoomRevision: number): Promise<void> {
    if (!confirm) throw this.error('ACTION_NOT_ALLOWED', 'room.error.dissolve_confirmation_required');
    const room = await this.requireRoom(identity.roomCode);
    this.policy.assertAllowed(room, identity.actorId, 'dissolve');
    await this.repository.mutate(identity.roomCode, expectedRoomRevision, (draft) => {
      assertIdentityRoom(identity, draft);
      draft.lastStartFailure = undefined;
      draft.status = 'ended';
      draft.closedAt = this.now();
      draft.closeReason = 'dissolved';
      this.touchActivity(draft);
    });
    const tombstone = await this.requireRoom(identity.roomCode);
    await Promise.allSettled(
      [...this.roomDissolvedListeners].map((listener) =>
        listener(tombstone.code, tombstone.id),
      ),
    );
    for (const key of [...this.connectionLeases.keys()]) {
      if (key.startsWith(`${tombstone.code}:`)) this.connectionLeases.delete(key);
    }
    await this.deleteRoomCredential(tombstone);
    await this.repository.remove(identity.roomCode);
  }

  async dispatchGame(identity: SocketIdentity, meta: GameCommandMeta, command: GameCommand) {
    const room = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, room);
    if (identity.kind !== 'player') return { ok: false, code: 'SPECTATOR_READ_ONLY', events: [] };
    if (meta.roomId !== room.id) return { ok: false, code: 'ROOM_MISMATCH', events: [] };
    if (meta.gameId !== room.gameId && meta.gameId !== room.session?.state.gameId) {
      return { ok: false, code: 'GAME_MISMATCH', events: [] };
    }
    if (meta.actorId !== identity.actorId) return { ok: false, code: 'IDENTITY_MISMATCH', events: [] };
    const session = this.sessions.get(room.code);
    if (!session) throw this.error('GAME_NOT_STARTED', 'room.error.game_not_started');
    const result = await session.dispatch(
      { ...meta, actorId: identity.actorId, roomId: room.id },
      command,
    );
    const current = await this.requireRoom(room.code);
    this.startAI(room.code, current.config?.mode === 'quick_computer');
    const viewer = await this.viewerForIdentity(identity);
    return { ...result, events: await session.projectEvents(result.events, viewer) };
  }

  async viewerForIdentity(identity: SocketIdentity): Promise<ViewerContext> {
    const room = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, room);
    if (identity.kind === 'spectator') {
      return { kind: 'spectator', spectatorId: identity.actorId, omniscient: identity.omniscient };
    }
    const player = room.players.find((item) => item.id === identity.actorId);
    if (!player?.role) throw this.error('ROLE_NOT_ASSIGNED', 'room.error.role_not_assigned');
    return { kind: 'player', playerId: identity.actorId, role: player.role };
  }

  async snapshot(identity: SocketIdentity) {
    const room = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, room);
    const session = this.sessions.get(room.code);
    if (!session) throw this.error('GAME_NOT_STARTED', 'room.error.game_not_started');
    return session.snapshotFor(await this.viewerForIdentity(identity));
  }

  async events(identity: SocketIdentity, afterSequence = 0) {
    const room = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, room);
    const session = this.sessions.get(room.code);
    if (!session) throw this.error('GAME_NOT_STARTED', 'room.error.game_not_started');
    return session.eventsFor(await this.viewerForIdentity(identity), afterSequence);
  }

  async getRecord(roomCode: string): Promise<RoomRecord | undefined> {
    const room = await this.repository.get(roomCode);
    // Compatibility for the pre-C in-process diagnostic API. It is
    // deliberately non-enumerable and contains no credential values; all
    // persisted/projection shapes use aiProviderConfig + credentialRef.
    if (room?.config?.aiProviderConfig) {
      Object.defineProperty(room.config, 'aiConfig', {
        configurable: true,
        enumerable: false,
        value: { ...room.config.aiProviderConfig, apiKey: '', token: '' },
      });
    }
    return room;
  }

  session(roomCode: string): GameSession | undefined {
    return this.sessions.get(roomCode.toUpperCase());
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const session of this.sessions.values()) session.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    this.aiRuns.clear();
    this.roomAIProviders.clear();
    this.fastAutoRooms.clear();
    this.legacyRoomCodes.clear();
    this.roomChangeListeners.clear();
  }

  private normalizeCreateConfig(options: CreateRoomOptionsV31): RoomConfigRecord {
    const result = this.catalog.validator.validate(options);
    if (result.ok === false) throw this.validationError(result);
    const config = clone(result.config as RoomConfigRecord);
    const aiProviderConfig = this.normalizeRoomAIConfig(options.aiConfig);
    if (aiProviderConfig) {
      const { apiKey: _apiKey, token: _token, ...nonSecretConfig } = aiProviderConfig;
      config.aiProviderConfig = nonSecretConfig as RoomAIProviderConfig;
    }
    return config;
  }

  private async deleteRoomCredential(room: RoomRecord): Promise<void> {
    const credentialRef = room.config?.credentialRef;
    if (!credentialRef) return;
    try {
      await this.credentialStore.delete(
        { namespace: this.credentialNamespace, roomCode: room.code },
        credentialRef,
      );
    } catch {
      // Keep the room lifecycle committed. The store operation is safe to
      // retry by an operator and its logs must never contain the secret.
    }
  }

  private createdAccess(room: RoomRecord, actorId: string): RoomAccess {
    const member = room.members.find((candidate) => candidate.id === actorId);
    if (!member) throw this.error('UNAUTHENTICATED', 'room.error.unauthenticated');
    return {
      room: this.projectRoom(room, actorId),
      credentials: {
        resumeToken: member.resumeToken,
        joinToken: room.joinToken,
        ...(room.config?.mode === 'quick_computer'
          ? { omniscientToken: room.omniscientToken }
          : {}),
      },
    };
  }

  private async resumeQuickCreate(
    roomCode: string,
    actorId: string,
    createRequestId: string,
  ): Promise<void> {
    const startCommandId = `create:${createRequestId}`;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const room = await this.requireRoom(roomCode);
      if (room.status === 'playing' || room.status === 'ended') return;
      if (room.status === 'starting') {
        if ((room.startLeaseUntil ?? 0) <= Date.now()) {
          await this.recoverStartingRoom(room.code);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (room.status === 'waiting') {
        await this.repository.mutate(room.code, room.roomRevision!, (draft) => {
          draft.status = 'ready_check';
          draft.configLocked = true;
          for (const member of draft.members) {
            if (member.kind === 'player' && !member.isAI) member.ready = true;
          }
          this.touchActivity(draft);
        });
        continue;
      }
      if (room.status === 'ready_check') {
        await this.startWithRevision(
          room.code,
          actorId,
          startCommandId,
          room.roomRevision!,
        );
        return;
      }
      return;
    }
    throw this.error('GAME_START_IN_PROGRESS', 'room.error.game_start_in_progress');
  }

  /**
   * A starting claim is intentionally recoverable without reconstructing a
   * random room. A committed session is promoted; an uncommitted claim is
   * rolled back, including AI seats added by that claim.
   */
  private async recoverStartingRoom(roomCode: string): Promise<void> {
    const current = await this.repository.get(roomCode);
    if (!current || current.status !== 'starting') return;
    if ((current.startLeaseUntil ?? 0) > this.now()) return;
    const recovered = await this.repository.mutate(
      current.code,
      current.roomRevision!,
      (room) => {
        if (room.status !== 'starting') return;
        const hasCommittedSession = Boolean(
          room.session?.state?.gameId || room.gameId,
        );
        if (hasCommittedSession && room.session) {
          room.status = 'playing';
          room.configLocked = true;
          room.gameId ??= room.session.state.gameId;
        } else {
          const added = new Set(room.startAddedAIIds ?? []);
          room.members = room.members.filter((member) => !added.has(member.id));
          room.players = room.players.filter((player) => !added.has(player.id));
          room.status = 'ready_check';
          room.configLocked = true;
          delete room.gameId;
          delete room.session;
          room.lastStartFailure = {
            code: 'GAME_START_FAILED',
            messageKey: 'room.error.game_start_failed',
            occurredAt: this.now(),
          };
        }
        this.touchActivity(room);
        delete room.startOwner;
        delete room.startLeaseUntil;
        delete room.startedAt;
        delete room.startAddedAIIds;
        return room;
      },
    );
    await this.notifyRoomChange(current.code, 'status_changed');
    if (recovered?.status === 'playing' && recovered.session) {
      const session = this.createSession(
        recovered,
        recovered.players,
        this.eventStore,
        recovered.session,
      );
      session.restoreScheduling();
      this.sessions.set(recovered.code, session);
    }
  }

  private normalizeRoomAIConfig(value: unknown): RoomAIConfig | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Partial<RoomAIConfig>;
    const providers: RoomAIConfig['provider'][] = ['siliconflow', 'deepseek', 'local', 'custom'];
    const behaviors: RoomAIConfig['behavior'][] = ['aggressive', 'conservative', 'random'];
    if (!providers.includes(raw.provider as RoomAIConfig['provider'])) return undefined;
    if (!behaviors.includes(raw.behavior as RoomAIConfig['behavior'])) return undefined;
    const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 160) : '';
    const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim().slice(0, 500) : '';
    if (!model || !endpoint) return undefined;
    return {
      provider: raw.provider as RoomAIConfig['provider'],
      model,
      ...(typeof raw.apiKey === 'string' ? { apiKey: raw.apiKey.trim().slice(0, 4_096) } : {}),
      ...(typeof raw.token === 'string' ? { token: raw.token.trim().slice(0, 4_096) } : {}),
      endpoint,
      temperature: typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)
        ? Math.min(2, Math.max(0, raw.temperature))
        : .7,
      maxTokens: typeof raw.maxTokens === 'number' && Number.isSafeInteger(raw.maxTokens)
        ? Math.min(4096, Math.max(128, raw.maxTokens))
        : 512,
      behavior: raw.behavior as RoomAIConfig['behavior'],
    };
  }

  private async providerForRoom(room: RoomRecord): Promise<AIProvider> {
    const roomConfig = room.config?.aiProviderConfig;
    if (!roomConfig) return this.aiProvider;
    const roomKey = room.code.toUpperCase();
    const existing = this.roomAIProviders.get(roomKey);
    if (existing) return existing;

    const providerConfig = structuredClone(AI_DEFAULTS) as AIConfig;
    providerConfig.apiType = roomConfig.provider === 'custom' ? 'local' : roomConfig.provider;
    providerConfig.defaultBehavior = roomConfig.behavior;
    const selected = providerConfig.apiType === 'siliconflow'
      ? providerConfig.siliconflow
      : providerConfig.apiType === 'deepseek'
        ? providerConfig.deepseek
        : providerConfig.local;
    selected.model = roomConfig.model;
    // The credential value exists only in this short-lived provider object;
    // it is never copied into the RoomRecord or any projection.
    const credential = room.config?.credentialRef
      ? this.credentialStore.get(
          { namespace: this.credentialNamespace, roomCode: room.code },
          room.config.credentialRef,
      )
      : Promise.resolve(undefined);
    const values = await credential;
    selected.apiKey = values?.token || values?.apiKey || '';
    selected.temperature = roomConfig.temperature;
    selected.maxTokens = roomConfig.maxTokens;
    if (providerConfig.apiType === 'local') providerConfig.local.apiUrl = roomConfig.endpoint;
    const provider = new HttpAIProvider(providerConfig, {
      timeoutMs: this.options.aiTimeoutMs,
      endpointPolicy: this.endpointPolicy,
    });
    this.roomAIProviders.set(roomKey, provider);
    return provider;
  }

  private projectRoom(room: RoomRecord, actor: string | SocketIdentity): RoomView {
    const view = this.projector.project(room, actor);
    if (!this.legacyRoomCodes.has(room.code)) return view;
    // The old test/client surface predates the V3.1 room config projection.
    // Keep this compatibility response private to legacy-shaped create calls;
    // all V3.1 callers receive the complete RoomView above.
    const {
      config: _config,
      startCheck: _startCheck,
      ...legacyView
    } = view;
    return legacyView as RoomView;
  }

  private normalizeCreateOptions(options: CreateRoomOptionsV31): CreateRoomOptionsV31 {
    const raw = options as unknown as Record<string, unknown>;
    if (typeof raw.catalogVersion === 'string') return options;

    this.legacyCompatibility = true;
    this.legacyCreatePending = true;

    const catalog = this.catalog.getCatalog();
    const preset = catalog.rolePresets.find((item) => item.enabled);
    if (!preset) throw this.error('RULESET_UNAVAILABLE', 'room.error.ruleset_unavailable');
    const maxPlayers =
      typeof raw.maxPlayers === 'number' && Number.isInteger(raw.maxPlayers)
        ? raw.maxPlayers
        : preset.playerCount;
    const automatic = raw.auto === true;
    return {
      catalogVersion: catalog.catalogVersion,
      roomName: typeof raw.roomName === 'string' ? raw.roomName : 'V3 房间',
      creator: {
        name: typeof raw.name === 'string' ? raw.name : '房主',
        avatarId: 'avatar-default',
      },
      mode: automatic ? 'quick_computer' : 'mixed',
      visibility: 'invite_only',
      maxPlayers,
      minHumanPlayers: automatic ? 0 : 1,
      computerSeats: 0,
      aiFillPolicy: 'fill_to_max',
      roleSetup: clone(preset.roleSetup),
      rolePresetId: preset.id,
      rulesetId: preset.rulesetId,
      rulesetVersion: preset.rulesetVersion,
      readyPolicy: 'all_connected_humans',
      allowPublicSpectators: false,
      reviewEnabled: true,
    };
  }

  private validationError(result: Extract<ReturnType<RoomCatalogService['validateConfig']>, { ok: false }>): RoomServiceError {
    return this.error(result.errorCode, 'room.error.invalid_config', undefined, result.issues);
  }

  private error(
    code: ProtocolErrorCode,
    messageKey: string,
    params?: Record<string, string | number>,
    issues?: RoomConfigIssue[],
  ): RoomServiceError {
    return new RoomServiceError({ code, messageKey, params, issues });
  }

  private async notifyRoomChange(
    roomCode: string,
    reason: RoomSnapshotReason,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.roomChangeListeners].map((listener) => listener(roomCode, reason)),
    );
  }

  private async startWithRevision(
    roomCode: string,
    actorId: string,
    commandId: string,
    expectedRoomRevision: number,
  ): Promise<RoomView> {
    try {
      const room = await this.requireRoom(roomCode);
      const member = room.members.find((candidate) => candidate.id === actorId);
      if (!member) throw this.error('UNAUTHENTICATED', 'room.error.unauthenticated');
      const identity = await this.identity(roomCode, actorId, member.resumeToken);
      const quickComputerObserver =
        room.config?.mode === 'quick_computer' &&
        identity.kind === 'spectator' &&
        identity.omniscient;
      if (!quickComputerObserver) this.policy.assertStartAllowed(room, actorId);
      const result = await this.starter.start(roomCode, {
        commandId,
        actorId,
        expectedRoomRevision,
      });
      if (result.session instanceof GameSession) this.sessions.set(roomCode.toUpperCase(), result.session);
      await this.repository.mutate(roomCode, (draft) => {
        this.touchActivity(draft);
      });
      this.startAI(roomCode, room.config?.mode === 'quick_computer');
      return this.projectRoom(await this.requireRoom(roomCode), identity);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private async mutateRoom(
    identity: SocketIdentity,
    expectedRoomRevision: number,
    action: Parameters<RoomPolicy['assertAllowed']>[2],
    mutation: (room: RoomRecord) => void,
  ): Promise<void> {
    try {
      await this.repository.mutate(identity.roomCode, expectedRoomRevision, (room) => {
        assertIdentityRoom(identity, room);
        this.policy.assertAllowed(room, identity.actorId, action);
        mutation(room);
        this.touchActivity(room);
      });
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private mapError(error: unknown): Error {
    if (error instanceof RoomServiceError) return error;
    if (error instanceof RoomRevisionConflictError) {
      return this.error('ROOM_REVISION_CONFLICT', 'room.error.revision_conflict', {
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      });
    }
    if (error instanceof RoomConfigValidationError) {
      return this.error(error.errorCode, 'room.error.invalid_config', undefined, error.issues);
    }
    if (error instanceof RoomPolicyError) {
      return this.error(error.code, error.failure.messageKey, error.params);
    }
    if (error instanceof GameStartError) {
      return this.error(error.code as ProtocolErrorCode, 'room.error.game_start_failed');
    }
    if (error instanceof Error && (error as { code?: string }).code) {
      const code = (error as unknown as { code: string }).code as ProtocolErrorCode;
      return this.error(code, `room.error.${code.toLowerCase()}`);
    }
    return this.error('UNKNOWN_ERROR', 'room.error.unknown');
  }

  private createSession(
    room: RoomRecord,
    players: Player[],
    eventStore: EventStore,
    snapshot?: RoomRecord['session'],
  ): GameSession {
    return new GameSession(room.id, players, eventStore, snapshot, {
      ...this.options.session,
      onChanged: async (session) => this.persistSession(room.code, session),
    });
  }

  private async persistSession(
    roomCode: string,
    session: GameSession,
    force = false,
  ): Promise<void> {
    const normalizedRoomCode = roomCode.toUpperCase();
    if (!force && this.fastAutoRooms.has(normalizedRoomCode)) {
      // Fast legacy auto rooms intentionally batch disk writes, but their
      // live monitor still needs every authoritative state transition.
      await this.notifyRoomChange(roomCode, 'status_changed');
      return;
    }
    const snapshot = session.serialize();
    let status: RoomRecord['status'] | undefined;
    await this.repository.mutate(roomCode, (room) => {
      // The coordinator owns the starting transaction. Do not let the initial
      // game.started event advance its CAS before the playing commit.
      if (room.status === 'starting') return;
      room.session = snapshot;
      room.players = session.players;
      room.gameId = snapshot.state.gameId;
      if (snapshot.state.gameState.phase === 'ended') room.status = 'ended';
      this.touchActivity(room);
      status = room.status;
    });
    if (status === 'playing' || status === 'ended') {
      // This callback is also used by AI actions and deadline recovery.  The
      // transport turns it into per-socket projections for the whole room.
      await this.notifyRoomChange(roomCode, 'status_changed');
    }
  }

  private async requireRoom(codeOrId: string): Promise<RoomRecord> {
    const direct = await this.repository.get(codeOrId);
    if (direct) return direct;
    const room = (await this.repository.list()).find((item) => item.id === codeOrId);
    if (!room) throw this.error('ROOM_NOT_FOUND', 'room.error.not_found');
    return room;
  }

  private async uniqueCode(): Promise<string> {
    let candidate = code();
    while (await this.repository.get(candidate)) candidate = code();
    return candidate;
  }

  private startAI(roomCode: string, autoRoom = false): void {
    if (
      this.closed ||
      this.options.autoDrive === false ||
      (!autoRoom && this.options.autoDrive !== true)
    ) return;
    if (this.aiRuns.has(roomCode)) return;
    const fastAuto = autoRoom && this.legacyRoomCodes.has(roomCode.toUpperCase());
    if (fastAuto) this.fastAutoRooms.add(roomCode);
    const run = this.driveAI(roomCode, autoRoom).finally(async () => {
      if (fastAuto) {
        this.fastAutoRooms.delete(roomCode);
        const session = this.sessions.get(roomCode.toUpperCase());
        if (session) await this.persistSession(roomCode, session, true);
      }
      this.aiRuns.delete(roomCode);
    });
    this.aiRuns.set(roomCode, run);
  }

  private async driveAI(roomCode: string, autoRoom: boolean): Promise<void> {
    for (let step = 0; step < 2_000; step += 1) {
      if (this.closed) return;
      const room = await this.requireRoom(roomCode);
      const session = this.sessions.get(room.code);
      if (!session || room.status !== 'playing') return;
      const state = session.serialize().state;
      const actorEntry = state.gameState.allowedActors?.find((entry) =>
        state.players.find(
          (player) => player.id === entry.playerId && (autoRoom || player.isAI),
        ),
      );
      if (!actorEntry) return;
      const actor = state.players.find((player) => player.id === actorEntry.playerId);
      if (!actor?.role) return;
      const projectedPlayers = this.projectAIPlayers(state.players, actor.id, actor.role);
      const visibleEvents = await session.eventsFor({
        kind: 'player',
        playerId: actor.id,
        role: actor.role,
      });
      const provider = await this.providerForRoom(room);
      const promptContext = provider.requiresPromptContext
        ? buildAIRuntimeContext({
            actorId: actor.id,
            role: actor.role,
            phase: state.gameState.phase,
            stage: state.gameState.phase === 'night' ? state.night.stage : state.dayFlow.stage,
            dayNumber: state.gameState.day,
            roundNumber:
              state.gameState.phase === 'voting'
                ? state.dayFlow.voteRound
                : state.gameState.phase === 'night'
                  ? state.gameState.wolfDiscussionRound
                  : state.gameState.dayPhase?.discussionRounds || 1,
            players: projectedPlayers,
            visibleEvents,
            allowedActions: actorEntry.actions,
            voteCandidates: state.dayFlow.voteCandidates,
            guardianLastTarget: state.gameState.guardianLastTarget,
            witchHasHealPotion: state.gameState.witchHasHealPotion,
            witchHasPoisonPotion: state.gameState.witchHasPoisonPotion,
            hunterShotAvailable: actorEntry.actions.includes('hunter_shoot'),
            wolfVoteRound: state.gameState.wolfDiscussionRound,
            lastWordsRound:
              state.gameState.phase === 'lastWords'
                ? 3 - state.dayFlow.lastWordsRemaining
                : undefined,
            lastWordsRoundsRemaining:
              state.gameState.phase === 'lastWords'
                ? state.dayFlow.lastWordsRemaining
                : undefined,
          })
        : undefined;
      const orchestrator = new AIOrchestrator(provider, this.options.session?.now, {
        timeoutMs: this.options.aiTimeoutMs,
      });
      await orchestrator.act(session, {
        roomId: room.id,
        gameId: session.gameId,
        playerId: actor.id,
        role: actor.role,
        phase: state.gameState.phase,
        stage: state.gameState.phase === 'night' ? state.night.stage : state.dayFlow.stage,
        stageRevision: session.stageRevision,
        players: projectedPlayers,
        allowedActions: [...actorEntry.actions],
        allowedCommandTypes: actorEntry.actions.map((action) => this.commandTypeForAction(action)),
        ...(promptContext ? { promptContext } : {}),
      });
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw this.error('UNKNOWN_ERROR', 'room.error.ai_step_limit');
  }

  private projectAIPlayers(players: readonly Player[], actorId: string, role: Role): Player[] {
    return players.map((player) => ({
      ...player,
      role:
        player.id === actorId || (role === 'wolf' && player.role === 'wolf')
          ? player.role
          : null,
      aiConfig: undefined,
    }));
  }

  private commandTypeForAction(action: GameAction): GameCommand['type'] {
    switch (action) {
      case 'guard':
      case 'check':
      case 'heal':
      case 'poison':
        return 'game.night_action';
      case 'wolf_speak': return 'game.wolf_speak';
      case 'wolf_vote': return 'game.wolf_vote';
      case 'skip_night': return 'game.skip_night';
      case 'speak': return 'game.speak';
      case 'skip_speech': return 'game.skip_speech';
      case 'vote':
      case 'abstain': return 'game.vote';
      case 'hunter_shoot':
      case 'skip_hunter_shot': return 'game.hunter_shoot';
      default: return 'game.speak';
    }
  }
}
