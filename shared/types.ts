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
  'confirm_role',
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
  /** Absolute start of the currently authoritative stage, when timed. */
  stageStartedAt: number | null;
}

export type ProjectedGameState = GameState & ProjectedAuthorityFields;

export interface RoleInfo {
  name: string;
  role: Role;
  team: 'wolf' | 'good';
  description: string;
  icon: string;
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
  isReady?: boolean;
}

export interface GameState {
  roomId: string;
  phase: 'waiting' | 'roleSelect' | 'role_confirm' | 'night' | 'day' | 'vote' | 'voting' | 'hunterShoot' | 'lastWords' | 'ended';
  /**
   * V3 authority fields. They remain optional while the legacy engine is
   * migrated; new engine and protocol code must publish them together.
   */
  nightStage?: NightStage | null;
  stageRevision?: number;
  allowedActors?: AllowedActor[];
  allowedActions?: GameAction[];
  deadlineTs?: number | null;
  /** Absolute start of the current authoritative stage. */
  stageStartedAt?: number | null;
  day: number;
  turn: number;
  votes: Record<string, string>;
  nightActions: NightAction[];
  /** Private alignment-only history for the living seer. */
  seerResults?: Record<string, 'wolf' | 'good'>;
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
}

export interface NightAction {
  playerId: string;
  action: 'kill' | 'check' | 'heal' | 'poison' | 'guard';
  targetId: string | null;
}
