import type { EventStore } from '../../shared/events';
import type { StartCheck } from '../../shared/roomContract';
import type { Player, Role } from '../../shared/types';
import { GameSession } from '../session/gameSession';
import type {
  SessionOptions,
  SessionSnapshot,
} from '../session/types';
import {
  RoomRepositoryError,
  RoomRevisionConflictError,
  type RoomRepository,
} from './repository';
import {
  buildRoleDeck,
  RoleDeckError,
  type SecureRandomIndex,
} from './roleDeckBuilder';
import type {
  AIFillPolicy,
  IdempotencyRecord,
  RoomConfigRecord,
  RoomMember,
  RoomRecord,
} from './types';

export interface StartGameCommand {
  commandId: string;
  actorId: string;
  expectedRoomRevision: number;
}

export type GameStartErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'HOST_REQUIRED'
  | 'SPECTATOR_READ_ONLY'
  | 'ACTION_NOT_ALLOWED'
  | 'GAME_ALREADY_STARTED'
  | 'GAME_START_IN_PROGRESS'
  | 'ROOM_REVISION_CONFLICT'
  | 'START_CHECK_FAILED'
  | 'MIN_PLAYERS_NOT_MET'
  | 'HUMAN_PLAYERS_NOT_READY'
  | 'MEMBER_OFFLINE'
  | 'ROLE_COUNT_MISMATCH'
  | 'RULESET_UNAVAILABLE'
  | 'INVALID_ROLE_SETUP'
  | 'GAME_START_FAILED';

export class GameStartError extends Error {
  readonly name = 'GameStartError';

  constructor(
    public readonly code: GameStartErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The small M3 seam consumed by the start transaction. */
export type StartCheckEvaluator = (
  room: RoomRecord,
) => StartCheck | Promise<StartCheck>;

export interface StartableGameSession {
  readonly gameId: string;
  readonly players: Player[];
  serialize(): SessionSnapshot;
  initialize(): Promise<void>;
  dispose?(): void;
}

export interface GameStartSessionFactoryContext {
  room: RoomRecord;
  players: Player[];
  eventStore: EventStore;
  snapshot?: SessionSnapshot;
  sessionOptions?: Omit<SessionOptions, 'onChanged'>;
}

export type GameStartSessionFactory = (
  context: GameStartSessionFactoryContext,
) => StartableGameSession;

export interface GameStartCoordinatorOptions {
  eventStore: EventStore;
  evaluateStartCheck?: StartCheckEvaluator;
  sessionFactory?: GameStartSessionFactory;
  sessionOptions?: Omit<SessionOptions, 'onChanged'>;
  now?: () => number;
  /** Test seam; production uses crypto.randomInt through roleDeckBuilder. */
  randomIndex?: SecureRandomIndex;
}

export interface GameStartResult {
  room: RoomRecord;
  gameId: string;
  players: Player[];
  session?: StartableGameSession;
  cached?: boolean;
}

interface PersistedStartOutcome {
  roomCode: string;
  roomId: string;
  gameId: string;
  players: Player[];
}

interface ClaimedStart {
  kind: 'claimed';
  addedAIIds: string[];
}

interface CachedStart {
  kind: 'cached';
  outcome: PersistedStartOutcome;
}

type ClaimResult = ClaimedStart | CachedStart;

interface AIFillPlan {
  desiredComputerSeats: number;
  existingComputerSeats: number;
  humanPlayers: number;
  finalPlayerCount: number;
  seatsToAdd: number;
}

const clone = <T>(value: T): T => structuredClone(value);

const revisionOf = (room: RoomRecord): number =>
  Number.isInteger(room.roomRevision) && room.roomRevision! > 0
    ? room.roomRevision!
    : 1;

const isPlayer = (member: RoomMember): boolean => member.kind === 'player';
const isComputer = (member: RoomMember): boolean =>
  isPlayer(member) && member.isAI === true;
const isHumanPlayer = (member: RoomMember): boolean =>
  isPlayer(member) && member.isAI !== true;

const roleCount = (setup: RoomConfigRecord['roleSetup']): number =>
  Object.values(setup ?? {}).reduce(
    (total, count) => total + (typeof count === 'number' ? count : 0),
    0,
  );

const desiredComputerSeats = (
  config: RoomConfigRecord,
  humanPlayers: number,
): number => {
  switch (config.aiFillPolicy as AIFillPolicy) {
    case 'none':
      return 0;
    case 'fixed':
      return config.computerSeats;
    case 'fill_to_max':
      return config.maxPlayers - humanPlayers;
  }
};

export const calculateAIFillPlan = (room: RoomRecord): AIFillPlan => {
  const config = room.config;
  if (!config) {
    throw new GameStartError(
      'ACTION_NOT_ALLOWED',
      'A normalized room configuration is required before starting.',
    );
  }

  const humanPlayers = room.members.filter(isHumanPlayer).length;
  const existingComputerSeats = room.members.filter(isComputer).length;
  const desired = desiredComputerSeats(config, humanPlayers);
  const finalPlayerCount = humanPlayers + desired;

  if (!Number.isSafeInteger(desired) || desired < 0) {
    throw new GameStartError(
      'ACTION_NOT_ALLOWED',
      'The room computer-seat policy is invalid.',
      { desiredComputerSeats: desired },
    );
  }
  if (existingComputerSeats > desired) {
    throw new GameStartError(
      'ACTION_NOT_ALLOWED',
      'The room already contains more computer seats than its configuration allows.',
      { existingComputerSeats, desiredComputerSeats: desired },
    );
  }
  if (finalPlayerCount !== config.maxPlayers) {
    throw new GameStartError(
      'MIN_PLAYERS_NOT_MET',
      'The final player seats do not fill the configured board.',
      { expected: config.maxPlayers, actual: finalPlayerCount },
    );
  }

  return {
    desiredComputerSeats: desired,
    existingComputerSeats,
    humanPlayers,
    finalPlayerCount,
    seatsToAdd: desired - existingComputerSeats,
  };
};

const defaultStartCheck = (room: RoomRecord): StartCheck => {
  const config = room.config;
  const humans = room.members.filter(isHumanPlayer);
  const setupTotal = config ? roleCount(config.roleSetup) : 0;
  let aiFillPassed = false;
  try {
    calculateAIFillPlan(room);
    aiFillPassed = true;
  } catch {
    aiFillPassed = false;
  }

  const items: StartCheck['items'] = [
    {
      key: 'config_valid',
      passed: config !== undefined,
      messageKey: config
        ? 'room.start.config_ready'
        : 'room.start.config_missing',
    },
    {
      key: 'role_count',
      passed: config !== undefined && setupTotal === config.maxPlayers,
      messageKey:
        config !== undefined && setupTotal === config.maxPlayers
          ? 'room.start.role_count_ready'
          : 'room.start.role_count_invalid',
      ...(config
        ? { params: { expected: config.maxPlayers, actual: setupTotal } }
        : {}),
    },
    {
      key: 'minimum_humans',
      passed: config !== undefined && humans.length >= config.minHumanPlayers,
      messageKey:
        config !== undefined && humans.length >= config.minHumanPlayers
          ? 'room.start.minimum_humans_ready'
          : 'room.start.minimum_humans_missing',
      ...(config ? { params: { minimum: config.minHumanPlayers } } : {}),
      affectedMemberIds: humans.length >= (config?.minHumanPlayers ?? Infinity)
        ? undefined
        : humans.map((member) => member.id),
    },
    {
      key: 'all_humans_online',
      passed: humans.every((member) => member.connected),
      messageKey: humans.every((member) => member.connected)
        ? 'room.start.players_online'
        : 'room.start.player_offline',
      affectedMemberIds: humans
        .filter((member) => !member.connected)
        .map((member) => member.id),
    },
    {
      key: 'all_humans_ready',
      passed: humans.length > 0 && humans.every((member) => member.ready === true),
      messageKey:
        humans.length > 0 && humans.every((member) => member.ready === true)
          ? 'room.start.players_ready'
          : 'room.start.player_not_ready',
      affectedMemberIds: humans
        .filter((member) => member.ready !== true)
        .map((member) => member.id),
    },
    {
      key: 'ai_fill',
      passed: aiFillPassed,
      messageKey: aiFillPassed
        ? 'room.start.ai_ready'
        : 'room.start.ai_seats_invalid',
    },
    {
      key: 'ruleset_available',
      passed: config?.rulesetAvailable !== false,
      messageKey:
        config?.rulesetAvailable !== false
          ? 'room.start.ruleset_ready'
          : 'room.start.ruleset_unavailable',
    },
  ];
  return { passed: items.every((item) => item.passed), items };
};

const firstFailedCode = (check: StartCheck): GameStartErrorCode => {
  const failed = check.items.find((item) => !item.passed);
  switch (failed?.key) {
    case 'minimum_humans':
      return 'MIN_PLAYERS_NOT_MET';
    case 'all_humans_online':
      return 'MEMBER_OFFLINE';
    case 'all_humans_ready':
      return 'HUMAN_PLAYERS_NOT_READY';
    case 'role_count':
      return 'ROLE_COUNT_MISMATCH';
    case 'ruleset_available':
      return 'RULESET_UNAVAILABLE';
    default:
      return 'START_CHECK_FAILED';
  }
};

const outcomeFromEntry = (
  entry: IdempotencyRecord | undefined,
): PersistedStartOutcome | undefined => {
  const value = entry?.result ?? entry?.response;
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<PersistedStartOutcome>;
  if (
    typeof candidate.roomCode !== 'string' ||
    typeof candidate.roomId !== 'string' ||
    typeof candidate.gameId !== 'string' ||
    !Array.isArray(candidate.players)
  ) {
    return undefined;
  }
  return clone(candidate as PersistedStartOutcome);
};

const cachedOutcome = (
  room: RoomRecord,
  commandId: string,
): PersistedStartOutcome | undefined =>
  outcomeFromEntry(
    (room.recentRoomCommands ?? []).find(
      (entry) => entry.commandId === commandId,
    ),
  );

const createAIId = (room: RoomRecord, seatIndex: number): string =>
  `ai:${room.id}:${seatIndex}`;

const createAIName = (seatIndex: number): string =>
  `电脑 ${String(seatIndex + 1).padStart(2, '0')}`;

const nextSeatIndex = (members: readonly RoomMember[]): number => {
  const used = new Set(
    members
      .filter(isPlayer)
      .map((member) => member.seatIndex)
      .filter(
        (seat): seat is number =>
          typeof seat === 'number' && Number.isInteger(seat) && seat >= 0,
      ),
  );
  let seat = 0;
  while (used.has(seat)) seat += 1;
  return seat;
};

const waitingPlayerFor = (
  room: RoomRecord,
  member: RoomMember,
  existing: Player | undefined,
): Player => ({
  ...(existing?.aiConfig ? { aiConfig: clone(existing.aiConfig) } : {}),
  id: member.id,
  roomId: room.id,
  name: member.name,
  isAI: member.isAI === true,
  role: null,
  isAlive: true,
  isHost: member.id === room.hostId,
  order: (member.seatIndex ?? 0) + 1,
  isReady: member.isAI === true ? true : member.ready === true,
});

const playersFromMembers = (room: RoomRecord): Player[] => {
  const members = room.members
    .filter(isPlayer)
    .sort((left, right) => (left.seatIndex ?? 0) - (right.seatIndex ?? 0));
  const occupied = new Set<number>();
  const existing = new Map((room.players ?? []).map((player) => [player.id, player]));
  return members.map((member) => {
    if (
      !Number.isInteger(member.seatIndex) ||
      member.seatIndex! < 0 ||
      occupied.has(member.seatIndex!)
    ) {
      throw new GameStartError(
        'ACTION_NOT_ALLOWED',
        'Every player must have one unique seat before starting.',
        { memberId: member.id, seatIndex: member.seatIndex },
      );
    }
    occupied.add(member.seatIndex!);
    return waitingPlayerFor(room, member, existing.get(member.id));
  });
};

const addComputerMembers = (
  room: RoomRecord,
  plan: AIFillPlan,
): string[] => {
  const addedIds: string[] = [];
  for (let index = 0; index < plan.seatsToAdd; index += 1) {
    const seatIndex = nextSeatIndex(room.members);
    const id = createAIId(room, seatIndex);
    if (room.members.some((member) => member.id === id)) {
      throw new GameStartError(
        'GAME_START_FAILED',
        'Could not allocate a unique computer identity.',
        { seatIndex },
      );
    }
    room.members.push({
      id,
      name: createAIName(seatIndex),
      kind: 'player',
      connected: true,
      omniscient: false,
      resumeToken: '',
      seatIndex,
      isAI: true,
      ready: null,
      avatarId: 'avatar-ai',
    });
    addedIds.push(id);
  }
  return addedIds;
};

const asGameStartError = (error: unknown): GameStartError => {
  if (error instanceof GameStartError) return error;
  if (error instanceof RoleDeckError) {
    return new GameStartError(error.code, error.message, error.details);
  }
  if (error instanceof RoomRevisionConflictError) {
    return new GameStartError(
      'ROOM_REVISION_CONFLICT',
      'The room changed while the game was starting.',
      {
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      },
    );
  }
  if (error instanceof RoomRepositoryError) {
    return new GameStartError(
      error.code === 'ROOM_NOT_FOUND' ? 'ROOM_NOT_FOUND' : 'GAME_START_FAILED',
      error.message,
    );
  }
  return new GameStartError('GAME_START_FAILED', 'The game could not be started.');
};

const defaultSessionFactory: GameStartSessionFactory = ({
  room,
  players,
  eventStore,
  snapshot,
  sessionOptions,
}) =>
  new GameSession(room.id, players, eventStore, snapshot, sessionOptions ?? {});

/**
 * Owns only the start transaction. Room policy, projection and transport stay
 * outside this class and are supplied through the M3/M5 seams.
 *
 * FINDINGS P0 #2 / protocol-state-machine review: the ready_check → starting
 * claim and the starting → playing commit both use repository CAS; no caller
 * can revive the old get → mutate → save race for a start command.
 */
export class GameStartCoordinator {
  private readonly now: () => number;
  private readonly sessionFactory: GameStartSessionFactory;
  private readonly inFlight = new Map<string, Promise<GameStartResult>>();
  private readonly sessions = new Map<string, StartableGameSession>();

  constructor(
    private readonly repository: RoomRepository,
    private readonly options: GameStartCoordinatorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
  }

  start(roomCode: string, command: StartGameCommand): Promise<GameStartResult> {
    const key = `${roomCode.toUpperCase()}:${command.commandId}`;
    const active = this.inFlight.get(key);
    if (active) return active;

    const operation = this.startOnce(roomCode, command).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  session(roomCode: string): StartableGameSession | undefined {
    return this.sessions.get(roomCode.toUpperCase());
  }

  private async startOnce(
    roomCode: string,
    command: StartGameCommand,
  ): Promise<GameStartResult> {
    if (
      typeof command.commandId !== 'string' ||
      command.commandId.trim().length === 0 ||
      !Number.isSafeInteger(command.expectedRoomRevision) ||
      command.expectedRoomRevision < 1
    ) {
      throw new GameStartError(
        'ACTION_NOT_ALLOWED',
        'A valid command id and room revision are required.',
      );
    }
    const current = await this.repository.get(roomCode);
    if (!current) {
      throw new GameStartError('ROOM_NOT_FOUND', 'Room does not exist.');
    }

    const cached = cachedOutcome(current, command.commandId);
    if (cached) return this.restoreCachedResult(current, cached);

    if (current.status === 'starting') {
      throw new GameStartError('GAME_START_IN_PROGRESS', 'The game is starting.');
    }
    if (current.status === 'playing' || current.status === 'ended') {
      throw new GameStartError('GAME_ALREADY_STARTED', 'The game has already started.');
    }
    if (current.status !== 'ready_check') {
      throw new GameStartError(
        'ACTION_NOT_ALLOWED',
        'The room must be in ready check before starting.',
      );
    }

    let claim: ClaimResult;
    try {
      claim = await this.repository.mutate<ClaimResult>(
        roomCode,
        command.expectedRoomRevision,
        async (room) => {
          const repeated = cachedOutcome(room, command.commandId);
          if (repeated) return { kind: 'cached', outcome: repeated };

          this.assertStartActor(room, command.actorId);
          if (room.status !== 'ready_check') {
            throw new GameStartError(
              room.status === 'starting'
                ? 'GAME_START_IN_PROGRESS'
                : room.status === 'playing' || room.status === 'ended'
                  ? 'GAME_ALREADY_STARTED'
                  : 'ACTION_NOT_ALLOWED',
              'The room changed before the start command was applied.',
            );
          }

          const check = this.options.evaluateStartCheck
            ? await this.options.evaluateStartCheck(room)
            : defaultStartCheck(room);
          if (!check.passed) {
            throw new GameStartError(
              firstFailedCode(check),
              'The room is not ready to start.',
              { startCheck: check },
            );
          }

          const plan = calculateAIFillPlan(room);
          const addedAIIds = addComputerMembers(room, plan);
          room.status = 'starting';
          room.configLocked = true;
          delete room.lastStartFailure;
          return { kind: 'claimed', addedAIIds };
        },
      );
    } catch (error) {
      if (error instanceof RoomRevisionConflictError) {
        const latest = await this.repository.get(roomCode);
        if (latest?.status === 'starting' || latest?.status === 'playing') {
          throw new GameStartError(
            'GAME_START_IN_PROGRESS',
            'Another start command already owns this room.',
          );
        }
      }
      throw asGameStartError(error);
    }

    if (claim.kind === 'cached') {
      const room = await this.repository.get(roomCode);
      if (!room) throw new GameStartError('ROOM_NOT_FOUND', 'Room does not exist.');
      return this.restoreCachedResult(room, claim.outcome);
    }

    const startingRoom = await this.repository.get(roomCode);
    if (!startingRoom) {
      throw new GameStartError('ROOM_NOT_FOUND', 'Room disappeared while starting.');
    }

    let session: StartableGameSession | undefined;
    try {
      const players = playersFromMembers(startingRoom);
      if (players.length !== startingRoom.config?.maxPlayers) {
        throw new GameStartError(
          'MIN_PLAYERS_NOT_MET',
          'The final player count does not match the configured board.',
          {
            expected: startingRoom.config?.maxPlayers,
            actual: players.length,
          },
        );
      }
      const roleSetup = startingRoom.config?.roleSetup;
      if (!roleSetup) {
        throw new GameStartError(
          'INVALID_ROLE_SETUP',
          'The room has no persisted role setup.',
        );
      }
      const deck = buildRoleDeck(
        roleSetup,
        players.length,
        this.options.randomIndex,
      );
      const assignedPlayers = players.map((player, index) => ({
        ...player,
        role: deck[index] as Role,
        isReady: true,
      }));
      session = this.sessionFactory({
        room: startingRoom,
        players: assignedPlayers,
        eventStore: this.options.eventStore,
        sessionOptions: this.options.sessionOptions,
      });
      await session.initialize();

      const outcome: PersistedStartOutcome = {
        roomCode: startingRoom.code,
        roomId: startingRoom.id,
        gameId: session.gameId,
        players: clone(assignedPlayers),
      };
      await this.repository.mutate(
        roomCode,
        revisionOf(startingRoom),
        (room) => {
          if (room.status !== 'starting') {
            throw new GameStartError(
              room.status === 'playing'
                ? 'GAME_START_IN_PROGRESS'
                : 'ACTION_NOT_ALLOWED',
              'The room changed before the game was committed.',
            );
          }
          room.status = 'playing';
          room.configLocked = true;
          room.gameId = outcome.gameId;
          room.players = clone(assignedPlayers);
          room.session = clone(session!.serialize());
          room.recentRoomCommands = [
            ...(room.recentRoomCommands ?? []).filter(
              (entry) => entry.commandId !== command.commandId,
            ),
            {
              commandId: command.commandId,
              roomRevision: revisionOf(room) + 1,
              createdAt: this.now(),
              result: clone(outcome),
            },
          ].slice(-64);
        },
      );

      const committed = await this.repository.get(roomCode);
      if (!committed) throw new GameStartError('ROOM_NOT_FOUND', 'Room does not exist.');
      this.sessions.set(committed.code, session);
      return {
        room: committed,
        gameId: outcome.gameId,
        players: clone(assignedPlayers),
        session,
      };
    } catch (error) {
      session?.dispose?.();
      const failure = asGameStartError(error);
      await this.rollback(
        roomCode,
        revisionOf(startingRoom),
        claim.addedAIIds,
        failure,
      );
      throw failure;
    }
  }

  private assertStartActor(room: RoomRecord, actorId: string): void {
    const member = room.members.find((candidate) => candidate.id === actorId);
    if (!member) throw new GameStartError('UNAUTHENTICATED', 'Member not found.');
    if (room.hostId !== actorId) {
      throw new GameStartError('HOST_REQUIRED', 'Only the host can start the game.');
    }
    if (member.kind !== 'player' || member.isAI === true) {
      throw new GameStartError(
        'SPECTATOR_READ_ONLY',
        'Spectators cannot start the game.',
      );
    }
  }

  private async rollback(
    roomCode: string,
    startingRevision: number,
    addedAIIds: readonly string[],
    failure: GameStartError,
  ): Promise<void> {
    try {
      await this.repository.mutate(
        roomCode,
        startingRevision,
        (room) => {
          if (room.status !== 'starting') return;
          const added = new Set(addedAIIds);
          room.members = room.members.filter((member) => !added.has(member.id));
          room.players = (room.players ?? []).filter((player) => !added.has(player.id));
          room.status = 'ready_check';
          room.configLocked = true;
          delete room.gameId;
          delete room.session;
          room.lastStartFailure = {
            code: failure.code,
            occurredAt: this.now(),
            ...(failure.details?.startCheck
              ? { details: { startCheck: failure.details.startCheck } }
              : {}),
          };
        },
      );
    } catch (rollbackError) {
      throw new GameStartError(
        'GAME_START_FAILED',
        'The failed start could not be rolled back safely.',
        { cause: failure.code, rollback: asGameStartError(rollbackError).code },
      );
    }
  }

  private async restoreCachedResult(
    room: RoomRecord,
    outcome: PersistedStartOutcome,
  ): Promise<GameStartResult> {
    let session = this.sessions.get(room.code);
    if (!session && room.session) {
      session = this.sessionFactory({
        room,
        players: clone(outcome.players),
        eventStore: this.options.eventStore,
        snapshot: clone(room.session),
        sessionOptions: this.options.sessionOptions,
      });
      const restorable = session as StartableGameSession & {
        restoreScheduling?: () => void;
      };
      restorable.restoreScheduling?.();
      this.sessions.set(room.code, session);
    }
    return {
      room,
      gameId: outcome.gameId,
      players: clone(outcome.players),
      ...(session ? { session } : {}),
      cached: true,
    };
  }
}

/** Convenience factory for callers that prefer a function over `new`. */
export const createGameStartCoordinator = (
  repository: RoomRepository,
  options: GameStartCoordinatorOptions,
): GameStartCoordinator => new GameStartCoordinator(repository, options);
