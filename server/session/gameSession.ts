import { randomUUID } from 'node:crypto';
import type {
  DomainEvent,
  DomainEventType,
  EventStore,
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
import { VisibilityProjector } from '../events/projector';
import type {
  AuthorityGameState,
  CommandResult,
  DayFlowState,
  SessionOptions,
  SessionScheduler,
  SessionSnapshot,
  SessionState,
} from './types';

const DEFAULT_STAGE_DURATION_MS = 30_000;

const defaultScheduler: SessionScheduler = {
  set: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

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
  speechQueue: [],
  lastWordsPlayerId: null,
  lastWordsRemaining: 0,
  pendingHunterId: null,
});

const createGameState = (roomId: string): AuthorityGameState => ({
  roomId,
  phase: 'night',
  nightStage: 'guard_seer',
  stageRevision: 1,
  allowedActors: [],
  allowedActions: [],
  deadlineTs: null,
  dayStage: null,
  day: 1,
  turn: 1,
  votes: {},
  nightActions: [],
  winner: null,
  currentSpeaker: null,
  speakerOrder: [],
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
  dayPhase: {
    phase: 'round1',
    queue: [],
    interjectQueue: [],
    usedCount: {},
    discussionRounds: 0,
    allSkipped: true,
    interjectedThisRound: [],
    sorterId: null,
  },
  lastSorterId: null,
});

export class GameSession {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly projector = new VisibilityProjector();
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly scheduler: SessionScheduler;
  private readonly stageDurationMs: number;
  private readonly onChanged?: SessionOptions['onChanged'];
  private timer: unknown;
  private timerRevision = -1;
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
    this.scheduler = resolvedOptions.scheduler ?? defaultScheduler;
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
        witchInventory: { antidote: 1, poison: 1 },
        processedCommands: {},
        sequence: 0,
        streamVersion: 0,
      };
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

  get deadlineTs(): number | null {
    return this.state.gameState.deadlineTs;
  }

  get players(): Player[] {
    return structuredClone(this.state.players);
  }

  serialize(): SessionSnapshot {
    return { state: structuredClone(this.state) };
  }

  async initialize(): Promise<void> {
    if (this.state.streamVersion === 0) {
      this.setDeadline();
      await this.append([
        this.event(
          'game.started',
          { day: 1, stage: 'guard_seer' },
          'public_timeline',
          undefined,
          'system:game-start',
        ),
        this.stateEvent('system:game-start'),
      ]);
      await this.changed();
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

  async eventsFor(viewer: ViewerContext, afterSequence = 0) {
    const stored = await this.eventStore.read(this.streamId(), afterSequence);
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
    const events = await this.eventStore.read(this.streamId());
    return this.projector.projectSnapshot(events, viewer);
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

    const actor = this.state.players.find((player) => player.id === meta.actorId);
    if (!actor) return this.reject('ACTOR_NOT_FOUND');
    if (!actor.isAlive && !this.deadActorMayAct(actor, command)) {
      return this.reject('ACTOR_DEAD');
    }

    const beforeRevision = this.stageRevision;
    const beforeStageKey = this.stageKey();
    const events = this.applyCommand(actor, command, meta.commandId);
    if (!events) return this.reject('ACTION_NOT_ALLOWED');

    if (
      beforeStageKey !== this.stageKey() &&
      beforeRevision === this.stageRevision
    ) {
      this.advanceRevision();
    }
    this.syncAuthorityFields(false);
    if (beforeRevision !== this.stageRevision) this.setDeadline();
    const committed = [
      ...events,
      this.stateEvent(meta.commandId, meta.actorId),
    ];
    await this.append(committed);
    const result = { ok: true, events: committed } satisfies CommandResult;
    this.state.processedCommands[meta.commandId] = structuredClone(result);
    this.trimProcessedCommands();
    await this.changed();
    this.scheduleDeadline();
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
    if (this.state.gameState.phase === 'night') {
      return this.applyNightCommand(actor, command, correlationId);
    }
    if (command.type === 'game.speak' || command.type === 'game.skip_speech') {
      return this.applySpeech(actor, command, correlationId);
    }
    if (command.type === 'game.vote') {
      return this.applyDayVote(actor, command.payload.targetId, correlationId);
    }
    if (command.type === 'game.hunter_shoot') {
      return this.applyHunterShot(actor, command.payload.targetId, correlationId);
    }
    return null;
  }

  private applyNightCommand(
    actor: Player,
    command: GameCommand,
    correlationId: string,
  ): DomainEvent[] | null {
    if (command.type === 'game.wolf_speak') {
      if (
        actor.role !== 'wolf' ||
        this.state.night.stage !== 'wolf_discussion'
      ) {
        return null;
      }
      return [
        this.event(
          'wolf.message',
          { actorId: actor.id, content: command.payload.content.slice(0, 300) },
          'wolf_private',
          undefined,
          correlationId,
          actor.id,
        ),
      ];
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

    if (action.action === 'check' && action.targetId !== null) {
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
      this.recordNightAction(action);
      return [
        this.event(
          'seer.result',
          {
            targetId: action.targetId,
            alignment: getSeerResult(corePlayers, action.targetId),
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
      action === 'check'
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
    if (this.state.night.stage === 'wolf_discussion') {
      this.state.night = startWolfVote(this.state.night);
    }
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
        { day: this.state.gameState.day },
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
    if (
      (flow.stage !== 'speech' && !isLastWords) ||
      this.state.gameState.currentSpeaker !== actor.id
    ) {
      return null;
    }
    const events = [
      this.event(
        command.type === 'game.speak'
          ? 'day.speech'
          : 'day.speech_skipped',
        command.type === 'game.speak'
          ? {
              actorId: actor.id,
              content: command.payload.content.slice(0, 300),
              lastWords: isLastWords,
            }
          : {
              actorId: actor.id,
              lastWords: isLastWords,
              ...(isLastWords && command.payload.reason?.trim()
                ? { reason: command.payload.reason.trim().slice(0, 80) }
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
    flow.speechQueue.shift();
    if (flow.speechQueue.length > 0) {
      this.state.gameState.currentSpeaker = flow.speechQueue[0];
      this.advanceRevision();
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
    }
    return events;
  }

  private applyDayVote(
    actor: Player,
    targetId: string | null,
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
    flow.votes[actor.id] = targetId;
    this.state.gameState.votes[actor.id] = targetId ?? '';
    if (eligibility.voterIds.some((id) => flow.votes[id] === undefined)) {
      return [
        this.event(
          'day.vote_cast',
          { actorId: actor.id },
          'public_timeline',
          undefined,
          correlationId,
          actor.id,
        ),
      ];
    }
    return this.resolveDayVote(correlationId);
  }

  private resolveDayVote(correlationId: string): DomainEvent[] {
    const flow = this.state.dayFlow;
    const ballots: VoteBallot[] = Object.entries(flow.votes).map(
      ([voterId, targetId]) => ({ voterId, targetId }),
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
          },
          'public_timeline',
          undefined,
          correlationId,
        ),
      ];
    }
    if (result.status === 'no_exile') {
      const events = [
        this.event(
          'day.no_exile',
          { day: this.state.gameState.day, round: result.round, voteHistory: ballots },
          'public_timeline',
          undefined,
          correlationId,
        ),
      ];
      events.push(...this.finishDay(correlationId));
      return events;
    }

    const exiled = this.state.players.find(
      (player) => player.id === result.targetId,
    );
    if (!exiled) return [];
    exiled.isAlive = false;
    const eligibility = getLastWordsEligibility('exile');
    this.state.dayFlow.stage = 'last_words';
    this.state.dayFlow.lastWordsPlayerId = exiled.id;
    this.state.dayFlow.lastWordsRemaining = eligibility.maxRounds;
    this.state.dayFlow.pendingHunterId =
      exiled.role === 'hunter' ? exiled.id : null;
    this.state.gameState.phase = 'lastWords';
    this.state.gameState.lastWordsPlayer = exiled.id;
    this.state.gameState.currentSpeaker = exiled.id;
    this.advanceRevision();
    return [
      this.event(
        'day.exiled',
        {
          day: this.state.gameState.day,
          playerId: exiled.id,
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
      this.state.gameState.phase = 'hunterShoot';
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
    const start = alive[0];
    const order = start
      ? [...buildSpeechOrder(alive, start, 'clockwise')]
      : [];
    this.state.dayFlow = {
      ...emptyDayFlow(),
      stage: 'speech',
      speechQueue: order,
    };
    this.state.gameState.phase = 'day';
    this.state.gameState.dayStage = 'speech';
    this.state.gameState.currentSpeaker = order[0] ?? null;
    this.state.gameState.speakerOrder = order;
    this.state.gameState.nightStage = 'resolve';
    this.advanceRevision();
  }

  private beginVoting(round: 1 | 2, candidates: PlayerId[]): void {
    this.state.dayFlow.stage = 'voting';
    this.state.dayFlow.voteRound = round;
    this.state.dayFlow.voteCandidates = candidates;
    this.state.dayFlow.votes = {};
    this.state.gameState.phase = 'voting';
    this.state.gameState.dayStage = 'voting';
    this.state.gameState.currentSpeaker = null;
    this.state.gameState.votes = {};
    this.advanceRevision();
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
    if (this.state.gameState.phase === 'night') {
      this.state.gameState.nightStage = this.state.night.stage;
    }
    const allowed = this.allowedActors();
    this.state.gameState.allowedActors = allowed;
    this.state.gameState.allowedActions = [
      ...new Set(allowed.flatMap((entry) => entry.actions)),
    ];
  }

  private allowedActors(): NonNullable<GameState['allowedActors']> {
    if (this.state.gameState.phase === 'ended') return [];
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
          return alive('wolf').map((player) => ({
            playerId: player.id,
            actions: ['wolf_speak', 'wolf_vote'],
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
      this.state.dayFlow.stage === 'last_words'
    ) {
      const playerId = this.state.gameState.currentSpeaker;
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
        .filter((id) => this.state.dayFlow.votes[id] === undefined)
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
    this.state.gameState.stageStartedAt = this.now();
    this.state.gameState.deadlineTs =
      this.state.gameState.phase === 'ended'
        ? null
        : this.now() + this.stageDurationMs;
  }

  private scheduleDeadline(): void {
    if (this.timer !== undefined) this.scheduler.clear(this.timer);
    this.timer = undefined;
    const deadline = this.state.gameState.deadlineTs;
    if (deadline === null || this.state.gameState.phase === 'ended') return;
    const revision = this.stageRevision;
    this.timerRevision = revision;
    this.timer = this.scheduler.set(Math.max(0, deadline - this.now()), () => {
      void this.enqueueTimeout(revision);
    });
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
      const correlationId = `timeout:${this.state.gameId}:${revision}`;
      const events = this.applyTimeout(correlationId);
      if (events.length === 0) return;
      this.syncAuthorityFields(false);
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
      await this.append(committed);
      await this.changed();
      this.scheduleDeadline();
    });
    this.queue = run.catch(() => undefined);
    return run.then(() => undefined);
  }

  private applyTimeout(correlationId: string): DomainEvent[] {
    if (this.state.gameState.phase === 'night') {
      if (this.state.night.stage === 'guard_seer') {
        if (!this.state.night.guardComplete) {
          this.state.night = completeGuard(this.state.night, null);
        }
        if (!this.state.night.seerComplete) {
          this.state.night = completeSeer(this.state.night, null);
        }
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
        this.state.night = startWolfVote(this.state.night);
        this.advanceRevision();
        return [
          this.event(
            'wolf.discussion_timed_out',
            {},
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
    if (
      this.state.dayFlow.stage === 'speech' ||
      this.state.dayFlow.stage === 'last_words'
    ) {
      const actor = this.state.players.find(
        (player) => player.id === this.state.gameState.currentSpeaker,
      );
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
  ): DomainEvent {
    return this.event(
      'game.state_updated',
      {
        gameState: structuredClone(this.state.gameState),
        players: structuredClone(this.state.players),
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
    };
    legacy.processedCommands ??= {};
    delete legacy.processedCommandIds;
    legacy.dayFlow ??= emptyDayFlow();
    const gameState = legacy.gameState as AuthorityGameState;
    gameState.deadlineTs ??= null;
    gameState.stageStartedAt ??= null;
    gameState.dayStage ??= null;
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
  }
}
