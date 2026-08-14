export type Role = 'wolf' | 'seer' | 'witch' | 'hunter' | 'villager' | 'guardian';

export const NIGHT_STAGES = [
  'guard_seer',
  'wolf_discussion',
  'wolf_vote',
  'witch',
  'resolve',
] as const;

export type NightStage = (typeof NIGHT_STAGES)[number];

export const GAME_ACTIONS = [
  'guard',
  'check',
  'wolf_speak',
  'wolf_vote',
  'heal',
  'poison',
  'skip_night',
  'speak',
  'skip_speech',
  'vote',
  'abstain',
  'hunter_shoot',
  'skip_hunter_shot',
] as const;

export type GameAction = (typeof GAME_ACTIONS)[number];

export interface AllowedActor {
  playerId: string;
  actions: GameAction[];
}

/**
 * Authority fields published in a V3 game-state projection for the current
 * viewer. Legacy GameState producers may omit them during migration.
 */
export interface ProjectedAuthorityFields {
  allowedActors: AllowedActor[];
  allowedActions: GameAction[];
  deadlineTs: number | null;
}

export type ProjectedGameState = GameState & ProjectedAuthorityFields;

export interface RoleInfo {
  name: string;
  role: Role;
  team: 'wolf' | 'good';
  description: string;
  icon: string;
}

// v2.4.3 任务A：白天自由讨论阶段状态（round1 → free_discussion → voting）
export interface DayPhaseState {
  phase: 'round1' | 'free_discussion' | 'voting';
  queue: string[]; // 轮流发言顺序（round1 / free_discussion 轮换用）
  interjectQueue: string[]; // 插话队列（free_discussion 用，被点名优先插队到队头）
  usedCount: Record<string, number>; // 每人发言次数（配额 ≤5，超过强制跳过）
  discussionRounds: number; // 自由讨论轮数 ≤4（v2.4.9 任务3：3→4）
  allSkipped: boolean; // 全员跳过标记（每轮起始为 true，有人发言置 false）
  interjectedThisRound: string[]; // 本轮已插话的玩家（每轮限一次）
  // v2.4.10 任务1：今日"捋"人（逻辑梳理配额——每白天最多 1 人做捋，字数放宽到 ≤300）
  sorterId: string | null;
}

export interface Room {
  id: string;
  name: string;
  maxPlayers: number;
  currentPlayers: number;
  status: 'waiting' | 'playing' | 'ended';
  hostId: string;
  createdAt: Date;
  aiPlayerCount: number;
  settings?: {
    // 猎人同守同救（被刀+被守+被救）致死时是否可开枪，默认 true = 保持现状
    hunterShootOnGuardHealDeath: boolean;
  };
}

export interface PlayerAIConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  behavior: 'aggressive' | 'conservative' | 'random';
}

export interface Player {
  id: string;
  roomId: string;
  name: string;
  isAI: boolean;
  role: Role | null;
  isAlive: boolean;
  isHost: boolean;
  order: number;
  aiConfig?: PlayerAIConfig;
  isReady?: boolean;
}

export interface GameState {
  roomId: string;
  phase: 'waiting' | 'roleSelect' | 'night' | 'day' | 'vote' | 'voting' | 'hunterShoot' | 'lastWords' | 'ended';
  /**
   * V3 authority fields. They remain optional while the legacy engine is
   * migrated; new engine and protocol code must publish them together.
   */
  nightStage?: NightStage | null;
  stageRevision?: number;
  allowedActors?: AllowedActor[];
  allowedActions?: GameAction[];
  deadlineTs?: number | null;
  day: number;
  turn: number;
  votes: Record<string, string>;
  nightActions: NightAction[];
  winner: 'wolf' | 'good' | null;
  currentSpeaker: string | null;
  speakerOrder: string[];
  actionDone: Record<string, boolean>;
  speechTimeLeft: number;
  actionTimeLeft: number;
  wolfVotes: Record<string, string>;
  wolfSpeakerOrder: string[];
  wolfCurrentSpeaker: string | null;
  wolfDiscussionRound: number;
  wolfVoteComplete: boolean;
  guardianLastTarget: string | null; // 守卫上一晚守护的目标
  guardianActionComplete: boolean; // 守卫是否已行动
  witchHasHealPotion: boolean; // 女巫是否有解药
  witchHasPoisonPotion: boolean; // 女巫是否有毒药
  witchActionComplete: boolean; // 女巫是否已完成行动
  lastWordsPlayer: string | null; // 正在说遗言的玩家ID
  hunterShootTarget: string | null; // 猎人开枪目标
  witchAntidoteUsed: boolean; // 女巫解药是否已使用（跨回合持久，N6 刀口隐藏依据）
  dayPhase: DayPhaseState; // v2.4.3 白天自由讨论状态机
  // v2.4.10 任务1：上一白天做"捋"的玩家ID（轮换用——不能连天同一人做捋）
  lastSorterId: string | null;
}

export interface NightAction {
  playerId: string;
  action: 'kill' | 'check' | 'heal' | 'poison' | 'guard';
  targetId: string | null;
}

export interface Message {
  id: string;
  roomId: string;
  playerId: string;
  playerName: string;
  content: string;
  timestamp: Date;
  type: 'public' | 'private' | 'system' | 'whisper' | 'wolf_chat' | 'night_action';
}

export interface SiliconflowConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface DeepseekConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface LocalModelConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiUrl: string;
}

export interface AIConfig {
  apiType: 'siliconflow' | 'deepseek' | 'local';
  siliconflow: SiliconflowConfig;
  deepseek: DeepseekConfig;
  local: LocalModelConfig;
  defaultBehavior: 'aggressive' | 'conservative' | 'random';
}

export interface GameLog {
  id: string;
  timestamp: Date;
  type: 'info' | 'warning' | 'error' | 'success' | 'api';
  title: string;
  message: string;
  details?: string;
  playerId?: string;
  playerName?: string;
  apiEndpoint?: string;
  duration?: number;
}

export interface AppState {
  currentUser: {
    id: string;
    name: string;
  } | null;
  currentRoom: Room | null;
  rooms: Room[];
  gameState: GameState | null;
  players: Player[];
  messages: Message[];
  wolfChatMessages: Message[];
  aiConfig: AIConfig;
  isHost: boolean;
  myRole: Role | null;
  showSettings: boolean;
  logs: GameLog[];
}
