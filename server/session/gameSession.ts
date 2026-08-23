import { randomUUID } from 'node:crypto';
import type {
  DomainEvent,
  DomainEventType,
  EventStore,
  StoredEvent,
  ViewerContext,
} from '../../shared/events';
import { DOMAIN_EVENT_SCHEMA_VERSION } from '../../shared/events';
import {
  EVENT_HISTORY_DEFAULT_LIMIT,
  EVENT_HISTORY_MAX_LIMIT,
} from '../../shared/protocol';
import type {
  EventHistoryPage,
  EventHistoryQuery,
  GameCommand,
  GameCommandMeta,
} from '../../shared/protocol';
import type {
  GameAction,
  GameState,
  NightAction,
  Player,
  Role,
  DiscussionQueueEntry,
} from '../../shared/types';
import {
  buildSpeechOrder,
  completeGuard,
  completeSeer,
  completeWitch,
  createNightState,
  evaluateVictory,
  getExileVoteEligibility,
  getLastWordsEligibility,
  RULE_VALUES,
  getSeerResult,
  getWitchNightView,
  lockWolfKill,
  resolveExileVote,
  resolveNight,
  resolveWolfVote,
  startWolfVote,
  validateGuardAction,
  validateHunterShot,
  validateSeerAction,
  validateVoteChoice,
  validateWitchAction,
  validateWolfKillTarget,
  type CorePlayer,
  type PlayerId,
  type VoteBallot,
} from '../../src/core';
import {
  ensureAIMemoryBoards,
  initializeAIMemoryBoards,
  updateAIMemoryBoards,
  type AIMemoryBoard,
  type AIMemoryBoards,
} from '../ai/memory';
import {
  ensureAIPersonaAssignments,
  getAIPersonaProfile,
  isAIPersonaId,
  type AIPersonaAssignments,
  type AIPersonaProfile,
} from '../ai/persona';
import type { SecureRandomIndex } from '../ai/randomSelection';
import { VisibilityProjector } from '../events/projector';
import type {
  AuthorityGameState,
  CommandResult,
  DayFlowState,
  AIExperienceAssignment,
  SessionOptions,
  SessionScheduler,
  SessionSnapshot,
  SessionState,
} from './types';
import { experienceLibrary } from '../ai/experienceLibrary';
import { createHash } from 'node:crypto';

const DEFAULT_STAGE_DURATION_MS = 30_000;

const TEXT_LIMITS = {
  wolfMessage: 300,
  speech: 100,
  discussion: 150,
  lastWords: 80,
  voteReason: 40,
  speechRequestReason: 80,
} as const;

const DISCUSSION_MENTION_LIMIT = 3;
const DISCUSSION_WAIT_TIMEOUT_MS = 30_000;
const FREE_DISCUSSION_SPEECH_QUOTA = 2;
const FREE_DISCUSSION_CYCLES = Math.max(
  1,
  RULE_VALUES['speech.speech_limits'].free_discussion_cycles,
);

const graphemeLength = (value: string): number => {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<unknown>;
    };
  }).Segmenter;
  return Segmenter
    ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
    : [...value].length;
};

/** Keep public/domain history plus only the latest full session snapshot. */
const compactStoredEvents = (events: readonly StoredEvent[]): StoredEvent[] => {
  let latestStateIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event.eventType === 'game.state_updated') {
      latestStateIndex = index;
      break;
    }
  }
  return events.filter(
    ({ event }, index) => event.eventType !== 'game.state_updated' || index === latestStateIndex,
  );
};

const createDefaultScheduler = (keepTimersRefed = false): SessionScheduler => ({
  set: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    if (!keepTimersRefed) handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
});

const toCorePlayers = (players: readonly Player[]): CorePlayer[] =>
  players
    .filter((player): player is Player & { role: Role } => player.role !== null)
    .map((player) => ({
      id: player.id,
      role: player.role,
      alive: player.isAlive,
    }));

const emptyDayFlow = (): DayFlowState => ({
  stage: null,
  voteRound: 1,
  voteCandidates: [],
  votes: {},
  voteReasons: {},
  speechQueue: [],
  speechDirection: null,
  speechStartPlayerId: null,
  discussionMode: null,
  discussionQueue: [],
  discussionMentionCounts: {},
  discussionMentionOrder: [],
  discussionSpokenPlayerIds: [],
  discussionRequestSequence: 0,
  discussionCycle: 0,
  discussionCyclesRequired: FREE_DISCUSSION_CYCLES,
  discussionSpeechQuota: FREE_DISCUSSION_SPEECH_QUOTA,
  discussionSpeechCounts: {},
  discussionRequestReasons: {},
  lastWordsPlayerId: null,
  lastWordsRemaining: 0,
  pendingHunterId: null,
  pendingExile: null,
});

const createGameState = (roomId: string): AuthorityGameState => ({
  roomId,
  phase: 'role_confirm',
  nightStage: null,
  stageRevision: 1,
  allowedActors: [],
  allowedActions: [],
  deadlineTs: null,
  dayStage: null,
  day: 1,
  turn: 1,
  votes: {},
  nightActions: [],
  seerResults: {},
  winner: null,
  currentSpeaker: null,
  speakerOrder: [],
  daySpeechMode: null,
  discussionQueue: [],
    discussionMentionCounts: {},
  discussionCycle: 0,
  discussionCyclesRequired: FREE_DISCUSSION_CYCLES,
  discussionSpeechQuota: FREE_DISCUSSION_SPEECH_QUOTA,
  discussionSpeechCounts: {},
  voteRound: 1,
  voteCandidates: [],
  actionDone: {},
  speechTimeLeft: 0,
  actionTimeLeft: 0,
  wolfVotes: {},
  wolfSpeakerOrder: [],
  wolfCurrentSpeaker: null,
  wolfDiscussionRound: 1,
  wolfVoteComplete: false,
  guardianLastTarget: null,
  guardianActionComplete: false,
  witchHasHealPotion: true,
  witchHasPoisonPotion: true,
  witchActionComplete: false,
  lastWordsPlayer: null,
  hunterShootTarget: null,
  witchAntidoteUsed: false,
});

export class GameSession {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly projector = new VisibilityProjector();
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly personaRandomIndex: SecureRandomIndex | undefined;
  private readonly scheduler: SessionScheduler;
  private readonly stageDurationMs: number;
  private readonly onChanged?: SessionOptions['onChanged'];
  private timer: unknown;
  private timerRevision = -1;
  private storedEventCache: StoredEvent[] = [];
  private eventCacheLoaded = false;
  private memoryMigrationPending = false;
  private personaMigrationPending = false;
  private state: SessionState;

  constructor(
    roomId: string,
    players: Player[],
    private readonly eventStore: EventStore,
    snapshot?: SessionSnapshot,
    options: SessionOptions | (() => number) = {},
  ) {
    const resolvedOptions =
      typeof options === 'function' ? { now: options } : options;
    this.now = resolvedOptions.now ?? Date.now;
    this.rng = resolvedOptions.rng ?? Math.random;
    this.personaRandomIndex = resolvedOptions.personaRandomIndex;
    this.scheduler = resolvedOptions.scheduler ?? createDefaultScheduler(
      resolvedOptions.keepTimersRefed,
    );
    this.stageDurationMs =
      resolvedOptions.stageDurationMs ?? DEFAULT_STAGE_DURATION_MS;
    this.onChanged = resolvedOptions.onChanged;
    this.state =
      (snapshot ? structuredClone(snapshot.state) : undefined) ?? {
        roomId,
        gameId: randomUUID(),
        players: structuredClone(players),
        gameState: createGameState(roomId),
        night: createNightState(),
        dayFlow: emptyDayFlow(),
        roleConfirmations: Object.fromEntries(
          players.map((player) => [player.id, false]),
        ),
        witchInventory: { antidote: 1, poison: 1 },
        processedCommands: {},
        aiMemories: initializeAIMemoryBoards(players),
        aiPersonas: ensureAIPersonaAssignments(
          undefined,
          players.map(({ id, isAI }) => ({ id, isAI })),
          this.personaRandomIndex,
        ),
        aiExperiences: {},
        sequence: 0,
        streamVersion: 0,
      };
    this.memoryMigrationPending = false;
    this.personaMigrationPending = false;
    this.migrateSnapshot();
    this.normalizeMissingNightActors();
    this.syncAuthorityFields(false);
  }

  get gameId(): string {
    return this.state.gameId;
  }

  get stageRevision(): number {
    return this.state.gameState.stageRevision ?? 0;
  }

  get sequence(): number {
    return this.state.sequence;
  }

  get deadlineTs(): number | null {
    return this.state.gameState.deadlineTs;
  }

  get players(): Player[] {
    return structuredClone(this.state.players);
  }

  /** Return only the requesting AI's private, server-maintained memory board. */
  aiMemoryFor(playerId: string): AIMemoryBoard | undefined {
    const board = this.state.aiMemories[playerId];
    return board ? structuredClone(board) : undefined;
  }

  /** Return only the requesting AI's private, role-independent voice profile. */
  aiPersonaFor(playerId: string): AIPersonaProfile | undefined {
    return getAIPersonaProfile(this.state.aiPersonas[playerId]);
  }

  /** Return only the requesting AI's private experience assignment. */
  aiExperienceFor(playerId: string): AIExperienceAssignment | undefined {
    const assignment = this.state.aiExperiences[playerId];
    return assignment ? structuredClone(assignment) : undefined;
  }

  /**
   * Build the AI-only viewer from authoritative session state. Dead actors
   * receive a death cutoff so their projection can retain pre-death knowledge
   * without receiving private events appended after elimination.
   */
  async aiViewerFor(
    playerId: string,
    role: Role,
  ): Promise<Extract<ViewerContext, { kind: 'player' }>> {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    const isAlive = player?.isAlive === true;
    const viewer: Extract<ViewerContext, { kind: 'player' }> = {
      kind: 'player',
      playerId,
      role,
      isAlive,
    };
    if (!isAlive) {
      const cutoff = await this.deathCutoffSequenceFor(playerId);
      if (cutoff !== null) viewer.deathCutoffSequence = cutoff;
    }
    return viewer;
  }

  serialize(): SessionSnapshot {
    const state = structuredClone(this.state);
    // Command receipts contain their own event arrays and grow much faster
    // than game state. The event stream rebuilds this cache during recovery,
    // so persisting it in rooms.json only creates quadratic files and stalls
    // unrelated Socket.IO handshakes.
    state.processedCommands = {};
    return { state };
  }

  async initialize(): Promise<void> {
    await this.reconcileFromEventStream();
    const beforeInitialization = structuredClone(this.state);
    const computerRolesConfirmed = this.confirmComputerRoles();
    const roleConfirmationCompleted =
      this.state.gameState.phase === 'role_confirm' &&
      this.state.players.every(
        (player) => this.state.roleConfirmations[player.id] === true,
      );
    if (roleConfirmationCompleted) {
      this.beginFirstNight();
      this.syncAuthorityFields(false);
      this.setDeadline();
    }
    if (this.state.streamVersion === 0) {
      const before = beforeInitialization;
      this.setDeadline();
      try {
        await this.append([
          this.event(
            'game.started',
            {
              day: 1,
              stage: this.state.gameState.phase === 'role_confirm'
                ? 'role_confirm'
                : this.state.gameState.phase === 'night'
                  ? this.state.night.stage
                  : this.state.dayFlow.stage,
            },
            'public_timeline',
            undefined,
            'system:game-start',
          ),
          this.stateEvent('system:game-start'),
        ]);
      } catch (error) {
        this.state = before;
        throw error;
      }
      try {
        await this.changed();
      } catch (error) {
        this.scheduleDeadline();
        throw error;
      }
    } else if (
      computerRolesConfirmed ||
      roleConfirmationCompleted ||
      this.memoryMigrationPending ||
      this.personaMigrationPending
    ) {
      // AI seats do not need a client-side identity confirmation. Persist the
      // normalization after recovery as well, so a room cannot regress to a
      // role-confirmation gate after a process restart.
      const before = beforeInitialization;
      try {
        const events: DomainEvent[] = [];
        if (roleConfirmationCompleted) {
          events.push(
            this.event(
              'role.confirmation_completed',
              { day: this.state.gameState.day, automated: true },
              'public_timeline',
              undefined,
              'system:ai-role-confirmation',
            ),
          );
        }
        events.push(this.stateEvent('system:ai-role-confirmation'));
        await this.append(events);
        await this.changed();
        this.memoryMigrationPending = false;
        this.personaMigrationPending = false;
      } catch (error) {
        this.state = before;
        throw error;
      }
    }
    this.scheduleDeadline();
  }

  restoreScheduling(): void {
    this.scheduleDeadline();
  }

  dispose(): void {
    if (this.timer !== undefined) this.scheduler.clear(this.timer);
    this.timer = undefined;
  }

  dispatch(meta: GameCommandMeta, command: GameCommand): Promise<CommandResult> {
    const queuedAt = this.now();
    const run = this.queue.then(() => this.handle(meta, command, queuedAt));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Mark a player who left an active game as dead without granting last words.
   * RoomService uses this seam before removing the room membership so the
   * public timeline can say “退出游戏” while the remaining AI turns continue.
   */
  markPlayerExited(playerId: string, operationId: string = randomUUID()): Promise<boolean> {
    const run = this.queue.then(async () => {
      const player = this.state.players.find((candidate) => candidate.id === playerId);
      if (!player || !player.isAlive || this.state.gameState.phase === 'ended') return false;
      const before = structuredClone(this.state);
      const correlationId = `exit:${operationId}`;
      player.isAlive = false;
      this.state.roleConfirmations[playerId] = true;
      const events: DomainEvent[] = [
        this.event(
          'player.exited',
          { playerId, reason: 'left_game' },
          'public_timeline',
          undefined,
          correlationId,
          playerId,
        ),
      ];
      const wasCurrentActor = this.state.gameState.allowedActors.some(
        (entry) => entry.playerId === playerId,
      );
      if (wasCurrentActor) events.push(...this.applyTimeout(correlationId));
      else events.push(...this.finishIfWon(correlationId));
      if (this.stageRevision === before.gameState.stageRevision) this.advanceRevision();
      this.syncAuthorityFields(false);
      this.state.aiMemories = updateAIMemoryBoards(this.state.aiMemories, events, this.state.players);
      this.setDeadline();
      try {
        await this.append([...events, this.stateEvent(correlationId)]);
        await this.changed();
        return true;
      } catch (error) {
        this.state = before;
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async eventsFor(viewer: ViewerContext, afterSequence = 0) {
    const stored = (await this.storedEvents()).filter(({ event }) => event.sequence > afterSequence);
    return stored
      .map(({ event }) => this.projector.projectEvent(event, viewer))
      .filter((event): event is DomainEvent => event !== undefined);
  }

  async eventPageFor(
    viewer: ViewerContext,
    query: EventHistoryQuery = {},
  ): Promise<EventHistoryPage> {
    const afterSequence = Number.isSafeInteger(query.afterSequence) && query.afterSequence! >= 0
      ? query.afterSequence!
      : 0;
    const beforeSequence = Number.isSafeInteger(query.beforeSequence) && query.beforeSequence! >= 0
      ? query.beforeSequence!
      : undefined;
    const limit = Number.isSafeInteger(query.limit) && (query.limit ?? 0) > 0
      ? Math.min(query.limit!, EVENT_HISTORY_MAX_LIMIT)
      : EVENT_HISTORY_DEFAULT_LIMIT;
    const stored = await this.eventStore.read(this.streamId(), afterSequence);
    const eligible = beforeSequence === undefined
      ? stored
      : stored.filter(({ event }) => event.sequence < beforeSequence);
    const page = beforeSequence === undefined
      ? eligible.slice(0, limit)
      : eligible.slice(-limit);
    const events = page
      .map(({ event }) => this.projector.projectEvent(event, viewer))
      .filter((event): event is DomainEvent => event !== undefined);
    const hasMore = beforeSequence === undefined
      ? eligible.length > page.length
      : eligible.length > page.length;
    const firstSequence = page[0]?.event.sequence;
    const lastSequence = page.at(-1)?.event.sequence;
    return {
      afterSequence,
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      events,
      limit,
      hasMore,
      // These cursors track the authoritative raw stream, even when the
      // viewer projection hides every event in this page.
      nextAfterSequence: beforeSequence === undefined
        ? (lastSequence ?? afterSequence)
        : null,
      nextBeforeSequence: beforeSequence !== undefined
        ? (firstSequence ?? beforeSequence)
        : null,
    };
  }

  async projectEvents(events: readonly DomainEvent[], viewer: ViewerContext) {
    return events
      .map((event) => this.projector.projectEvent(event, viewer))
      .filter((event): event is DomainEvent => event !== undefined);
  }

  async snapshotFor(viewer: ViewerContext) {
    const events = await this.storedEvents();
    return this.projector.projectSnapshot(events, viewer);
  }

  private async deathCutoffSequenceFor(playerId: string): Promise<number | null> {
    const events = await this.storedEvents();
    for (const { event } of events) {
      const item = event.payload as Record<string, unknown>;
      if (
        (event.eventType === 'day.exiled' && item.playerId === playerId) ||
        (event.eventType === 'hunter.shot' && item.targetId === playerId) ||
        (event.eventType === 'night.resolved' &&
          Array.isArray(item.deaths) &&
          item.deaths.includes(playerId))
      ) {
        return event.sequence;
      }
    }
    return null;
  }

  private async storedEvents(): Promise<StoredEvent[]> {
    if (!this.eventCacheLoaded) {
      this.storedEventCache = compactStoredEvents(await this.eventStore.read(this.streamId()));
      this.eventCacheLoaded = true;
    } else {
      const delta = await this.eventStore.read(
        this.streamId(),
        this.storedEventCache.at(-1)?.event.sequence ?? 0,
      );
      if (delta.length > 0) {
        this.storedEventCache = compactStoredEvents([...this.storedEventCache, ...delta]);
      }
    }
    // Callers only read this cache and the visibility projector clones every
    // event that it returns. Cloning the complete cache here duplicated every
    // full `game.state_updated` session snapshot for every AI turn; the
    // per-seat memory boards make that quadratic cost especially visible.
    return this.storedEventCache;
  }

  private async handle(
    meta: GameCommandMeta,
    command: GameCommand,
    queuedAt: number,
  ): Promise<CommandResult> {
    const cached = this.state.processedCommands[meta.commandId];
    if (cached) return structuredClone(cached);

    const rejected = this.validateMeta(meta, queuedAt);
    if (rejected) return rejected;

    if (
      command.type === 'game.skip_speech' &&
      this.state.dayFlow.stage === 'last_words' &&
      !command.payload.reason?.trim()
    ) {
      return this.reject('REASON_REQUIRED');
    }

    const contentError = this.validateTextCommand(command);
    if (contentError) return this.reject(contentError);

    const actor = this.state.players.find((player) => player.id === meta.actorId);
    if (!actor) return this.reject('ACTOR_NOT_FOUND');
    if (!actor.isAlive && !this.deadActorMayAct(actor, command)) {
      return this.reject('ACTOR_DEAD');
    }

    const before = structuredClone(this.state);
    const beforeRevision = this.stageRevision;
    const beforeStageKey = this.stageKey();
    const events = this.applyCommand(actor, command, meta.commandId);
    if (!events) return this.reject('ACTION_NOT_ALLOWED');
    this.normalizeSingleWolfDiscussion();

    if (
      beforeStageKey !== this.stageKey() &&
      beforeRevision === this.stageRevision
    ) {
      this.advanceRevision();
    }
    this.syncAuthorityFields(false);
    // Memory is part of the same serialized transaction as the authoritative
    // state. The session queue therefore makes concurrent speech/action updates
    // deterministic and the state_updated commit persists the whole board.
    this.state.aiMemories = updateAIMemoryBoards(
      this.state.aiMemories,
      events,
      this.state.players,
    );
    const revisionChanged = beforeRevision !== this.stageRevision;
    if (revisionChanged) this.setDeadline();
    const committed = [
      ...events,
      this.stateEvent(meta.commandId, meta.actorId, meta.commandId),
    ];
    try {
      await this.append(committed);
    } catch (error) {
      this.state = before;
      throw error;
    }
    const result = { ok: true, events: committed } satisfies CommandResult;
    this.state.processedCommands[meta.commandId] = structuredClone(result);
    this.trimProcessedCommands();
    try {
      await this.changed();
    } finally {
      this.scheduleDeadline();
    }
    return result;
  }

  private validateMeta(
    meta: GameCommandMeta,
    queuedAt: number,
  ): CommandResult | null {
    if (meta.roomId !== this.state.roomId) return this.reject('INVALID_COMMAND');
    if (meta.gameId !== this.state.gameId) return this.reject('INVALID_COMMAND');
    if (meta.expectedStageRevision !== this.stageRevision) {
      return this.reject('STALE_STAGE_REVISION');
    }
    if (
      this.state.gameState.deadlineTs !== null &&
      queuedAt > this.state.gameState.deadlineTs
    ) {
      return this.reject('EXPIRED_COMMAND');
    }
    return null;
  }

  private applyCommand(
    actor: Player,
    command: GameCommand,
    correlationId: string,
  ): DomainEvent[] | null {
    if (this.state.gameState.phase === 'role_confirm') {
      return this.applyRoleConfirmation(actor, command, correlationId);
    }
    if (this.state.gameState.phase === 'night') {
      return this.applyNightCommand(actor, command, correlationId);
    }
    if (command.type === 'game.speak' || command.type === 'game.skip_speech') {
      return this.applySpeech(actor, command, correlationId);
    }
    if (command.type === 'game.request_speech') {
      return this.applySpeechRequest(actor, command.payload.reason, correlationId);
    }
    if (command.type === 'game.vote') {
      return this.applyDayVote(
        actor,
        command.payload.targetId,
        command.payload.reason,
        correlationId,
      );
    }
    if (command.type === 'game.hunter_shoot') {
      return this.applyHunterShot(actor, command.payload.targetId, correlationId);
    }
    return null;
  }

  private validateTextCommand(command: GameCommand): CommandResult['code'] | null {
    let value: string | undefined;
    let limit: number | undefined;
    if (command.type === 'game.wolf_speak') {
      value = command.payload.content;
      limit = TEXT_LIMITS.wolfMessage;
    } else if (command.type === 'game.speak') {
      value = command.payload.content;
      limit = this.state.dayFlow.stage === 'discussion'
        ? TEXT_LIMITS.discussion
        : this.state.dayFlow.stage === 'last_words'
          ? TEXT_LIMITS.lastWords
          : TEXT_LIMITS.speech;
    } else if (command.type === 'game.skip_speech' && command.payload.reason) {
      value = command.payload.reason;
      limit = TEXT_LIMITS.lastWords;
    } else if (command.type === 'game.request_speech' && command.payload.reason) {
      value = command.payload.reason;
      limit = TEXT_LIMITS.speechRequestReason;
    } else if (command.type === 'game.vote' && command.payload.reason) {
      value = command.payload.reason;
      limit = TEXT_LIMITS.voteReason;
    }
    return value !== undefined && limit !== undefined && graphemeLength(value) > limit
      ? 'CONTENT_TOO_LONG'
      : null;
  }

  private applyRoleConfirmation(
    actor: Player,
    command: GameCommand,
    correlationId: string,
  ): DomainEvent[] | null {
    if (command.type !== 'game.confirm_role' || this.state.roleConfirmations[actor.id]) {
      return null;
    }
    this.state.roleConfirmations[actor.id] = true;
    const events: DomainEvent[] = [
      this.event(
        'role.confirmed',
        { confirmed: true },
        'role_private',
        [actor.id],
        correlationId,
        actor.id,
      ),
    ];
    if (this.state.players.every((player) => this.state.roleConfirmations[player.id] === true)) {
      this.beginFirstNight();
      events.push(
        this.event(
          'role.confirmation_completed',
          { day: this.state.gameState.day },
          'public_timeline',
          undefined,
          correlationId,
        ),
      );
    }
    return events;
  }

  private applyNightCommand(
    actor: Player,
    command: GameCommand,
    correlationId: string,
  ): DomainEvent[] | null {
    if (command.type === 'game.wolf_speak' || command.type === 'game.skip_speech') {
      if (
        actor.role !== 'wolf' ||
        this.state.night.stage !== 'wolf_discussion' ||
        this.state.gameState.wolfCurrentSpeaker !== actor.id
      ) {
        return null;
      }
      const events = command.type === 'game.wolf_speak'
        ? [this.event(
            'wolf.message',
            {
              actorId: actor.id,
              round: this.state.gameState.wolfDiscussionRound,
              content: command.payload.content,
            },
            'wolf_private',
            this.alivePlayers('wolf').map((player) => player.id),
            correlationId,
            actor.id,
          )]
        : [];
      const order = this.state.gameState.wolfSpeakerOrder.filter((id) =>
        this.state.players.some((player) => player.id === id && player.isAlive && player.role === 'wolf'),
      );
      const index = order.indexOf(actor.id);
      const next = index >= 0 ? order[index + 1] : undefined;
      if (next) {
        this.state.gameState.wolfCurrentSpeaker = next;
      } else if (this.state.gameState.wolfDiscussionRound < 2) {
        const wolves = this.alivePlayers('wolf');
        this.state.gameState.wolfDiscussionRound = 2;
        this.state.gameState.wolfCurrentSpeaker = wolves[0]?.id ?? null;
        this.advanceRevision();
        events.push(
          this.event(
            'wolf.discussion_round_started',
            { round: 2 },
            'wolf_private',
            wolves.map((player) => player.id),
            correlationId,
          ),
        );
      } else {
        this.state.gameState.wolfCurrentSpeaker = null;
        this.state.night = startWolfVote(this.state.night);
      }
      return events;
    }
    if (command.type === 'game.night_action') {
      return this.applyNightAction(actor, command.payload, correlationId);
    }
    if (command.type === 'game.skip_night') {
      return this.applyNightSkip(actor, command.payload.action, correlationId);
    }
    if (command.type === 'game.wolf_vote') {
      return this.applyWolfVote(actor, command.payload.targetId, correlationId);
    }
    return null;
  }

  private applyNightAction(
    actor: Player,
    action: NightAction,
    correlationId: string,
  ): DomainEvent[] | null {
    if (action.playerId !== actor.id) return null;
    const corePlayers = toCorePlayers(this.state.players);

    if (action.action === 'guard') {
      if (
        !validateGuardAction(
          corePlayers,
          actor.id,
          action.targetId,
          this.state.gameState.guardianLastTarget,
          this.state.night.stage,
        ).ok
      ) {
        return null;
      }
      this.state.night = completeGuard(this.state.night, action.targetId);
      this.state.gameState.guardianLastTarget = action.targetId;
      this.state.gameState.guardianActionComplete = true;
      this.recordNightAction(action);
      return [
        this.event(
          'guardian.completed',
          { targetId: action.targetId },
          'role_private',
          [actor.id],
          correlationId,
          actor.id,
        ),
      ];
    }

    if (
      action.action === 'check' &&
      action.targetId !== null &&
      !this.state.night.seerComplete
    ) {
      if (
        !validateSeerAction(
          corePlayers,
          actor.id,
          action.targetId,
          this.state.night.stage,
        ).ok
      ) {
        return null;
      }
      this.state.night = completeSeer(this.state.night, action.targetId);
      const alignment = getSeerResult(corePlayers, action.targetId);
      if (alignment !== null) {
        this.state.gameState.seerResults ??= {};
        this.state.gameState.seerResults[action.targetId] = alignment;
      }
      this.recordNightAction(action);
      return [
        this.event(
          'seer.result',
          {
            targetId: action.targetId,
            alignment,
          },
          'role_private',
          [actor.id],
          correlationId,
          actor.id,
        ),
      ];
    }

    if (action.action === 'heal' || action.action === 'poison') {
      if (actor.role !== 'witch' || this.state.night.stage !== 'witch') {
        return null;
      }
      const witchView = getWitchNightView(
        this.state.night.actions.wolfKillTargetId,
        this.state.night.actions.guardTargetId,
        this.state.witchInventory,
      );
      const useAntidote = action.action === 'heal';
      const poisonTargetId = action.action === 'poison' ? action.targetId : null;
      if (
        !validateWitchAction(
          corePlayers,
          actor.id,
          { useAntidote, poisonTargetId },
          this.state.witchInventory,
          witchView.killTargetId,
          this.state.night.stage,
        ).ok
      ) {
        return null;
      }
      this.state.night = completeWitch(
        this.state.night,
        useAntidote,
        poisonTargetId,
      );
      if (useAntidote) this.state.witchInventory.antidote -= 1;
      if (poisonTargetId !== null) this.state.witchInventory.poison -= 1;
      this.state.gameState.witchActionComplete = true;
      this.recordNightAction({
        playerId: actor.id,
        action: action.action,
        targetId: useAntidote ? witchView.killTargetId : poisonTargetId,
      });
      return [
        this.event(
          'witch.completed',
          {
            action: action.action,
            targetId: useAntidote ? witchView.killTargetId : poisonTargetId,
          },
          'role_private',
          [actor.id],
          correlationId,
          actor.id,
        ),
        ...this.resolveNightAndAdvance(correlationId),
      ];
    }
    return null;
  }

  private applyNightSkip(
    actor: Player,
    action: GameAction,
    correlationId: string,
  ): DomainEvent[] | null {
    if (
      this.state.night.stage === 'guard_seer' &&
      actor.role === 'guardian' &&
      action === 'guard'
    ) {
      this.state.night = completeGuard(this.state.night, null);
      this.state.gameState.guardianActionComplete = true;
    } else if (
      this.state.night.stage === 'guard_seer' &&
      actor.role === 'seer' &&
      action === 'check' &&
      !this.state.night.seerComplete
    ) {
      this.state.night = completeSeer(this.state.night, null);
    } else if (
      this.state.night.stage === 'witch' &&
      actor.role === 'witch' &&
      (action === 'heal' || action === 'poison')
    ) {
      this.state.night = completeWitch(this.state.night, false, null);
      this.state.gameState.witchActionComplete = true;
    } else {
      return null;
    }
    this.state.gameState.actionDone[actor.id] = true;
    return [
      this.event(
        'night.skipped',
        { actorId: actor.id, action },
        'role_private',
        [actor.id],
        correlationId,
        actor.id,
      ),
      ...this.resolveNightAndAdvance(correlationId),
    ];
  }

  private applyWolfVote(
    actor: Player,
    targetId: string | null,
    correlationId: string,
  ): DomainEvent[] | null {
    if (actor.role !== 'wolf') return null;
    const validation = validateWolfKillTarget(
      toCorePlayers(this.state.players),
      actor.id,
      targetId,
      this.state.night.stage,
    );
    if (!validation.ok) return null;

    this.state.gameState.wolfVotes[actor.id] = targetId ?? '';
    const wolves = this.alivePlayers('wolf');
    if (
      wolves.some(
        (wolf) => this.state.gameState.wolfVotes[wolf.id] === undefined,
      )
    ) {
      return [
        this.event(
          'wolf.vote_cast',
          {
            actorId: actor.id,
            targetId,
            targetName: targetId
              ? this.state.players.find((player) => player.id === targetId)?.name ?? null
              : null,
          },
          'wolf_private',
          undefined,
          correlationId,
          actor.id,
        ),
      ];
    }

    const ballots = wolves.map((wolf) => ({
      voterId: wolf.id,
      targetId: this.state.gameState.wolfVotes[wolf.id] || null,
    }));
    const result = resolveWolfVote(ballots, this.rng);
    this.state.gameState.wolfVotes = {};
    this.state.night = lockWolfKill(this.state.night, result.targetId);
    this.state.gameState.wolfVoteComplete = true;
    const witch = this.alivePlayers('witch')[0];
    const witchView = getWitchNightView(
      result.targetId,
      this.state.night.actions.guardTargetId,
      this.state.witchInventory,
    );
    const events = [
      this.event(
        'wolf.kill_locked',
        { targetId: result.targetId },
        'wolf_private',
        undefined,
        correlationId,
      ),
      ...(witch
        ? [
            this.event(
              'witch.kill_notice',
              witchView as unknown as Record<string, unknown>,
              'role_private',
              [witch.id],
              correlationId,
            ),
          ]
        : []),
    ];
    if (!witch) {
      this.state.night = completeWitch(this.state.night, false, null);
      events.push(...this.resolveNightAndAdvance(correlationId));
    }
    return events;
  }

  private resolveNightAndAdvance(correlationId: string): DomainEvent[] {
    if (this.state.night.stage !== 'resolve') return [];
    const result = resolveNight(toCorePlayers(this.state.players), this.state.night);
    this.applyAliveState(result.players);
    // `deaths` is the atomic resolution result. Derive the public list from
    // it here instead of relying on a second, independently maintained
    // projection field. The same list must reach the event store, every
    // viewer projection, and the AI prompt context.
    const publicDeaths = result.deaths.map((death) => death.playerId);
    const events = [
      this.event(
        'night.resolved',
        {
          day: this.state.gameState.day,
          peacefulNight: publicDeaths.length === 0,
          deaths: publicDeaths,
        },
        'public_timeline',
        undefined,
        correlationId,
      ),
      this.event(
        'night.resolution_detail',
        {
          deaths: result.deaths,
          guardedTargetId: result.guardedTargetId,
          healedTargetId: result.healedTargetId,
          poisonedTargetId: result.poisonedTargetId,
        },
        'spectator_omniscient',
        undefined,
        correlationId,
      ),
    ];
    const victory = this.finishIfWon(correlationId);
    if (victory.length > 0) return [...events, ...victory];
    this.beginDay();
    return [
      ...events,
      this.event(
        'day.started',
        {
          day: this.state.gameState.day,
          stage: 'dawn',
          startPlayerId: this.state.dayFlow.speechStartPlayerId,
          direction: this.state.dayFlow.speechDirection,
        },
        'public_timeline',
        undefined,
        correlationId,
      ),
    ];
  }

  private applySpeech(
    actor: Player,
    command: Extract<
      GameCommand,
      { type: 'game.speak' | 'game.skip_speech' }
    >,
    correlationId: string,
  ): DomainEvent[] | null {
    const flow = this.state.dayFlow;
    const isLastWords = flow.stage === 'last_words';
    const isDiscussion = flow.stage === 'discussion';
    const speechRound = isLastWords
      ? 3 - flow.lastWordsRemaining
      : isDiscussion
        ? flow.discussionCycle ?? 1
        : 1;
    if (
      (flow.stage !== 'speech' && !isDiscussion && !isLastWords) ||
      this.state.gameState.currentSpeaker !== actor.id
    ) {
      return null;
    }
    const mentions = command.type === 'game.speak'
      ? this.recordDiscussionMentions(command.payload.content, actor.id)
      : [];
    const events = [
      this.event(
        command.type === 'game.speak'
          ? 'day.speech'
          : 'day.speech_skipped',
        command.type === 'game.speak'
          ? {
              actorId: actor.id,
              day: this.state.gameState.day,
              round: speechRound,
              content: command.payload.content,
              ...(!isLastWords ? { mentions } : {}),
              lastWords: isLastWords,
              ...(isDiscussion ? { discussion: true, discussionRound: speechRound } : {}),
              ...(isLastWords ? { lastWordsRound: speechRound } : {}),
            }
          : {
              actorId: actor.id,
              day: this.state.gameState.day,
              round: speechRound,
              lastWords: isLastWords,
              ...(isDiscussion ? { discussion: true, discussionRound: speechRound } : {}),
              ...(isLastWords ? { lastWordsRound: speechRound } : {}),
              ...(isLastWords && command.payload.reason?.trim()
                ? { reason: command.payload.reason.trim() }
                : {}),
            },
        'public_timeline',
        undefined,
        correlationId,
        actor.id,
      ),
    ];
    if (isLastWords) {
      flow.lastWordsRemaining -= 1;
      if (flow.lastWordsRemaining > 0) {
        this.advanceRevision();
      } else {
        events.push(...this.afterLastWords(correlationId));
      }
      return events;
    }
    if (isDiscussion) {
      flow.discussionSpeechCounts ??= {};
      flow.discussionSpeechQuota ??= FREE_DISCUSSION_SPEECH_QUOTA;
      flow.discussionSpeechCounts[actor.id] =
        (flow.discussionSpeechCounts[actor.id] ?? 0) + 1;
      flow.discussionSpokenPlayerIds ??= [];
      if (!flow.discussionSpokenPlayerIds.includes(actor.id)) {
        flow.discussionSpokenPlayerIds.push(actor.id);
      }
      this.removeDiscussionQueueEntry(actor.id);
      this.promoteDiscussionWaiters();
      this.sortDiscussionQueue();
      const discussionContinues = flow.speechQueue.length > 0;
      const hasRemainingQuota = this.hasDiscussionQuota();
      if (discussionContinues) {
        this.state.gameState.currentSpeaker = flow.speechQueue[0];
        this.advanceRevision();
        events.push(this.discussionQueueEvent(correlationId));
      } else if (hasRemainingQuota) {
        // Free discussion is demand-driven. When the current speaker finishes
        // and nobody has been mentioned or inserted, keep the stage open with
        // a visible 30-second idle countdown instead of manufacturing a full
        // second lap for every player.
        this.state.gameState.currentSpeaker = null;
        this.advanceRevision();
        events.push(this.discussionQueueEvent(correlationId));
      } else {
        this.beginVoting(1, []);
        events.push(
          this.event(
            'day.voting_started',
            { round: 1 },
            'public_timeline',
            undefined,
            correlationId,
          ),
        );
        events.push(this.discussionQueueEvent(correlationId));
      }
    } else {
      flow.speechQueue.shift();
      flow.discussionQueue?.shift();
      flow.discussionSpokenPlayerIds ??= [];
      flow.discussionSpokenPlayerIds.push(actor.id);
      this.refreshDiscussionQueueProjection();
      if (flow.speechQueue.length > 0) {
        this.state.gameState.currentSpeaker = flow.speechQueue[0];
        this.advanceRevision();
      } else {
      this.beginDiscussion();
      events.push(
        this.event(
          'day.discussion_started',
          { day: this.state.gameState.day },
          'public_timeline',
          undefined,
          correlationId,
        ),
      );
      // An empty free-discussion queue is an intentional waiting state. Keep
      // the stage open for insert/mention requests and let the 30s deadline
      // move the table to voting if nobody steps forward.
      events.push(this.discussionQueueEvent(correlationId));
      }
    }
    return events;
  }

  private applySpeechRequest(
    actor: Player,
    reason: string | undefined,
    correlationId: string,
  ): DomainEvent[] | null {
    const flow = this.state.dayFlow;
    if (
      flow.stage !== 'discussion' ||
      flow.discussionMode !== 'free_discussion' ||
      this.state.gameState.currentSpeaker === actor.id ||
      !actor.isAlive
    ) {
      return null;
    }
    flow.discussionRequestReasons ??= {};
    if (reason?.trim()) flow.discussionRequestReasons[actor.id] = reason.trim();
    this.enqueueDiscussionPlayer(actor.id, 'insert', 2);
    if (!this.state.gameState.currentSpeaker) {
      this.state.gameState.currentSpeaker = flow.speechQueue[0] ?? null;
    }
    this.advanceRevision();
    return [this.discussionQueueEvent(correlationId)];
  }

  private applyDayVote(
    actor: Player,
    targetId: string | null,
    reason: string | undefined,
    correlationId: string,
  ): DomainEvent[] | null {
    const flow = this.state.dayFlow;
    if (flow.stage !== 'voting') return null;
    const eligibility = getExileVoteEligibility(
      toCorePlayers(this.state.players),
      flow.voteRound,
      flow.voteCandidates,
    );
    if (
      !validateVoteChoice(actor.id, targetId, {
        eligibleVoterIds: eligibility.voterIds,
        eligibleTargetIds: eligibility.targetIds,
        abstainAllowed: eligibility.abstainAllowed,
      }).ok
    ) {
      return null;
    }
    const hadPreviousVote = Object.prototype.hasOwnProperty.call(
      flow.votes,
      actor.id,
    );
    const previousTarget = flow.votes[actor.id];
    flow.votes[actor.id] = targetId;
    flow.voteReasons[actor.id] = reason?.trim() || null;
    const waitingFor = eligibility.voterIds.filter(
      (id) => flow.votes[id] === undefined,
    );
    const voteEvent = this.event(
      'day.vote_cast',
      {
        accepted: true,
        targetId,
        changed: hadPreviousVote && previousTarget !== targetId,
        submittedCount: eligibility.voterIds.length - waitingFor.length,
        totalVoters: eligibility.voterIds.length,
        waitingFor: waitingFor.length,
      },
      'role_private',
      [actor.id],
      correlationId,
      actor.id,
    );
    return waitingFor.length > 0
      ? [voteEvent]
      : [voteEvent, ...this.resolveDayVote(correlationId)];
  }

  private resolveDayVote(correlationId: string): DomainEvent[] {
    const flow = this.state.dayFlow;
    const ballots: VoteBallot[] = Object.entries(flow.votes).map(
      ([voterId, targetId]) => ({
        voterId,
        targetId,
        reason: flow.voteReasons[voterId] ?? null,
      }),
    );
    const result = resolveExileVote(
      toCorePlayers(this.state.players),
      ballots,
      flow.voteRound,
      flow.voteCandidates,
    );
    if (result.status === 'revote_required') {
      this.beginVoting(2, [...result.candidates]);
      return [
        this.event(
          'day.revote_required',
          {
            candidates: result.candidates,
            eligibleVoterIds: result.eligibleVoterIds,
            voteHistory: ballots,
          },
          'public_timeline',
          undefined,
          correlationId,
        ),
      ];
    }
    const targetId = result.status === 'exiled' ? result.targetId : null;
    this.beginExileResult(
      result.status,
      targetId,
      result.round,
      result.tally,
      ballots,
    );
    return [
      this.event(
        'day.exile_result',
        {
          day: this.state.gameState.day,
          status: result.status,
          ...(targetId ? { targetId } : {}),
          tally: result.tally,
          voteHistory: ballots,
        },
        'public_timeline',
        undefined,
        correlationId,
      ),
    ];
  }

  private afterLastWords(correlationId: string): DomainEvent[] {
    const hunterId = this.state.dayFlow.pendingHunterId;
    if (hunterId) {
      this.state.dayFlow.stage = 'hunter';
      this.state.gameState.phase = 'day';
      this.state.gameState.currentSpeaker = null;
      this.advanceRevision();
      return [
        this.event(
          'hunter.entitled',
          { hunterId },
          'role_private',
          [hunterId],
          correlationId,
        ),
      ];
    }
    return this.finishDay(correlationId);
  }

  private applyHunterShot(
    actor: Player,
    targetId: string | null,
    correlationId: string,
  ): DomainEvent[] | null {
    if (
      this.state.dayFlow.stage !== 'hunter' ||
      this.state.dayFlow.pendingHunterId !== actor.id ||
      !validateHunterShot(
        toCorePlayers(this.state.players),
        actor.id,
        'exile',
        targetId,
      ).ok
    ) {
      return null;
    }
    if (targetId !== null) {
      const target = this.state.players.find((player) => player.id === targetId);
      if (!target) return null;
      target.isAlive = false;
      this.state.gameState.hunterShootTarget = targetId;
    }
    this.state.dayFlow.pendingHunterId = null;
    const events = [
      this.event(
        targetId === null ? 'hunter.shot_skipped' : 'hunter.shot',
        { day: this.state.gameState.day, hunterId: actor.id, targetId },
        'public_timeline',
        undefined,
        correlationId,
        actor.id,
      ),
    ];
    events.push(...this.finishDay(correlationId));
    return events;
  }

  private finishDay(correlationId: string): DomainEvent[] {
    this.beginDayEnd();
    return [
      this.event(
        'day.ended',
        { day: this.state.gameState.day },
        'public_timeline',
        undefined,
        correlationId,
      ),
    ];
  }

  private beginFirstNight(): void {
    this.state.gameState.phase = 'night';
    this.state.gameState.dayStage = null;
    this.state.gameState.nightStage = this.state.night.stage;
    this.state.gameState.currentSpeaker = null;
    this.state.gameState.speakerOrder = [];
    this.advanceRevision();
  }

  private finishIfWon(correlationId: string): DomainEvent[] {
    const result = evaluateVictory(toCorePlayers(this.state.players), {
      checkpoint: 'after_atomic_resolution',
    });
    if (result.winner === null) return [];
    this.state.gameState.phase = 'ended';
    this.state.gameState.winner =
      result.winner === 'draw' ? null : result.winner;
    this.state.gameState.allowedActors = [];
    this.state.gameState.allowedActions = [];
    this.state.gameState.deadlineTs = null;
    this.state.dayFlow.stage = null;
    this.state.gameState.dayStage = null;
    this.state.dayFlow.pendingExile = null;
    this.advanceRevision();
    return [
      this.event(
        'game.ended',
        { winner: result.winner, reason: result.reason },
        'public_timeline',
        undefined,
        correlationId,
      ),
    ];
  }

  private beginDay(): void {
    const alive = this.state.players
      .filter((player) => player.isAlive)
      .sort((a, b) => a.order - b.order)
      .map((player) => player.id);
    const randomStart = alive.length > 0
      ? Math.min(alive.length - 1, Math.max(0, Math.floor(this.rng() * alive.length)))
      : 0;
    const start = alive[randomStart];
    const direction = this.rng() < 0.5 ? 'clockwise' : 'counterclockwise';
    const order = start ? [...buildSpeechOrder(alive, start, direction)] : [];
    this.state.dayFlow = {
      ...emptyDayFlow(),
      stage: 'dawn',
      discussionMode: 'first_report',
      speechQueue: order,
      speechDirection: direction,
      speechStartPlayerId: start ?? null,
      discussionQueue: order.map((playerId, index) => ({
        playerId,
        position: index + 1,
        enqueuedAt: this.now(),
        requestOrder: index + 1,
        source: 'first_report',
        mentionCount: 0,
        priority: 0,
      })),
    };
    this.state.gameState.phase = 'day';
    this.state.gameState.dayStage = 'dawn';
    this.state.gameState.currentSpeaker = null;
    this.state.gameState.speakerOrder = order;
    this.state.gameState.nightStage = 'resolve';
    this.advanceRevision();
  }

  private beginVoting(round: 1 | 2, candidates: PlayerId[]): void {
    this.state.dayFlow.stage = 'voting';
    this.state.dayFlow.discussionMode = null;
    this.state.dayFlow.discussionQueue = [];
    this.state.dayFlow.speechQueue = [];
    this.state.dayFlow.voteRound = round;
    this.state.dayFlow.voteCandidates = candidates;
    this.state.dayFlow.votes = {};
    this.state.dayFlow.voteReasons = {};
    this.state.gameState.phase = 'day';
    this.state.gameState.dayStage = 'voting';
    this.state.gameState.currentSpeaker = null;
    this.state.gameState.speakerOrder = [];
    this.state.gameState.votes = {};
    this.advanceRevision();
  }

  private beginSpeech(): void {
    this.state.dayFlow.stage = 'speech';
    this.state.dayFlow.discussionMode = 'first_report';
    this.state.dayFlow.discussionQueue ??= [];
    if (this.state.dayFlow.discussionQueue.length === 0) {
      this.state.dayFlow.discussionQueue = this.state.dayFlow.speechQueue.map(
        (playerId, index) => ({
          playerId,
          position: index + 1,
          enqueuedAt: this.now(),
          requestOrder: index + 1,
          source: 'first_report',
          mentionCount: 0,
          priority: 0,
        }),
      );
    }
    this.state.gameState.phase = 'day';
    this.state.gameState.dayStage = 'speech';
    this.state.gameState.currentSpeaker = this.state.dayFlow.speechQueue[0] ?? null;
    this.refreshDiscussionQueueProjection();
    this.advanceRevision();
  }

  private beginDiscussion(): boolean {
    const flow = this.state.dayFlow;
    flow.discussionMode = 'free_discussion';
    this.state.dayFlow.stage = 'discussion';
    flow.discussionCycle = 1;
    flow.discussionSpeechQuota = FREE_DISCUSSION_SPEECH_QUOTA;
    flow.discussionSpeechCounts ??= {};
    // Do not enqueue every living player. Free discussion starts with players
    // mentioned during the ordered report; everyone else enters only after an
    // explicit insert request or a later mention.
    const aliveIds = new Set(this.alivePlayers().map((player) => player.id));
    const queued = [...new Set(flow.discussionMentionOrder ?? [])]
      .filter((playerId) => aliveIds.has(playerId))
      .filter((playerId) => (flow.discussionSpeechCounts?.[playerId] ?? 0) < (flow.discussionSpeechQuota ?? FREE_DISCUSSION_SPEECH_QUOTA));
    flow.discussionQueue = queued.map((playerId, index) => ({
      playerId,
      position: index + 1,
      enqueuedAt: this.now(),
      requestOrder: index + 1,
      source: 'mention',
      mentionCount: Math.min(
        DISCUSSION_MENTION_LIMIT,
        flow.discussionMentionCounts?.[playerId] ?? 0,
      ),
      priority: Math.min(3, flow.discussionMentionCounts?.[playerId] ?? 0),
      cycle: 1,
    }));
    this.state.gameState.currentSpeaker = null;
    this.sortDiscussionQueue();
    flow.discussionRequestSequence = Math.max(
      flow.discussionRequestSequence ?? 0,
      ...(flow.discussionQueue ?? []).map((entry) => entry.requestOrder),
    );
    this.state.dayFlow.speechQueue = (flow.discussionQueue ?? []).map(
      (entry) => entry.playerId,
    );
    this.state.gameState.phase = 'day';
    this.state.gameState.dayStage = 'discussion';
    this.state.gameState.currentSpeaker = flow.speechQueue[0] ?? null;
    this.refreshDiscussionQueueProjection();
    this.advanceRevision();
    return flow.speechQueue.length > 0;
  }

  private hasDiscussionQuota(): boolean {
    const quota = this.state.dayFlow.discussionSpeechQuota ?? FREE_DISCUSSION_SPEECH_QUOTA;
    return this.alivePlayers().some((player) =>
      (this.state.dayFlow.discussionSpeechCounts?.[player.id] ?? 0) < quota,
    );
  }

  private discussionCycleOrder(): PlayerId[] {
    const alive = this.alivePlayers()
      .sort((left, right) => left.order - right.order)
      .map((player) => player.id);
    if (alive.length === 0) return [];
    const start = flowStart(this.state.dayFlow.speechStartPlayerId, alive);
    return [...buildSpeechOrder(
      alive,
      start,
      this.state.dayFlow.speechDirection ?? 'clockwise',
    )];
  }

  private beginNextDiscussionCycle(): boolean {
    const flow = this.state.dayFlow;
    const cycle = flow.discussionCycle ?? 1;
    const required = flow.discussionCyclesRequired ?? FREE_DISCUSSION_CYCLES;
    if (cycle >= required) return false;
    const nextCycle = cycle + 1;
    const queued = this.discussionCycleOrder();
    flow.discussionCycle = nextCycle;
    let requestSequence = flow.discussionRequestSequence ?? 0;
    flow.discussionQueue = queued.map((playerId, index) => ({
      playerId,
      position: index + 1,
      enqueuedAt: this.now(),
      requestOrder: ++requestSequence,
      source: 'free_cycle',
      mentionCount: Math.min(
        DISCUSSION_MENTION_LIMIT,
        flow.discussionMentionCounts?.[playerId] ?? 0,
      ),
      priority: 0,
      cycle: nextCycle,
    }));
    flow.discussionRequestSequence = requestSequence;
    this.refreshDiscussionQueueProjection();
    return flow.speechQueue.length > 0;
  }

  private discussionQueueEvent(correlationId: string): DomainEvent {
    return this.event(
      'day.speech_queue_updated',
      {
        mode: this.state.dayFlow.discussionMode ?? null,
        cycle: this.state.dayFlow.discussionCycle ?? 0,
        cyclesRequired: this.state.dayFlow.discussionCyclesRequired ?? FREE_DISCUSSION_CYCLES,
        speechQuota: this.state.dayFlow.discussionSpeechQuota ?? FREE_DISCUSSION_SPEECH_QUOTA,
        speechCounts: { ...(this.state.dayFlow.discussionSpeechCounts ?? {}) },
        remainingQuotaPlayers: this.alivePlayers().filter((player) =>
          (this.state.dayFlow.discussionSpeechCounts?.[player.id] ?? 0) <
          (this.state.dayFlow.discussionSpeechQuota ?? FREE_DISCUSSION_SPEECH_QUOTA),
        ).length,
        currentSpeaker: this.state.gameState.currentSpeaker,
        queue: (this.state.dayFlow.discussionQueue ?? []).map((entry) => ({
          playerId: entry.playerId,
          position: entry.position,
          enqueuedAt: entry.enqueuedAt,
          requestOrder: entry.requestOrder,
          source: entry.source,
          mentionCount: entry.mentionCount,
          priority: entry.priority,
          cycle: entry.cycle,
        })),
      },
      'public_timeline',
      undefined,
      correlationId,
    );
  }

  private refreshDiscussionQueueProjection(): void {
    const flow = this.state.dayFlow;
    if (
      (flow.discussionQueue === undefined || flow.discussionQueue.length === 0) &&
      flow.discussionMode === 'first_report' &&
      flow.speechQueue.length > 0
    ) {
      flow.discussionQueue = flow.speechQueue.map((playerId, index) => ({
        playerId,
        position: index + 1,
        enqueuedAt: this.now(),
        requestOrder: index + 1,
        source: 'first_report',
        mentionCount: 0,
        priority: 0,
      }));
    }
    const queue = flow.discussionQueue ?? [];
    queue.forEach((entry, index) => {
      entry.position = index + 1;
    });
    flow.speechQueue = queue.map((entry) => entry.playerId);
    this.state.gameState.speakerOrder = [...flow.speechQueue];
    this.state.gameState.daySpeechMode = flow.discussionMode ?? null;
    this.state.gameState.discussionQueue = structuredClone(queue);
    this.state.gameState.discussionMentionCounts = {
      ...(flow.discussionMentionCounts ?? {}),
    };
    this.state.gameState.discussionCycle = flow.discussionCycle ?? 0;
    this.state.gameState.discussionCyclesRequired =
      flow.discussionCyclesRequired ?? FREE_DISCUSSION_CYCLES;
    this.state.gameState.discussionSpeechQuota =
      flow.discussionSpeechQuota ?? FREE_DISCUSSION_SPEECH_QUOTA;
    this.state.gameState.discussionSpeechCounts = {
      ...(flow.discussionSpeechCounts ?? {}),
    };
  }

  private sortDiscussionQueue(): void {
    const flow = this.state.dayFlow;
    const currentSpeaker = this.state.gameState.currentSpeaker;
    flow.discussionQueue ??= [];
    flow.discussionQueue.sort((left, right) => {
      if (left.playerId === currentSpeaker) return -1;
      if (right.playerId === currentSpeaker) return 1;
      const waitScore = (entry: DiscussionQueueEntry): number =>
        Math.min(3, Math.floor(Math.max(0, this.now() - entry.enqueuedAt) / 10_000));
      const score = (entry: DiscussionQueueEntry): number =>
        entry.priority + Math.min(3, entry.mentionCount) * 2 + waitScore(entry);
      return score(right) - score(left) ||
        left.requestOrder - right.requestOrder ||
        left.enqueuedAt - right.enqueuedAt;
    });
    this.refreshDiscussionQueueProjection();
  }

  private removeDiscussionQueueEntry(playerId: PlayerId): void {
    const flow = this.state.dayFlow;
    flow.discussionQueue = (flow.discussionQueue ?? []).filter(
      (entry) => entry.playerId !== playerId,
    );
    this.refreshDiscussionQueueProjection();
  }

  private promoteDiscussionWaiters(): void {
    const flow = this.state.dayFlow;
    const now = this.now();
    for (const entry of flow.discussionQueue ?? []) {
      if (
        entry.source !== 'wait_timeout' &&
        now - entry.enqueuedAt >= DISCUSSION_WAIT_TIMEOUT_MS
      ) {
        entry.source = 'wait_timeout';
        entry.priority = 3;
      }
    }
  }

  private enqueueDiscussionPlayer(
    playerId: PlayerId,
    source: DiscussionQueueEntry['source'],
    priority: number,
  ): void {
    const flow = this.state.dayFlow;
    flow.discussionQueue ??= [];
    flow.discussionMentionCounts ??= {};
    flow.discussionSpeechQuota ??= FREE_DISCUSSION_SPEECH_QUOTA;
    flow.discussionSpeechCounts ??= {};
    if ((flow.discussionSpeechCounts[playerId] ?? 0) >= flow.discussionSpeechQuota) return;
    const mentionCount = Math.min(
      DISCUSSION_MENTION_LIMIT,
      flow.discussionMentionCounts[playerId] ?? 0,
    );
    const existing = flow.discussionQueue.find(
      (entry) => entry.playerId === playerId,
    );
    if (existing) {
      existing.source = source;
      existing.mentionCount = mentionCount;
      existing.priority = Math.max(
        existing.priority,
        mentionCount >= 2 ? 1 : priority,
      );
      this.sortDiscussionQueue();
      return;
    }
    flow.discussionRequestSequence = (flow.discussionRequestSequence ?? 0) + 1;
    flow.discussionQueue.push({
      playerId,
      position: flow.discussionQueue.length + 1,
      enqueuedAt: this.now(),
      requestOrder: flow.discussionRequestSequence,
      source,
      mentionCount,
      priority,
    });
    this.sortDiscussionQueue();
  }

  private recordDiscussionMentions(content: string, actorId: PlayerId): string[] {
    const flow = this.state.dayFlow;
    flow.discussionMentionCounts ??= {};
    flow.discussionMentionOrder ??= [];
    const normalized = content.toLocaleLowerCase();
    const mentioned = this.state.players
      .filter((player) => player.isAlive && player.id !== actorId)
      .filter((player) => {
        const name = player.name.trim().toLocaleLowerCase();
        if (!name) return false;
        return normalized.includes(`@${name}`) || normalized.includes(name);
      })
      .map((player) => player.id);
    for (const playerId of mentioned) {
      const count = Math.min(
        DISCUSSION_MENTION_LIMIT,
        (flow.discussionMentionCounts[playerId] ?? 0) + 1,
      );
      flow.discussionMentionCounts[playerId] = count;
      if (!flow.discussionMentionOrder.includes(playerId)) {
        flow.discussionMentionOrder.push(playerId);
      }
      if (flow.discussionMode === 'free_discussion') {
        if (this.state.gameState.currentSpeaker !== playerId) {
          this.enqueueDiscussionPlayer(
            playerId,
            'mention',
            count >= 2 ? 1 : 0,
          );
        }
        const entry = flow.discussionQueue?.find(
          (candidate) => candidate.playerId === playerId,
        );
        if (entry) {
          entry.mentionCount = count;
          entry.priority = Math.max(entry.priority, count >= 2 ? 1 : 0);
        }
      }
    }
    this.sortDiscussionQueue();
    return mentioned;
  }

  private beginExileResult(
    status: 'exiled' | 'no_exile',
    targetId: PlayerId | null,
    round: 1 | 2,
    tally: { counts: Readonly<Record<PlayerId, number>>; leaders: readonly PlayerId[]; maxVotes: number },
    ballots: VoteBallot[],
  ): void {
    this.state.dayFlow.stage = 'exile_result';
    this.state.dayFlow.pendingExile = {
      status,
      targetId,
      round,
      tally,
      ballots: structuredClone(ballots),
    };
    this.state.gameState.phase = 'day';
    this.state.gameState.dayStage = 'exile_result';
    this.state.gameState.currentSpeaker = null;
    this.state.gameState.votes = Object.fromEntries(
      ballots.map((ballot) => [ballot.voterId, ballot.targetId ?? '']),
    );
    this.advanceRevision();
  }

  private settleExileResult(correlationId: string): DomainEvent[] {
    const pending = this.state.dayFlow.pendingExile;
    if (!pending) return [];
    this.state.dayFlow.pendingExile = null;
    if (pending.status === 'no_exile') {
      this.state.gameState.votes = {};
      const noExile = this.event(
        'day.no_exile',
        {
          day: this.state.gameState.day,
          round: pending.round,
          voteHistory: pending.ballots,
        },
        'public_timeline',
        undefined,
        correlationId,
      );
      const dayEnd = this.finishDay(correlationId);
      return [noExile, ...dayEnd];
    }
    const exiled = this.state.players.find((player) => player.id === pending.targetId);
    if (!exiled) return [];
    exiled.isAlive = false;
    const eligibility = getLastWordsEligibility('exile');
    this.state.dayFlow.stage = 'last_words';
    this.state.dayFlow.speechQueue = [exiled.id];
    this.state.dayFlow.lastWordsPlayerId = exiled.id;
    this.state.dayFlow.lastWordsRemaining = eligibility.maxRounds;
    this.state.dayFlow.pendingHunterId = exiled.role === 'hunter' ? exiled.id : null;
    this.state.gameState.phase = 'day';
    this.state.gameState.dayStage = 'last_words';
    this.state.gameState.lastWordsPlayer = exiled.id;
    this.state.gameState.currentSpeaker = exiled.id;
    this.state.gameState.votes = {};
    this.advanceRevision();
    return [
      this.event(
        'day.exiled',
        {
          day: this.state.gameState.day,
          playerId: exiled.id,
          voteHistory: pending.ballots,
        },
        'public_timeline',
        undefined,
        correlationId,
      ),
    ];
  }

  private beginDayEnd(): void {
    this.state.dayFlow.stage = 'day_end';
    this.state.dayFlow.speechQueue = [];
    this.state.gameState.phase = 'day';
    this.state.gameState.dayStage = 'day_end';
    this.state.gameState.currentSpeaker = null;
    this.advanceRevision();
  }

  private completeDayEnd(correlationId: string): DomainEvent[] {
    const victory = this.finishIfWon(correlationId);
    if (victory.length > 0) return victory;
    this.beginNextNight();
    return [
      this.event(
        'night.started',
        { day: this.state.gameState.day },
        'public_timeline',
        undefined,
        correlationId,
      ),
    ];
  }

  private beginNextNight(): void {
    this.state.gameState.day += 1;
    this.state.gameState.turn += 1;
    this.state.gameState.phase = 'night';
    this.state.gameState.dayStage = null;
    this.state.gameState.currentSpeaker = null;
    this.state.gameState.speakerOrder = [];
    this.state.gameState.votes = {};
    this.state.gameState.nightActions = [];
    this.state.gameState.actionDone = {};
    this.state.gameState.wolfVotes = {};
    this.state.gameState.wolfDiscussionRound = 1;
    this.state.gameState.wolfSpeakerOrder = [];
    this.state.gameState.wolfCurrentSpeaker = null;
    this.state.gameState.wolfVoteComplete = false;
    this.state.gameState.guardianActionComplete = false;
    this.state.gameState.witchActionComplete = false;
    this.state.gameState.lastWordsPlayer = null;
    this.state.gameState.hunterShootTarget = null;
    this.state.night = createNightState();
    this.normalizeMissingNightActors();
    this.state.dayFlow = emptyDayFlow();
    this.advanceRevision();
  }

  private syncAuthorityFields(_incrementRevision: boolean): void {
    this.state.gameState.witchHasHealPotion =
      this.state.witchInventory.antidote > 0;
    this.state.gameState.witchHasPoisonPotion =
      this.state.witchInventory.poison > 0;
    this.state.gameState.voteRound = this.state.dayFlow.voteRound;
    this.state.gameState.voteCandidates = [
      ...this.state.dayFlow.voteCandidates,
    ];
    if (this.state.gameState.phase === 'night') {
      this.state.gameState.nightStage = this.state.night.stage;
      if (this.state.night.stage === 'wolf_discussion') {
        const wolves = this.alivePlayers('wolf').map((player) => player.id);
        this.state.gameState.wolfSpeakerOrder = wolves;
        if (!this.state.gameState.wolfCurrentSpeaker || !wolves.includes(this.state.gameState.wolfCurrentSpeaker)) {
          this.state.gameState.wolfCurrentSpeaker = wolves[0] ?? null;
        }
      }
    }
    if (this.state.gameState.phase === 'role_confirm') {
      this.state.gameState.nightStage = null;
      this.state.gameState.dayStage = null;
    }
    if (this.state.dayFlow.stage === 'speech' || this.state.dayFlow.stage === 'discussion') {
      this.state.dayFlow.discussionMode ??=
        this.state.dayFlow.stage === 'speech' ? 'first_report' : 'free_discussion';
      this.refreshDiscussionQueueProjection();
    } else {
      this.state.gameState.daySpeechMode = null;
      this.state.gameState.discussionQueue = [];
      this.state.gameState.discussionMentionCounts = {};
      this.state.gameState.discussionCycle = 0;
      this.state.gameState.discussionCyclesRequired = FREE_DISCUSSION_CYCLES;
      this.state.gameState.discussionSpeechQuota = FREE_DISCUSSION_SPEECH_QUOTA;
      this.state.gameState.discussionSpeechCounts = {};
    }
    const allowed = this.allowedActors();
    this.state.gameState.allowedActors = allowed;
    this.state.gameState.allowedActions = [
      ...new Set(allowed.flatMap((entry) => entry.actions)),
    ];
  }

  private allowedActors(): NonNullable<GameState['allowedActors']> {
    if (this.state.gameState.phase === 'ended') return [];
    if (this.state.gameState.phase === 'role_confirm') {
      return this.state.players
        .filter((player) => !this.state.roleConfirmations[player.id])
        .map((player) => ({
          playerId: player.id,
          actions: ['confirm_role'] as GameAction[],
        }));
    }
    if (this.state.gameState.phase === 'night') {
      const alive = (role: Role) => this.alivePlayers(role);
      switch (this.state.night.stage) {
        case 'guard_seer':
          return [
            ...(!this.state.night.guardComplete
              ? alive('guardian').map((player) => ({
                  playerId: player.id,
                  actions: ['guard', 'skip_night'] as GameAction[],
                }))
              : []),
            ...(!this.state.night.seerComplete
              ? alive('seer').map((player) => ({
                  playerId: player.id,
                  actions: ['check', 'skip_night'] as GameAction[],
                }))
              : []),
          ];
        case 'wolf_discussion':
          return alive('wolf')
            .filter((player) => player.id === this.state.gameState.wolfCurrentSpeaker)
            .map((player) => ({
              playerId: player.id,
              actions: ['wolf_speak', 'skip_speech'],
            }));
        case 'wolf_vote':
          return alive('wolf')
            .filter(
              (player) =>
                this.state.gameState.wolfVotes[player.id] === undefined,
            )
            .map((player) => ({
              playerId: player.id,
              actions: ['wolf_vote'],
            }));
        case 'witch':
          return this.state.gameState.witchActionComplete
            ? []
            : alive('witch').map((player) => ({
              playerId: player.id,
              actions: [
                ...(this.state.witchInventory.antidote > 0
                  ? (['heal'] as GameAction[])
                  : []),
                ...(this.state.witchInventory.poison > 0
                  ? (['poison'] as GameAction[])
                  : []),
                'skip_night',
              ],
              }));
        default:
          return [];
      }
    }
    if (
      this.state.dayFlow.stage === 'speech' ||
      this.state.dayFlow.stage === 'discussion' ||
      this.state.dayFlow.stage === 'last_words'
    ) {
      const playerId = this.state.gameState.currentSpeaker;
      if (this.state.dayFlow.stage === 'discussion' &&
          this.state.dayFlow.discussionMode === 'free_discussion') {
        const response = this.state.players
          .filter((player) => player.isAlive && player.id !== playerId)
          .map((player) => ({
            playerId: player.id,
            actions: ['request_speech'] as GameAction[],
          }));
        return playerId
          ? [{ playerId, actions: ['speak', 'skip_speech'] }, ...response]
          : response;
      }
      return playerId
        ? [{ playerId, actions: ['speak', 'skip_speech'] }]
        : [];
    }
    if (this.state.dayFlow.stage === 'voting') {
      const eligibility = getExileVoteEligibility(
        toCorePlayers(this.state.players),
        this.state.dayFlow.voteRound,
        this.state.dayFlow.voteCandidates,
      );
      return eligibility.voterIds
        .map((playerId) => ({
          playerId,
          actions: [
            'vote',
            ...(eligibility.abstainAllowed
              ? (['abstain'] as GameAction[])
              : []),
          ],
        }));
    }
    if (
      this.state.dayFlow.stage === 'hunter' &&
      this.state.dayFlow.pendingHunterId
    ) {
      return [
        {
          playerId: this.state.dayFlow.pendingHunterId,
          actions: ['hunter_shoot', 'skip_hunter_shot'],
        },
      ];
    }
    return [];
  }

  private setDeadline(): void {
    const stageStartedAt = this.now();
    // Dawn is an internal hand-off between the atomic night result and the
    // first public speech turn. A single-human room deliberately has no
    // deadlines for player-controlled stages, but leaving this passive stage
    // without a one-shot transition would leave it with neither an actor nor
    // a timer after the last AI night action commits.
    const autoAdvanceSingleHumanDawn =
      this.state.gameState.phase === 'day' &&
      this.state.dayFlow.stage === 'dawn' &&
      this.humanPlayerCount() === 1;
    const waitingForFreeDiscussion =
      this.state.gameState.phase === 'day' &&
      this.state.dayFlow.stage === 'discussion' &&
      this.state.gameState.currentSpeaker === null;
    if (this.state.gameState.phase === 'ended') {
      this.state.gameState.deadlineTs = null;
    } else if (autoAdvanceSingleHumanDawn) {
      this.state.gameState.deadlineTs = stageStartedAt;
    } else if (waitingForFreeDiscussion) {
      this.state.gameState.deadlineTs = stageStartedAt + DISCUSSION_WAIT_TIMEOUT_MS;
    } else if (this.humanPlayerCount() === 1) {
      this.state.gameState.deadlineTs = null;
    } else {
      this.state.gameState.deadlineTs = stageStartedAt + this.stageDurationMs;
    }
    this.state.gameState.stageStartedAt = stageStartedAt;
  }

  private humanPlayerCount(): number {
    return this.state.players.filter((player) => player.isAI !== true).length;
  }

  private scheduleDeadline(retryDelayMs?: number): void {
    if (this.timer !== undefined) this.scheduler.clear(this.timer);
    this.timer = undefined;
    const deadline = this.state.gameState.deadlineTs;
    if (deadline === null || this.state.gameState.phase === 'ended') return;
    const revision = this.stageRevision;
    this.timerRevision = revision;
    this.timer = this.scheduler.set(
      retryDelayMs ?? Math.max(0, deadline - this.now()),
      () => {
        void this.enqueueTimeout(revision).catch(() => undefined);
      },
    );
  }

  private enqueueTimeout(revision: number): Promise<void> {
    const run = this.queue.then(async () => {
      if (
        revision !== this.stageRevision ||
        revision !== this.timerRevision ||
        this.state.gameState.deadlineTs === null ||
        this.now() < this.state.gameState.deadlineTs
      ) {
        return;
      }
      const before = structuredClone(this.state);
      const correlationId = `timeout:${this.state.gameId}:${revision}`;
      const events = this.applyTimeout(correlationId);
      if (events.length === 0) {
        this.state = before;
        return;
      }
      this.syncAuthorityFields(false);
      this.state.aiMemories = updateAIMemoryBoards(
        this.state.aiMemories,
        events,
        this.state.players,
      );
      this.setDeadline();
      const committed = [
        this.event(
          'stage.timed_out',
          { revision },
          'public_timeline',
          undefined,
          correlationId,
        ),
        ...events,
        this.stateEvent(correlationId),
      ];
      try {
        await this.append(committed);
      } catch (error) {
        this.state = before;
        // Leave a retryable timer behind without recursively retrying in the
        // same scheduler turn when the store is still unavailable.
        this.scheduleDeadline(1);
        throw error;
      }
      try {
        await this.changed();
      } finally {
        this.scheduleDeadline();
      }
    });
    this.queue = run.catch(() => undefined);
    return run.then(() => undefined);
  }

  private applyTimeout(correlationId: string): DomainEvent[] {
    if (this.state.gameState.phase === 'role_confirm') {
      const events: DomainEvent[] = [];
      for (const player of this.state.players) {
        if (this.state.roleConfirmations[player.id]) continue;
        this.state.roleConfirmations[player.id] = true;
        events.push(
          this.event(
            'role.confirmed',
            { confirmed: true, timedOut: true },
            'role_private',
            [player.id],
            correlationId,
            player.id,
          ),
        );
      }
      this.beginFirstNight();
      events.push(
        this.event(
          'role.confirmation_completed',
          { day: this.state.gameState.day, timedOut: true },
          'public_timeline',
          undefined,
          correlationId,
        ),
      );
      return events;
    }
    if (this.state.gameState.phase === 'night') {
      if (this.state.night.stage === 'guard_seer') {
        if (!this.state.night.guardComplete) {
          this.state.night = completeGuard(this.state.night, null);
        }
        if (!this.state.night.seerComplete) {
          this.state.night = completeSeer(this.state.night, null);
        }
        this.normalizeSingleWolfDiscussion();
        this.advanceRevision();
        return [
          this.event(
            'night.roles_defaulted',
            {},
            'spectator_omniscient',
            undefined,
            correlationId,
          ),
        ];
      }
      if (this.state.night.stage === 'wolf_discussion') {
        const wolves = this.alivePlayers('wolf');
        if (this.state.gameState.wolfDiscussionRound < 2) {
          this.state.gameState.wolfDiscussionRound = 2;
          this.state.gameState.wolfCurrentSpeaker = wolves[0]?.id ?? null;
          this.advanceRevision();
          return [
            this.event(
              'wolf.discussion_timed_out',
              { round: 1 },
              'wolf_private',
              wolves.map((player) => player.id),
              correlationId,
            ),
            this.event(
              'wolf.discussion_round_started',
              { round: 2 },
              'wolf_private',
              wolves.map((player) => player.id),
              correlationId,
            ),
          ];
        }
        this.state.night = startWolfVote(this.state.night);
        this.advanceRevision();
        return [
          this.event(
            'wolf.discussion_timed_out',
            { round: 2 },
            'wolf_private',
            undefined,
            correlationId,
          ),
        ];
      }
      if (this.state.night.stage === 'wolf_vote') {
        const wolves = this.alivePlayers('wolf');
        const candidates = this.state.players
          .filter((player) => player.isAlive)
          .map((player) => player.id);
        for (const wolf of wolves) {
          if (this.state.gameState.wolfVotes[wolf.id] === undefined) {
            this.state.gameState.wolfVotes[wolf.id] =
              candidates[0] ?? '';
          }
        }
        const actor = wolves[0];
        return actor
          ? this.applyWolfVote(
              actor,
              this.state.gameState.wolfVotes[actor.id] || null,
              correlationId,
            ) ?? []
          : [];
      }
      if (this.state.night.stage === 'witch') {
        const witch = this.alivePlayers('witch')[0];
        if (!witch) {
          this.state.night = completeWitch(this.state.night, false, null);
          this.advanceRevision();
          return this.resolveNightAndAdvance(correlationId);
        }
        return (
          this.applyNightSkip(witch, 'heal', correlationId) ?? []
        );
      }
    }
    if (this.state.dayFlow.stage === 'dawn') {
      this.beginSpeech();
      return [
        this.event(
          'day.started',
          { day: this.state.gameState.day, stage: 'speech' },
          'public_timeline',
          undefined,
          correlationId,
        ),
      ];
    }
    if (
      this.state.dayFlow.stage === 'speech' ||
      this.state.dayFlow.stage === 'discussion' ||
      this.state.dayFlow.stage === 'last_words'
    ) {
      const actor = this.state.players.find(
        (player) => player.id === this.state.gameState.currentSpeaker,
      );
      if (!actor && this.state.dayFlow.stage === 'discussion') {
        this.beginVoting(1, []);
        return [
          this.event(
            'day.voting_started',
            { round: 1, discussionTimedOut: true },
            'public_timeline',
            undefined,
            correlationId,
          ),
        ];
      }
      return actor
        ? this.applySpeech(
            actor,
            {
              type: 'game.skip_speech',
              payload: {
                reason:
                  this.state.dayFlow.stage === 'last_words'
                    ? '超时未想到新的内容'
                    : undefined,
              },
            },
            correlationId,
          ) ?? []
        : [];
    }
    if (this.state.dayFlow.stage === 'voting') {
      const eligibility = getExileVoteEligibility(
        toCorePlayers(this.state.players),
        this.state.dayFlow.voteRound,
        this.state.dayFlow.voteCandidates,
      );
      for (const voterId of eligibility.voterIds) {
        if (this.state.dayFlow.votes[voterId] === undefined) {
          const targetId = eligibility.abstainAllowed
            ? null
            : eligibility.targetIds.find((id) => id !== voterId) ?? null;
          this.state.dayFlow.votes[voterId] = targetId;
        }
      }
      return this.resolveDayVote(correlationId);
    }
    if (this.state.dayFlow.stage === 'exile_result') {
      return this.settleExileResult(correlationId);
    }
    if (this.state.dayFlow.stage === 'day_end') {
      return this.completeDayEnd(correlationId);
    }
    if (this.state.dayFlow.stage === 'hunter') {
      const hunter = this.state.players.find(
        (player) => player.id === this.state.dayFlow.pendingHunterId,
      );
      return hunter
        ? this.applyHunterShot(hunter, null, correlationId) ?? []
        : [];
    }
    return [];
  }

  private stateEvent(
    correlationId: string,
    actorId?: string,
    commandId?: string,
  ): DomainEvent {
    const sessionState = structuredClone(this.state);
    // Command receipts contain their event arrays and are a runtime cache,
    // not game state. Persisting them inside every state event would make the
    // event stream grow quadratically (and recursively through clones).
    sessionState.processedCommands = {};
    return this.event(
      'game.state_updated',
      {
        gameState: structuredClone(this.state.gameState),
        players: structuredClone(this.state.players),
        sessionState,
        ...(commandId ? { commandId } : {}),
      },
      'spectator_omniscient',
      undefined,
      correlationId,
      actorId,
    );
  }

  private event(
    eventType: DomainEventType,
    payload: Record<string, unknown>,
    visibility: DomainEvent['visibility'],
    audienceIds?: string[],
    correlationId = `system:${randomUUID()}`,
    actorId?: string,
  ): DomainEvent {
    this.state.sequence += 1;
    const eventId = randomUUID();
    const resolvedAudienceIds =
      visibility === 'wolf_private' && audienceIds === undefined
        ? this.alivePlayers('wolf').map((player) => player.id)
        : audienceIds;
    return {
      eventId,
      roomId: this.state.roomId,
      gameId: this.state.gameId,
      sequence: this.state.sequence,
      occurredAt: this.now(),
      phase: this.state.gameState.phase,
      stage:
        this.state.gameState.phase === 'night'
          ? this.state.night.stage
          : this.state.dayFlow.stage,
      actorId,
      eventType,
      payload,
      visibility,
      audienceIds: resolvedAudienceIds,
      correlationId,
      schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
    };
  }

  private async append(events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    const stored = await this.eventStore.append({
      streamId: this.streamId(),
      expectedVersion: this.state.streamVersion,
      events,
    });
    this.state.streamVersion += stored.length;
  }

  /**
   * The room snapshot is only a cache of the projection. A process can die
   * after the event append and before onChanged persists that cache, so every
   * recovery starts by reconciling it with the event stream.
   */
  private async reconcileFromEventStream(): Promise<void> {
    const stored = await this.eventStore.read(this.streamId());
    if (stored.length === 0) {
      if (this.state.streamVersion !== 0) {
        throw new Error(
          `Game stream ${this.streamId()} is missing persisted events for snapshot version ${this.state.streamVersion}.`,
        );
      }
      this.storedEventCache = [];
      this.eventCacheLoaded = true;
      return;
    }

    for (let index = 0; index < stored.length; index += 1) {
      const expected = index + 1;
      if (stored[index].streamVersion !== expected) {
        throw new Error(`Game stream ${this.streamId()} has a non-contiguous version.`);
      }
    }

    const last = stored.at(-1)!;
    const stateEventIndex = [...stored]
      .map(({ event }, index) => ({ event, index }))
      .reverse()
      .find(({ event }) => event.eventType === 'game.state_updated');
    const payload = stateEventIndex?.event.payload as {
      sessionState?: unknown;
      commandId?: unknown;
    } | undefined;
    const persistedState = payload?.sessionState;

    // Streams written before the full session state was added can only be
    // trusted when the room snapshot is already at their exact version.
    if (!persistedState) {
      if (this.state.streamVersion !== last.streamVersion) {
        throw new Error(
          `Game stream ${this.streamId()} cannot replay an older state-event format from a stale room snapshot.`,
        );
      }
      this.storedEventCache = compactStoredEvents(stored);
      this.eventCacheLoaded = true;
      return;
    }

    if (
      typeof persistedState !== 'object' ||
      Array.isArray(persistedState) ||
      (persistedState as Partial<SessionState>).roomId !== this.state.roomId ||
      (persistedState as Partial<SessionState>).gameId !== this.state.gameId
    ) {
      throw new Error(`Game stream ${this.streamId()} does not match its room.`);
    }

    const recovered = structuredClone(persistedState as SessionState);
    recovered.streamVersion = last.streamVersion;
    recovered.sequence = Math.max(
      recovered.sequence,
      ...stored.map(({ event }) => event.sequence),
    );

    // state_updated is the commit marker for one command transaction. Rebuild
    // the runtime receipt cache from each committed transaction so a retry is
    // idempotent even after a process restart. The receipts themselves are
    // deliberately not embedded in sessionState (see stateEvent above).
    const stateEventIndexes = stored
      .map(({ event }, index) => ({ event, index }))
      .filter(({ event }) => event.eventType === 'game.state_updated');
    for (let index = 0; index < stateEventIndexes.length; index += 1) {
      const entry = stateEventIndexes[index];
      const commandId = (entry.event.payload as { commandId?: unknown }).commandId;
      if (typeof commandId !== 'string') continue;
      const previousIndex = stateEventIndexes[index - 1]?.index ?? -1;
      recovered.processedCommands[commandId] = {
        ok: true,
        events: stored
          .slice(previousIndex + 1, entry.index + 1)
          .map(({ event }) => structuredClone(event)),
      };
    }
    recovered.processedCommands = Object.fromEntries(
      Object.entries(recovered.processedCommands).slice(-400),
    );

    this.state = recovered;
    this.migrateSnapshot();
    this.storedEventCache = compactStoredEvents(stored);
    this.eventCacheLoaded = true;
  }

  private streamId(): string {
    return `game:${this.state.gameId}`;
  }

  private reject(code: NonNullable<CommandResult['code']>): CommandResult {
    return { ok: false, code, events: [] };
  }

  private alivePlayers(role?: Role): Player[] {
    return this.state.players.filter(
      (player) => player.isAlive && (role === undefined || player.role === role),
    );
  }

  private applyAliveState(players: readonly CorePlayer[]): void {
    const aliveById = new Map(players.map((player) => [player.id, player.alive]));
    this.state.players = this.state.players.map((player) => ({
      ...player,
      isAlive: aliveById.get(player.id) ?? player.isAlive,
    }));
  }

  private recordNightAction(action: NightAction): void {
    this.state.gameState.nightActions.push(action);
    this.state.gameState.actionDone[action.playerId] = true;
  }

  private advanceRevision(): void {
    this.state.gameState.stageRevision =
      (this.state.gameState.stageRevision ?? 0) + 1;
  }

  private stageKey(): string {
    return [
      this.state.gameState.phase,
      this.state.night.stage,
      this.state.dayFlow.stage,
      this.state.dayFlow.voteRound,
      this.state.dayFlow.lastWordsRemaining,
      this.state.gameState.currentSpeaker,
      this.state.gameState.wolfCurrentSpeaker,
    ].join(':');
  }

  private deadActorMayAct(actor: Player, command: GameCommand): boolean {
    return (
      (this.state.dayFlow.stage === 'last_words' &&
        this.state.dayFlow.lastWordsPlayerId === actor.id &&
        (command.type === 'game.speak' ||
          command.type === 'game.skip_speech')) ||
      (this.state.dayFlow.stage === 'hunter' &&
        this.state.dayFlow.pendingHunterId === actor.id &&
        command.type === 'game.hunter_shoot')
    );
  }

  private trimProcessedCommands(): void {
    const entries = Object.entries(this.state.processedCommands);
    if (entries.length <= 500) return;
    this.state.processedCommands = Object.fromEntries(entries.slice(-400));
  }

  private async changed(): Promise<void> {
    await this.onChanged?.(this);
  }

  private migrateSnapshot(): void {
    const legacy = this.state as SessionState & {
      processedCommandIds?: string[];
      dayFlow?: DayFlowState;
      aiPersonas?: AIPersonaAssignments;
      aiExperiences?: Record<string, AIExperienceAssignment>;
    };
    legacy.processedCommands ??= {};
    delete legacy.processedCommandIds;
    legacy.dayFlow ??= emptyDayFlow();
    legacy.dayFlow.voteReasons ??= {};
    legacy.dayFlow.speechDirection ??= null;
    legacy.dayFlow.speechStartPlayerId ??= null;
    legacy.dayFlow.pendingExile ??= null;
    legacy.dayFlow.discussionMentionCounts ??= {};
    legacy.dayFlow.discussionMentionOrder ??= [];
    legacy.dayFlow.discussionSpokenPlayerIds ??= [];
    legacy.dayFlow.discussionRequestSequence ??= 0;
    legacy.dayFlow.discussionCycle ??=
      legacy.dayFlow.discussionMode === 'free_discussion' ? 1 : 0;
    legacy.dayFlow.discussionCyclesRequired ??= FREE_DISCUSSION_CYCLES;
    legacy.dayFlow.discussionSpeechQuota ??= FREE_DISCUSSION_SPEECH_QUOTA;
    legacy.dayFlow.discussionSpeechCounts ??= {};
    legacy.dayFlow.discussionRequestReasons ??= {};
    if (legacy.dayFlow.discussionMode === undefined) {
      legacy.dayFlow.discussionMode = legacy.dayFlow.stage === 'discussion'
        ? 'free_discussion'
        : legacy.dayFlow.stage === 'speech' || legacy.dayFlow.stage === 'dawn'
          ? 'first_report'
          : null;
    }
    if (!legacy.dayFlow.discussionQueue ||
        legacy.dayFlow.discussionQueue.length === 0 && legacy.dayFlow.speechQueue.length > 0) {
      legacy.dayFlow.discussionQueue = legacy.dayFlow.speechQueue.map(
        (playerId, index) => ({
          playerId,
          position: index + 1,
          enqueuedAt: this.now(),
          requestOrder: index + 1,
          source: legacy.dayFlow.discussionMode === 'first_report'
            ? 'first_report'
            : 'mention',
          mentionCount: legacy.dayFlow.discussionMentionCounts?.[playerId] ?? 0,
          priority: 0,
        }),
      );
    }
    const gameState = legacy.gameState as AuthorityGameState;
    gameState.deadlineTs ??= null;
    gameState.stageStartedAt ??= null;
    gameState.dayStage ??= null;
    gameState.seerResults ??= {};
    gameState.wolfDiscussionRound ??= 1;
    gameState.wolfSpeakerOrder ??= [];
    gameState.wolfCurrentSpeaker ??= null;
    gameState.daySpeechMode ??= legacy.dayFlow.discussionMode ?? null;
    gameState.discussionQueue ??= structuredClone(legacy.dayFlow.discussionQueue ?? []);
    gameState.discussionMentionCounts ??= {
      ...(legacy.dayFlow.discussionMentionCounts ?? {}),
    };
    gameState.discussionCycle ??= legacy.dayFlow.discussionCycle ?? 0;
    gameState.discussionCyclesRequired ??=
      legacy.dayFlow.discussionCyclesRequired ?? FREE_DISCUSSION_CYCLES;
    gameState.discussionSpeechQuota ??=
      legacy.dayFlow.discussionSpeechQuota ?? FREE_DISCUSSION_SPEECH_QUOTA;
    gameState.discussionSpeechCounts ??= {
      ...(legacy.dayFlow.discussionSpeechCounts ?? {}),
    };
    legacy.roleConfirmations ??= Object.fromEntries(
      this.state.players.map((player) => [player.id, true]),
    );
    const memory = ensureAIMemoryBoards(
      (legacy as SessionState & { aiMemories?: AIMemoryBoards }).aiMemories,
      this.state.players,
      this.state.sequence,
    );
    (legacy as SessionState).aiMemories = memory.boards;
    this.memoryMigrationPending ||= memory.changed;
    const aiSeats = this.state.players.map(({ id, isAI }) => ({ id, isAI }));
    const personaIds = aiSeats.filter(({ isAI }) => isAI).map(({ id }) => id);
    const existingPersonas = legacy.aiPersonas;
    this.personaMigrationPending ||=
      existingPersonas
        ? Object.keys(existingPersonas).length !== personaIds.length ||
          personaIds.some((id) => !isAIPersonaId(existingPersonas[id]))
        : personaIds.length > 0;
    legacy.aiPersonas = ensureAIPersonaAssignments(
      legacy.aiPersonas,
      aiSeats,
      this.personaRandomIndex,
    );
    const existingExperiences = legacy.aiExperiences ?? {};
    const aiExperiences: Record<string, AIExperienceAssignment> = {};
    const roleSeatCounts = new Map<Role, number>();
    for (const player of this.state.players.filter(({ isAI }) => isAI === true)) {
      if (!player.role) continue;
      const existing = existingExperiences[player.id];
      if (
        existing &&
        existing.role === player.role &&
        typeof existing.experienceInstanceId === 'string' &&
        typeof existing.assetId === 'string' &&
        typeof existing.baseText === 'string'
      ) {
        aiExperiences[player.id] = existing;
        continue;
      }
      const roleIndex = roleSeatCounts.get(player.role) ?? 0;
      roleSeatCounts.set(player.role, roleIndex + 1);
      const assignment = experienceLibrary.getAssignment(
        player.role,
        `${this.state.roomId}:${player.role}:${roleIndex}:${player.id}`,
      );
      const experienceInstanceId = `exp:${createHash('sha256')
        .update(`${this.state.gameId}:${player.id}:${assignment.assetId}`)
        .digest('hex')
        .slice(0, 24)}`;
      aiExperiences[player.id] = {
        experienceInstanceId,
        assetId: assignment.assetId,
        role: player.role,
        baseText: assignment.text,
        revision: 0,
      };
    }
    this.state.aiExperiences = aiExperiences;
    // Older snapshots used top-level phases for day sub-stages. The runtime
    // keeps one authoritative day stage and exposes the old phase only to
    // readers that still understand the compatibility shape.
    if (['voting', 'vote', 'lastWords', 'hunterShoot'].includes(gameState.phase)) {
      gameState.phase = 'day';
    }
  }

  /** AI roles are assigned by the server and never need a human confirmation. */
  private confirmComputerRoles(): boolean {
    let changed = false;
    for (const player of this.state.players) {
      if (player.isAI !== true || this.state.roleConfirmations[player.id] === true) {
        continue;
      }
      this.state.roleConfirmations[player.id] = true;
      changed = true;
    }
    if (changed) this.syncAuthorityFields(false);
    return changed;
  }

  private normalizeMissingNightActors(): void {
    if (this.state.gameState.phase !== 'night') return;
    if (
      this.state.night.stage === 'guard_seer' &&
      this.alivePlayers('guardian').length === 0 &&
      !this.state.night.guardComplete
    ) {
      this.state.night = completeGuard(this.state.night, null);
    }
    if (
      this.state.night.stage === 'guard_seer' &&
      this.alivePlayers('seer').length === 0 &&
      !this.state.night.seerComplete
    ) {
      this.state.night = completeSeer(this.state.night, null);
    }
    this.normalizeSingleWolfDiscussion();
  }

  private normalizeSingleWolfDiscussion(): void {
    if (
      this.state.gameState.phase === 'night' &&
      this.state.night.stage === 'wolf_discussion' &&
      this.alivePlayers('wolf').length === 1
    ) {
      this.state.night = startWolfVote(this.state.night);
      this.state.gameState.wolfSpeakerOrder = [];
      this.state.gameState.wolfCurrentSpeaker = null;
    }
  }
}

const flowStart = (preferred: PlayerId | null, alive: readonly PlayerId[]): PlayerId =>
  preferred && alive.includes(preferred) ? preferred : alive[0];
