import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { DomainEvent, EventStore, ViewerContext } from '../../shared/events';
import type {
  CommandReceipt,
  CreateRoomOptionsV31,
  GameCommand,
  GameCommandMeta,
  RoomMutationCommand,
  RoomListPage,
  RoomListQuery,
  EventHistoryPage,
  EventHistoryQuery,
  ProtocolErrorCode,
  RoomConfigIssue,
  RoomConfigView,
  RoomSnapshotReason,
  RoomSummary,
  RoomView,
} from '../../shared/protocol';
import {
  ROOM_LIST_DEFAULT_LIMIT,
  ROOM_LIST_MAX_LIMIT,
} from '../../shared/protocol';
import { SERVER_AI_DEFAULTS, type ServerAIConfig, type ServerAIProviderSettings } from '../ai/config';
import { loadAIConfig } from '../config';
import type {
  RoomAIConfig,
  RoomAIConfigPatch,
  RoomAIConfigSummary,
  RoomAIProviderConfig,
} from '../../shared/roomContract';
import {
  endpointMatchesCapability,
  getAIProviderCapability,
} from '../../shared/aiProviderCapabilities';
import type { Player } from '../../shared/types';
import { defaultAITelemetry, type AITelemetry } from '../ai/aiTelemetry';
import {
  AI_SPEECH_DELAY_MAX_MS,
  AI_SPEECH_DELAY_MIN_MS,
} from '../ai/aiTurnScheduler';
import { defaultAILogger, type AILogger } from '../ai/types';
import { DeterministicAIProvider } from '../ai/deterministicProvider';
import { HttpAIProvider } from '../ai/httpProvider';
import type { AIProvider } from '../ai/types';
import type { HttpAIProviderOptions } from '../ai/httpProvider';
import type { InsightStore } from '../review/insightStore';
import { GameSession } from '../session/gameSession';
import type { SessionOptions } from '../session/types';
import type { ReviewPipeline } from '../review/reviewPipeline';
import { RoomCatalogService, defaultRoomCatalogService } from './roomCatalogService';
import { RoomConfigValidationError } from './roomConfigValidator';
import { GameStartCoordinator, GameStartError } from './gameStartCoordinator';
import { nextSeatIndex } from './seatAllocator';
import { RoomPolicy, RoomPolicyError, roomCounts } from './roomPolicy';
import { RoomProjector, assertIdentityRoom } from './roomProjector';
import { ConnectionRegistry } from './connectionRegistry';
import {
  RoomLifecycleService,
  type RoomMutationResult,
  type RoomTombstone,
} from './roomLifecycleService';
import type { LifecycleOutbox } from './lifecycleOutbox';
import type { RoomRepository } from './repository';
import { SessionCoordinator } from './sessionCoordinator';
import { RoomRevisionConflictError } from './repository';
import type { RuntimeEnvironment } from '../runtimeConfig';
import {
  EndpointPolicy,
  EndpointPolicyError,
} from '../security/endpointPolicy';
import {
  InMemoryCredentialStore,
  CredentialSchemaAmbiguousError,
  canonicalCredentialValues,
  resolveBearerCredential,
  type RoomCredentialStore,
  type RoomCredentialValues,
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

const encodeRoomListCursor = (roomCode: string): string =>
  Buffer.from(roomCode, 'utf8').toString('base64url');

const decodeRoomListCursor = (cursor: string | undefined): string | null => {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8').toUpperCase();
    return decoded || null;
  } catch {
    return null;
  }
};

interface RoomAIConfigCommandOutcome {
  summary: RoomAIConfigSummary | null;
  roomRevision: number;
}
interface RoomAISecretMutation {
  kind: 'created' | 'rotated' | 'emptied';
  credentialRef: string;
  previous: RoomCredentialValues;
}

/**
 * Keep old in-process callers readable without putting the retired fields on
 * the wire. JSON/object-key projections expose only hasCredential.
 */
const withLegacyCredentialAliases = (
  summary: RoomAIConfigSummary,
  hasApiKey: boolean,
  hasToken: boolean,
): RoomAIConfigSummary => {
  Object.defineProperties(summary, {
    hasApiKey: { configurable: true, enumerable: false, value: hasApiKey },
    hasToken: { configurable: true, enumerable: false, value: hasToken },
  });
  return summary;
};

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
    const {
      apiKey: _apiKey,
      token: _token,
      bearerCredential: _bearerCredential,
      ...providerConfig
    } = options.aiConfig;
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
  receipt?: CommandReceipt;
  retryAfterMs?: number;
}

/** Errors crossing the socket boundary have stable, UI-safe fields. */
export class RoomServiceError extends Error {
  readonly code: ProtocolErrorCode;
  readonly messageKey: string;
  readonly params?: Record<string, string | number>;
  readonly issues?: RoomConfigIssue[];
  readonly receipt?: CommandReceipt;
  readonly retryAfterMs?: number;

  constructor(options: RoomServiceErrorOptions) {
    super(options.code);
    this.name = 'RoomServiceError';
    this.code = options.code;
    this.messageKey = options.messageKey;
    this.params = options.params;
    this.issues = options.issues;
    this.receipt = options.receipt;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface RoomServiceOptions {
  session?: Omit<SessionOptions, 'onChanged'>;
  aiProvider?: AIProvider;
  aiTimeoutMs?: number;
  /** Delay bounds for AI speech turns; test environments default to zero. */
  aiSpeechDelayMinMs?: number;
  aiSpeechDelayMaxMs?: number;
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
  startupGraceMs?: number;
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
  /** Production composition root supplies the provider implementation. */
  aiProviderFactory?: (
    config: ServerAIConfig,
    options: HttpAIProviderOptions,
  ) => AIProvider;
  /** Optional test/composition override for the deployment AI settings. */
  serverAIConfig?: ServerAIConfig;
  reviewPipeline?: ReviewPipeline;
  insightStore?: InsightStore;
  aiTelemetry?: AITelemetry;
  aiLogger?: AILogger;
  connectionRegistry?: ConnectionRegistry;
  lifecycleService?: RoomLifecycleService;
  lifecycleOutbox?: LifecycleOutbox;
}

export class RoomService {
  private readonly sessions = new Map<string, GameSession>();
  private readonly roomAIProviders = new Map<string, AIProvider>();
  private readonly roomChangeListeners = new Set<
    (roomCode: string, reason: RoomSnapshotReason) => void | Promise<void>
  >();
  private readonly roomDissolvedListeners = new Set<
    (roomCode: string, roomId: string, causeCommandId?: string) => void | Promise<void>
  >();
  readonly connectionRegistry: ConnectionRegistry;
  private readonly lifecycle: RoomLifecycleService;
  private readonly connectionLeases = new Map<string, Set<string>>();
  private readonly aiProvider?: AIProvider;
  private readonly aiTelemetry: AITelemetry;
  private readonly aiLogger: AILogger;
  private readonly coordinator: SessionCoordinator;
  private readonly catalog: RoomCatalogService;
  private readonly policy: RoomPolicy;
  private readonly projector: RoomProjector;
  private readonly starter: GameStartCoordinator;
  private readonly credentialStore: RoomCredentialStore;
  private readonly credentialNamespace: string;
  private readonly endpointPolicy: EndpointPolicy;
  private readonly aiProviderFactory: NonNullable<RoomServiceOptions['aiProviderFactory']>;
  private readonly serverAIConfig: ServerAIConfig;
  private readonly reviewPipeline?: ReviewPipeline;
  private readonly insightStore?: InsightStore;
  private closed = false;
  private readonly environment: RuntimeEnvironment;
  private readonly deploymentNamespace: string;
  private readonly waitingRoomTtlMs: number;
  private readonly endedRoomTtlMs: number;
  private readonly roomSweepIntervalMs: number;
  private readonly startupGraceMs: number;
  private startupGraceUntil = 0;
  private readonly now: () => number;
  private readonly sweepLogger?: RoomServiceOptions['sweepLogger'];
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly repository: RoomRepository,
    private readonly eventStore: EventStore,
    private readonly options: RoomServiceOptions = {},
  ) {
    const repositoryScope = repository as RoomRepository & {
      environment?: RuntimeEnvironment;
      deploymentNamespace?: string;
    };
    this.environment =
      options.environment ?? repositoryScope.environment ?? 'development';
    if (this.environment === 'production' && !options.credentialStore) {
      throw new Error('production RoomService requires an injected encrypted RoomCredentialStore');
    }
    if (this.environment === 'production' && !options.aiProvider && !options.aiProviderFactory) {
      throw new Error('AI_PROVIDER_REQUIRED');
    }
    if (this.environment === 'production' && options.aiProvider?.mode === 'test-deterministic') {
      throw new Error('AI_PROVIDER_REQUIRED');
    }
    this.aiProvider = options.aiProvider ?? (
      this.environment === 'production'
        ? undefined
        : new DeterministicAIProvider({
            mode: this.environment === 'test' ? 'test-deterministic' : 'rules-degraded',
          })
    );
    this.aiTelemetry = options.aiTelemetry ?? defaultAITelemetry;
    this.aiLogger = options.aiLogger ?? defaultAILogger;
    this.deploymentNamespace =
      options.deploymentNamespace ?? repositoryScope.deploymentNamespace ?? 'default';
    this.waitingRoomTtlMs = options.waitingRoomTtlMs ?? 30 * 60 * 1000;
    this.endedRoomTtlMs = options.endedRoomTtlMs ?? 24 * 60 * 60 * 1000;
    this.roomSweepIntervalMs = options.roomSweepIntervalMs ?? 60 * 1000;
    this.startupGraceMs = options.startupGraceMs ?? 5_000;
    this.now = options.clock ?? Date.now;
    this.sweepLogger = options.sweepLogger;
    this.reviewPipeline = options.reviewPipeline;
    this.insightStore = options.insightStore;
    this.coordinator = new SessionCoordinator({
      getRoom: async (roomCode) => this.repository.get(roomCode),
      getSession: (roomCode) => this.sessions.get(roomCode.toUpperCase()),
      providerForRoom: (room) => this.providerForRoom(room),
      insightStore: this.insightStore,
      timeoutMs: options.aiTimeoutMs,
      now: options.session?.now,
      telemetry: this.aiTelemetry,
      logger: this.aiLogger,
      aiSpeechDelayMinMs: options.aiSpeechDelayMinMs ??
        (this.environment === 'test' ? 0 : AI_SPEECH_DELAY_MIN_MS),
      aiSpeechDelayMaxMs: options.aiSpeechDelayMaxMs ??
        (this.environment === 'test' ? 0 : AI_SPEECH_DELAY_MAX_MS),
    });
    this.connectionRegistry = options.connectionRegistry ?? new ConnectionRegistry();
    for (const fact of repository.takeLegacyConnectionFacts?.() ?? []) {
      for (const memberId of fact.memberIds) {
        this.connectionRegistry.markServiceConnected(fact.roomCode, memberId);
      }
    }
    this.catalog = options.catalog ?? defaultRoomCatalogService;
    this.policy = options.policy ?? new RoomPolicy({
      registry: this.catalog.registry,
      isConnected: (roomCode, memberId) => this.connectionRegistry.isConnected(roomCode, memberId),
    });
    this.projector =
      options.projector ??
      new RoomProjector({
        policy: this.policy,
        registry: this.catalog.registry,
        isConnected: (roomCode, memberId) => this.connectionRegistry.isConnected(roomCode, memberId),
      });
    this.credentialStore = options.credentialStore ?? new InMemoryCredentialStore();
    this.credentialNamespace = options.credentialNamespace ?? process.env.WW_DEPLOYMENT_NAMESPACE ?? 'development';
    this.endpointPolicy = options.endpointPolicy ?? new EndpointPolicy({ environment: this.environment });
    this.aiProviderFactory = options.aiProviderFactory ?? ((config, providerOptions) =>
      new HttpAIProvider(config, providerOptions));
    this.serverAIConfig = structuredClone(options.serverAIConfig ?? loadAIConfig());
    this.lifecycle = options.lifecycleService ?? new RoomLifecycleService(repository, {
      environment: this.environment,
      deploymentNamespace: this.deploymentNamespace,
      credentialNamespace: this.credentialNamespace,
      credentialStore: this.credentialStore,
      outbox: options.lifecycleOutbox,
      clock: this.now,
      onCommitted: async (room, intent) => {
        if (!intent.terminal) return;
        this.connectionRegistry.clearRoom(room.code);
        this.clearConnectionLeases(room.code);
      },
      onCleanup: async (room, intent) => {
        if (!intent.terminal) return;
        const session = this.sessions.get(intent.roomCode.toUpperCase());
        session?.dispose();
        this.sessions.delete(intent.roomCode.toUpperCase());
        this.roomAIProviders.delete(intent.roomCode.toUpperCase());
        void room;
      },
    });
    this.starter =
      options.startCoordinator ??
      new GameStartCoordinator(repository, {
        eventStore,
        evaluateStartCheck: (room) => this.policy.evaluateStartCheck(room),
        sessionOptions: options.session,
        randomIndex: (maxExclusive) => randomInt(maxExclusive),
        onRoomChange: (room, reason) => this.notifyRoomChange(room.code, reason),
        startLeaseMs: options.startLeaseMs,
        sessionFactory: ({ room, players, eventStore, snapshot }) =>
          this.createSession(room, players, eventStore, snapshot),
      });
  }

  async restore(): Promise<number> {
    this.closed = false;
    // A process epoch starts with no live sockets. Persisted `connected` bits
    // are legacy input only and are intentionally not imported.
    this.connectionRegistry.restore();
    this.startupGraceUntil = this.now() + this.startupGraceMs;
    await this.lifecycle.restore();
    await this.sweepExpiredRooms();
    this.startSweepTimer();
    await this.reviewPipeline?.restore();
    const rooms = await this.repository.list();
    if (this.reviewPipeline) {
      // Backfill a missing end job during server recovery. Result-page reads
      // are projections only and must never be the trigger for production
      // review work.
      for (const room of rooms) {
        if (room.status !== 'ended') continue;
        const gameId = room.gameId ?? room.session?.state.gameId;
        if (!gameId || await this.reviewPipeline.get(gameId)) continue;
        await this.reviewPipeline.enqueue({
          gameId,
          roomId: room.id,
          reviewEnabled: Boolean(room.config?.reviewEnabled),
        });
      }
    }
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
      const session = this.createSession(room, room.players, this.eventStore, recoverySnapshot);
      // initialize() reconciles the room cache with the event stream. It also
      // creates the initial event when a durable playing intent was committed
      // just before a process crashed.
      await session.initialize();
      session.restoreScheduling();
      this.sessions.set(room.code, session);
      this.startAI(room.code, room.config?.mode === 'quick_computer');
    }
    return this.sessions.size;
  }

  async create(request: CreateRoomRequest): Promise<RoomAccess> {
    const options = request.options;
    if (
      typeof request.actorId !== 'string' ||
      !request.actorId.trim() ||
      !options ||
      typeof options.catalogVersion !== 'string' ||
      !options.catalogVersion.trim()
    ) {
      throw this.error(
        'UNSUPPORTED_PROTOCOL_VERSION',
        'room.error.unsupported_protocol_version',
      );
    }
    const config = this.normalizeCreateConfig(options);
    // In-process callers may omit the id; socket callers still provide it so
    // retries remain idempotent across the transport boundary.
    const createRequestId = request.createRequestId?.trim() || randomUUID();
    const fingerprint = createFingerprint(options);
    const roomId = randomUUID();
    const roomCode = await this.uniqueCode();
    let candidateCredentialRef: string | undefined;
    const aiConfig = this.createRoomAIConfig(options);
    if (aiConfig) {
      if (!aiConfig) throw this.error('INVALID_ROOM_CONFIG', 'room.error.invalid_ai_config');
      if (!endpointMatchesCapability(aiConfig.provider, aiConfig.endpoint)) {
        throw this.error('AI_ENDPOINT_NOT_ALLOWED', 'room.error.ai_endpoint_not_allowed');
      }
      try {
        await this.endpointPolicy.validate(aiConfig.endpoint, {
          provider: aiConfig.provider,
        });
        const explicitAIConfig = options.aiConfig !== undefined;
        const serverCredential = this.serverCredentialFor(aiConfig.provider);
        const legacyKey = explicitAIConfig ? options.aiConfig?.apiKey?.trim() : undefined;
        const legacyToken = explicitAIConfig ? options.aiConfig?.token?.trim() : undefined;
        const hasCanonicalCredential = explicitAIConfig && options.aiConfig?.bearerCredential !== undefined;
        const hasLegacyCredential = explicitAIConfig && (options.aiConfig?.apiKey !== undefined || options.aiConfig?.token !== undefined);
        const mixedCredentialSchema = hasCanonicalCredential && hasLegacyCredential;
        const legacyAmbiguous = mixedCredentialSchema || Boolean(legacyKey && legacyToken && legacyKey !== legacyToken);
        const credentialValues = !explicitAIConfig
          ? canonicalCredentialValues({ apiKey: serverCredential?.apiKey })
          : mixedCredentialSchema
            ? {
                bearerCredential: options.aiConfig?.bearerCredential?.trim(),
                apiKey: legacyKey,
                token: legacyToken,
              }
            : options.aiConfig?.bearerCredential !== undefined
            ? canonicalCredentialValues({ bearerCredential: options.aiConfig.bearerCredential })
            : legacyAmbiguous
              // Keep the legacy values isolated for offline migration. The room
              // is marked ambiguous and providerForRoom refuses to call out.
              ? { apiKey: legacyKey, token: legacyToken }
              : canonicalCredentialValues({ apiKey: legacyKey, token: legacyToken });
        candidateCredentialRef = await this.credentialStore.put(
          { namespace: this.credentialNamespace, roomCode },
          credentialValues,
        );
        config.credentialRef = candidateCredentialRef;
        if (legacyAmbiguous) config.credentialSchemaAmbiguous = true;
      } catch (error) {
        if (candidateCredentialRef) {
          await this.lifecycle.enqueueOrphanCredentialCleanup(roomCode, roomId, candidateCredentialRef);
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
    const creatorName = options.creator.name.trim();
    const resumeToken = token();
    const host: RoomMember = {
      id: request.actorId,
      name: creatorName,
      // A quick computer room is observed by its creator.  The creator must
      // not consume a human seat or receive a player projection.
      kind: config.mode === 'quick_computer' ? 'spectator' : 'player',
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
          // Human rooms open directly in the preparation phase. The wizard
          // has already collected and validated the configuration, so a
          // second host-only "begin ready check" transition is unnecessary.
          status: 'ready_check',
          auto: config.mode === 'quick_computer',
          debugMode: false,
          config,
          configLocked: true,
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
        await this.lifecycle.enqueueOrphanCredentialCleanup(roomCode, roomId, candidateCredentialRef);
      }
      throw error;
    }
    if (!claim.created && candidateCredentialRef && claim.room.config?.credentialRef !== candidateCredentialRef) {
      await this.lifecycle.enqueueOrphanCredentialCleanup(roomCode, roomId, candidateCredentialRef);
    }

    if (claim.room.config?.mode === 'quick_computer') {
      await this.resumeQuickCreate(claim.room.code, request.actorId, createRequestId);
    }

    const current = await this.requireRoom(claim.room.code);
    this.connectionRegistry.markServiceConnected(current.code, request.actorId);
    this.startAI(current.code, current.config?.mode === 'quick_computer');
    return this.createdAccess(current, request.actorId);
  }

  async join(request: JoinRoomRequest): Promise<RoomAccess> {
    const room = await this.requireRoom(request.roomCode);
    const spectator = request.spectator === true;
    if (room.joinToken !== request.joinToken &&
      !(spectator && room.config?.allowPublicSpectators === true)) {
      throw this.error('ROOM_TOKEN_INVALID', 'room.error.invalid_join_token');
    }
    const resumeToken = token();
    try {
      // The revision is part of the join claim. Every status, membership and
      // capacity decision below is made against the same RoomRecord that is
      // persisted, so a start claim cannot race a stale outer pre-check.
      await this.repository.mutate(room.code, room.roomRevision!, (draft) => {
        if (draft.status !== 'waiting' && draft.status !== 'ready_check') {
          throw this.error('GAME_ALREADY_STARTED', 'room.error.game_already_started');
        }
        const config = draft.config;
        if (!config) throw this.error('INVALID_ROOM_CONFIG', 'room.error.config_missing');
        if (draft.members.some((member) => member.id === request.actorId)) {
          throw this.error('IDENTITY_ALREADY_EXISTS', 'room.error.identity_exists');
        }
        if (spectator) {
          if (roomCounts(draft).spectators >= this.catalog.getCatalog().limits.maxSpectators) {
            throw this.error('ROOM_FULL', 'room.error.spectator_limit');
          }
          if (config.allowPublicSpectators !== true && draft.joinToken !== request.joinToken) {
            throw this.error('ROOM_TOKEN_INVALID', 'room.error.invalid_join_token');
          }
        } else {
          const humanCapacity = config.maxPlayers - config.computerSeats;
          if (roomCounts(draft).humanPlayers >= humanCapacity) {
            throw this.error('ROOM_FULL', 'room.error.room_full');
          }
        }
        const member: RoomMember = {
          id: request.actorId,
          name: request.name.trim().slice(0, 32) || '玩家',
          kind: spectator ? 'spectator' : 'player',
          omniscient:
            spectator && request.omniscientToken !== undefined &&
            request.omniscientToken === draft.omniscientToken,
          resumeToken,
          seatIndex: spectator ? null : nextSeatIndex(draft.members, config.maxPlayers),
          isAI: false,
          ready: spectator ? null : false,
          avatarId: request.avatarId ?? '',
        };
        draft.members.push(member);
        if (!spectator) draft.players.push(makePlayer(draft.id, member, draft.hostId));
        this.touchActivity(draft);
      });
    } catch (error) {
      if (error instanceof RoomRevisionConflictError) {
        const latest = await this.repository.get(room.code);
        if (latest && latest.status !== 'waiting' && latest.status !== 'ready_check') {
          throw this.error('GAME_ALREADY_STARTED', 'room.error.game_already_started');
        }
      }
      throw this.mapError(error);
    }
    const current = await this.requireRoom(room.code);
    this.connectionRegistry.markServiceConnected(current.code, request.actorId);
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
      room.lastSeenAt = this.now();
      this.touchActivity(room);
    });
    if (!accepted) throw this.error('UNAUTHENTICATED', 'room.error.unauthenticated');
    const room = await this.requireRoom(roomCode);
    this.connectionRegistry.markServiceConnected(room.code, actorId);
    return { room: this.projectRoom(room, actorId), credentials: { resumeToken } };
  }

  /** Bind one physical socket to a logical member lease. */
  async bindConnection(identity: SocketIdentity, connectionId: string): Promise<void> {
    const room = await this.requireRoom(identity.roomCode);
    const member = assertIdentityRoom(identity, room);
    const key = `${room.code.toUpperCase()}:${member.id}`;
    const leases = this.connectionLeases.get(key) ?? new Set<string>();
    leases.add(connectionId);
    this.connectionLeases.set(key, leases);
    this.connectionRegistry.bind(room.code, member.id, connectionId);
  }

  async identity(roomCode: string, actorId: string, resumeToken: string): Promise<SocketIdentity> {
    const room = await this.requireRoom(roomCode);
    const member = room.members.find(
      (item) => item.id === actorId && item.resumeToken === resumeToken,
    );
    if (!member) throw this.error('UNAUTHENTICATED', 'room.error.unauthenticated');
    // Direct service callers have no transport bind step. Socket transport
    // replaces this synthetic lease with its physical socket immediately.
    this.connectionRegistry.markServiceConnected(room.code, actorId);
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
    this.connectionRegistry.unbind(identity.roomCode, identity.actorId, connectionId);
    const leases = this.connectionLeases.get(key);
    if (connectionId && leases) {
      leases.delete(connectionId);
      if (leases.size === 0) this.connectionLeases.delete(key);
    } else if (!connectionId) {
      this.connectionLeases.delete(key);
    }
    if (connectionId && this.connectionRegistry.isConnected(identity.roomCode, identity.actorId)) return;
    await this.repository.mutate(identity.roomCode, (room) => {
      const member = assertIdentityRoom(identity, room);
      void member;
      room.lastSeenAt = this.now();
      this.touchActivity(room);
    });
  }

  subscribeRoomDissolved(
    listener: (roomCode: string, roomId: string, causeCommandId?: string) => void | Promise<void>,
  ): () => void {
    this.roomDissolvedListeners.add(listener);
    return () => this.roomDissolvedListeners.delete(listener);
  }

  /** Query the durable receipt before a client retries an unknown command. */
  async commandReceipt(
    identity: SocketIdentity,
    commandId: string,
  ): Promise<CommandReceipt | undefined> {
    if (!commandId.trim()) throw this.error('INVALID_COMMAND', 'room.error.invalid_command');
    const room = await this.repository.get(identity.roomCode);
    if (room) {
      assertIdentityRoom(identity, room);
      const stored = (room.commandReceipts ?? []).find(
        (receipt) => receipt.commandId === commandId,
      );
      if (stored && stored.actorId !== identity.actorId) {
        throw this.error('IDENTITY_MISMATCH', 'room.error.identity_mismatch');
      }
      return stored;
    }
    const tombstone = this.lifecycle.getTombstone(identity.roomCode);
    const receipt = this.lifecycle.getReceipt(identity.roomCode, commandId);
    if (
      tombstone &&
      tombstone.roomId === identity.roomId &&
      tombstone.authSummary.actorIds.includes(identity.actorId) &&
      tombstone.authSummary.resumeTokenDigests.includes(this.resumeTokenDigest(identity.resumeToken))
    ) return receipt;
    throw this.error('ROOM_NOT_FOUND', 'room.error.not_found');
  }

  /**
   * Single room-mutation seam used by socket transport. Every implementation
   * records its receipt in the same repository mutation as the room fact.
   */
  async runRoomMutation(
    identity: SocketIdentity,
    commandId: string,
    expectedRoomRevision: number,
    command: RoomMutationCommand,
  ): Promise<RoomMutationResult> {
    const previous = await this.commandReceipt(identity, commandId).catch((error) => {
      if (error instanceof RoomServiceError && error.code === 'ROOM_NOT_FOUND') return undefined;
      throw error;
    });
    if (previous) {
      if (previous.status === 'rejected') {
        throw this.error(
          previous.errorCode ?? 'ACTION_NOT_ALLOWED',
          previous.messageKey ?? 'room.error.action_not_allowed',
          undefined,
          undefined,
          previous,
        );
      }
      const current = await this.repository.get(identity.roomCode);
      return {
        receipt: previous,
        ...(current ? { room: this.projectRoom(current, identity.actorId) } : {}),
      };
    }

    try {
      switch (command.type) {
        case 'room.update_config':
          return { room: await this.updateConfig(identity, command.payload.config, expectedRoomRevision, commandId), receipt: await this.requireReceipt(identity.roomCode, commandId) };
        case 'room.update_ai_config': {
          const outcome = await this.updateAIConfig(identity, command.payload.patch, expectedRoomRevision, commandId);
          return {
            room: await this.get(identity.roomCode, identity.actorId),
            summary: outcome.summary as unknown as Record<string, unknown> | null,
            roomRevision: outcome.roomRevision,
            receipt: await this.requireReceipt(identity.roomCode, commandId),
          };
        }
        case 'room.begin_ready_check':
          return { room: await this.beginReadyCheck(identity, expectedRoomRevision, commandId), receipt: await this.requireReceipt(identity.roomCode, commandId) };
        case 'room.cancel_ready_check':
          return { room: await this.cancelReadyCheck(identity, expectedRoomRevision, commandId), receipt: await this.requireReceipt(identity.roomCode, commandId) };
        case 'room.ready':
          return { room: await this.setReady(identity, command.payload.ready, expectedRoomRevision, commandId), receipt: await this.requireReceipt(identity.roomCode, commandId) };
        case 'room.start_game':
          return { room: await this.startGame(identity, { commandId, expectedRoomRevision }), receipt: await this.requireReceipt(identity.roomCode, commandId) };
        case 'room.transfer_host':
          return { room: await this.transferHost(identity, command.payload.targetMemberId, expectedRoomRevision, commandId), receipt: await this.requireReceipt(identity.roomCode, commandId) };
        case 'room.leave': {
          const room = await this.leave(identity, expectedRoomRevision, commandId);
          return { ...(room ? { room } : {}), receipt: await this.requireReceipt(identity.roomCode, commandId) };
        }
        case 'room.dissolve': {
          const tombstone = await this.dissolve(identity, command.payload.confirm, expectedRoomRevision, commandId);
          return { tombstone, receipt: await this.requireReceipt(identity.roomCode, commandId) };
        }
      }
    } catch (error) {
      const mapped = this.mapError(error) as RoomServiceError;
      const receipt = await this.recordRejectedReceipt(identity, commandId, command.type, mapped).catch(() => undefined);
      if (receipt) {
        throw new RoomServiceError({
          code: mapped.code,
          messageKey: mapped.messageKey,
          params: mapped.params,
          issues: mapped.issues,
          receipt,
        });
      }
      throw mapped;
    }
  }

  async publishRoomClosed(tombstone: RoomTombstone): Promise<void> {
    await Promise.allSettled(
      [...this.roomDissolvedListeners].map((listener) =>
        listener(tombstone.roomCode, tombstone.roomId, tombstone.causeCommandId),
      ),
    );
  }

  async listPublicRooms(): Promise<RoomSummary[]>;
  async listPublicRooms(options: RoomListQuery): Promise<RoomListPage>;
  async listPublicRooms(options?: RoomListQuery): Promise<RoomSummary[] | RoomListPage> {
    const publicRecords = (await this.repository.list())
      .filter((room) => this.isPubliclyVisible(room))
      // createdAt is durable and gives the public catalogue a stable order;
      // modern JS sort is stable, so same-millisecond creations retain the
      // repository's durable order as their deterministic tie-breaker.
      .sort((left, right) => left.createdAt - right.createdAt);
    const rooms = publicRecords.map((room) => {
        const config = room.config;
        const counts = this.policy.counts(room);
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

    if (!options) return rooms;

    const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 0) > 0
      ? Math.min(options.limit!, ROOM_LIST_MAX_LIMIT)
      : ROOM_LIST_DEFAULT_LIMIT;
    const cursor = decodeRoomListCursor(options.cursor);
    const cursorIndex = cursor
      ? rooms.findIndex((room) => room.roomCode === cursor)
      : -1;
    const pageStart = cursorIndex < 0 ? 0 : cursorIndex + 1;
    if (cursor && cursorIndex < 0) {
      return { rooms: [], hasMore: false, nextCursor: null };
    }
    const page = rooms.slice(pageStart, pageStart + limit);
    const hasMore = pageStart + page.length < rooms.length;
    return {
      rooms: page,
      hasMore,
      nextCursor: hasMore ? encodeRoomListCursor(page.at(-1)!.roomCode) : null,
    };
  }

  async listPublicRoomsPage(options: RoomListQuery = {}): Promise<RoomListPage> {
    return this.listPublicRooms(options);
  }

  async list(): Promise<RoomSummary[]> {
    return this.listPublicRooms();
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
      const kind = room.status === 'ended' ? 'ended_retention' : 'waiting_ttl';
      await this.lifecycle.commit(room.code, kind);
      if (await this.repository.get(room.code)) continue;
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

  /** Administrative removal still goes through the same tombstone saga. */
  async adminRemove(roomCode: string): Promise<boolean> {
    const room = await this.repository.get(roomCode);
    if (!room) return false;
    await this.lifecycle.commit(room.code, 'admin_remove');
    return (await this.repository.get(room.code)) === undefined;
  }

  private clearConnectionLeases(roomCode: string): void {
    const prefix = `${roomCode.trim().toUpperCase()}:`;
    for (const key of [...this.connectionLeases.keys()]) {
      if (key.startsWith(prefix)) this.connectionLeases.delete(key);
    }
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
    if (room.environment !== this.environment ||
      room.deploymentNamespace !== this.deploymentNamespace) return false;
    if (now < this.startupGraceUntil) return false;
    const lastActivity = room.lastActivityAt ?? room.updatedAt ?? room.createdAt;
    if (!Number.isFinite(lastActivity)) return false;
    if (room.status === 'waiting' || room.status === 'ready_check') {
      const hasOnlineHuman = room.members.some(
        (member) => member.kind === 'player' && !member.isAI &&
          this.connectionRegistry.isConnected(room.code, member.id),
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
    commandId: string = randomUUID(),
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
      // Saving settings starts a fresh preparation phase. This keeps the
      // legacy "return to settings" path usable without bringing back a
      // separate begin-preparation button.
      room.status = 'ready_check';
      room.configLocked = true;
      room.auto = next.mode === 'quick_computer';
      room.members.forEach((member) => {
        if (member.kind === 'player' && !member.isAI) member.ready = false;
      });
    }, commandId);
    const updated = await this.requireRoom(identity.roomCode);
    if (existing.config?.credentialRef && !updated.config?.credentialRef) {
      await this.lifecycle.enqueueCleanup(existing, 'mode_switch', existing.config.credentialRef);
      this.roomAIProviders.delete(identity.roomCode.toUpperCase());
    }
    return this.get(identity.roomCode, identity.actorId);
  }

  /** Return the host-only, secret-free AI projection for a waiting room. */
  async getAIConfig(identity: SocketIdentity): Promise<RoomAIConfigSummary | null> {
    const room = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, room);
    this.policy.assertAllowed(room, identity.actorId, 'update_ai_config');
    return this.aiConfigSummary(room);
  }

  /** Explicit alias for callers that name the read operation by its DTO. */
  async getAIConfigSummary(identity: SocketIdentity): Promise<RoomAIConfigSummary | null> {
    return this.getAIConfig(identity);
  }

  /**
   * Update AI tuning and credentials through a separate CAS command. Secret
   * store changes happen inside the repository transaction and are restored if
   * persistence fails; the room record only receives non-secret tuning/ref.
   */
  async updateAIConfig(
    identity: SocketIdentity,
    patch: RoomAIConfigPatch,
    expectedRoomRevision: number,
    commandId: string,
  ): Promise<RoomAIConfigCommandOutcome> {
    if (!commandId.trim() || !Number.isSafeInteger(expectedRoomRevision) || expectedRoomRevision < 1) {
      throw this.error('INVALID_COMMAND', 'room.error.invalid_command');
    }

    const current = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, current);
    this.policy.assertAllowed(current, identity.actorId, 'update_ai_config');

    const cached = this.cachedAIConfigOutcome(current, commandId);
    if (cached) return cached;

    const normalizedPatch = this.validateAIConfigPatch(patch);
    const candidateBase = this.mergeRoomAIConfig(current.config?.aiProviderConfig, normalizedPatch);
    if (!candidateBase) {
      throw this.error('INVALID_ROOM_CONFIG', 'room.error.invalid_ai_config', undefined, [{
        path: 'patch',
        messageKey: 'room.error.invalid_ai_config',
        errorCode: 'INVALID_ROOM_CONFIG',
      }]);
    }
    let candidate: RoomAIConfig & { endpointOrigin: string };
    try {
      if (!endpointMatchesCapability(candidateBase.provider, candidateBase.endpoint)) {
        throw this.error('AI_ENDPOINT_NOT_ALLOWED', 'room.error.ai_endpoint_not_allowed');
      }
      const validatedEndpoint = await this.endpointPolicy.validate(candidateBase.endpoint, {
        provider: candidateBase.provider,
      });
      candidate = {
        ...candidateBase,
        endpoint: validatedEndpoint.url,
        endpointOrigin: validatedEndpoint.origin,
      };
    } catch (error) {
      if (error instanceof EndpointPolicyError) {
        throw this.error('AI_ENDPOINT_NOT_ALLOWED', 'room.error.ai_endpoint_not_allowed', undefined, [{
          path: 'patch.endpoint',
          messageKey: 'room.error.ai_endpoint_not_allowed',
          errorCode: error.code,
        }]);
      }
      throw this.error('SECRET_STORE_UNAVAILABLE', 'room.error.secret_store_unavailable');
    }

    let secretMutation: RoomAISecretMutation | undefined;
    let cleanupRef: string | undefined;
    let outcome: RoomAIConfigCommandOutcome | undefined;
    let committedReceipt: CommandReceipt | undefined;
    try {
      const result = await this.repository.mutate<
        { kind: 'cached'; outcome: RoomAIConfigCommandOutcome } |
        { kind: 'applied'; outcome: RoomAIConfigCommandOutcome; cleanupRef?: string }
      >(identity.roomCode, expectedRoomRevision, async (draft) => {
        assertIdentityRoom(identity, draft);
        this.policy.assertAllowed(draft, identity.actorId, 'update_ai_config');
        const repeated = this.cachedAIConfigOutcome(draft, commandId);
        if (repeated) return { kind: 'cached', outcome: repeated };

        const previousConfig = draft.config?.aiProviderConfig;
        const previousRef = draft.config?.credentialRef;
        const previousValues = previousRef
          ? await this.credentialStore.get(
            { namespace: this.credentialNamespace, roomCode: draft.code },
            previousRef,
          )
          : undefined;
        if (previousRef && previousValues === undefined) {
          throw this.error('SECRET_STORE_UNAVAILABLE', 'room.error.secret_store_unavailable');
        }

        const hasCanonicalPatch = normalizedPatch.credential !== undefined || normalizedPatch.clearCredential === true;
        const hasLegacyPatch = normalizedPatch.apiKey !== undefined || normalizedPatch.token !== undefined ||
          normalizedPatch.clearApiKey === true || normalizedPatch.clearToken === true;
        if (hasCanonicalPatch && hasLegacyPatch) {
          throw this.error('CREDENTIAL_SCHEMA_AMBIGUOUS', 'room.error.ai_credential_schema_ambiguous');
        }
        if (hasCanonicalPatch) resolveBearerCredential(previousValues);
        const legacyAgainstCanonical = Boolean(
          hasLegacyPatch && previousValues?.bearerCredential &&
          !(normalizedPatch.apiKey !== undefined && normalizedPatch.token !== undefined) &&
          !(normalizedPatch.clearApiKey === true && normalizedPatch.clearToken === true),
        );
        if (hasLegacyPatch && previousValues?.bearerCredential && !legacyAgainstCanonical) {
          throw this.error('CREDENTIAL_SCHEMA_AMBIGUOUS', 'room.error.ai_credential_schema_ambiguous');
        }
        const effectiveCanonicalPatch = hasCanonicalPatch || legacyAgainstCanonical;
        const nextValues: RoomCredentialValues = effectiveCanonicalPatch
          ? normalizedPatch.clearCredential
            ? {}
            : legacyAgainstCanonical
              ? normalizedPatch.clearApiKey || normalizedPatch.clearToken
                ? {}
                : { bearerCredential: normalizedPatch.apiKey ?? normalizedPatch.token }
              : { bearerCredential: normalizedPatch.credential }
          : { ...(previousValues ?? {}) };
        const setApiKey = normalizedPatch.apiKey;
        const setToken = normalizedPatch.token;
        if (!effectiveCanonicalPatch) {
          if (normalizedPatch.clearApiKey) delete nextValues.apiKey;
          else if (setApiKey) nextValues.apiKey = setApiKey;
          if (normalizedPatch.clearToken) delete nextValues.token;
          else if (setToken) nextValues.token = setToken;
        }

        const secretsChanged =
          JSON.stringify(nextValues) !== JSON.stringify(previousValues ?? {});
        let nextRef = previousRef;
        if (secretsChanged) {
          const nextCredential = effectiveCanonicalPatch
            ? Boolean(nextValues.bearerCredential)
            : Boolean(nextValues.apiKey || nextValues.token);
          if (nextCredential) {
            if (previousRef) {
              await this.credentialStore.rotate(
                { namespace: this.credentialNamespace, roomCode: draft.code },
                previousRef,
                nextValues,
              );
              secretMutation = {
                kind: 'rotated',
                credentialRef: previousRef,
                previous: previousValues ?? {},
              };
            } else {
              nextRef = await this.credentialStore.put(
                { namespace: this.credentialNamespace, roomCode: draft.code },
                nextValues,
              );
              secretMutation = {
                kind: 'created',
                credentialRef: nextRef,
                previous: {},
              };
            }
          } else if (previousRef) {
            // Keep an empty encrypted record until the room commit succeeds;
            // deleting it after commit makes rollback possible without ever
            // putting the old secret in a room record.
            await this.credentialStore.rotate(
              { namespace: this.credentialNamespace, roomCode: draft.code },
              previousRef,
              {},
            );
            secretMutation = {
              kind: 'emptied',
              credentialRef: previousRef,
              previous: previousValues ?? {},
            };
            cleanupRef = previousRef;
            nextRef = undefined;
          } else {
            nextRef = undefined;
          }
        }

        const nextProviderConfig: RoomAIProviderConfig = {
          provider: candidate.provider,
          model: candidate.model,
          endpoint: candidate.endpoint,
          temperature: candidate.temperature,
          maxTokens: candidate.maxTokens,
          behavior: candidate.behavior,
        };
        const configChanged =
          JSON.stringify(stableValue(previousConfig)) !== JSON.stringify(stableValue(nextProviderConfig)) ||
          previousRef !== nextRef;
        const draftConfig = draft.config;
        if (!draftConfig) {
          throw this.error('INVALID_ROOM_CONFIG', 'room.error.config_missing');
        }
        draft.config = {
          ...draftConfig,
          aiProviderConfig: nextProviderConfig,
          ...(nextRef ? { credentialRef: nextRef } : {}),
        };
        if (!effectiveCanonicalPatch && nextValues.apiKey && nextValues.token && nextValues.apiKey !== nextValues.token) {
          draft.config.credentialSchemaAmbiguous = true;
        } else if (effectiveCanonicalPatch) {
          delete draft.config.credentialSchemaAmbiguous;
          delete draft.config.credentialRotationRequired;
        }
        if (!nextRef) delete draft.config.credentialRef;
        delete draft.config.aiConfig;
        if (configChanged) {
          draft.members.forEach((member) => {
            if (member.kind === 'player' && !member.isAI) member.ready = false;
          });
        }
        const previousActivity = draft.lastActivityAt ?? 0;
        this.touchActivity(draft);
        if ((draft.lastActivityAt ?? 0) <= previousActivity) {
          draft.lastActivityAt = previousActivity + 1;
        }

        const configRevision = (draft.configRevision ?? 1) + (configChanged ? 1 : 0);
        const nextRoomRevision = (draft.roomRevision ?? 1) + 1;
        const summary = withLegacyCredentialAliases({
          provider: candidate.provider,
          model: candidate.model,
          endpointOrigin: candidate.endpointOrigin,
          temperature: candidate.temperature,
          maxTokens: candidate.maxTokens,
          behavior: candidate.behavior,
          capability: getAIProviderCapability(candidate.provider),
          hasCredential: Boolean(nextValues.bearerCredential || nextValues.apiKey || nextValues.token),
          configRevision,
          updatedAt: this.now(),
        } satisfies RoomAIConfigSummary, Boolean(nextValues.apiKey), Boolean(nextValues.token));
        outcome = { summary, roomRevision: nextRoomRevision };
        draft.recentRoomCommands = [
          ...(draft.recentRoomCommands ?? []).filter((entry) => entry.commandId !== commandId),
          {
            commandId,
            roomRevision: nextRoomRevision,
            createdAt: this.now(),
            response: clone(outcome),
          },
        ].slice(-64);
        committedReceipt = this.makeReceipt(
          draft,
          identity,
          commandId,
          'room.update_ai_config',
          'committed',
          nextRoomRevision,
        );
        this.appendCommittedReceipt(draft, committedReceipt);
        return { kind: 'applied', outcome, ...(cleanupRef ? { cleanupRef } : {}) };
      });

      outcome = result.outcome;
      if (committedReceipt) this.lifecycle.rememberReceipt(committedReceipt);
      if (result.kind === 'applied' && result.cleanupRef) {
        const updated = await this.requireRoom(identity.roomCode);
        await this.lifecycle.enqueueCleanup(updated, 'mode_switch', result.cleanupRef);
      }
      this.roomAIProviders.delete(identity.roomCode.toUpperCase());
      return outcome;
    } catch (error) {
      if (secretMutation) {
        const scope = { namespace: this.credentialNamespace, roomCode: identity.roomCode };
        if (secretMutation.kind === 'created') {
          await this.credentialStore.delete(scope, secretMutation.credentialRef).catch(() => undefined);
        } else {
          await this.credentialStore.rotate(
            scope,
            secretMutation.credentialRef,
            secretMutation.previous,
          ).catch(() => undefined);
        }
      }
      if (error instanceof EndpointPolicyError) {
        throw this.error('AI_ENDPOINT_NOT_ALLOWED', 'room.error.ai_endpoint_not_allowed', undefined, [{
          path: 'patch.endpoint',
          messageKey: 'room.error.ai_endpoint_not_allowed',
          errorCode: error.code,
        }]);
      }
      if (error instanceof RoomRevisionConflictError) throw this.mapError(error);
      if (error instanceof RoomServiceError) throw error;
      if (error instanceof CredentialSchemaAmbiguousError) {
        throw this.error('CREDENTIAL_SCHEMA_AMBIGUOUS', 'room.error.ai_credential_schema_ambiguous');
      }
      if (error && typeof error === 'object' && String((error as { code?: unknown }).code ?? '').startsWith('CREDENTIAL_')) {
        throw this.error('SECRET_STORE_UNAVAILABLE', 'room.error.secret_store_unavailable');
      }
      throw this.mapError(error);
    }
  }

  async beginReadyCheck(
    identity: SocketIdentity,
    expectedRoomRevision: number,
    commandId: string = randomUUID(),
  ): Promise<RoomView> {
    await this.mutateRoom(identity, expectedRoomRevision, 'begin_ready_check', (room) => {
      room.status = 'ready_check';
      room.configLocked = true;
      room.members.forEach((member) => {
        if (member.kind === 'player' && !member.isAI) member.ready = false;
      });
    }, commandId);
    return this.get(identity.roomCode, identity.actorId);
  }

  async cancelReadyCheck(
    identity: SocketIdentity,
    expectedRoomRevision: number,
    commandId: string = randomUUID(),
  ): Promise<RoomView> {
    await this.mutateRoom(identity, expectedRoomRevision, 'cancel_ready_check', (room) => {
      room.status = 'waiting';
      room.configLocked = false;
      room.members.forEach((member) => {
        if (member.kind === 'player' && !member.isAI) member.ready = false;
      });
    }, commandId);
    return this.get(identity.roomCode, identity.actorId);
  }

  async setReady(
    identity: SocketIdentity,
    ready: boolean,
    expectedRoomRevision: number,
    commandId: string = randomUUID(),
  ): Promise<RoomView> {
    await this.mutateRoom(identity, expectedRoomRevision, 'set_ready', (room) => {
      const member = room.members.find((item) => item.id === identity.actorId);
      if (!member || member.kind !== 'player' || member.isAI) {
        throw this.error('ACTION_NOT_ALLOWED', 'room.error.ready_not_allowed');
      }
      member.ready = ready;
    }, commandId);
    return this.get(identity.roomCode, identity.actorId);
  }

  async startGame(
    identity: SocketIdentity,
    command: { commandId: string; expectedRoomRevision: number },
  ): Promise<RoomView> {
    assertIdentityRoom(identity, await this.requireRoom(identity.roomCode));
    return this.startWithRevision(
      identity.roomCode,
      identity.actorId,
      command.commandId,
      command.expectedRoomRevision,
    );
  }

  async leave(
    identity: SocketIdentity,
    expectedRoomRevision: number,
    commandId: string = randomUUID(),
  ): Promise<RoomView | undefined> {
    const room = await this.requireRoom(identity.roomCode);
    this.policy.assertAllowed(room, identity.actorId, 'leave');
    let committedReceipt: CommandReceipt | undefined;
    let committedTombstone: RoomTombstone | undefined;
    try {
      await this.repository.mutate(identity.roomCode, expectedRoomRevision, (draft) => {
        assertIdentityRoom(identity, draft);
        this.policy.assertAllowed(draft, identity.actorId, 'leave');
        draft.members = draft.members.filter((member) => member.id !== identity.actorId);
        draft.players = draft.players.filter((player) => player.id !== identity.actorId);
        if (draft.hostId === identity.actorId) {
          const nextHost = draft.members.find(
            (member) => member.kind === 'player' && !member.isAI,
          );
          if (nextHost) draft.hostId = nextHost.id;
        }
        this.touchActivity(draft);
        committedReceipt = this.makeReceipt(draft, identity, commandId, 'room.leave', 'committed', draft.roomRevision! + 1);
        this.appendCommittedReceipt(draft, committedReceipt);
        committedTombstone = this.makeTombstone(draft, commandId, 'last_member_left', identity.actorId, identity.resumeToken);
      });
      if (committedReceipt) this.lifecycle.rememberReceipt(committedReceipt);
    } catch (error) {
      const mapped = this.mapError(error) as RoomServiceError;
      const receipt = await this.recordRejectedReceipt(identity, commandId, 'room.leave', mapped).catch(() => undefined);
      if (receipt) throw new RoomServiceError({ code: mapped.code, messageKey: mapped.messageKey, params: mapped.params, issues: mapped.issues, receipt });
      throw mapped;
    }
    const current = await this.repository.get(identity.roomCode).catch(() => undefined);
    if (!current || current.members.length === 0) {
      if (committedTombstone) this.lifecycle.rememberTombstone(committedTombstone);
      if (current) await this.lifecycle.commit(current.code, 'last_member_leave');
      return undefined;
    }
    return this.projectRoom(current, current.hostId);
  }

  async transferHost(
    identity: SocketIdentity,
    targetMemberId: string,
    expectedRoomRevision: number,
    commandId: string = randomUUID(),
  ): Promise<RoomView> {
    await this.mutateRoom(identity, expectedRoomRevision, 'transfer_host', (room) => {
      const target = room.members.find((member) => member.id === targetMemberId);
      if (!target || target.kind !== 'player' || target.isAI ||
        !this.connectionRegistry.isConnected(identity.roomCode, target.id)) {
        throw this.error('MEMBER_NOT_FOUND', 'room.error.host_target_not_found');
      }
      room.hostId = target.id;
    }, commandId);
    return this.get(identity.roomCode, identity.actorId);
  }

  async dissolve(
    identity: SocketIdentity,
    confirm: boolean,
    expectedRoomRevision: number,
    commandId: string = randomUUID(),
  ): Promise<RoomTombstone> {
    if (!confirm) throw this.error('ACTION_NOT_ALLOWED', 'room.error.dissolve_confirmation_required');
    const room = await this.requireRoom(identity.roomCode);
    this.policy.assertAllowed(room, identity.actorId, 'dissolve');
    let committedReceipt: CommandReceipt | undefined;
    let committedTombstone: RoomTombstone | undefined;
    try {
      await this.repository.mutate(identity.roomCode, expectedRoomRevision, (draft) => {
        assertIdentityRoom(identity, draft);
        this.policy.assertAllowed(draft, identity.actorId, 'dissolve');
        draft.lastStartFailure = undefined;
        draft.status = 'ended';
        draft.closedAt = this.now();
        draft.closeReason = 'dissolved';
        this.touchActivity(draft);
        committedReceipt = this.makeReceipt(draft, identity, commandId, 'room.dissolve', 'committed', draft.roomRevision! + 1);
        this.appendCommittedReceipt(draft, committedReceipt);
        committedTombstone = this.makeTombstone(draft, commandId);
      });
    } catch (error) {
      const mapped = this.mapError(error) as RoomServiceError;
      const receipt = await this.recordRejectedReceipt(identity, commandId, 'room.dissolve', mapped).catch(() => undefined);
      if (receipt) throw new RoomServiceError({ code: mapped.code, messageKey: mapped.messageKey, params: mapped.params, issues: mapped.issues, receipt });
      throw mapped;
    }
    const committedRoom = await this.repository.get(identity.roomCode).catch(() => undefined) ?? room;
    const tombstone = committedTombstone ?? this.makeTombstone(committedRoom, commandId);
    this.lifecycle.rememberTombstone(tombstone);
    if (committedReceipt) this.lifecycle.rememberReceipt(committedReceipt);
    await this.lifecycle.commit(identity.roomCode, 'dissolve');
    return tombstone;
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
    return {
      kind: 'player',
      playerId: identity.actorId,
      role: player.role,
      isAlive: player.isAlive,
    };
  }

  async snapshot(identity: SocketIdentity) {
    const room = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, room);
    const session = this.sessions.get(room.code);
    if (!session) throw this.error('GAME_NOT_STARTED', 'room.error.game_not_started');
    return session.snapshotFor(await this.viewerForIdentity(identity));
  }

  async events(identity: SocketIdentity, afterSequence?: number): Promise<DomainEvent[]>;
  async events(identity: SocketIdentity, query: EventHistoryQuery): Promise<EventHistoryPage>;
  async events(
    identity: SocketIdentity,
    afterOrQuery: number | EventHistoryQuery = 0,
  ): Promise<DomainEvent[] | EventHistoryPage> {
    const room = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, room);
    const session = this.sessions.get(room.code);
    if (!session) throw this.error('GAME_NOT_STARTED', 'room.error.game_not_started');
    const viewer = await this.viewerForIdentity(identity);
    if (typeof afterOrQuery === 'number') return session.eventsFor(viewer, afterOrQuery);
    return session.eventPageFor(viewer, afterOrQuery);
  }

  async eventsPage(
    identity: SocketIdentity,
    query: EventHistoryQuery = {},
  ): Promise<EventHistoryPage> {
    const result = await this.events(identity, query);
    return result as EventHistoryPage;
  }

  async review(identity: SocketIdentity, godView = false) {
    const room = await this.requireRoom(identity.roomCode);
    assertIdentityRoom(identity, room);
    const gameId = room.gameId ?? room.session?.state.gameId;
    if (!gameId) throw this.error('GAME_NOT_STARTED', 'room.error.game_not_started');
    if (!this.reviewPipeline) {
      return {
        gameId,
        roomId: room.id,
        status: 'disabled' as const,
        enabled: false,
        generationMode: room.config?.reviewMode === 'ai' ? 'ai' as const : 'rules' as const,
        operationId: `review:${gameId}:${room.config?.reviewMode === 'ai' ? 'ai' : 'rules'}`,
        timeline: [],
        messages: [],
        insights: [],
        updatedAt: Date.now(),
      };
    }
    const viewer = godView && room.status === 'ended' && identity.kind === 'player'
      ? { kind: 'spectator' as const, spectatorId: identity.actorId, omniscient: true }
      : await this.viewerForIdentity(identity);
    const review = await this.reviewPipeline.view(gameId, viewer);
    return review ?? {
      gameId,
      roomId: room.id,
      status: 'pending' as const,
      enabled: Boolean(room.config?.reviewEnabled),
      generationMode: room.config?.reviewMode === 'ai' ? 'ai' as const : 'rules' as const,
      operationId: `review:${gameId}:${room.config?.reviewMode === 'ai' ? 'ai' : 'rules'}`,
      timeline: [],
      messages: [],
      insights: [],
      updatedAt: Date.now(),
    };
  }

  async reviewInsights(identity: SocketIdentity) {
    const viewer = await this.viewerForIdentity(identity);
    if (viewer.kind !== 'player' || !this.insightStore) return [];
    return this.insightStore.list(viewer.role);
  }

  async clearReviewInsights(identity: SocketIdentity, role?: import('../../shared/types').Role): Promise<void> {
    const viewer = await this.viewerForIdentity(identity);
    if (viewer.kind !== 'player') {
      throw this.error('SPECTATOR_READ_ONLY', 'room.error.spectator_read_only');
    }
    if (role && role !== viewer.role) {
      throw this.error('SPECTATOR_READ_ONLY', 'room.error.spectator_read_only');
    }
    if (this.reviewPipeline) {
      await this.reviewPipeline.clearInsights(viewer, role);
    } else {
      await this.insightStore?.clear(viewer.role);
    }
  }

  async getRecord(roomCode: string): Promise<RoomRecord | undefined> {
    const room = await this.repository.get(roomCode);
    if (room) {
      // Keep the old diagnostic API useful without making this derived fact
      // serializable by any repository adapter.
      for (const member of room.members) {
        Object.defineProperty(member, 'connected', {
          configurable: true,
          enumerable: true,
          value: this.connectionRegistry.isConnected(room.code, member.id),
        });
      }
    }
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
    await this.coordinator.close();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const session of this.sessions.values()) session.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    this.roomAIProviders.clear();
    this.connectionRegistry.clear();
    this.connectionLeases.clear();
    this.roomChangeListeners.clear();
  }

  private normalizeCreateConfig(options: CreateRoomOptionsV31): RoomConfigRecord {
    const result = this.catalog.validator.validate(options);
    if (result.ok === false) throw this.validationError(result);
    const config = clone(result.config as RoomConfigRecord);
    const aiProviderConfig = this.createRoomAIConfig(options);
    if (options.aiConfig !== undefined && !aiProviderConfig) {
      throw this.error('INVALID_ROOM_CONFIG', 'room.error.invalid_ai_config');
    }
    if (aiProviderConfig) {
      const {
        apiKey: _apiKey,
        token: _token,
        bearerCredential: _bearerCredential,
        ...nonSecretConfig
      } = aiProviderConfig;
      config.aiProviderConfig = nonSecretConfig as RoomAIProviderConfig;
    }
    return config;
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
        delete room.startRosterRevision;
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
      ...(typeof raw.bearerCredential === 'string'
        ? { bearerCredential: raw.bearerCredential.trim().slice(0, 4_096) }
        : {}),
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

  private createRoomAIConfig(options: CreateRoomOptionsV31): RoomAIConfig | undefined {
    if (options.aiConfig !== undefined) return this.normalizeRoomAIConfig(options.aiConfig);
    if (options.mode === 'human' || !this.hasConfiguredServerAI()) return undefined;
    const provider = this.serverAIConfig.apiType;
    const settings = this.serverSettingsFor(provider);
    const endpoint = provider === 'local'
      ? settings.apiUrl
      : getAIProviderCapability(provider).defaultEndpoint;
    if (!settings.model || !endpoint) return undefined;
    return {
      provider,
      model: settings.model,
      endpoint,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      behavior: this.serverAIConfig.defaultBehavior,
    };
  }

  private hasConfiguredServerAI(): boolean {
    const configuredByEnvironment = Boolean(process.env.WW_API_URL?.trim());
    if (configuredByEnvironment) return true;
    if (this.serverAIConfig.apiType !== SERVER_AI_DEFAULTS.apiType) return true;
    const settings = this.serverSettingsFor('local');
    return settings.apiUrl !== SERVER_AI_DEFAULTS.local.apiUrl ||
      settings.model !== SERVER_AI_DEFAULTS.local.model ||
      Boolean(settings.apiKey.trim());
  }

  private serverSettingsFor(provider: ServerAIConfig['apiType']): ServerAIProviderSettings {
    return provider === 'siliconflow'
      ? this.serverAIConfig.siliconflow
      : provider === 'deepseek'
        ? this.serverAIConfig.deepseek
        : this.serverAIConfig.local;
  }

  private serverCredentialFor(provider: RoomAIConfig['provider']): ServerAIProviderSettings | undefined {
    if (provider === 'custom') return undefined;
    return this.serverSettingsFor(provider);
  }

  private validateAIConfigPatch(value: RoomAIConfigPatch): RoomAIConfigPatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw this.error('INVALID_ROOM_CONFIG', 'room.error.invalid_ai_config');
    }
    const patch = value as Record<string, unknown>;
    const issues: RoomConfigIssue[] = [];
    const normalized: RoomAIConfigPatch = {};
    const providers: RoomAIConfig['provider'][] = ['siliconflow', 'deepseek', 'local', 'custom'];
    const behaviors: RoomAIConfig['behavior'][] = ['aggressive', 'conservative', 'random'];

    if (patch.provider !== undefined) {
      if (!providers.includes(patch.provider as RoomAIConfig['provider'])) {
        issues.push({ path: 'provider', messageKey: 'room.error.invalid_ai_provider', errorCode: 'INVALID_ROOM_CONFIG' });
      } else normalized.provider = patch.provider as RoomAIConfig['provider'];
    }
    if (patch.behavior !== undefined) {
      if (!behaviors.includes(patch.behavior as RoomAIConfig['behavior'])) {
        issues.push({ path: 'behavior', messageKey: 'room.error.invalid_ai_behavior', errorCode: 'INVALID_ROOM_CONFIG' });
      } else normalized.behavior = patch.behavior as RoomAIConfig['behavior'];
    }
    if (patch.model !== undefined) {
      if (typeof patch.model !== 'string' || !patch.model.trim() || patch.model.trim().length > 160) {
        issues.push({ path: 'model', messageKey: 'room.error.invalid_ai_model', errorCode: 'INVALID_ROOM_CONFIG' });
      } else normalized.model = patch.model.trim();
    }
    if (patch.endpoint !== undefined) {
      if (typeof patch.endpoint !== 'string' || !patch.endpoint.trim() || patch.endpoint.trim().length > 500) {
        issues.push({ path: 'endpoint', messageKey: 'room.error.invalid_ai_endpoint', errorCode: 'INVALID_ROOM_CONFIG' });
      } else normalized.endpoint = patch.endpoint.trim();
    }
    if (patch.temperature !== undefined) {
      if (typeof patch.temperature !== 'number' || !Number.isFinite(patch.temperature) || patch.temperature < 0 || patch.temperature > 2) {
        issues.push({ path: 'temperature', messageKey: 'room.error.invalid_ai_temperature', errorCode: 'INVALID_ROOM_CONFIG' });
      } else normalized.temperature = patch.temperature;
    }
    if (patch.maxTokens !== undefined) {
      if (typeof patch.maxTokens !== 'number' || !Number.isSafeInteger(patch.maxTokens) || patch.maxTokens < 128 || patch.maxTokens > 4096) {
        issues.push({ path: 'maxTokens', messageKey: 'room.error.invalid_ai_max_tokens', errorCode: 'INVALID_ROOM_CONFIG' });
      } else normalized.maxTokens = patch.maxTokens;
    }

    if (patch.credential !== undefined || patch.clearCredential !== undefined) {
      if (patch.clearCredential !== undefined && typeof patch.clearCredential !== 'boolean') {
        issues.push({ path: 'clearCredential', messageKey: 'room.error.invalid_ai_credential', errorCode: 'INVALID_ROOM_CONFIG' });
      }
      const credential = typeof patch.credential === 'string' ? patch.credential.trim() : undefined;
      if (patch.credential !== undefined &&
        (typeof patch.credential !== 'string' || credential === '******' || credential!.length > 4_096)) {
        issues.push({ path: 'credential', messageKey: 'room.error.invalid_ai_credential', errorCode: 'INVALID_ROOM_CONFIG' });
      }
      if (credential && patch.clearCredential === true) {
        issues.push({ path: 'credential', messageKey: 'room.error.ai_credential_set_and_clear', errorCode: 'INVALID_ROOM_CONFIG' });
      } else if (credential) normalized.credential = credential;
      if (patch.clearCredential === true) normalized.clearCredential = true;
      if (patch.apiKey !== undefined || patch.token !== undefined ||
        patch.clearApiKey !== undefined || patch.clearToken !== undefined) {
        issues.push({ path: 'credential', messageKey: 'room.error.ai_credential_schema_ambiguous', errorCode: 'CREDENTIAL_SCHEMA_AMBIGUOUS' });
      }
    }

    const secretField = (
      key: 'apiKey' | 'token',
      clearKey: 'clearApiKey' | 'clearToken',
    ): void => {
      const raw = patch[key];
      const clear = patch[clearKey];
      if (clear !== undefined && typeof clear !== 'boolean') {
        issues.push({ path: clearKey, messageKey: 'room.error.invalid_ai_credential', errorCode: 'INVALID_ROOM_CONFIG' });
      }
      const text = typeof raw === 'string' ? raw.trim() : undefined;
      if (text && (text === '******' || text.length > 4_096)) {
        issues.push({ path: key, messageKey: 'room.error.invalid_ai_credential', errorCode: 'INVALID_ROOM_CONFIG' });
      }
      if (text && clear === true) {
        issues.push({ path: key, messageKey: 'room.error.ai_credential_set_and_clear', errorCode: 'INVALID_ROOM_CONFIG' });
      } else if (text) {
        normalized[key] = text;
      }
      if (clear === true) normalized[clearKey] = true;
    };
    secretField('apiKey', 'clearApiKey');
    secretField('token', 'clearToken');

    if (issues.length > 0) {
      throw this.error('INVALID_ROOM_CONFIG', 'room.error.invalid_ai_config', undefined, issues);
    }
    return normalized;
  }

  private mergeRoomAIConfig(
    existing: RoomAIProviderConfig | undefined,
    patch: RoomAIConfigPatch,
  ): RoomAIConfig | undefined {
    const hasMeaningfulCreateField = [
      patch.provider,
      patch.model,
      patch.endpoint,
      patch.temperature,
      patch.maxTokens,
      patch.behavior,
      patch.credential,
      patch.apiKey,
      patch.token,
    ].some((value) => value !== undefined);
    if (!existing && !hasMeaningfulCreateField) return undefined;
    const provider = patch.provider ?? existing?.provider ?? this.serverAIConfig.apiType;
    const serverDefaults = provider === this.serverAIConfig.apiType
      ? this.serverSettingsFor(provider)
      : undefined;
    const defaults = serverDefaults ?? (provider === 'siliconflow'
      ? SERVER_AI_DEFAULTS.siliconflow
      : provider === 'deepseek'
        ? SERVER_AI_DEFAULTS.deepseek
        : SERVER_AI_DEFAULTS.local);
    const model = patch.model ?? existing?.model ?? defaults.model;
    const capability = getAIProviderCapability(provider);
    const providerChanged = patch.provider !== undefined && patch.provider !== existing?.provider;
    const endpoint = patch.endpoint ??
      (providerChanged
        ? (serverDefaults?.apiUrl ?? capability.defaultEndpoint)
        : existing?.endpoint ?? serverDefaults?.apiUrl ?? capability.defaultEndpoint);
    if (!model || !endpoint) return undefined;
    return {
      provider,
      model,
      endpoint,
      temperature: patch.temperature ?? existing?.temperature ?? defaults.temperature,
      maxTokens: patch.maxTokens ?? existing?.maxTokens ?? defaults.maxTokens,
      behavior: patch.behavior ?? existing?.behavior ?? SERVER_AI_DEFAULTS.defaultBehavior,
      ...(patch.credential ? { bearerCredential: patch.credential } : {}),
      ...(patch.apiKey ? { apiKey: patch.apiKey } : {}),
      ...(patch.token ? { token: patch.token } : {}),
    };
  }

  private cachedAIConfigOutcome(
    room: RoomRecord,
    commandId: string,
  ): RoomAIConfigCommandOutcome | undefined {
    const entry = (room.recentRoomCommands ?? []).find((item) => item.commandId === commandId);
    const value = entry?.response ?? entry?.result;
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<RoomAIConfigCommandOutcome>;
    if (!Number.isSafeInteger(candidate.roomRevision)) return undefined;
    if (candidate.summary !== null && (!candidate.summary || typeof candidate.summary !== 'object')) return undefined;
    return clone(candidate as RoomAIConfigCommandOutcome);
  }

  private async aiConfigSummary(room: RoomRecord): Promise<RoomAIConfigSummary | null> {
    const config = room.config?.aiProviderConfig;
    if (!config) return null;
    let endpoint;
    try {
      endpoint = await this.endpointPolicy.validate(config.endpoint, { provider: config.provider });
    } catch (error) {
      if (error instanceof EndpointPolicyError) {
        throw this.error('AI_ENDPOINT_NOT_ALLOWED', 'room.error.ai_endpoint_not_allowed', undefined, [{
          path: 'endpoint',
          messageKey: 'room.error.ai_endpoint_not_allowed',
          errorCode: error.code,
        }]);
      }
      throw error;
    }
    let values: RoomCredentialValues | undefined;
    try {
      values = room.config?.credentialRef
        ? await this.credentialStore.get(
          { namespace: this.credentialNamespace, roomCode: room.code },
          room.config.credentialRef,
        )
        : undefined;
    } catch {
      throw this.error('SECRET_STORE_UNAVAILABLE', 'room.error.secret_store_unavailable');
    }
    if (room.config?.credentialRef && values === undefined) {
      throw this.error('SECRET_STORE_UNAVAILABLE', 'room.error.secret_store_unavailable');
    }
    const hasApiKey = Boolean(values?.apiKey);
    const hasToken = Boolean(values?.token);
    const hasCredential = Boolean(values?.bearerCredential || values?.apiKey || values?.token);
    return withLegacyCredentialAliases({
      provider: config.provider,
      model: config.model,
      endpointOrigin: endpoint.origin,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      behavior: config.behavior,
      capability: getAIProviderCapability(config.provider),
      hasCredential,
      ...(room.config?.credentialRotationRequired
        ? { credentialRotationRequired: true }
        : {}),
      configRevision: room.configRevision ?? 1,
      updatedAt: room.updatedAt ?? room.createdAt,
    }, hasApiKey, hasToken);
  }

  private async providerForRoom(room: RoomRecord): Promise<AIProvider> {
    const roomConfig = room.config?.aiProviderConfig;
    if (room.config?.credentialSchemaAmbiguous || room.config?.credentialRotationRequired) {
      throw this.error('CREDENTIAL_SCHEMA_AMBIGUOUS', 'room.error.ai_credential_schema_ambiguous');
    }
    if (!roomConfig) {
      if (!this.aiProvider) throw this.error('AI_PROVIDER_REQUIRED', 'room.error.ai_provider_required');
      return this.aiProvider;
    }
    const roomKey = room.code.toUpperCase();
    const existing = this.roomAIProviders.get(roomKey);
    if (existing) return existing;

    const providerConfig = structuredClone(SERVER_AI_DEFAULTS) as ServerAIConfig;
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
    try {
      selected.apiKey = resolveBearerCredential(values) ?? '';
    } catch (error) {
      if (error instanceof CredentialSchemaAmbiguousError) {
        throw this.error('CREDENTIAL_SCHEMA_AMBIGUOUS', 'room.error.ai_credential_schema_ambiguous');
      }
      throw error;
    }
    selected.temperature = roomConfig.temperature;
    selected.maxTokens = roomConfig.maxTokens;
    if (providerConfig.apiType === 'local') providerConfig.local.apiUrl = roomConfig.endpoint;
    const provider = this.aiProviderFactory(providerConfig, {
      timeoutMs: this.options.aiTimeoutMs,
      endpointPolicy: this.endpointPolicy,
      endpoint: roomConfig.endpoint,
      logger: this.aiLogger,
    });
    const endpoint = new URL(roomConfig.endpoint);
    console.info(`[server:ai] provider=${roomConfig.provider} endpoint=${endpoint.origin}${endpoint.pathname} model=${roomConfig.model}`);
    this.roomAIProviders.set(roomKey, provider);
    return provider;
  }

  private projectRoom(room: RoomRecord, actor: string | SocketIdentity): RoomView {
    const view = this.projector.project(room, actor);
    const providerMode = room.config?.aiProviderConfig
      ? 'real_ai' as const
      : this.aiProvider?.mode;
    const projected = providerMode
      ? { ...view, computerPlayerMode: providerMode }
      : view;
    return projected;
  }

  private validationError(result: Extract<ReturnType<RoomCatalogService['validateConfig']>, { ok: false }>): RoomServiceError {
    return this.error(result.errorCode, 'room.error.invalid_config', undefined, result.issues);
  }

  private error(
    code: ProtocolErrorCode,
    messageKey: string,
    params?: Record<string, string | number>,
    issues?: RoomConfigIssue[],
    receipt?: CommandReceipt,
  ): RoomServiceError {
    return new RoomServiceError({ code, messageKey, params, issues, receipt });
  }

  private makeReceipt(
    room: RoomRecord,
    identity: SocketIdentity,
    commandId: string,
    commandType: string,
    status: CommandReceipt['status'],
    revision: number,
    error?: RoomServiceError,
  ): CommandReceipt {
    return {
      schemaVersion: 1,
      environment: this.environment,
      deploymentNamespace: this.deploymentNamespace,
      revision,
      commandId,
      commandType,
      actorId: identity.actorId,
      roomId: room.id,
      roomCode: room.code,
      status,
      createdAt: this.now(),
      roomRevision: status === 'committed' ? revision : room.roomRevision,
      ...(error ? { errorCode: error.code, messageKey: error.messageKey } : {}),
    };
  }

  private appendCommittedReceipt(room: RoomRecord, receipt: CommandReceipt): void {
    room.commandReceipts = [
      ...(room.commandReceipts ?? []).filter((item) => item.commandId !== receipt.commandId),
      receipt,
    ].slice(-128);
  }

  private async recordRejectedReceipt(
    identity: SocketIdentity,
    commandId: string,
    commandType: string,
    error: RoomServiceError,
  ): Promise<CommandReceipt | undefined> {
    const room = await this.repository.get(identity.roomCode);
    if (!room) return this.lifecycle.getReceipt(identity.roomCode, commandId);
    const existing = room.commandReceipts?.find((item) => item.commandId === commandId);
    if (existing) {
      this.lifecycle.rememberReceipt(existing);
      return existing;
    }
    const receipt = this.makeReceipt(
      room,
      identity,
      commandId,
      commandType,
      'rejected',
      room.roomRevision ?? 1,
      error,
    );
    await this.repository.mutate(room.code, (draft) => {
      const repeated = draft.commandReceipts?.find((item) => item.commandId === commandId);
      if (!repeated) this.appendCommittedReceipt(draft, receipt);
    });
    const committed = await this.repository.get(room.code);
    const stored = committed?.commandReceipts?.find((item) => item.commandId === commandId) ?? receipt;
    this.lifecycle.rememberReceipt(stored);
    return stored;
  }

  private async requireReceipt(roomCode: string, commandId: string): Promise<CommandReceipt> {
    const receipt = this.lifecycle.getReceipt(roomCode, commandId) ??
      (await this.repository.get(roomCode))?.commandReceipts?.find((item) => item.commandId === commandId);
    if (!receipt) throw this.error('UNKNOWN_ERROR', 'room.error.receipt_unavailable');
    this.lifecycle.rememberReceipt(receipt);
    return receipt;
  }

  private makeTombstone(
    room: RoomRecord,
    causeCommandId?: string,
    reason: RoomTombstone['reason'] = 'dissolved',
    actorId?: string,
    actorResumeToken?: string,
  ): RoomTombstone {
    const actorIds = room.members.map((member) => member.id);
    if (actorId && !actorIds.includes(actorId)) actorIds.push(actorId);
    const resumeTokenDigests = room.members
      .map((member) => this.resumeTokenDigest(member.resumeToken))
      .filter(Boolean);
    if (actorResumeToken) resumeTokenDigests.push(this.resumeTokenDigest(actorResumeToken));
    return {
      schemaVersion: 1,
      environment: this.environment,
      deploymentNamespace: this.deploymentNamespace,
      revision: (room.roomRevision ?? 1) + 1,
      roomCode: room.code,
      roomId: room.id,
      reason,
      closedAt: room.closedAt ?? this.now(),
      retainedUntil: (room.closedAt ?? this.now()) + 30 * 24 * 60 * 60 * 1000,
      ...(causeCommandId ? { causeCommandId } : {}),
      authSummary: {
        actorIds,
        memberCount: room.members.length,
        resumeTokenDigests: [...new Set(resumeTokenDigests)],
      },
    };
  }

  private resumeTokenDigest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
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
      if (
        this.environment === 'production' &&
        room.config?.mode !== 'human' &&
        room.config?.aiFillPolicy !== 'none' &&
        ((room.config?.computerSeats ?? 0) > 0 || room.config?.aiFillPolicy === 'fill_to_max') &&
        !room.config?.aiProviderConfig &&
        !this.aiProvider
      ) {
        throw this.error('AI_PROVIDER_REQUIRED', 'room.error.ai_provider_required');
      }
      const result = await this.starter.start(roomCode, {
        commandId,
        actorId,
        expectedRoomRevision,
      });
      if (result.session instanceof GameSession) this.sessions.set(roomCode.toUpperCase(), result.session);
      let committedReceipt: CommandReceipt | undefined;
      await this.repository.mutate(roomCode, (draft) => {
        this.touchActivity(draft);
        const identity = draft.members.find((member) => member.id === actorId);
        if (identity) {
          committedReceipt = this.makeReceipt(
            draft,
            {
              actorId,
              roomCode: draft.code,
              roomId: draft.id,
              kind: identity.kind,
              omniscient: Boolean(identity.omniscient),
              resumeToken: identity.resumeToken,
            },
            commandId,
            'room.start_game',
            'committed',
            (draft.roomRevision ?? 1) + 1,
          );
          this.appendCommittedReceipt(draft, committedReceipt);
        }
      });
      if (committedReceipt) this.lifecycle.rememberReceipt(committedReceipt);
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
    commandId: string = randomUUID(),
  ): Promise<void> {
    let committedReceipt: CommandReceipt | undefined;
    try {
      await this.repository.mutate(identity.roomCode, expectedRoomRevision, (room) => {
        assertIdentityRoom(identity, room);
        this.policy.assertAllowed(room, identity.actorId, action);
        mutation(room);
        this.touchActivity(room);
        committedReceipt = this.makeReceipt(
          room,
          identity,
          commandId,
          `room.${action}`,
          'committed',
          (room.roomRevision ?? 1) + 1,
        );
        this.appendCommittedReceipt(room, committedReceipt);
      });
      if (committedReceipt) this.lifecycle.rememberReceipt(committedReceipt);
    } catch (error) {
      const mapped = this.mapError(error) as RoomServiceError;
      const receipt = await this.recordRejectedReceipt(identity, commandId, `room.${action}`, mapped).catch(() => undefined);
      if (receipt) {
        throw new RoomServiceError({
          code: mapped.code,
          messageKey: mapped.messageKey,
          params: mapped.params,
          issues: mapped.issues,
          receipt,
        });
      }
      throw mapped;
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
      ...(room.config?.mode === 'quick_computer'
        ? { keepTimersRefed: true }
        : {}),
      onChanged: async (session) => this.persistSession(room.code, session),
    });
  }

  private async persistSession(
    roomCode: string,
    session: GameSession,
  ): Promise<void> {
    const snapshot = session.serialize();
    let status: RoomRecord['status'] | undefined;
    let endedGameId: string | undefined;
    let endedReviewEnabled = false;
    let endedReviewMode: 'ai' | 'rules' = 'rules';
    let autoRoom = false;
    await this.repository.mutate(roomCode, (room) => {
      // The coordinator owns the starting transaction. Do not let the initial
      // game.started event advance its CAS before the playing commit.
      if (room.status === 'starting') return;
      const persistedVersion = room.session?.state.streamVersion ?? 0;
      if (persistedVersion > snapshot.state.streamVersion) return;
      room.session = snapshot;
      room.players = session.players;
      room.gameId = snapshot.state.gameId;
      if (snapshot.state.gameState.phase === 'ended') room.status = 'ended';
      this.touchActivity(room);
      status = room.status;
      autoRoom = room.config?.mode === 'quick_computer';
      if (status === 'ended') {
        endedGameId = snapshot.state.gameId;
        endedReviewEnabled = Boolean(room.config?.reviewEnabled);
        endedReviewMode = room.config?.reviewMode === 'ai' ? 'ai' : 'rules';
      }
    });
    if (status === 'playing' || status === 'ended') {
      // This callback is also used by AI actions and deadline recovery.  The
      // transport turns it into per-socket projections for the whole room.
      await this.notifyRoomChange(roomCode, 'status_changed');
      if (status === 'playing') {
        // Keep the same auto-drive gate for human/mixed rooms after a direct
        // session transition. Quick-computer rooms are explicitly automatic;
        // tests and manual mixed-room callers can still advance a session one
        // command at a time with autoDrive disabled.
        this.startAI(roomCode, autoRoom);
      }
    }
    if (status === 'ended' && endedGameId && this.reviewPipeline) {
      // The session has already appended game.ended and its final state event.
      // The durable gameId makes repeated onChanged callbacks harmless.
      void this.reviewPipeline.enqueue({
        gameId: endedGameId,
        roomId: snapshot.state.roomId,
        reviewEnabled: endedReviewEnabled,
        generationMode: endedReviewMode,
      }).catch(() => undefined);
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
    void this.coordinator.scheduleEligibleAI({ roomCode, autoRoom });
  }
}
