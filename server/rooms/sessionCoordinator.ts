import type { GameAction, Player } from '../../shared/types';
import type { GameCommand } from '../../shared/protocol';
import { AIOrchestrator } from '../ai/orchestrator';
import {
  AI_SPEECH_DELAY_MAX_MS,
  AI_SPEECH_DELAY_MIN_MS,
  AITurnScheduler,
  type AITurnTask,
} from '../ai/aiTurnScheduler';
import { buildAIRuntimeContext } from '../ai/runtimeContext';
import { PromptContextCache } from '../ai/promptContextCache';
import { experienceLibrary } from '../ai/experienceLibrary';
import type { AIProvider } from '../ai/types';
import type { AITelemetry } from '../ai/aiTelemetry';
import type { AILogger } from '../ai/types';
import type { InsightStore } from '../review/insightStore';
import type { GameSession } from '../session/gameSession';
import type { RoomRecord } from './types';

export interface SessionCoordinatorOptions {
  getRoom: (roomCode: string) => Promise<RoomRecord | undefined>;
  getSession: (roomCode: string) => GameSession | undefined;
  providerForRoom: (room: RoomRecord) => Promise<AIProvider>;
  insightStore?: InsightStore;
  timeoutMs?: number;
  now?: () => number;
  telemetry?: AITelemetry;
  logger?: AILogger;
  /** Server-owned delay between computer-player speech turns. */
  aiSpeechDelayMinMs?: number;
  aiSpeechDelayMaxMs?: number;
}

export interface ScheduleEligibleAIInput {
  roomCode: string;
  gameId?: string;
  stageRevision?: number;
  actorId?: string;
  actionClass?: string;
  autoRoom?: boolean;
}

const commandTypeForAction = (action: GameAction): GameCommand['type'] => {
  switch (action) {
    case 'confirm_role': return 'game.confirm_role';
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
  }
};

const projectPlayers = (players: readonly Player[], actorId: string, role: Player['role']): Player[] =>
  players.map((player) => ({
    ...player,
    role: player.id === actorId || role === 'wolf' && player.role === 'wolf' ? player.role : null,
    aiConfig: undefined,
  }));

/**
 * Coordinates durable session changes with one-action AI work.  A session
 * transition is the only thing that schedules the next action; no loop in
 * RoomService is allowed to invent additional transitions.
 */
export class SessionCoordinator {
  readonly contextCache = new PromptContextCache();
  readonly scheduler: AITurnScheduler;
  private closed = false;
  private readonly aiSpeechDelayMinMs: number;
  private readonly aiSpeechDelayMaxMs: number;

  constructor(private readonly options: SessionCoordinatorOptions) {
    this.aiSpeechDelayMinMs = Math.max(
      0,
      Math.floor(options.aiSpeechDelayMinMs ?? AI_SPEECH_DELAY_MIN_MS),
    );
    this.aiSpeechDelayMaxMs = Math.max(
      this.aiSpeechDelayMinMs,
      Math.floor(options.aiSpeechDelayMaxMs ?? AI_SPEECH_DELAY_MAX_MS),
    );
    this.scheduler = new AITurnScheduler(
      (task) => this.execute(task),
      undefined,
      this.options.logger,
    );
  }

  async scheduleEligibleAI(input: ScheduleEligibleAIInput | string, autoRoom = false): Promise<void> {
    if (this.closed) return;
    const request: ScheduleEligibleAIInput = typeof input === 'string'
      ? { roomCode: input, autoRoom }
      : input;
    const roomCode = request.roomCode.toUpperCase();
    const room = await this.options.getRoom(roomCode);
    const session = this.options.getSession(roomCode);
    if (!room || !session || room.status !== 'playing') return;
    const state = session.serialize().state;
    if (request.gameId && request.gameId !== state.gameId) return;
    if (request.stageRevision !== undefined && request.stageRevision !== session.stageRevision) return;
    const auto = request.autoRoom ?? room.config?.mode === 'quick_computer';
    const actorEntry = state.gameState.allowedActors?.find((entry) => {
      const player = state.players.find((candidate) => candidate.id === entry.playerId);
      return Boolean(player && (auto || player.isAI));
    });
    if (!actorEntry) return;
    if (request.actorId && request.actorId !== actorEntry.playerId) return;
    const actionClass = request.actionClass ?? actorEntry.actions[0];
    if (!actionClass) return;
    const task: AITurnTask = {
      roomCode,
      gameId: state.gameId,
      stageRevision: session.stageRevision,
      actorId: actorEntry.playerId,
      actionClass,
    };
    await this.scheduler.schedule(task);
  }

  pending(): string[] {
    return this.scheduler.pending();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.scheduler.close();
    this.contextCache.clear();
  }

  private async execute(task: AITurnTask & { signal: AbortSignal }): Promise<void> {
    if (this.closed || task.signal.aborted) return;
    const room = await this.options.getRoom(task.roomCode);
    const session = this.options.getSession(task.roomCode);
    if (!room || !session || room.status !== 'playing' || session.gameId !== task.gameId) return;
    if (session.stageRevision !== task.stageRevision) return;
    const state = session.serialize().state;
    const actorEntry = state.gameState.allowedActors?.find(
      (entry) => entry.playerId === task.actorId && entry.actions.includes(task.actionClass as GameAction),
    );
    const actor = state.players.find((player) => player.id === task.actorId);
    // Last-words and hunter stages intentionally authorize one dead actor.
    if (!actorEntry || !actor?.role) return;
    if (task.actionClass === 'confirm_role') {
      await session.dispatch(
        {
          commandId: `ai:${task.gameId}:${task.stageRevision}:${actor.id}:confirm_role`,
          actorId: actor.id,
          sentAt: this.options.now?.() ?? Date.now(),
          roomId: room.id,
          gameId: session.gameId,
          expectedStageRevision: task.stageRevision,
        },
        { type: 'game.confirm_role', payload: {} },
      );
      return;
    }
    if (isSpeechAction(task.actionClass)) {
      const delay = this.nextSpeechDelayMs();
      if (!(await waitForDelay(delay, task.signal))) return;
      // The stage may have timed out while the AI was waiting. Do not spend a
      // provider call on a speaker whose authoritative turn has already gone.
      const current = this.options.getSession(task.roomCode);
      const currentState = current?.serialize().state;
      if (
        !current ||
        current.gameId !== task.gameId ||
        current.stageRevision !== task.stageRevision ||
        !currentState?.gameState.allowedActors?.some(
          (entry) => entry.playerId === task.actorId && entry.actions.includes(task.actionClass as GameAction),
        )
      ) return;
    }
    const provider = await this.options.providerForRoom(room);
    const events = await this.contextCache.eventsFor(session, {
      kind: 'player',
      playerId: actor.id,
      role: actor.role,
    });
    const players = projectPlayers(state.players, actor.id, actor.role);
    const stage = state.gameState.phase === 'night' ? state.night.stage : state.dayFlow.stage;
    const promptContext = buildAIRuntimeContext({
      actorId: actor.id,
      role: actor.role,
      phase: state.gameState.phase,
      stage,
      dayNumber: state.gameState.day,
      roundNumber:
        state.dayFlow.stage === 'voting'
          ? state.dayFlow.voteRound
          : state.gameState.phase === 'night'
            ? state.gameState.wolfDiscussionRound
            : state.dayFlow.voteRound,
      players,
      visibleEvents: events,
      allowedActions: [task.actionClass as GameAction],
      voteCandidates: state.dayFlow.voteCandidates,
      guardianLastTarget: state.gameState.guardianLastTarget,
      witchHasHealPotion: state.gameState.witchHasHealPotion,
      witchHasPoisonPotion: state.gameState.witchHasPoisonPotion,
      hunterShotAvailable: actorEntry.actions.includes('hunter_shoot'),
      wolfVoteRound: state.gameState.wolfDiscussionRound,
      lastWordsRound:
        state.dayFlow.stage === 'last_words'
          ? 3 - state.dayFlow.lastWordsRemaining
          : undefined,
      lastWordsRoundsRemaining:
        state.dayFlow.stage === 'last_words'
          ? state.dayFlow.lastWordsRemaining
          : undefined,
      experience: [
        experienceLibrary.getReference(actor.role, session.stageRevision),
        this.options.insightStore ? await this.options.insightStore.getPromptReference(actor.role) : '',
      ].filter(Boolean).join('\n\n'),
    });
    const orchestrator = new AIOrchestrator(provider, this.options.now, {
      timeoutMs: this.options.timeoutMs,
      contextCache: this.contextCache,
      telemetry: this.options.telemetry,
      logger: this.options.logger,
    });
    await orchestrator.act(session, {
      roomId: room.id,
      gameId: session.gameId,
      playerId: actor.id,
      role: actor.role,
      phase: state.gameState.phase,
      stage,
      stageRevision: task.stageRevision,
      deadlineTs: state.gameState.deadlineTs,
      players,
      allowedActions: [task.actionClass as GameAction],
      allowedCommandTypes: [commandTypeForAction(task.actionClass as GameAction)],
      promptContext,
      signal: task.signal,
    });
  }

  private nextSpeechDelayMs(): number {
    if (this.aiSpeechDelayMinMs === this.aiSpeechDelayMaxMs) {
      return this.aiSpeechDelayMinMs;
    }
    return this.aiSpeechDelayMinMs + Math.floor(
      Math.random() * (this.aiSpeechDelayMaxMs - this.aiSpeechDelayMinMs + 1),
    );
  }
}

const isSpeechAction = (actionClass: string): boolean =>
  actionClass === 'speak' || actionClass === 'skip_speech' || actionClass === 'wolf_speak';

const waitForDelay = (delayMs: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
