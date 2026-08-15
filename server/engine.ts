import type { AIConfig, AIOutputSource, GameState, Message, Player, Role, NightAction } from '../shared/types';
import { randomInt, randomBytes } from 'node:crypto';
import {
  createInitialGameState,
  assignRoles,
  reassignRole,
  forceAssignRole,
  processNightActions,
  checkWinCondition,
  checkGoodOneLeftWin,
  determineVoteResult,
  createPlayer,
} from '../shared/gameLogic';
import { parseWitchDecision } from '../shared/gameLogic';
import { getRoleInfo } from '../shared/roleConfig';
import {
  callAIApi,
  generateAIVoteDecision,
  generateAIThought,
  resetExperienceCache,
  resetSpeechRepeatCache,
} from '../shared/aiClient';
import type { GameHistory } from '../shared/aiClient';
import { initGameMemory } from '../shared/memorySystem';
import {
  addReviewInsight,
  buildReviewPrompt,
  setReviewStorageBackend,
  type ReviewEvidence,
} from '../shared/experienceReview';
import { loadAIConfig } from './config';
import { loadReviewStore, saveReviewStore, addArchive, serverStorage } from './persistence';
import type { PersistedRoom } from './persistence';
import type {
  Snapshot,
  ReviewState,
  ArchiveRecord,
  ReviewStage,
  DebugSnapshot,
  DebugLogEntry,
  GameTimelineEvent,
  GameTimelineEventType,
  GameLogEvent,
} from '../shared/protocol';
import { redactSensitive } from '../shared/redact';
// The shared review helper uses a browser-shaped storage key. Map it to the
// server archive key so generated insights survive a process restart.
setReviewStorageBackend({
  get: (key) => serverStorage.get(key === 'wolf-exp-review-v1' ? 'review-insights' : key),
  set: (key, value) => serverStorage.set(key === 'wolf-exp-review-v1' ? 'review-insights' : key, value),
});

export interface EngineHub {
  broadcastRoom(roomCode: string): void;
  destroyRoom(roomCode: string): void;
  emitDebug?(roomCode: string, event: 'debug:snapshot' | 'debug:log'): void;
  persistRoom?(room: PersistedRoom): void;
  onTimelineEvent?(event: GameTimelineEvent): void;
  onArchive?(record: ArchiveRecord): void;
}

/**
 * AI 适配器（阶段 0b test-drive headless 注入点，可选）：
 * 缺省使用真实 aiClient 模块函数（行为零变化）；test-drive 注入 mock 驱动真实 engine。
 */
export interface EngineAIAdapter {
  callAIApi: typeof import('../shared/aiClient').callAIApi;
  generateAIVoteDecision: typeof import('../shared/aiClient').generateAIVoteDecision;
  generateAIThought: typeof import('../shared/aiClient').generateAIThought;
  resetExperienceCache: () => void;
  resetSpeechRepeatCache: () => void;
  /** Source label for AI output injected by a headless driver. */
  source?: AIOutputSource;
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 斗蛐蛐（纯 AI 自跑房）单房间对局数上限 —— 防公网 AI 成本放大（P1-6） */
export const AUTO_MAX_GAMES = 3;

export const generateRoomCode = (): string => {
  let code = '';
  for (let i = 0; i < 5; i++) code += ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)];
  return code;
};

/** 进入令牌（join token）：房主建房时生成，加入者凭「房间码 + 令牌」进入（P0-2） */
export const generateJoinToken = (): string => {
  const bytes = randomBytes(24);
  return [...bytes].map((byte) => TOKEN_CHARS[byte % TOKEN_CHARS.length]).join('');
};

interface DeathRecord {
  name: string;
  role: Role | null;
  day: number;
  reason: string;
}

const isSkipResponse = (text: string): boolean => {
  const t = (text || '').replace(/[，。！？!？\s]/g, '');
  return !t || t === '过' || t === '跳过' || t === '过过' || t === '没话说';
};

interface LastWordsAIResult {
  content: string;
  skipReason: string | null;
}

const parseLastWordsAIResult = (text: string): LastWordsAIResult => {
  const value = (text || '').trim();
  if (!value) return { content: '', skipReason: null };
  const match = /^(放弃遗言|跳过遗言|跳过|放弃|过过|过|没话说|不想说|懒得说)\s*(?:[：:,，；;-]\s*(.*))?$/u.exec(value);
  if (!match) return { content: value, skipReason: null };
  const explicitReason = match[2]?.trim() || '';
  const shortReason = ['没话说', '不想说', '懒得说'].includes(match[1]) ? match[1] : '';
  return {
    content: '',
    skipReason: explicitReason || shortReason || null,
  };
};
const MAX_MESSAGE_LENGTH = 1000;
const limitContent = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, MAX_MESSAGE_LENGTH) : '';

const NOW = () => new Date();

export class RoomEngine {
  readonly roomId: string;
  readonly roomCode: string;
  roomName: string;
  readonly maxPlayers: number;
  settings: { hunterShootOnGuardHealDeath: boolean; reviewEnabled: boolean };
  hostId: string | null = null;
  players: Player[] = [];
  spectators: Array<{ id: string; name: string }> = [];
  game: GameState | null = null;
  messages: Message[] = [];
  wolfChat: Message[] = [];
  review: ReviewState = { enabled: false, stage: 'idle', messages: [], team: null, startedAt: null };
  gameStarted = false;
  winnerTeam: 'wolf' | 'good' | null = null;
  aborted = false;
  /** 斗蛐蛐：纯 AI 房，开房即自动开局 */
  auto = false;
  connected: Record<string, boolean> = {};
  notice: string | null = null;
  deadlineTs: number | null = null;
  readonly debugMode: boolean;
  private debugSeq = 0;
  private debugEntries: DebugLogEntry[] = [];

  /** 进入令牌（P0-2）：加入者凭「房间码 + 令牌」进入 */
  readonly joinToken: string;
  /** 斗蛐蛐房主 = 创建房间的观战 socket（无真人房主时用此兜底） */
  creatorSpectatorId: string | null = null;
  creatorConnected = false;
  /** 斗蛐蛐累计对局数（P1-6 对局数上限） */
  autoGamesPlayed = 0;
  /** 斗蛐蛐已达对局上限，禁止再开 */
  autoExhausted = false;
  /** 斗蛐蛐创建者已离开 → 当前局结束后销毁房间（P1-6 自动房清理） */
  pendingDestroy = false;

  aiConfig: AIConfig;
  private hub: EngineHub;
  /** 阶段 0b：AI 适配器（可选，缺省=真实 aiClient；test-drive headless 注入用） */
  private aiAdapter: EngineAIAdapter | null = null;
  /** Optional headless escape hatch for tests that must not write archives. */
  private noArchive: boolean;

  // 局中辅助状态
  private dayDiscussionRound = 1;
  private dayVoteCount = 0;
  private tiePlayers: string[] = [];
  private tieDebateRound = 1;
  private isInTieDebate = false;
  private pendingHunterShoot = false;
  private afkPlayers: Record<string, boolean> = {};
  private deaths: DeathRecord[] = [];
  private gameHistory: GameHistory = { nightResults: [], votes: {}, deadPlayers: [] };
  private startVoteRequested = false;
  private turnDone = false;
  private wolfVotes: Record<string, string> = {};
  private wolfDecisions: Record<string, { targetId: string; intention: string; reason: string }> = {};
  private thinkingPlayers: Record<string, number> = {};
  private reviewInsights: Array<{ role: Role; text: string }> = [];
  private timelineEvents: GameTimelineEvent[] = [];
  private gameLogEvents: GameLogEvent[] = [];
  private voteReasons: Record<string, string> = {};
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private waiters: Array<() => void> = [];

  constructor(opts: {
    roomName: string;
    maxPlayers: number;
    reviewEnabled?: boolean;
    hunterShootOnGuardHealDeath?: boolean;
    auto?: boolean;
    hub: EngineHub;
    aiAdapter?: EngineAIAdapter;
    noArchive?: boolean;
    debugMode?: boolean;
    persisted?: PersistedRoom;
  }) {
    this.roomId = opts.persisted?.roomId || `r-${Math.random().toString(36).slice(2, 10)}`;
    this.roomCode = opts.persisted?.roomCode || generateRoomCode();
    this.joinToken = opts.persisted?.joinToken || generateJoinToken();
    this.roomName = opts.roomName || '联机房间';
    this.maxPlayers = opts.maxPlayers;
    this.auto = opts.auto ?? false;
    this.settings = {
      hunterShootOnGuardHealDeath: opts.hunterShootOnGuardHealDeath ?? true,
      reviewEnabled: opts.reviewEnabled ?? true,
    };
    this.hub = opts.hub;
    this.aiAdapter = opts.aiAdapter ?? null;
    this.noArchive = opts.noArchive ?? false;
    this.debugMode = opts.debugMode ?? false;
    this.aiConfig = loadAIConfig();
    if (opts.persisted) this.restore(opts.persisted);
  }

  /* ==================== AI 调用（headless 注入点） ==================== */

  private callAIApi(
    config: AIConfig,
    role: Role,
    playerName: string,
    players: Player[],
    messages: Message[],
    gamePhase: string,
    day: number,
    nightActions?: NightAction[],
    gameHistory?: GameHistory,
    currentSpeaker?: string,
    speakerOrder?: string[],
    wolfDiscussionRound?: number,
    playerId?: string,
    customUserPrompt?: string,
    isSorter?: boolean
  ): Promise<string> {
    return this.aiAdapter
      ? this.aiAdapter.callAIApi(config, role, playerName, players, messages, gamePhase, day, nightActions, gameHistory, currentSpeaker, speakerOrder, wolfDiscussionRound, playerId, customUserPrompt, isSorter)
      : callAIApi(config, role, playerName, players, messages, gamePhase, day, nightActions, gameHistory, currentSpeaker, speakerOrder, wolfDiscussionRound, playerId, customUserPrompt, isSorter);
  }

  private generateAIVoteDecision(
    config: AIConfig,
    role: Role,
    playerName: string,
    players: Player[],
    messages: Message[],
    gamePhase: string,
    day: number,
    tiePlayers?: string[],
    isInTieDebate?: boolean,
    playerId?: string
  ): Promise<{ targetId: string; reason: string }> {
    return this.aiAdapter
      ? this.aiAdapter.generateAIVoteDecision(config, role, playerName, players, messages, gamePhase, day, tiePlayers, isInTieDebate, playerId)
      : generateAIVoteDecision(config, role, playerName, players, messages, gamePhase, day, tiePlayers, isInTieDebate, playerId);
  }

  private generateAIThought(
    config: AIConfig,
    role: Role,
    playerName: string,
    players: Player[],
    messages: Message[],
    gamePhase: string,
    day: number,
    nightActions?: NightAction[],
    gameHistory?: GameHistory,
    playerId?: string,
    witchAntidoteUsed?: boolean
  ): Promise<string> {
    return this.aiAdapter
      ? this.aiAdapter.generateAIThought(config, role, playerName, players, messages, gamePhase, day, nightActions, gameHistory, playerId, witchAntidoteUsed)
      : generateAIThought(config, role, playerName, players, messages, gamePhase, day, nightActions, gameHistory, playerId, witchAntidoteUsed);
  }

  private resetAI() {
    if (this.aiAdapter) {
      this.aiAdapter.resetExperienceCache();
      this.aiAdapter.resetSpeechRepeatCache();
    } else {
      resetExperienceCache();
      resetSpeechRepeatCache();
    }
  }

  /* ==================== 加入 / 离开 ==================== */

  joinHuman(name: string): { playerId: string; isHost: boolean } {
    const isHost = this.players.length === 0 && !this.auto;
    const p = createPlayer(this.roomId, name, false, isHost, this.players.length + 1);
    p.isReady = false;
    this.players.push(p);
    this.connected[p.id] = true;
    if (isHost) this.hostId = p.id;
    this.broadcast();
    return { playerId: p.id, isHost };
  }

  joinSpectator(name: string): { id: string } {
    const s = { id: `sp-${Math.random().toString(36).slice(2, 9)}`, name };
    this.spectators.push(s);
    this.broadcast();
    return s;
  }

  /** 玩家离线（挂机保护：不踢出，标记离线；局中由超时逻辑接管）/ 重连恢复 */
  setConnected(playerId: string, online: boolean): void {
    this.connected[playerId] = online;
    if (online) {
      delete this.afkPlayers[playerId];
    } else {
      this.afkPlayers[playerId] = true;
      this.wake();
    }
    this.broadcast();
  }

  get connectedCount(): number {
    return Object.values(this.connected).filter(Boolean).length;
  }

  leaveHuman(playerId: string): void {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx >= 0) {
      const [leaver] = this.players.splice(idx, 1);
      this.connected[leaver.id] = false;
      if (this.hostId === leaver.id) {
        const nextHost = this.players.find((p) => !p.isAI);
        this.hostId = nextHost ? nextHost.id : null;
        this.players = this.players.map((p) => ({ ...p, isHost: p.id === this.hostId }));
      }
    }
    this.wake();
    this.broadcast();
  }

  leaveSpectator(id: string): void {
    this.spectators = this.spectators.filter((s) => s.id !== id);
    this.broadcast();
  }

  /* ==================== 广播 ==================== */

  broadcast(): void {
    this.hub.persistRoom?.(this.toPersistedRoom());
    this.hub.broadcastRoom(this.roomCode);
  }

  private toPersistedRoom(): PersistedRoom {
    return { roomId: this.roomId, roomCode: this.roomCode, roomName: this.roomName, maxPlayers: this.maxPlayers, joinToken: this.joinToken, hostId: this.hostId, players: this.players, spectators: this.spectators, game: this.game, messages: this.messages, wolfChat: this.wolfChat, timelineEvents: this.timelineEvents, gameLogEvents: this.gameLogEvents, gameStarted: this.gameStarted, winnerTeam: this.winnerTeam, aborted: this.aborted, auto: this.auto, settings: this.settings, debugMode: this.debugMode, savedAt: Date.now() };
  }

  private restore(room: PersistedRoom): void {
    this.hostId = room.hostId; this.players = room.players || []; this.spectators = room.spectators || [];
    this.game = room.game || null; this.messages = room.messages || []; this.wolfChat = room.wolfChat || [];
    this.timelineEvents = room.timelineEvents || [];
    this.gameLogEvents = room.gameLogEvents || [];
    this.gameStarted = !!room.gameStarted; this.winnerTeam = room.winnerTeam || null; this.aborted = !!room.aborted;
    this.settings = room.settings || this.settings; this.connected = {};
    this.players.forEach((player) => { this.connected[player.id] = false; });
  }

  private wake(): void {
    const ws = [...this.waiters];
    this.waiters = [];
    ws.forEach((w) => w());
  }

  private waitFor(
    pred: () => boolean,
    timeoutMs?: number,
    onTimeout?: () => void
  ): Promise<void> {
    this.deadlineTs = timeoutMs ? Date.now() + timeoutMs : null;
    this.broadcast();
    return new Promise((resolve) => {
      if (pred()) {
        resolve();
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        const i = this.waiters.indexOf(check);
        if (i >= 0) this.waiters.splice(i, 1);
        if (timer) clearTimeout(timer);
        this.deadlineTs = null;
      };
      const check = () => {
        if (pred()) {
          cleanup();
          resolve();
        }
      };
      if (timeoutMs) {
        timer = setTimeout(() => {
          cleanup();
          onTimeout?.();
          resolve();
        }, timeoutMs);
      }
      this.waiters.push(check);
    });
  }

  /* ==================== 消息 ==================== */

  private makeMessage(
    who: { id: string; name: string },
    content: string,
    type: Message['type'],
    source?: AIOutputSource,
  ): Message {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      roomId: this.roomId,
      playerId: who.id,
      playerName: who.name,
      content,
      timestamp: NOW(),
      type,
      ...(source ? { source } : {}),
    };
  }

  private aiOutputSource(): AIOutputSource {
    if (this.aiAdapter?.source) return this.aiAdapter.source;
    const config = this.aiConfig;
    if (config.apiType === 'siliconflow') {
      return config.siliconflow.apiKey.trim() ? 'real_ai' : 'template';
    }
    if (config.apiType === 'deepseek') {
      return config.deepseek.apiKey.trim() ? 'real_ai' : 'template';
    }
    return config.local.apiKey.trim() || config.local.apiUrl.trim()
      ? 'real_ai'
      : 'template';
  }

  private appendTimelineEvent(
    eventType: GameTimelineEventType,
    visibility: GameTimelineEvent['visibility'],
    payload: Record<string, unknown>,
    actor?: Player,
    source?: AIOutputSource,
  ): void {
    const event: GameTimelineEvent = {
      id: `${this.roomId}-${this.timelineEvents.length + 1}`,
      roomId: this.roomId,
      day: this.game?.day ?? 1,
      phase: this.game?.phase ?? 'waiting',
      occurredAt: new Date().toISOString(),
      eventType,
      visibility,
      payload,
      ...(actor ? { actorId: actor.id, actorName: actor.name } : {}),
      ...(source ? { source } : {}),
    };
    this.timelineEvents.push(event);
    const targetName = typeof payload.targetName === 'string' ? payload.targetName : undefined;
    const line = eventType === 'wolf.message'
      ? `第${event.day}晚 狼人讨论 ${event.actorName || '狼人'}: ${String(payload.content || '')}`
      : eventType === 'wolf.vote_cast'
      ? `第${event.day}晚 狼队投票 ${event.actorName || '狼人'}→${String(targetName || '跳过')}`
      : eventType === 'wolf.kill_locked'
      ? targetName
        ? `第${event.day}晚 狼人刀杀 ${targetName}`
        : `第${event.day}晚 狼人决定不杀人`
      : eventType === 'hunter.shot'
      ? `第${event.day}天 猎人开枪 ${String(targetName || '目标')}`
      : `第${event.day}天 猎人选择不开枪`;
    this.appendGameLog(line, source);
    this.appendReviewEvent({
      day: event.day,
      phase: event.phase === 'night' ? '夜间行动' : '猎人开枪',
      event: line,
      actor: event.actorName,
      target: targetName,
    });
    this.hub.onTimelineEvent?.(structuredClone(event));
  }

  getTimelineEvents(): GameTimelineEvent[] {
    return structuredClone(this.timelineEvents);
  }

  getGameLogEvents(): GameLogEvent[] {
    return structuredClone(this.gameLogEvents);
  }

  private addSystem(content: string): void {
    this.messages.push(this.makeMessage({ id: 'system', name: '系统' }, content, 'system'));
    if (content.startsWith('【公告】')) this.appendGameLog(content);
  }

  private appendGameLog(line: string, source?: AIOutputSource): void {
    this.gameLogEvents.push({
      id: `${this.roomId}-log-${this.gameLogEvents.length + 1}`,
      roomId: this.roomId,
      day: this.game?.day ?? 1,
      phase: this.game?.phase ?? 'waiting',
      line,
      ...(source ? { source } : {}),
    });
  }

  private appendReviewEvent(event: {
    day?: number;
    phase: string;
    event: string;
    actor?: string;
    target?: string;
  }): void {
    this.gameHistory.reviewTimeline = this.gameHistory.reviewTimeline || [];
    this.gameHistory.reviewTimeline.push({
      day: event.day ?? this.game?.day ?? 1,
      phase: event.phase,
      event: event.event,
      ...(event.actor ? { actor: event.actor } : {}),
      ...(event.target ? { target: event.target } : {}),
    });
  }

  private recordNightActionLog(
    actor: Player,
    action: 'check' | 'guard' | 'heal' | 'poison',
    target?: Player,
    result?: string,
  ): void {
    const targetName = target?.name || '无目标';
    const line = action === 'check'
      ? `第${this.game?.day ?? 1}晚 预言家查验 ${targetName} → ${result || '结果未记录'}`
      : action === 'guard'
      ? `第${this.game?.day ?? 1}晚 守卫守护 ${targetName}`
      : action === 'heal'
      ? `第${this.game?.day ?? 1}晚 女巫解药救 ${targetName}`
      : `第${this.game?.day ?? 1}晚 女巫毒杀 ${targetName}`;
    this.appendGameLog(line, actor.isAI ? this.aiOutputSource() : undefined);
    this.appendReviewEvent({
      phase: '夜间行动',
      event: line,
      actor: actor.name,
      target: target?.name,
    });
  }

  private recordSpeechLog(
    player: Player,
    content: string,
    kind: 'day' | 'free' | 'pk' | 'lastWords',
  ): void {
    const day = this.game?.day ?? 1;
    if (kind === 'free') this.appendGameLog(`第${day}天[自由讨论] 插话: ${player.name}`);
    const line = kind === 'pk'
      ? `第${day}天 PK ${player.name}: ${content}`
      : kind === 'lastWords'
      ? `第${day}天 ${player.name} 遗言: ${content}`
      : `第${day}天 ${player.name}: ${content}`;
    this.appendGameLog(line, player.isAI ? this.aiOutputSource() : undefined);
    this.appendReviewEvent({
      day,
      phase: kind === 'lastWords' ? '遗言' : kind === 'pk' ? 'PK争辩' : kind === 'free' ? '自由讨论' : '白天发言',
      event: content,
      actor: player.name,
    });
  }

  private recordLastWordsSkip(player: Player, reason: string): void {
    const day = this.game?.day ?? 1;
    const line = `第${day}天 ${player.name} 遗言：放弃（理由：${reason}）`;
    this.appendGameLog(line, player.isAI ? this.aiOutputSource() : undefined);
    this.appendReviewEvent({
      day,
      phase: '遗言',
      event: `放弃遗言（理由：${reason}）`,
      actor: player.name,
    });
  }

  private pushRepeat(playerName: string, speech: string, day?: number): void {
    // aiClient 内部已做复读检测与窗口记录，这里仅保留接口以对齐单机行为
    void playerName;
    void speech;
    void day;
  }

  private setThinking(playerId: string | null, progress: number | null): void {
    if (!playerId) return;
    if (progress === null) {
      delete this.thinkingPlayers[playerId];
    } else {
      this.thinkingPlayers[playerId] = progress;
    }
    this.broadcast();
  }

  /* ==================== 开局 ==================== */

  private addAIPlayers(count: number): void {
    const AI_NAMES = ['小明', '小红', '大壮', '小美', '老王', '小李', '阿强', '小芳', '阿志', '甜甜', '大头', '小翠'];
    const behaviors: Array<'aggressive' | 'conservative' | 'random'> = ['aggressive', 'conservative', 'random'];
    const cfg = this.aiConfig;
    for (let i = 0; i < count; i++) {
      const p = createPlayer(this.roomId, AI_NAMES[i % AI_NAMES.length], true, false, this.players.length + 1);
      p.isReady = true;
      p.aiConfig = {
        model: cfg.apiType === 'siliconflow' ? cfg.siliconflow.model : cfg.apiType === 'deepseek' ? cfg.deepseek.model : cfg.local.model,
        temperature: 0.9 + (Math.random() - 0.5) * 0.2,
        maxTokens: cfg.apiType === 'siliconflow' ? cfg.siliconflow.maxTokens : cfg.apiType === 'deepseek' ? cfg.deepseek.maxTokens : cfg.local.maxTokens,
        behavior: behaviors[i % behaviors.length],
      };
      this.players.push(p);
    }
  }

  fillAIPlayers(count?: number): void {
    const aiNeeded = count !== undefined ? count : Math.max(0, this.maxPlayers - this.players.length);
    if (aiNeeded > 0) this.addAIPlayers(aiNeeded);
    this.broadcast();
  }

  setReady(playerId: string): void {
    const p = this.players.find((x) => x.id === playerId);
    if (!p || p.isAI) return;
    p.isReady = true;
    this.broadcast();
  }

  allHumansReady(): boolean {
    const humans = this.players.filter((p) => !p.isAI);
    return humans.every((p) => p.isReady);
  }

  startGame(): void {
    if (!this.game && this.players.length >= 4 && this.allHumansReady()) {
      this.beginRoles();
    }
  }

  /** 斗蛐蛐 / 全部就绪后自动开局 */
  autoStartIfNeeded(): void {
    if (this.auto && !this.game && this.players.length >= 4) {
      this.beginRoles();
    }
  }

  private beginRoles(): void {
    this.players = assignRoles(this.players);
    this.game = createInitialGameState(this.roomId, this.players.map((p) => p.id));
    this.game.phase = 'roleSelect';
    this.gameStarted = true;
    this.deaths = [];
    this.gameHistory = { nightResults: [], votes: {}, deadPlayers: [] };
    this.review = { enabled: this.settings.reviewEnabled, stage: 'idle', messages: [], team: null, startedAt: null };
    this.reviewInsights = [];
    this.timelineEvents = [];
    this.gameLogEvents = [];
    this.voteReasons = {};
    this.wolfChat = [];
    this.messages = [];
    this.resetAI();
    this.broadcast();
    this.addSystem(`🎴 已分配身份，等待房主确认角色`);
    this.broadcast();
    if (this.auto) {
      // 斗蛐蛐无真人房主 → 自动确认开局
      setTimeout(() => {
        if (this.game && this.game.phase === 'roleSelect') this.confirmRoles();
      }, 1200);
    }
  }

  confirmRoles(): void {
    if (!this.game || this.game.phase !== 'roleSelect') return;
    initGameMemory(this.roomId, this.players);
    this.game.phase = 'night';
    this.game.day = 1;
    this.game.wolfSpeakerOrder = this.players.filter((p) => p.role === 'wolf').map((p) => p.id);
    this.game.wolfCurrentSpeaker = this.game.wolfSpeakerOrder[0] || null;
    this.game.wolfDiscussionRound = 1;
    this.addSystem(`🌙 天黑了，第 1 晚降临。狼人请睁眼。`);
    this.broadcast();
    this.kick();
  }

  redrawRole(playerId: string): void {
    if (!this.game || this.game.phase !== 'roleSelect') return;
    this.players = reassignRole(this.players, playerId);
    this.broadcast();
  }

  forceAssignRole(playerId: string, role: Role): void {
    if (!this.game || this.game.phase !== 'roleSelect') return;
    this.players = forceAssignRole(this.players, playerId, role);
    this.broadcast();
  }

  reassignAllRoles(): void {
    if (!this.game || this.game.phase !== 'roleSelect') return;
    this.players = assignRoles(this.players);
    this.broadcast();
  }

  /* ==================== 流程泵 ==================== */

  private kick(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 停止对局（销毁房间 / 房主终止时调用） */
  destroy(): void {
    this.aborted = true;
    this.wake();
  }

  /** 斗蛐蛐创建者断开：无真人看管 → 当局打完即销毁（P1-6） */
  markCreatorLeft(): void {
    this.creatorConnected = false;
    if (this.running && this.game && !this.winnerTeam) {
      this.pendingDestroy = true;
    } else {
      this.hub.destroyRoom(this.roomCode);
    }
  }

  setCreatorConnected(online: boolean): void {
    this.creatorConnected = online;
    if (online) this.pendingDestroy = false;
  }

  private async loop(): Promise<void> {
    while (this.game && !this.aborted && !this.winnerTeam) {
      const phase = this.game.phase;
      try {
        if (phase === 'night') await this.runNight();
        else if (phase === 'day') await this.runDay();
        else if (phase === 'vote' || phase === 'voting') await this.runVote();
        else if (phase === 'lastWords') await this.runLastWords();
        else if (phase === 'hunterShoot') await this.runHunterShoot();
        else break;
      } catch (e) {
        console.error('[engine] 流程异常:', e);
        this.addSystem(`⚠ 服务端流程异常：${e instanceof Error ? e.message : String(e)}，本阶段暂停。`);
        this.broadcast();
        break;
      }
    }
    if (this.winnerTeam) {
      await this.finishGame();
    }
    this.running = false;
    if (this.pendingDestroy) {
      this.hub.destroyRoom(this.roomCode);
    } else if (this.auto && !this.creatorConnected && !this.game) {
      this.hub.destroyRoom(this.roomCode);
    }
  }

  private checkWinner(): boolean {
    if (!this.game) return false;
    const w = checkWinCondition(this.players);
    // v2.4.7b：好人仅存 1 人且狼人 ≥1 —— 夜晚狼刀后/猎人枪后不在此自动终局，
    // 保留白天流程的「抢救」空间；只在白天投票结束后由 forceEndIfGoodOneLeft 直接判狼胜进复盘。
    if (w === 'wolf' && checkGoodOneLeftWin(this.players) === 'wolf') {
      return false;
    }
    if (w) {
      this.winnerTeam = w;
      this.game.phase = 'ended';
      this.game.winner = w;
      this.addSystem(
        w === 'wolf'
          ? `🐺 狼人阵营获胜！（${this.players.filter((p) => p.role === 'wolf').length} 狼在场）`
          : `✨ 好人阵营获胜！所有狼人已被消灭。`
      );
      this.broadcast();
      return true;
    }
    return false;
  }

  /** v2.4.7b：白天票完（含 PK 判定）好人仅存 1 人且狼人 ≥1 → 直接判狼胜、跳过夜晚、立即进复盘 */
  private forceEndIfGoodOneLeft(): boolean {
    if (!this.game) return false;
    if (checkGoodOneLeftWin(this.players) === 'wolf') {
      this.winnerTeam = 'wolf';
      this.game.phase = 'ended';
      this.game.winner = 'wolf';
      this.addSystem('😢 好人仅存一人，结局已定——狼人胜。');
      this.broadcast();
      return true;
    }
    return false;
  }

  /* ==================== 夜晚 ==================== */

  private async runNight(): Promise<void> {
    if (!this.game || this.game.phase !== 'night') return;
    this.dayVoteCount = 0;
    this.tiePlayers = [];
    this.tieDebateRound = 1;
    this.isInTieDebate = false;
    this.game.witchActionComplete = false;
    this.game.guardianActionComplete = false;
    this.game.actionDone = {};
    this.game.nightActions = [];
    this.broadcast();

    await this.runWolfNight();
    if (this.winnerTeam || !this.game || this.game.phase !== 'night') return;

    await this.runGuardianNight();
    if (this.winnerTeam || !this.game || this.game.phase !== 'night') return;

    await this.runSeerNight();
    if (this.winnerTeam || !this.game || this.game.phase !== 'night') return;

    await this.runWitchNight();
    if (this.winnerTeam || !this.game || this.game.phase !== 'night') return;

    await this.resolveNight();
  }

  private aliveWolves(): Player[] {
    return this.players.filter((p) => p.role === 'wolf' && p.isAlive);
  }

  private async runWolfNight(): Promise<void> {
    if (!this.game) return;
    const wolves = this.aliveWolves();
    if (wolves.length === 0) {
      this.addSystem('🌑 没有狼人在场，夜晚无人行动。');
      this.broadcast();
      return;
    }

    this.game.wolfVotes = {};
    this.wolfVotes = {};
    this.wolfDecisions = {};
    this.game.wolfSpeakerOrder = wolves.map((w) => w.id);
    this.game.wolfDiscussionRound = 1;
    this.game.wolfCurrentSpeaker = wolves[0]?.id || null;
    this.broadcast();
    this.addSystem(`🐺 狼人开始夜间讨论（共 ${wolves.length} 狼）。`);
    this.broadcast();

    const maxRounds = wolves.length === 1 ? 2 : 3;
    for (let round = 1; round <= maxRounds; round++) {
      if (!this.game || this.game.phase !== 'night') return;
      this.game.wolfDiscussionRound = round;
      for (const w of wolves) {
        if (!this.game || this.game.phase !== 'night') return;
        if (!w.isAlive) continue;
        this.game.wolfCurrentSpeaker = w.id;
        this.broadcast();
        if (w.isAI) {
          const text = await this.callWolfDiscussion(w);
          if (text && !isSkipResponse(text)) {
            const source = this.aiOutputSource();
            this.wolfChat.push(this.makeMessage(w, text, 'wolf_chat', source));
            this.appendTimelineEvent(
              'wolf.message',
              'wolf_private',
              { content: text },
              w,
              source,
            );
            this.pushRepeat(w.name, text, this.game.day);
            this.broadcast();
          }
          await this.sleep(600);
        } else {
          // 人类狼发言不阻塞：等一小段让其在聊天框发言，随后自动进入下一人
          const sp = w.id;
          this.turnDone = false;
          await this.waitFor(() => this.turnDone || !this.game || this.game.phase !== 'night', 10000, () => {});
          if (this.game && this.game.currentSpeaker === sp && this.game.phase === 'night') {
            this.game.wolfCurrentSpeaker = this.nextWolfSpeaker(w.id);
            this.broadcast();
          }
        }
      }
      // 纯 AI 或已全部投票 → 两轮后收口
      if (this.game) this.game.wolfVoteComplete = round >= Math.min(maxRounds, 2);
      this.broadcast();
    }
    if (!this.game || this.game.phase !== 'night') return;

    // 投票
    for (const w of wolves) {
      if (!w.isAlive) continue;
      if (w.isAI) {
        const stated = this.aiWolfVoteTarget(w);
        const candidates = this.players.filter((x) => x.isAlive && x.role !== 'wolf');
        const targetId =
          stated === 'skip'
            ? 'skip'
            : stated || (candidates.length ? candidates[Math.floor(Math.random() * candidates.length)].id : 'skip');
        this.wolfVotes[w.id] = targetId;
        this.wolfDecisions[w.id] = {
          targetId,
          intention: targetId === 'skip' ? '跳过' : '击杀',
          reason: stated ? '讨论中明确目标' : '随机选择目标',
        };
        this.appendTimelineEvent(
          'wolf.vote_cast',
          'wolf_private',
          {
            targetId: targetId === 'skip' ? null : targetId,
            targetName: targetId === 'skip'
              ? null
              : this.players.find((p) => p.id === targetId)?.name ?? null,
            intention: this.wolfDecisions[w.id].intention,
            reason: this.wolfDecisions[w.id].reason,
          },
          w,
          this.aiOutputSource(),
        );
      } else {
        this.wolfVotes[w.id] = 'skip';
        this.broadcast();
        await this.waitFor(
          () => this.wolfVotes[w.id] !== 'skip' && this.wolfVotes[w.id] !== undefined,
          120000,
          () => {
            this.afkPlayers[w.id] = true;
            const alive = this.players.filter((p) => p.isAlive && p.id !== w.id);
            this.wolfVotes[w.id] = alive.length ? alive[Math.floor(Math.random() * alive.length)].id : 'skip';
          }
        );
        if (!this.timelineEvents.some(
          (event) => event.eventType === 'wolf.vote_cast' && event.actorId === w.id && event.day === this.game?.day,
        )) {
          const targetId = this.wolfVotes[w.id];
          this.appendTimelineEvent(
            'wolf.vote_cast',
            'wolf_private',
            {
              targetId: targetId === 'skip' ? null : targetId ?? null,
              targetName: targetId && targetId !== 'skip'
                ? this.players.find((p) => p.id === targetId)?.name ?? null
                : null,
              intention: targetId === 'skip' ? '跳过' : '击杀',
              reason: this.afkPlayers[w.id] ? '超时自动选择' : '狼群投票',
            },
            w,
          );
        }
      }
      this.game.wolfVotes = { ...this.wolfVotes };
      this.game.wolfVoteComplete = true;
      this.broadcast();
    }

    const killTarget = this.resolveWolfVote();
    const lockedTarget = killTarget && killTarget !== 'skip'
      ? this.players.find((p) => p.id === killTarget)
      : undefined;
    this.appendTimelineEvent(
      'wolf.kill_locked',
      'wolf_private',
      {
        targetId: lockedTarget?.id ?? null,
        targetName: lockedTarget?.name ?? null,
        votes: { ...this.wolfVotes },
      },
      undefined,
      wolves.every((wolf) => wolf.isAI) ? this.aiOutputSource() : undefined,
    );
    if (killTarget && killTarget !== 'skip') {
      const target = this.players.find((p) => p.id === killTarget);
      this.game.nightActions.push({ playerId: 'wolf', action: 'kill', targetId: killTarget });
      this.addSystem(`🐺 狼人决定袭击 ${target?.name || '某位玩家'}。`);
    } else {
      this.addSystem('🐺 狼人今晚决定不杀人。');
    }
    this.broadcast();
  }

  private nextWolfSpeaker(currentId: string): string | null {
    if (!this.game) return null;
    const order = this.game.wolfSpeakerOrder.filter((id) => {
      const p = this.players.find((x) => x.id === id);
      return p && p.isAlive && p.role === 'wolf';
    });
    const i = order.indexOf(currentId);
    return order[(i + 1) % order.length] ?? null;
  }

  private async callWolfDiscussion(w: Player): Promise<string> {
    if (!this.game) return '';
    this.setThinking(w.id, 20);
    try {
      const result = await this.callAIApi(
        this.aiConfig,
        'wolf',
        w.name,
        this.players,
        [...this.messages, ...this.wolfChat],
        '狼人讨论',
        this.game.day,
        this.game.nightActions,
        this.gameHistory,
        this.game.currentSpeaker || undefined,
        this.game.speakerOrder,
        this.game.wolfDiscussionRound,
        w.id
      );
      return result;
    } catch (e) {
      console.error('[engine] 狼人讨论 AI 失败:', e);
      return '';
    } finally {
      this.setThinking(w.id, null);
    }
  }

  private aiWolfVoteTarget(w: Player): string | null {
    const ownMsgs = this.wolfChat.filter((m) => m.playerId === w.id);
    const findByName = (t: string): string | null => {
      const p =
        this.players.find((x) => x.name === t) ||
        this.players.find((x) => x.name.includes(t) || t.includes(x.name));
      return p ? p.id : null;
    };
    for (let i = ownMsgs.length - 1; i >= 0; i--) {
      const m = ownMsgs[i].content;
      const match = m.match(/\{([^}]+)\}/);
      if (match) {
        const t = match[1].trim();
        if (t === '跳过' || t === 'skip' || t === '不杀') return 'skip';
        const id = findByName(t);
        if (id) return id;
      }
    }
    for (let i = ownMsgs.length - 1; i >= 0; i--) {
      const m = ownMsgs[i].content;
      if (/不杀|不刀|跳过|不下刀/.test(m)) return 'skip';
      for (const name of this.players.map((p) => p.name)) {
        if (new RegExp(`(刀|杀|投|票)\\s*${name}`, 'gi').test(m)) {
          const p = this.players.find((x) => x.name === name);
          if (p) return p.id;
        }
      }
    }
    return null;
  }

  private resolveWolfVote(): string | null {
    const wolves = this.aliveWolves();
    const targets = wolves.map((w) => this.wolfVotes[w.id]).filter(Boolean);
    if (targets.length === 0) return null;
    const count: Record<string, number> = {};
    targets.forEach((t) => (count[t] = (count[t] || 0) + 1));
    let max = 0;
    let best: string[] = [];
    Object.entries(count).forEach(([t, c]) => {
      if (c > max) {
        max = c;
        best = [t];
      } else if (c === max) {
        best.push(t);
      }
    });
    if (best.length === 0) return null;
    if (best.length === 1) return best[0];
    const nonSkip = best.filter((t) => t !== 'skip');
    return nonSkip.length ? nonSkip[Math.floor(Math.random() * nonSkip.length)] : 'skip';
  }

  private async runGuardianNight(): Promise<void> {
    if (!this.game) return;
    const guard = this.players.find((p) => p.role === 'guardian' && p.isAlive);
    if (!guard) return;
    if (this.game.guardianActionComplete) return;
    this.addSystem('🛡️ 守卫请行动。');
    this.broadcast();
    if (guard.isAI) {
      const targetId = await this.aiNightTarget(guard, 'guard');
      if (targetId) {
        this.game.nightActions.push({ playerId: guard.id, action: 'guard', targetId });
        const t = this.players.find((p) => p.id === targetId);
        this.recordNightActionLog(guard, 'guard', t);
        this.addSystem(`🛡️ 守卫守护了 ${t?.name || '目标'}。`);
      } else {
        this.appendReviewEvent({ phase: '夜间行动', event: '守卫选择跳过', actor: guard.name });
        this.addSystem('🛡️ 守卫选择跳过。');
      }
      this.game.guardianActionComplete = true;
      this.broadcast();
    } else {
      await this.waitFor(
        () => !!this.game && this.game.actionDone[guard.id] === true,
        120000,
        () => {
          this.afkPlayers[guard.id] = true;
          if (this.game) this.game.actionDone[guard.id] = true;
        }
      );
    }
  }

  private async runSeerNight(): Promise<void> {
    if (!this.game) return;
    const seers = this.players.filter((p) => p.role === 'seer' && p.isAlive);
    for (const seer of seers) {
      if (!this.game || this.game.phase !== 'night') return;
      if (this.game.actionDone[seer.id]) continue;
      this.addSystem('🔮 预言家请查验。');
      this.broadcast();
      if (seer.isAI) {
        const targetId = await this.aiNightTarget(seer, 'check');
        if (targetId) {
          this.game.nightActions.push({ playerId: seer.id, action: 'check', targetId });
          const t = this.players.find((p) => p.id === targetId);
          this.recordNightActionLog(seer, 'check', t, t?.role === 'wolf' ? '狼人' : t?.role ? '好人' : undefined);
          this.addSystem(`🔮 预言家查验了 ${t?.name || '目标'}。`);
          // v2.4.8 任务12：记录查验结果进 gameHistory.playerKnowledge（预言家记住验过谁/结果，供白天发言 + 夜间不重复查验）
          if (t && t.role) {
            this.gameHistory.playerKnowledge = this.gameHistory.playerKnowledge || {};
            const entry = this.gameHistory.playerKnowledge[t.name] || {
              name: t.name,
              suspiciousLevel: 0,
              checkResults: [],
            };
            entry.checkResults = entry.checkResults || [];
            entry.checkResults.push({ day: this.game.day, result: t.role === 'wolf' ? '狼人' : '好人' });
            this.gameHistory.playerKnowledge[t.name] = entry;
          }
          this.game.actionDone[seer.id] = true;
        }
      } else {
        await this.waitFor(
          () => !!this.game && this.game.actionDone[seer.id] === true,
          120000,
          () => {
            this.afkPlayers[seer.id] = true;
            if (this.game) this.game.actionDone[seer.id] = true;
          }
        );
      }
      this.broadcast();
    }
  }

  private async runWitchNight(): Promise<void> {
    if (!this.game) return;
    const witches = this.players.filter((p) => p.role === 'witch' && p.isAlive);
    for (const witch of witches) {
      if (!this.game || this.game.phase !== 'night') return;
      if (this.game.actionDone[witch.id]) continue;
      const killAction = this.game.nightActions.find((a) => a.action === 'kill');
      const killTarget = killAction?.targetId || null;
      const killTargetName = killTarget
        ? this.players.find((p) => p.id === killTarget)?.name || '玩家'
        : '某玩家';
      if (this.game.witchHasHealPotion && killTarget) {
        this.addSystem(`🧙 女巫得知 ${killTargetName} 被袭击，可用解药救人或用毒药毒人。`);
      } else {
        this.addSystem('🧙 女巫请行动（毒人 / 跳过）。');
      }
      this.broadcast();
      if (witch.isAI) {
        await this.aiWitchDecision(witch, killTarget);
        this.game.actionDone[witch.id] = true;
        this.broadcast();
      } else {
        await this.waitFor(
          () => !!this.game && this.game.actionDone[witch.id] === true,
          120000,
          () => {
            this.afkPlayers[witch.id] = true;
            if (this.game) this.game.actionDone[witch.id] = true;
          }
        );
      }
    }
  }

  private async aiNightTarget(p: Player, action: 'check' | 'guard' | 'kill' | 'hunter'): Promise<string | null> {
    if (!this.game) return null;
    this.setThinking(p.id, 30);
    try {
      if (action === 'guard') {
        // 守卫不能连续两晚守同一人
        const banned = this.game.guardianLastTarget;
        const candidates = this.players.filter((x) => x.isAlive && x.id !== banned);
        const targetId = await this.generateAIThought(
          this.aiConfig,
          'guardian',
          p.name,
          candidates.map((x) => ({ ...x, isAlive: true })),
          [...this.messages, ...this.wolfChat],
          '夜晚行动',
          this.game.day,
          this.game.nightActions,
          this.gameHistory,
          p.id
        );
        const target = candidates.find((x) => x.id === targetId);
        if (target) {
          this.game.guardianLastTarget = target.id;
          return target.id;
        }
        if (candidates.length) {
          const pick = candidates[Math.floor(Math.random() * candidates.length)];
          this.game.guardianLastTarget = pick.id;
          return pick.id;
        }
        return null;
      }
      if (action === 'check') {
        // v2.4.8 任务12：预言家不得重复查验已验过的人（配合 aiClient 提示词注入"已查验名单"）
        const checkedIds = new Set<string>();
        if (this.gameHistory.playerKnowledge) {
          Object.entries(this.gameHistory.playerKnowledge).forEach(([name, k]) => {
            if (k.checkResults && k.checkResults.length > 0) {
              const p = this.players.find((x) => x.name === name);
              if (p) checkedIds.add(p.id);
            }
          });
        }
        const candidates = this.players.filter((x) => x.isAlive && x.id !== p.id && !checkedIds.has(x.id));
        const targetId = await this.generateAIThought(
          this.aiConfig,
          'seer',
          p.name,
          this.players,
          this.messages,
          '夜晚行动',
          this.game.day,
          this.game.nightActions,
          this.gameHistory,
          p.id
        );
        const target = candidates.find((x) => x.id === targetId) || candidates[0];
        return target?.id || null;
      }
      if (action === 'hunter') {
        const candidates = this.players.filter((x) => x.isAlive && x.id !== p.id);
        const targetId = await this.generateAIThought(
          this.aiConfig,
          'hunter',
          p.name,
          this.players,
          this.messages,
          '猎人开枪',
          this.game.day,
          this.game.nightActions,
          this.gameHistory,
          p.id
        );
        const target = candidates.find((x) => x.id === targetId) || candidates[0];
        return target?.id || null;
      }
      return null;
    } catch (e) {
      console.error('[engine] AI 夜间目标失败:', e);
      return null;
    } finally {
      this.setThinking(p.id, null);
    }
  }

  private async aiWitchDecision(
    witch: Player,
    killTarget: string | null
  ): Promise<void> {
    if (!this.game) return;
    this.setThinking(witch.id, 30);
    try {
      const raw = await this.generateAIThought(
        this.aiConfig,
        'witch',
        witch.name,
        this.players,
        this.messages,
        '夜晚行动',
        this.game.day,
        this.game.nightActions,
        this.gameHistory,
        witch.id,
        !this.game.witchHasHealPotion
      );
      // v2.4.8 任务11：女巫决策原文完整落日志（round10 "p0" 乱码排查依据）
      console.log(`[engine] 女巫 ${witch.name} 决策原文:`, raw);
      const canHeal = this.game.witchHasHealPotion && !!killTarget;

      // v2.4.8 任务11：格式解析 + 容错（parseWitchDecision：解析失败/乱码 → 默认不用药）
      // v2.4.9 任务7：乱码（round11 "p4/p2/p7/p2"）→ action='unclear'，按合理默认决策：
      //   有人被刀且女巫活着且还有解药 → 默认用解药救人（不再永远不用药）；否则才跳过。
      const decision = parseWitchDecision(raw);
      let used = false;
      if (decision.action === 'unclear') {
        if (canHeal) {
          console.warn(`[engine] 女巫 ${witch.name} 决策原文乱码「${raw.trim().slice(0, 40)}」，按默认决策使用解药救人（有人被刀且女巫有解药）`);
          this.game.nightActions.push({ playerId: witch.id, action: 'heal', targetId: killTarget });
          this.recordNightActionLog(witch, 'heal', this.players.find((p) => p.id === killTarget));
          this.game.witchHasHealPotion = false;
          this.game.witchAntidoteUsed = true;
          this.addSystem(`🧙 女巫使用解药救了 ${this.players.find((p) => p.id === killTarget)?.name || '目标'}。`);
          used = true;
        } else {
          console.warn(`[engine] 女巫 ${witch.name} 决策原文乱码「${raw.trim().slice(0, 40)}」，无解药可救 → 跳过`);
        }
      } else if (decision.action === 'heal' && canHeal) {
        // 解药只能救被狼刀的目标：AI 点名了别的玩家 → 视为无效行动（不浪费解药），仅当目标就是被刀者才救
        const namedTarget = decision.target
          ? this.players.find((x) => x.id === killTarget && (x.name.includes(decision.target!) || decision.target!.includes(x.name)))
          : null;
        if (namedTarget || !decision.target) {
          const targetId = killTarget;
          this.game.nightActions.push({ playerId: witch.id, action: 'heal', targetId });
          this.recordNightActionLog(witch, 'heal', this.players.find((p) => p.id === targetId));
          this.game.witchHasHealPotion = false;
          this.game.witchAntidoteUsed = true;
          this.addSystem(`🧙 女巫使用解药救了 ${this.players.find((p) => p.id === targetId)?.name || '目标'}。`);
          used = true;
        } else {
          console.warn(`[engine] 女巫 ${witch.name} 救人目标「${decision.target}」≠ 被刀目标，忽略用药（不浪费解药）`);
        }
      } else if (decision.action === 'poison' && this.game.witchHasPoisonPotion) {
        const named = decision.target
          ? this.players.find(
              (x) => x.isAlive && x.id !== killTarget && x.id !== witch.id && x.name.includes(decision.target!)
            )
          : null;
        if (named) {
          this.game.nightActions.push({ playerId: witch.id, action: 'poison', targetId: named.id });
          this.recordNightActionLog(witch, 'poison', named);
          this.game.witchHasPoisonPotion = false;
          this.addSystem(`🧙 女巫使用毒药毒杀 ${named.name}。`);
          used = true;
        } else {
          console.warn(`[engine] 女巫 ${witch.name} 毒人目标「${decision.target}」不合法，忽略毒药`);
        }
      }
      if (!used) this.addSystem('🧙 女巫选择跳过。');
    } catch (e) {
      console.error('[engine] 女巫 AI 失败:', e);
    } finally {
      this.setThinking(witch.id, null);
    }
  }

  private async resolveNight(): Promise<void> {
    if (!this.game) return;
    const result = processNightActions(this.players, this.game.nightActions);
    this.players = result.players;
    const day = this.game.day;
    const killedHunter =
      result.killed.find((id) => this.players.find((p) => p.id === id)?.role === 'hunter') ||
      (this.players.find((p) => p.id === result.killed[0])?.role === 'hunter'
        ? result.killed[0]
        : null);
    const isGuardHealDeath = !!(
      result.guarded.includes(result.killed[0] || '') &&
      result.healed.includes(result.killed[0] || '') &&
      result.killed.length > 0
    );
    const allowShoot = this.settings.hunterShootOnGuardHealDeath || !isGuardHealDeath;

    result.killed.forEach((id) => {
      const p = this.players.find((x) => x.id === id);
      this.recordDeath(p, day, '狼刀');
      this.addSystem(`【公告】第${day}晚 死亡：${p?.name || '玩家'}（狼刀）`);
    });
    result.poisoned.forEach((id) => {
      const p = this.players.find((x) => x.id === id);
      this.recordDeath(p, day, '女巫毒');
      this.addSystem(`【公告】第${day}晚 死亡：${p?.name || '玩家'}（女巫毒）`);
    });
    this.gameHistory.nightResults.push({
      day,
      killed: result.killed[0] ? this.players.find((p) => p.id === result.killed[0])?.name : undefined,
      poisoned: result.poisoned[0] ? this.players.find((p) => p.id === result.poisoned[0])?.name : undefined,
      healed: result.healed[0] ? this.players.find((p) => p.id === result.healed[0])?.name : undefined,
      guarded: result.guarded[0] ? this.players.find((p) => p.id === result.guarded[0])?.name : undefined,
    });
    this.broadcast();

    if (this.checkWinner()) return;

    if (killedHunter && allowShoot) {
      this.pendingHunterShoot = true;
      this.game.phase = 'hunterShoot';
      this.game.lastWordsPlayer = killedHunter;
      this.game.hunterShootTarget = null;
      const h = this.players.find((p) => p.id === killedHunter);
      this.addSystem(`🔫 ${h?.name || '猎人'}（猎人）被杀害，可以开枪带走一人！`);
      this.broadcast();
      await this.runHunterShoot();
    } else {
      this.transitionToDay();
    }
  }

  /* ==================== 白天 ==================== */

  /** v2.4.8 任务15：每日局势摘要（公开信息黑板）——存活/死亡/阶段，写入事件日志 + gameHistory 供 AI 注入
   *  v2.4.10 任务2：摘要只含截至"上一晚结束"的信息——第N天摘要 = 第N-1晚及之前的死亡，
   *  过滤死亡记录的 day ≤ 当前天-1（防摘要标签含当晚刀杀 → 提前泄漏夜间信息）。
   */
  private buildSituationSummary(): string {
    const alive = this.players.filter((p) => p.isAlive);
    const cutoffDay = Math.max(0, (this.game?.day ?? 1) - 1);
    // Use the same ledger consumed by the AI prompt compressor. This keeps
    // the dawn blackboard and the overnight death line from disagreeing.
    const dead = this.gameHistory.deadPlayers
      .filter((d) => d.day <= cutoffDay)
      .map((d) => d.name);
    const day = this.game?.day ?? 1;
    const phaseText =
      this.game?.phase === 'vote' || this.game?.phase === 'voting'
        ? '投票'
        : this.game?.phase === 'night'
        ? '夜晚'
        : this.game?.phase === 'lastWords'
        ? '遗言'
        : '白天';
    return `第${day}天 ${phaseText}：场上存活 ${alive.length} 人（${alive.map((p) => p.name).join('、') || '无'}）；截至上一晚结束已出局 ${dead.length} 人（${dead.join('、') || '无'}）。`;
  }

  /**
   * Keep the legacy engine's public death ledger and AI history in lockstep.
   * System announcements are not a durable AI fact source: the prompt
   * compressor reads gameHistory.deadPlayers, so writing only this.deaths
   * makes a real death look like a peaceful night to the next prompt.
   */
  private recordDeath(player: Player | undefined, day: number, reason: string): void {
    const name = player?.name || '玩家';
    const role = player?.role || null;
    this.deaths.push({ name, role, day, reason });
    this.gameHistory.deadPlayers.push({ name, role, day, reason });
    this.appendReviewEvent({
      day,
      phase: reason.includes('投票') ? '白天放逐' : '夜间结算',
      event: `${name} ${reason}`,
      target: name,
    });
  }

  private transitionToDay(): void {
    if (!this.game) return;
    this.game.day += 1;
    const alive = this.players.filter((p) => p.isAlive);
    const queue = alive.map((p) => p.id).sort(() => Math.random() - 0.5);
    this.game.phase = 'day';
    this.game.speakerOrder = queue;
    this.game.currentSpeaker = queue[0] || null;
    // v2.4.10 任务1：指定今日"捋"人（逻辑梳理配额）——存活 AI 里选一个，且不能连天同一人（轮换）
    const aliveAI = alive.filter((p) => p.isAI);
    const prevSorter = this.game.lastSorterId;
    const sorterId =
      aliveAI.map((p) => p.id).find((id) => id !== prevSorter) ??
      aliveAI[0]?.id ??
      null;
    this.game.lastSorterId = sorterId;
    this.game.dayPhase = {
      phase: 'round1',
      queue,
      interjectQueue: [],
      usedCount: {},
      discussionRounds: 1,
      allSkipped: true,
      interjectedThisRound: [],
      sorterId,
    };
    this.dayDiscussionRound = 1;
    this.startVoteRequested = false;
    this.addSystem(`☀️ 天亮了，第 ${this.game.day} 天。`);
    // v2.4.8 任务15：每天天亮生成局势摘要（公开黑板），写入事件日志（可检查 AI 推理环境）+ 注入 AI 提示词
    const summary = this.buildSituationSummary();
    this.gameHistory.situationSummary = summary;
    this.addSystem(`【局势摘要】${summary}`);
    this.broadcast();
  }

  private async runDay(): Promise<void> {
    if (!this.game || this.game.phase !== 'day') return;
    // 第一轮发言
    if (this.game.dayPhase.phase === 'round1') {
      let guard = 0;
      while (
        this.game &&
        this.game.phase === 'day' &&
        this.game.dayPhase.phase === 'round1' &&
        guard++ < 100
      ) {
        const speakerId = this.game.currentSpeaker;
        if (!speakerId) break;
        const speaker = this.players.find((p) => p.id === speakerId);
        if (!speaker) {
          this.advanceDayTurn();
          continue;
        }
        this.turnDone = false;
        if (speaker.isAI) {
          this.broadcast();
          const text = await this.callDaySpeech(speaker, '白天发言');
          if (!this.game || this.game.phase !== 'day' || this.game.dayPhase.phase !== 'round1') return;
          if (text && !isSkipResponse(text)) {
            this.messages.push(this.makeMessage(speaker, text, 'public', this.aiOutputSource()));
            this.recordSpeechLog(speaker, text, 'day');
            this.game.dayPhase.allSkipped = false;
            this.broadcast();
          }
          this.advanceDayTurn();
          await this.sleep(400);
        } else {
          this.broadcast();
          await this.waitFor(
            () =>
              this.turnDone ||
              !this.game ||
              this.game.phase !== 'day' ||
              this.game.dayPhase.phase !== 'round1' ||
              this.game.currentSpeaker !== speakerId,
            60000,
            () => {
              this.afkPlayers[speakerId] = true;
              this.turnDone = true;
            }
          );
          if (this.game && this.game.currentSpeaker === speakerId) this.advanceDayTurn();
        }
      }
    }

    if (!this.game || this.game.phase !== 'day') return;

    // 自由讨论
    this.game.dayPhase.phase = 'free_discussion';
    this.game.dayPhase.interjectedThisRound = [];
    this.game.currentSpeaker = null;
    this.addSystem('💬 自由讨论开始，可随时插话。讨论几轮后即可发起投票。');
    this.broadcast();

    const aliveAI = this.players.filter((p) => p.isAlive && p.isAI);
    // v2.4.9 任务3：自由讨论配额/轮数上限 3 → 4（用户反馈讨论时间不够）
    const maxRounds = 4;
    for (let round = 1; round <= maxRounds; round++) {
      if (!this.game || this.game.phase !== 'day' || this.game.dayPhase.phase !== 'free_discussion') return;
      let spoke = 0;
      for (const p of aliveAI) {
        if (!this.game || this.game.phase !== 'day') return;
        const used = this.game.dayPhase.usedCount[p.id] || 0;
        if (used >= 5) continue;
        const text = await this.callDaySpeech(p, '自由讨论');
        if (!this.game || this.game.phase !== 'day') return;
        if (text && !isSkipResponse(text)) {
          this.messages.push(this.makeMessage(p, text, 'public', this.aiOutputSource()));
          this.recordSpeechLog(p, text, 'free');
          this.game.dayPhase.usedCount = { ...this.game.dayPhase.usedCount, [p.id]: used + 1 };
          this.game.dayPhase.allSkipped = false;
          spoke++;
          this.broadcast();
        }
        await this.sleep(500);
      }
      if (spoke === 0) break;
    }
    if (!this.game || this.game.phase !== 'day') return;

    this.game.dayPhase.discussionRounds = 4;
    this.broadcast();

    const anyHumanAlive = this.players.some((p) => p.isAlive && !p.isAI);
    if (!anyHumanAlive) {
      await this.sleep(1500);
      if (this.game && this.game.phase === 'day' && this.game.dayPhase.phase === 'free_discussion') {
        this.startVoteRequested = true;
      }
    } else {
      this.startVoteRequested = false;
      this.addSystem('🗳️ 所有人可以点击「发起投票」进入投票阶段。');
      this.broadcast();
      await this.waitFor(
        () =>
          this.startVoteRequested ||
          !this.game ||
          this.game.phase !== 'day',
        300000,
        () => {
          this.startVoteRequested = true;
        }
      );
    }
    if (this.game && this.game.phase === 'day' && this.game.dayPhase.phase === 'free_discussion' && this.startVoteRequested) {
      this.game.phase = 'vote';
      this.game.dayPhase.phase = 'voting';
      this.game.currentSpeaker = null;
      this.addSystem('🗳️ 进入投票阶段！');
      this.broadcast();
    }
  }

  private async callDaySpeech(p: Player, gamePhase: string): Promise<string> {
    if (!this.game) return '';
    this.setThinking(p.id, 20);
    try {
      const names = this.players.map((x) => x.name);
      void names;
      // v2.4.10 任务1：今天是捋人的 AI 字数放宽到 ≤300（其余人仍 ≤100/150）
      const isSorter = this.game.dayPhase.sorterId === p.id;
      return await this.callAIApi(
        this.aiConfig,
        p.role || 'villager',
        p.name,
        this.players,
        this.messages,
        gamePhase,
        this.game.day,
        this.game.nightActions,
        this.gameHistory,
        this.game.currentSpeaker || undefined,
        this.game.speakerOrder,
        undefined,
        p.id,
        undefined,
        isSorter
      );
    } catch (e) {
      console.error('[engine] AI 白天发言失败:', e);
      return '';
    } finally {
      this.setThinking(p.id, null);
    }
  }

  private advanceDayTurn(): void {
    if (!this.game || this.game.phase !== 'day') return;
    const queue = this.game.dayPhase.queue.filter((id) => {
      const p = this.players.find((x) => x.id === id);
      return p && p.isAlive;
    });
    const cur = this.game.currentSpeaker;
    const i = queue.indexOf(cur || '');
    this.game.currentSpeaker = queue[(i + 1) % queue.length] || null;
    if (i === queue.length - 1 || queue.length === 0) {
      // 一轮结束 → 自由讨论
      this.game.dayPhase.phase = 'free_discussion';
      this.game.dayPhase.allSkipped = false;
      this.game.currentSpeaker = null;
    }
    this.broadcast();
  }

  /* ==================== 投票 ==================== */

  private async runVote(): Promise<void> {
    if (!this.game || this.game.phase !== 'vote') return;
    const deadline = Date.now() + 180000;
    this.isInTieDebate = false;
    this.tiePlayers = [];
    this.tieDebateRound = 1;
    this.game.votes = {}; // 每天重新清空投票，防止沿用上一轮
    this.voteReasons = {};

    for (let round = 1; round <= 4; round++) {
      if (!this.game || this.game.phase !== 'vote') return;
      const alive = this.players.filter((p) => p.isAlive);
      const voters = this.isInTieDebate
        ? this.tiePlayers.map((id) => this.players.find((x) => x.id === id)).filter((x) => x && x.isAlive)
        : alive;
      for (const p of voters) {
        if (!this.game || this.game.phase !== 'vote') return;
        if (!p) continue;
        if (this.game.votes[p.id] !== undefined) continue;
        if (p.isAI) {
          const aliveTargets = this.players.filter((x) => x.isAlive && x.id !== p.id);
          const { targetId, reason } = await this.aiVote(p, this.tiePlayers, this.isInTieDebate);
          const finalTarget =
            targetId && this.players.find((x) => x.id === targetId)
              ? targetId
              : this.isInTieDebate && this.tiePlayers.length
              ? (this.players.find((x) => x.id !== p.id && this.tiePlayers.includes(x.id) && x.isAlive)?.id ?? 'skip')
              : aliveTargets.length
              ? aliveTargets[Math.floor(Math.random() * aliveTargets.length)].id
              : 'skip';
          this.game.votes = { ...this.game.votes, [p.id]: finalTarget };
          this.voteReasons[p.id] = reason;
          this.broadcast();
        } else {
          this.broadcast();
          await this.waitFor(
            () => this.game!.votes[p.id] !== undefined,
            Math.max(20000, deadline - Date.now()),
            () => {
              this.afkPlayers[p.id] = true;
              const aliveTargets = this.players.filter((x) => x.isAlive && x.id !== p.id);
              this.game!.votes = {
                ...this.game!.votes,
                [p.id]: this.isInTieDebate && this.tiePlayers.length
                  ? (aliveTargets.find((x) => this.tiePlayers.includes(x.id))?.id ?? 'skip')
                  : aliveTargets.length
                  ? aliveTargets[Math.floor(Math.random() * aliveTargets.length)].id
                  : 'skip',
              };
            }
          );
        }
      }

      // v2.4.9 任务5：投票记录是公开信息——把本轮投票（谁投谁）写入 playerKnowledge 记忆库，供 AI 分析票型
      this.recordPublicVotes(this.game.day, this.isInTieDebate ? 'PK' : '正常');

      const result = determineVoteResult(this.game.votes);
      if (result && result !== 'skip') {
        await this.applyVoteResult(result);
        return;
      }
      if (result === 'skip') {
        // 全员弃票 → 平安夜式跳过，直接进入夜晚
        this.addSystem('🗳️ 无人被投出（弃票居多），进入夜晚。');
        this.broadcast();
        if (this.game) this.game.phase = 'night';
        return;
      }
      // 平票 → 争辩 + PK
      const count: Record<string, number> = {};
      Object.values(this.game.votes).forEach((t) => {
        if (t && t !== 'skip') count[t] = (count[t] || 0) + 1;
      });
      const max = Math.max(0, ...Object.values(count));
      this.tiePlayers = Object.entries(count)
        .filter(([, c]) => c === max && max > 0)
        .map(([id]) => id);
      if (this.tiePlayers.length < 2) {
        // 极端：全部弃票 → 随机放逐一个存活玩家（推进流程，防死锁）
        const aliveTargets = this.players.filter((x) => x.isAlive);
        if (aliveTargets.length) {
          await this.applyVoteResult(aliveTargets[Math.floor(Math.random() * aliveTargets.length)].id);
        }
        return;
      }
      this.isInTieDebate = true;
      this.tieDebateRound = round;
      this.addSystem(
        `⚔️ 平票！${this.tiePlayers
          .map((id) => this.players.find((x) => x.id === id)?.name || '玩家')
          .join(' vs ')} 进入争辩加投（PK）第 ${round} 轮。`
      );
      this.broadcast();
      // 平票争辩发言（AI）
      for (const tId of this.tiePlayers) {
        const tp = this.players.find((x) => x.id === tId);
        if (!tp) continue;
        if (tp.isAI) {
          const text = await this.callTieDebate(tp);
          if (text && !isSkipResponse(text)) {
            this.messages.push(this.makeMessage(tp, text, 'public', this.aiOutputSource()));
            this.recordSpeechLog(tp, text, 'pk');
            this.broadcast();
          }
        } else {
          this.turnDone = false;
          await this.waitFor(() => this.turnDone, 30000, () => {});
        }
      }
      // PK 加投：只允许平票玩家投平票玩家（不能投自己）
      this.game.votes = {};
      this.voteReasons = {};
      const pkVoters = this.tiePlayers.map((id) => this.players.find((x) => x.id === id)).filter((x) => x && x.isAlive);
      for (const p of pkVoters) {
        if (!this.game || this.game.phase !== 'vote') return;
        if (!p) continue;
        const candidates = this.tiePlayers.filter((id) => id !== p.id && this.players.find((x) => x.id === id)?.isAlive);
        if (p.isAI) {
          const { targetId, reason } = await this.aiVote(p, this.tiePlayers, true);
          const pick = candidates.find((id) => id === targetId) || candidates[0];
          this.game.votes = { ...this.game.votes, [p.id]: pick || 'skip' };
          this.voteReasons[p.id] = reason;
          this.broadcast();
        } else {
          this.broadcast();
          await this.waitFor(
            () => !!this.game && this.game.votes[p.id] !== undefined,
            60000,
            () => {
              this.afkPlayers[p.id] = true;
              const pick = candidates[Math.floor(Math.random() * candidates.length)];
              if (this.game) this.game.votes = { ...this.game.votes, [p.id]: pick || 'skip' };
            }
          );
        }
      }
      this.recordPublicVotes(this.game.day, 'PK');
      const pkResult = determineVoteResult(this.game.votes);
      if (pkResult && pkResult !== 'skip') {
        await this.applyVoteResult(pkResult);
        return;
      }
      // PK 仍平 → 随机
      const candidates = this.tiePlayers.filter((id) => this.players.find((x) => x.id === id)?.isAlive);
      if (candidates.length) {
        await this.applyVoteResult(candidates[Math.floor(Math.random() * candidates.length)]);
        return;
      }
    }
    if (this.game && this.game.phase === 'vote') {
      const aliveTargets = this.players.filter((x) => x.isAlive);
      if (aliveTargets.length) {
        await this.applyVoteResult(aliveTargets[Math.floor(Math.random() * aliveTargets.length)].id);
      }
    }
  }

  private async aiVote(p: Player, tiePlayers: string[], isInTieDebate: boolean): Promise<{ targetId: string; reason: string }> {
    if (!this.game) return { targetId: '', reason: '' };
    this.setThinking(p.id, 30);
    try {
      const { targetId, reason } = await this.generateAIVoteDecision(
        this.aiConfig,
        p.role || 'villager',
        p.name,
        this.players,
        this.messages,
        '投票',
        this.game.day,
        tiePlayers,
        isInTieDebate,
        p.id
      );
      return { targetId, reason };
    } catch (e) {
      console.error('[engine] AI 投票失败:', e);
      return { targetId: '', reason: '' };
    } finally {
      this.setThinking(p.id, null);
    }
  }

  private async callTieDebate(p: Player): Promise<string> {
    if (!this.game) return '';
    this.setThinking(p.id, 20);
    try {
      return await this.callAIApi(
        this.aiConfig,
        p.role || 'villager',
        p.name,
        this.players,
        this.messages,
        '平票争辩',
        this.game.day,
        this.game.nightActions,
        this.gameHistory,
        p.id
      );
    } catch (e) {
      console.error('[engine] 平票争辩 AI 失败:', e);
      return '';
    } finally {
      this.setThinking(p.id, null);
    }
  }

  /**
   * v2.4.9 任务5：把当轮投票（谁投谁）写入 playerKnowledge.votes（公开信息），供 AI 分析票型。
   * 每个投票者记录 { day, target }，PK 轮同样记录（target 为平票玩家）。
   */
  private recordPublicVotes(day: number, phase: string): void {
    if (!this.game) return;
    this.gameHistory.playerKnowledge = this.gameHistory.playerKnowledge || {};
    const byId = (id: string): string | null => this.players.find((p) => p.id === id)?.name ?? null;
    Object.entries(this.game.votes).forEach(([voterId, targetId]) => {
      if (!targetId || targetId === 'skip') return;
      const voterName = byId(voterId);
      if (!voterName) return;
      const targetName = byId(targetId) || targetId;
      const entry = this.gameHistory.playerKnowledge[voterName] || {
        name: voterName,
        suspiciousLevel: 0,
        votes: [],
      };
      entry.votes = entry.votes || [];
      // 去重：同一天同一轮不重复记
      if (!entry.votes.some((v) => v.day === day && v.target === targetName)) {
        entry.votes.push({ day, target: targetName });
      }
      this.gameHistory.playerKnowledge[voterName] = entry;
    });
    this.gameHistory.votes = { ...this.game.votes };
    // 时间线公开记录（供 AI 票型分析）
    this.gameHistory.timeline = this.gameHistory.timeline || [];
    this.gameHistory.timeline.push({
      time: new Date().toISOString(),
      day,
      phase: `投票(${phase})`,
      event: Object.entries(this.game.votes)
        .filter(([, t]) => t && t !== 'skip')
        .map(([v, t]) => `${byId(v) ?? '玩家'}投→${byId(t) ?? t}`)
        .join('、') || '全员弃票',
    });
    Object.entries(this.game.votes).forEach(([voterId, targetId]) => {
      const voterName = byId(voterId) || '玩家';
      const targetName = targetId && targetId !== 'skip' ? byId(targetId) || targetId : '弃票';
      const reason = this.voteReasons[voterId];
      const line = `第${day}天 ${voterName} ${phase === 'PK' ? 'PK投' : '投'}→${targetName}${reason ? `（理由：${reason}）` : ''}`;
      this.appendGameLog(line);
      this.appendReviewEvent({
        day,
        phase: phase === 'PK' ? 'PK投票' : '公开投票',
        event: line,
        actor: voterName,
        target: targetName === '弃票' ? undefined : targetName,
      });
    });
  }

  private async applyVoteResult(targetId: string): Promise<void> {
    if (!this.game) return;
    const voted = this.players.find((p) => p.id === targetId);
    if (!voted) {
      this.game.phase = 'night';
      this.broadcast();
      return;
    }
    this.gameHistory.votes = { ...this.game.votes };
    this.players = this.players.map((p) => (p.id === targetId ? { ...p, isAlive: false } : p));
    this.recordDeath(voted, this.game.day, '被投票出局');
    this.addSystem(`【公告】第${this.game.day}天 被投票出局：${voted.name}`);
    this.broadcast();

    // A vote elimination always owns the last-words stage.  Victory is
    // evaluated after it (and a possible exile hunter shot), otherwise a
    // final wolf or the last good player ends the game before their prompt is
    // ever generated.
    this.game.phase = 'lastWords';
    this.game.lastWordsPlayer = targetId;
    this.pendingHunterShoot = voted.role === 'hunter';
    this.addSystem(
      voted.role === 'hunter'
        ? `💬 ${voted.name}（猎人）被投票出局，可以说遗言并开枪。`
        : `💬 ${voted.name} 可以说遗言。`
    );
    this.broadcast();
    await this.runLastWords();
    if (this.winnerTeam) return;
    const afterLastWords = this.game as GameState | null;
    if (afterLastWords && afterLastWords.phase === 'hunterShoot') await this.runHunterShoot();
    if (this.winnerTeam) return;
    if (this.checkWinner()) return;
    // v2.4.7b: retain the direct end condition, but only after the voted
    // player's last words (and hunter entitlement) have been completed.
    this.forceEndIfGoodOneLeft();
  }

  /* ==================== 遗言 / 猎人开枪 ==================== */

  private async runLastWords(): Promise<void> {
    if (!this.game || this.game.phase !== 'lastWords') return;
    const id = this.game.lastWordsPlayer;
    if (!id) {
      this.afterLastWords();
      return;
    }
    const p = this.players.find((x) => x.id === id);
    if (!p) {
      this.afterLastWords();
      return;
    }
    if (p.isAI) {
      this.broadcast();
      const text = await this.callLastWords(p);
      const result = parseLastWordsAIResult(text);
      if (result.content) {
        this.messages.push(this.makeMessage(p, result.content, 'public', this.aiOutputSource()));
        this.recordSpeechLog(p, result.content, 'lastWords');
        this.broadcast();
      } else if (result.skipReason) {
        this.recordLastWordsSkip(p, result.skipReason.slice(0, 80));
        this.addDebugLog('event', 'info', `${p.name} 放弃遗言（理由：${result.skipReason}）`);
        this.broadcast();
      } else {
        this.addDebugLog('error', 'error', `${p.name} 遗言缺失：AI 未提供发言或放弃理由`);
      }
      await this.sleep(500);
      this.afterLastWords();
    } else {
      this.turnDone = false;
      this.broadcast();
      await this.waitFor(
        () => this.turnDone || !this.game || this.game.phase !== 'lastWords',
        60000,
        () => {
          this.afkPlayers[id] = true;
          this.turnDone = true;
        }
      );
      this.afterLastWords();
    }
  }

  private afterLastWords(): void {
    if (!this.game) return;
    if (this.pendingHunterShoot) {
      this.game.phase = 'hunterShoot';
      this.game.hunterShootTarget = null;
      const h = this.players.find((p) => p.id === this.game.lastWordsPlayer);
      this.addSystem(`🔫 ${h?.name || '猎人'}（猎人）请选择开枪目标！`);
      this.broadcast();
      this.kick();
    } else {
      this.game.phase = 'night';
      this.game.lastWordsPlayer = null;
      this.addSystem('🌙 天黑了。');
      this.broadcast();
    }
  }

  private async callLastWords(p: Player): Promise<string> {
    if (!this.game) return '';
    this.setThinking(p.id, 20);
    try {
      return await this.callAIApi(
        this.aiConfig,
        p.role || 'villager',
        p.name,
        this.players,
        this.messages,
        '遗言',
        this.game.day,
        this.game.nightActions,
        this.gameHistory,
        this.game.currentSpeaker || undefined,
        this.game.speakerOrder,
        undefined,
        p.id
      );
    } catch (e) {
      console.error('[engine] 遗言 AI 失败:', e);
      return '';
    } finally {
      this.setThinking(p.id, null);
    }
  }

  private async runHunterShoot(): Promise<void> {
    if (!this.game || this.game.phase !== 'hunterShoot') return;
    const hunterId = this.game.lastWordsPlayer;
    const hunter = this.players.find((p) => p.id === hunterId && p.role === 'hunter');
    if (!hunter) {
      this.afterHunterShoot(null);
      return;
    }
    if (hunter.isAI) {
      const targetId = await this.aiNightTarget(hunter, 'hunter');
      if (targetId) {
        await this.afterHunterShoot(targetId);
      } else {
        this.addSystem('🔫 猎人选择不开枪。');
        this.broadcast();
        this.afterHunterShoot(null);
      }
    } else {
      this.broadcast();
      await this.waitFor(
        () => !!this.game && this.game.hunterShootTarget !== null,
        60000,
        () => {
          this.afkPlayers[hunterId] = true;
          const alive = this.players.filter((x) => x.isAlive && x.id !== hunterId);
          if (this.game && alive.length) this.game.hunterShootTarget = alive[Math.floor(Math.random() * alive.length)].id;
        }
      );
      if (this.game && this.game.hunterShootTarget) {
        await this.afterHunterShoot(this.game.hunterShootTarget);
      } else {
        this.afterHunterShoot(null);
      }
    }
  }

  private async afterHunterShoot(targetId: string | null): Promise<void> {
    if (!this.game) return;
    const hunter = this.players.find((p) => p.id === this.game?.lastWordsPlayer && p.role === 'hunter');
    const target = targetId ? this.players.find((p) => p.id === targetId) : undefined;
    this.appendTimelineEvent(
      targetId ? 'hunter.shot' : 'hunter.shot_skipped',
      'public_timeline',
      {
        hunterId: hunter?.id ?? this.game.lastWordsPlayer,
        targetId: target?.id ?? null,
        targetName: target?.name ?? null,
      },
      hunter,
      hunter?.isAI ? this.aiOutputSource() : undefined,
    );
    if (targetId) {
      this.players = this.players.map((p) => (p.id === targetId ? { ...p, isAlive: false } : p));
      this.recordDeath(target, this.game.day, '猎人枪');
      this.addSystem(`🔫 猎人开枪带走 ${target?.name || '目标'}！`);
      this.broadcast();
      if (this.checkWinner()) return;
    }
    this.game.phase = 'night';
    this.game.lastWordsPlayer = null;
    this.game.hunterShootTarget = null;
    this.pendingHunterShoot = false;
    this.addSystem('🌙 天黑了。');
    this.broadcast();
  }

  /* ==================== 人类操作入口 ==================== */

  handleAction(playerId: string, action: import('../shared/protocol').ClientAction): void {
    if (this.deadlineTs !== null && Date.now() > this.deadlineTs) {
      this.addDebugLog('event', 'warning', `拒绝逾期 action: ${action.t}`);
      return;
    }
    const p = this.players.find((x) => x.id === playerId);
    switch (action.t) {
      case 'ready':
        this.setReady(playerId);
        break;
      case 'start-game':
        if (!this.isOwner(playerId)) return;
        this.startGame();
        break;
      case 'confirm-roles':
        if (!this.isOwner(playerId)) return;
        this.confirmRoles();
        break;
      case 'redraw-role':
        if (!this.isOwner(playerId)) return;
        this.redrawRole(action.playerId);
        break;
      case 'force-assign-role':
        if (!this.isOwner(playerId)) return;
        this.forceAssignRole(action.playerId, action.role);
        break;
      case 'reassign-all':
        if (!this.isOwner(playerId)) return;
        this.reassignAllRoles();
        break;
      case 'speak': {
        if (!this.game) break;
        const content = limitContent(action.content);
        if (!content) break;
        const isAlive = !!p && p.isAlive;
        // 白天/遗言轮到本人 → 正常发言
        if (this.game.phase === 'day' && p && this.game.currentSpeaker === p.id) {
          this.messages.push(this.makeMessage(p, content, 'public'));
          this.recordSpeechLog(p, content, 'day');
          if (this.game.dayPhase.phase !== 'round1') {
            this.game.dayPhase.usedCount = {
              ...this.game.dayPhase.usedCount,
              [p.id]: (this.game.dayPhase.usedCount[p.id] || 0) + 1,
            };
          }
          this.game.dayPhase.allSkipped = false;
          this.turnDone = true;
          this.broadcast();
        } else if (this.game.phase === 'lastWords' && p && this.game.lastWordsPlayer === p.id) {
          this.messages.push(this.makeMessage(p, content, 'public'));
          this.recordSpeechLog(p, content, 'lastWords');
          this.turnDone = true;
          this.broadcast();
        } else if (this.game.phase === 'day' && p && isAlive && this.game.dayPhase.phase === 'free_discussion') {
          // 自由讨论插话（不计入当前发言者，计入自身配额）
          const used = this.game.dayPhase.usedCount[p.id] || 0;
          if (used < 5) {
            this.messages.push(this.makeMessage(p, content, 'public'));
            this.recordSpeechLog(p, content, 'free');
            this.game.dayPhase.usedCount = { ...this.game.dayPhase.usedCount, [p.id]: used + 1 };
            this.game.dayPhase.allSkipped = false;
            this.broadcast();
          }
        } else if (this.game.phase === 'night' && p && isAlive && p.role === 'wolf') {
          this.wolfChat.push(this.makeMessage(p, content, 'wolf_chat'));
          this.appendTimelineEvent('wolf.message', 'wolf_private', { content }, p);
          this.broadcast();
        }
        break;
      }
      case 'skip-speech': {
        if (!this.game) break;
        if (this.game.phase === 'day' && p && this.game.currentSpeaker === p.id) {
          this.turnDone = true;
          this.broadcast();
        } else if (this.game.phase === 'lastWords' && p && this.game.lastWordsPlayer === p.id) {
          const reason = action.reason?.trim();
          if (!reason) {
            this.addDebugLog('error', 'error', `${p.name} 遗言静默放弃：缺少理由`);
            return;
          }
          this.recordLastWordsSkip(p, reason.slice(0, 80));
          this.turnDone = true;
          this.broadcast();
        }
        break;
      }
      case 'start-vote': {
        if (!this.game || !p || !p.isAlive) break;
        if (this.game.phase === 'day' && this.game.dayPhase.phase === 'free_discussion') {
          this.startVoteRequested = true;
          this.wake();
        }
        break;
      }
      case 'vote': {
        if (!this.game || !p || !p.isAlive) break;
        if (this.game.phase !== 'vote' && this.game.phase !== 'voting') break;
        if (this.game.votes[p.id] !== undefined) break;
        let target = action.targetId;
        if (target !== 'skip' && !this.players.some((x) => x.id === target && x.isAlive && x.id !== p.id)) break;
        if (this.isInTieDebate && this.tiePlayers.length && !this.tiePlayers.includes(target)) {
          const valid = this.tiePlayers.find((id) => id !== p.id);
          target = valid || 'skip';
        }
        this.game.votes = { ...this.game.votes, [p.id]: target };
        this.voteReasons[p.id] = action.reason || '';
        this.wake();
        this.broadcast();
        break;
      }
      case 'wolf-speak': {
        if (!this.game || !p || !p.isAlive || p.role !== 'wolf' || this.game.phase !== 'night') break;
        const content = limitContent(action.content);
        if (!content) break;
        this.wolfChat.push(this.makeMessage(p, content, 'wolf_chat'));
        this.appendTimelineEvent('wolf.message', 'wolf_private', { content }, p);
        this.broadcast();
        break;
      }
      case 'wolf-vote':
      case 'wolf-execute-kill': {
        if (!this.game || !p || !p.isAlive || p.role !== 'wolf') break;
        if (this.game.phase !== 'night') break;
        const target = action.targetId === 'skip'
          ? 'skip'
          : this.players.find((x) => x.id === action.targetId && x.isAlive && x.role !== 'wolf')?.id;
        if (!target) break;
        this.wolfVotes[p.id] = target;
        this.wolfDecisions[p.id] = {
          targetId: target,
          intention: target === 'skip' ? '跳过' : '击杀',
          reason: action.t === 'wolf-vote' ? '狼群投票' : '直接执行',
        };
        this.appendTimelineEvent(
          'wolf.vote_cast',
          'wolf_private',
          {
            targetId: target === 'skip' ? null : target,
            targetName: target === 'skip' ? null : this.players.find((x) => x.id === target)?.name ?? null,
            intention: this.wolfDecisions[p.id].intention,
            reason: this.wolfDecisions[p.id].reason,
          },
          p,
        );
        this.game.wolfVotes = { ...this.wolfVotes };
        this.wake();
        this.broadcast();
        break;
      }
      case 'wolf-next-speaker': {
        if (!this.game || !p || p.role !== 'wolf') break;
        if (this.game.phase === 'night' && this.game.currentSpeaker === p.id) {
          this.game.wolfCurrentSpeaker = this.nextWolfSpeaker(p.id);
          this.wake();
          this.broadcast();
        }
        break;
      }
      case 'night-action': {
        if (!this.game || !p || !p.isAlive) break;
        if (this.game.phase !== 'night') break;
        const roleOk =
          (action.action === 'check' && p.role === 'seer') ||
          (action.action === 'heal' && p.role === 'witch') ||
          (action.action === 'poison' && p.role === 'witch') ||
          (action.action === 'guard' && p.role === 'guardian');
        if (!roleOk) break;
        const target = this.players.find((x) => x.id === action.targetId);
        if (!target || !target.isAlive || target.id === p.id) break;
        if (this.game.nightActions.some((a) => a.playerId === p.id && a.action === action.action)) break;
        if (action.action === 'heal' && !this.game.witchHasHealPotion) break;
        if (action.action === 'poison' && !this.game.witchHasPoisonPotion) break;
        this.game.nightActions.push({ playerId: p.id, action: action.action, targetId: target.id });
        this.game.actionDone = { ...this.game.actionDone, [p.id]: true };
        if (action.action === 'check') {
          this.recordNightActionLog(p, 'check', target, target.role === 'wolf' ? '狼人' : target.role ? '好人' : undefined);
        } else if (action.action === 'guard' || action.action === 'heal' || action.action === 'poison') {
          this.recordNightActionLog(p, action.action, target);
        }
        if (action.action === 'guard') {
          this.game.guardianActionComplete = true;
          // v2.4.10 任务3：人类守卫的守护目标同样落系统日志（round12 确认"没守还是没记录"——补齐）
          this.addSystem(`🛡️ 守卫守护了 ${target.name}。`);
        }
        if (action.action === 'heal') {
          this.game.witchHasHealPotion = false;
          this.game.witchAntidoteUsed = true;
        }
        if (action.action === 'poison') this.game.witchHasPoisonPotion = false;
        this.wake();
        this.broadcast();
        break;
      }
      case 'skip-night': {
        if (!this.game || !p || !p.isAlive) break;
        if (this.game.phase !== 'night') break;
        this.game.actionDone = { ...this.game.actionDone, [p.id]: true };
        if (p.role === 'guardian') {
          this.game.guardianActionComplete = true;
          this.appendReviewEvent({ phase: '夜间行动', event: '守卫选择跳过', actor: p.name });
          this.addSystem('🛡️ 守卫选择跳过。');
        }
        this.wake();
        this.broadcast();
        break;
      }
      case 'hunter-shoot': {
        if (!this.game || !p || p.role !== 'hunter') break;
        if (this.game.phase !== 'hunterShoot') break;
        const target = this.players.find((x) => x.id === action.targetId && x.isAlive);
        if (!target || target.id === p.id) break;
        this.game.hunterShootTarget = target.id;
        this.wake();
        this.broadcast();
        break;
      }
      case 'review-speak': {
        const content = limitContent(action.content);
        if (!content || !this.review.enabled || this.review.stage === 'idle' || this.review.stage === 'done') break;
        const who = p ? { id: p.id, name: p.name } : { id: 'spectator', name: '旁观者' };
        this.review.messages.push(this.makeMessage(who, content, 'public'));
        this.broadcast();
        break;
      }
      case 'restart': {
        if (this.isOwner(playerId) && this.winnerTeam && !this.autoExhausted) {
          this.restartRoom();
        }
        break;
      }
      case 'abort': {
        if (this.isOwner(playerId)) {
          this.aborted = true;
          this.addSystem('⛔ 房主中止游戏。');
          this.broadcast();
        }
        break;
      }
      case 'kick-player': {
        if (!this.isOwner(playerId)) return;
        this.kickPlayer(action.playerId);
        break;
      }
      case 'set-review': {
        if (!this.isOwner(playerId)) return;
        this.settings.reviewEnabled = !!action.enabled;
        this.review.enabled = this.settings.reviewEnabled;
        this.broadcast();
        this.addSystem(action.enabled ? '📋 复盘已开启（本局结束后生效）。' : '⏹ 复盘已关闭。');
        this.broadcast();
        break;
      }
      case 'destroy-room': {
        if (!this.isOwner(playerId)) return;
        this.destroy();
        break;
      }
      case 'transfer-host': {
        if (!this.isOwner(playerId)) return;
        this.transferHost(action.targetPlayerId);
        break;
      }
      case 'leave':
        if (p) this.leaveHuman(playerId);
        else if (this.spectators.some((s) => s.id === playerId)) this.leaveSpectator(playerId);
        break;
    }
  }

  /** 房间所有者：真人房主；斗蛐蛐无真人房主时 = 创建房间的观战者（P0-3） */
  private isOwner(actorId: string): boolean {
    const p = this.players.find((x) => x.id === actorId);
    if (p?.isHost) return true;
    if (this.auto && this.creatorSpectatorId && actorId === this.creatorSpectatorId) return true;
    return false;
  }

  transferHost(targetPlayerId: string): boolean {
    const target = this.players.find((p) => p.id === targetPlayerId && !p.isAI);
    if (!target) return false;
    this.hostId = target.id;
    this.players = this.players.map((p) => ({ ...p, isHost: p.id === this.hostId }));
    this.addSystem(`👑 房主已转移给 ${target.name}。`);
    this.addDebugLog('event', 'info', `房主转移: ${target.id}`);
    this.broadcast();
    return true;
  }

  private addDebugLog(category: DebugLogEntry['category'], level: DebugLogEntry['level'], text: string): void {
    if (!this.debugMode) return;
    this.debugEntries.push({ seq: ++this.debugSeq, ts: Date.now(), category, level, text: redactSensitive(text) });
    if (this.debugEntries.length > 200) this.debugEntries.shift();
    this.hub.emitDebug?.(this.roomCode, 'debug:log');
  }

  getDebugSnapshot(): DebugSnapshot {
    return {
      roomCode: this.roomCode,
      hostId: this.hostId || '',
      isHost: true,
      debugMode: this.debugMode,
      players: this.players.map((p) => ({ id: p.id, name: p.name, role: p.role, isAlive: p.isAlive, isAI: p.isAI })),
      gameState: this.game ? { ...this.game } : null,
      messages: [...this.messages],
      wolfChatMessages: [...this.wolfChat],
      thinkingPlayers: { ...this.thinkingPlayers },
      serverTime: Date.now(),
    };
  }

  getDebugLogs(): DebugLogEntry[] { return this.debugEntries.map((entry) => ({ ...entry })); }

  /** 房主踢出玩家（真人）：被踢者挂机标记 + 房主易主（P0-3） */
  kickPlayer(targetId: string): void {
    const target = this.players.find((x) => x.id === targetId);
    if (!target || target.isAI) return;
    const idx = this.players.findIndex((p) => p.id === targetId);
    if (idx >= 0) {
      const [leaver] = this.players.splice(idx, 1);
      this.connected[leaver.id] = false;
      delete this.afkPlayers[leaver.id];
      if (this.hostId === leaver.id) {
        const nextHost = this.players.find((p) => !p.isAI);
        this.hostId = nextHost ? nextHost.id : null;
        this.players = this.players.map((p) => ({ ...p, isHost: p.id === this.hostId }));
      }
    }
    this.addSystem(`👢 房主已将 ${target.name} 移出房间。`);
    this.broadcast();
  }

  private restartRoom(): void {
    this.game = null;
    this.gameStarted = false;
    this.winnerTeam = null;
    this.aborted = false;
    this.messages = [];
    this.wolfChat = [];
    this.timelineEvents = [];
    this.gameLogEvents = [];
    this.voteReasons = {};
    this.deaths = [];
    this.players = this.players.map((p) => ({ ...p, role: null, isAlive: true, isReady: p.isAI }));
    this.review = { enabled: this.settings.reviewEnabled, stage: 'idle', messages: [], team: null, startedAt: null };
    this.reviewInsights = [];
    this.addSystem('🔄 房间已重置，房主可重新开始。');
    this.broadcast();
  }

  /* ==================== 对局结束 + 复盘 ==================== */

  private async finishGame(): Promise<void> {
    if (this.winnerTeam) {
      this.appendGameLog(`第${this.game?.day ?? 1}天 游戏结束，${this.winnerTeam === 'wolf' ? '狼人' : '好人'}获胜`);
      // 斗蛐蛐对局数上限（P1-6）
      if (this.auto) {
        this.autoGamesPlayed += 1;
        if (this.autoGamesPlayed >= AUTO_MAX_GAMES) this.autoExhausted = true;
      }
      try {
        if (this.settings.reviewEnabled) {
          await this.runReview();
        } else {
          await this.archiveGame();
        }
      } catch (e) {
        console.error('[engine] 复盘异常:', e);
        this.review.stage = 'done';
        this.broadcast();
      }
    }
  }

  private buildSummary(): string {
    const dead = this.deaths.map((d) => `第${d.day}${d.reason.includes('投票') ? '天被投票出局' : d.reason.includes('毒') ? '晚女巫毒杀' : d.reason.includes('枪') ? '天猎人开枪' : '晚狼刀死亡'}`).join('；');
    const result = this.winnerTeam === 'wolf' ? '狼人获胜' : this.winnerTeam === 'good' ? '好人获胜' : '未分胜负';
    return `本局第${this.game?.day ?? 1}天结束，${result}；共 ${this.deaths.length} 人死亡（${dead || '无'}）。`;
  }

  private buildReviewEvidence(): ReviewEvidence {
    const tags = new Set<string>();
    this.deaths.forEach((death) => {
      if (death.reason.includes('投票')) tags.add('被投票出局');
      if (death.reason.includes('刀')) tags.add('狼刀');
      if (death.reason.includes('毒')) tags.add('女巫毒');
      if (death.reason.includes('枪')) tags.add('猎人开枪');
    });
    (this.gameHistory.reviewTimeline || []).forEach((event) => {
      const text = `${event.event} ${event.phase}`;
      if (text.includes('查验')) tags.add('查验');
      if (text.includes('投票')) tags.add('公开投票');
      if (text.includes('票型')) tags.add('公开票型');
      if (text.includes('守卫守护')) tags.add('守护');
      if (text.includes('女巫')) tags.add('女巫');
      if (text.includes('刀口')) tags.add('刀口');
    });
    return { tags: [...tags] };
  }

  private async runReview(): Promise<void> {
    this.review.enabled = true;
    this.review.startedAt = Date.now();
    this.review.messages = [];
    this.addSystem(`📋 本局复盘开始（第${this.game?.day ?? 1}天结束，${this.winnerTeam === 'wolf' ? '🐺狼人胜' : '✨好人胜'}）。`);
    this.broadcast();

    // 阶段1：同阵营对账（狼队内部 → 好人队内部）
    await this.runTeamReviewStage('team-wolf', 'wolf');
    if (this.aborted || this.winnerTeam === null) {
      // 复盘不因异常中断
    }
    await this.runTeamReviewStage('team-good', 'good');
    // 阶段2：全场合议
    await this.runMeetingReview();
    // 阶段3：经验心得回写
    await this.runInsights();
    this.review.stage = 'done';
    this.broadcast();
    await this.archiveGame();
  }

  private async runTeamReviewStage(stage: ReviewStage, team: 'wolf' | 'good'): Promise<void> {
    this.review.stage = stage;
    this.review.team = team;
    this.broadcast();
    const teamName = team === 'wolf' ? '狼人队' : '好人队';
    this.review.messages.push(
      this.makeMessage({ id: 'system', name: '系统' }, `🔍 ${teamName} 内部复盘开始。`, 'system')
    );
    this.broadcast();
    const members = this.players.filter((p) => (team === 'wolf' ? p.role === 'wolf' : p.role !== 'wolf'));
    for (const m of members) {
      if (!m.isAI) continue;
      const text = await this.callReview(
        m,
        `你是本局${getRoleInfo(m.role || 'villager').name}。现在进行【${teamName} 内部复盘】。`
        + `只能基于本局真实事件（谁在哪个晚上死了/被票出、谁查验了谁、投票过程、关键转折）发言，禁止捏造——不得出现"我记得XX说过"式虚构。`
        + `从你的角度总结本队本局的协作与信息传递得失：哪里判断错、哪里配合失误、下一局该改进什么。`
        + `产出必须是可迁移经验：无玩家名、无具体天数例子（对齐经验库口径）。发言 1-3 句，≤100 字，禁止套话模板、禁止复读。`
      );
      if (text) {
        this.review.messages.push(this.makeMessage(m, text, 'public', this.aiOutputSource()));
        this.broadcast();
      }
      await this.sleep(400);
    }
    // 人类可随时 review-speak（不阻塞）
    await this.sleep(1200);
  }

  private async runMeetingReview(): Promise<void> {
    this.review.stage = 'meeting';
    this.review.team = null;
    this.broadcast();
    this.review.messages.push(
      this.makeMessage({ id: 'system', name: '系统' }, '🏛️ 全场合议开始：狼队与好人队面对面复盘整局胜负。', 'system')
    );
    this.broadcast();
    const members = this.players.filter((p) => p.isAI);
    for (const m of members) {
      const text = await this.callReview(
        m,
        `你是本局${getRoleInfo(m.role || 'villager').name}。现在进行【全场合议】复盘。`
        + `只能基于本局真实事件（谁在哪个晚上死了/被票出、谁查验了谁、投票过程、关键转折）发言，禁止捏造——不得出现"我记得XX说过"式虚构。`
        + `综合双方视角，说一句对整局最有价值的复盘总结：胜负关键点、双方最大失误、下一局最该改进的一件事。`
        + `产出必须是可迁移经验：无玩家名、无具体天数例子。发言 1-3 句，≤100 字，禁止套话模板、禁止复读。`
      );
      if (text) {
        this.review.messages.push(this.makeMessage(m, text, 'public', this.aiOutputSource()));
        this.broadcast();
      }
      await this.sleep(400);
    }
    await this.sleep(800);
  }

  private async callReview(p: Player, customUserPrompt: string): Promise<string> {
    if (!this.game) return '';
    this.setThinking(p.id, 20);
    try {
      return await this.callAIApi(
        this.aiConfig,
        p.role || 'villager',
        p.name,
        this.players,
        this.messages,
        '复盘',
        this.game.day,
        this.game.nightActions,
        this.gameHistory,
        undefined,
        undefined,
        undefined,
        p.id,
        customUserPrompt
      );
    } catch (e) {
      console.error('[engine] 复盘 AI 失败:', e);
      return '';
    } finally {
      this.setThinking(p.id, null);
    }
  }

  /** 各职业经验心得：复用 experienceReview 的 buildReviewPrompt + addReviewInsight（服务端文件持久化） */
  private async runInsights(): Promise<void> {
    const summary = this.buildSummary();
    const evidence = this.buildReviewEvidence();
    const rolesPresent = new Set<Role>();
    this.players.forEach((p) => {
      if (p.role) rolesPresent.add(p.role);
    });
    const roleRep: Partial<Record<Role, Player>> = {};
    this.players.forEach((p) => {
      if (p.role && !roleRep[p.role]) roleRep[p.role] = p;
    });

    for (const role of [...rolesPresent]) {
      const rep = roleRep[role];
      if (!rep || rep.isAI === false) continue; // 只让 AI 写心得
      const prompt = buildReviewPrompt(role, this.winnerTeam, summary);
      const text = await this.callReview(rep, prompt);
      const cleaned = (text || '').replace(/^[-*•]\s*/, '').replace(/^["'“”]|["'“”]$/g, '').trim();
      const ok = addReviewInsight(role, cleaned, evidence);
      if (ok) this.reviewInsights.push({ role, text: cleaned });
      await this.sleep(300);
    }

    // B2.5.3：好人方团队协作/信息传递心得；狼方针对好人沟通断层策略
    const goodRep = [...rolesPresent].filter((r) => r !== 'wolf').map((r) => roleRep[r]).find((x) => x);
    const wolfRep = roleRep['wolf'];
    if (goodRep) {
      const text = await this.callReview(
        goodRep,
        `你刚打完一局狼人杀（好人获胜/落败）。只能基于本局真实事件（死亡、查验、投票、关键转折）复盘，禁止捏造。`
        + `请输出 1 条【好人方团队协作与信息传递】的可迁移复盘心得：如何把查验/身份信息更有效地传递与对齐。`
        + `≤100 字，无玩家名、无具体天数例子，以"- "开头。`
      );
      const cleaned = (text || '').replace(/^[-*•]\s*/, '').trim();
      for (const r of [...rolesPresent].filter((x) => x !== 'wolf')) {
        if (addReviewInsight(r, cleaned, evidence)) this.reviewInsights.push({ role: r, text: cleaned });
      }
    }
    if (wolfRep) {
      const text = await this.callReview(
        wolfRep,
        `你刚打完一局狼人杀（狼方获胜/落败）。只能基于本局真实事件（死亡、查验、投票、关键转折）复盘，禁止捏造。`
        + `请输出 1 条【狼方针对好人沟通断层】的可迁移复盘心得：如何利用好人之间的信息差与沟通断层扩大优势。`
        + `≤100 字，无玩家名、无具体天数例子，以"- "开头。`
      );
      const cleaned = (text || '').replace(/^[-*•]\s*/, '').trim();
      if (addReviewInsight('wolf', cleaned, evidence)) {
        this.reviewInsights.push({ role: 'wolf', text: cleaned });
      }
    }
    // 同步一次到文件
    saveReviewStore(loadReviewStore());
    this.addSystem(
      this.reviewInsights.length > 0
        ? '✅ 复盘心得已写入对应职业经验库（局后复盘补充段，下一局自动注入）。'
        : '⚠️ 本局没有心得通过可验证事件门禁，未写入经验库。',
    );
    this.broadcast();
  }

  private async archiveGame(): Promise<void> {
    const record: ArchiveRecord = {
      id: `ar-${Date.now()}`,
      roomId: this.roomId,
      roomName: this.roomName,
      roomCode: this.roomCode,
      startedAt: this.messages[0]?.timestamp ? new Date(this.messages[0].timestamp).toISOString() : new Date().toISOString(),
      endedAt: new Date().toISOString(),
      winner: this.winnerTeam,
      day: this.game?.day ?? 1,
      playerCount: this.players.length,
      players: this.players.map((p) => ({ name: p.name, role: p.role, isAI: p.isAI })),
      deaths: this.deaths,
      reviewMessages: this.review.messages,
      insights: this.reviewInsights,
      timelineEvents: this.timelineEvents,
      gameLogEvents: this.gameLogEvents,
      kind: this.auto ? 'auto' : 'online',
    };
    // Tests/headless observers may consume the exact record without writing it.
    if (this.noArchive) {
      this.hub.onArchive?.(structuredClone(record));
      return;
    }
    addArchive(record);
    this.hub.onArchive?.(structuredClone(record));
    console.log(`[server] 存档：${this.roomName} (${this.roomCode}) 第${record.day}天 ${record.winner === 'wolf' ? '狼胜' : '好胜'}`);
  }

  /* ==================== 个性化快照 ==================== */

  private maskRoles(viewerId: string, spectatorView: boolean): Player[] {
    const viewer = this.players.find((p) => p.id === viewerId);
    const myRole = viewer?.role || null;
    return this.players.map((p) => {
      if (p.id === viewerId) return p;
      if (spectatorView) return p;
      if (p.role === null) return p;
      if (myRole === 'wolf' && p.role === 'wolf') return p;
      return { ...p, role: null };
    });
  }

  /**
   * P0-1：gameState 身份掩码 —— 只下发"该视角可见"的字段，堵住 nightActions / actionDone /
   * 女巫/守卫状态、狼队信息等侧信道身份泄露。观战视角（spectatorView）保留全场可见（允许）。
   */
  private maskGameState(viewerId: string, spectatorView: boolean): GameState | null {
    if (!this.game) return null;
    const viewer = this.players.find((p) => p.id === viewerId);
    const viewerRole = viewer?.role ?? null;
    const gs = { ...this.game, votes: { ...this.game.votes } };
    if (spectatorView) return gs;
    const canSeeWolf = viewerRole === 'wolf';

    const masked: GameState = {
      ...gs,
      // 夜晚行动：只留自己发起的动作；女巫/狼人保留 kill（女巫要决策救/毒，狼人已知目标）
      nightActions: gs.nightActions.filter(
        (a) => a.playerId === viewerId || (a.action === 'kill' && (viewerRole === 'wolf' || viewerRole === 'witch'))
      ),
      // actionDone：只留自己的行动标记（防侧信道：谁已行动 = 谁是神职）
      actionDone: Object.fromEntries(
        Object.entries(gs.actionDone).filter(([id]) => id === viewerId)
      ),
      // 狼队信息：非狼人不可见（含狼名、投票、决策、发言轮次）
      wolfVotes: canSeeWolf ? { ...gs.wolfVotes } : {},
      wolfSpeakerOrder: canSeeWolf ? [...gs.wolfSpeakerOrder] : [],
      wolfCurrentSpeaker: canSeeWolf ? gs.wolfCurrentSpeaker : null,
      // 守卫专属状态
      guardianLastTarget: viewerRole === 'guardian' ? gs.guardianLastTarget : null,
      guardianActionComplete: viewerRole === 'guardian' ? gs.guardianActionComplete : false,
      // 女巫专属状态
      witchHasHealPotion: viewerRole === 'witch' ? gs.witchHasHealPotion : true,
      witchHasPoisonPotion: viewerRole === 'witch' ? gs.witchHasPoisonPotion : true,
      witchActionComplete: viewerRole === 'witch' ? gs.witchActionComplete : false,
      witchAntidoteUsed: viewerRole === 'witch' ? gs.witchAntidoteUsed : false,
    };
    return masked;
  }

  buildSnapshot(viewerId: string, spectatorView: boolean): Snapshot {
    const viewer = this.players.find((p) => p.id === viewerId);
    const myRole = viewer?.role ?? null;
    const canSeeWolf = myRole === 'wolf' || spectatorView;
    const connected: Record<string, boolean> = {};
    this.players.forEach((p) => {
      connected[p.id] = !!this.connected[p.id] && !this.afkPlayers[p.id];
    });
    const review: ReviewState = {
      enabled: this.review.enabled,
      stage: this.review.stage,
      messages: [...this.review.messages],
      team: this.review.team,
      startedAt: this.review.startedAt,
    };
    const gameState = this.maskGameState(viewerId, spectatorView);
    return {
      roomId: this.roomId,
      roomCode: this.roomCode,
      roomName: this.roomName,
      hostId: this.hostId || '',
      isHost: viewer?.isHost ?? false,
      isSpectator: spectatorView,
      isCreator: this.auto && viewerId === this.creatorSpectatorId,
      joinToken:
        viewer?.isHost || (this.auto && viewerId === this.creatorSpectatorId) ? this.joinToken : undefined,
      myRole,
      gameState,
      players: this.maskRoles(viewerId, spectatorView),
      spectators: this.spectators,
      messages: [...this.messages],
      wolfChatMessages: canSeeWolf ? [...this.wolfChat] : [],
      wolfVotes: canSeeWolf ? { ...this.wolfVotes } : {},
      wolfCurrentSpeaker: canSeeWolf ? this.game?.wolfCurrentSpeaker ?? null : null,
      wolfSpeakerOrder: canSeeWolf ? this.game?.wolfSpeakerOrder ?? [] : [],
      wolfDiscussionRound: this.game?.wolfDiscussionRound ?? 1,
      wolfVoteComplete: this.game?.wolfVoteComplete ?? false,
      wolfDecisions: canSeeWolf ? { ...this.wolfDecisions } : {},
      thinkingPlayers: { ...this.thinkingPlayers },
      dayDiscussionRound: this.dayDiscussionRound,
      dayVoteCount: this.dayVoteCount,
      tiePlayers: [...this.tiePlayers],
      tieDebateRound: this.tieDebateRound,
      isInTieDebate: this.isInTieDebate,
      connected,
      review,
      notice: this.notice,
      serverTime: Date.now(),
      deadlineTs: this.deadlineTs,
      debugMode: this.debugMode,
    };
  }

  private sleep(ms: number): Promise<void> {
    // 斗蛐蛐（纯 AI 自跑）用极短间隔，快速打完一局；真人房保持可读节奏
    const t = this.auto ? Math.min(60, ms) : ms;
    return new Promise((r) => setTimeout(r, t));
  }
}
