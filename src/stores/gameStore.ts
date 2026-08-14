import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Room, Player, GameState, Message, AIConfig, Role, GameLog, DayPhaseState } from '../types';
import type { Snapshot } from '../net/protocol';
import { AI_DEFAULTS } from '../../shared/config/aiDefaults';

interface GameStore {
  currentUser: { id: string; name: string } | null;
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
  showMonitor: boolean;
  logs: GameLog[];
  isGameAborted: boolean;
  isSpectator: boolean; // 观战模式
  hunterShootOnGuardHealDeath: boolean; // 房间默认设置：猎人同守同救致死能否开枪（默认 true）
  wolfCurrentSpeaker: string | null;
  wolfSpeakerOrder: string[];
  wolfVotes: Record<string, string>;
  wolfDiscussionRound: number;
  wolfVoteComplete: boolean;
  wolfKillComplete: boolean;
  wolfKillTarget: string | null;
  wolfDecisions: Record<string, { targetId: string; intention: string; reason: string }>;
  
  thinkingPlayers: Record<string, number>;
  
  dayDiscussionRound: number;
  dayVoteCount: number;
  tiePlayers: string[];
  tieDebateRound: number;
  isInTieDebate: boolean;
  dayInputFocused: boolean; // v2.4.3 白天输入框是否活跃（挂机保护判断用）

  setCurrentUser: (user: { id: string; name: string }) => void;
  setCurrentRoom: (room: Room | null) => void;
  setRooms: (rooms: Room[]) => void;
  setGameState: (state: GameState | null | ((prev: GameState | null) => GameState | null)) => void;
  setPlayers: (players: Player[]) => void;
  updatePlayerAIConfig: (playerId: string, config: Player['aiConfig']) => void;
  addMessage: (message: Message) => void;
  setMessages: (messages: Message[]) => void;
  addWolfChatMessage: (message: Message) => void;
  setWolfChatMessages: (messages: Message[]) => void;
  setAIConfig: (config: AIConfig) => void;
  setIsHost: (isHost: boolean) => void;
  setMyRole: (role: Role | null) => void;
  setShowSettings: (show: boolean) => void;
  setShowMonitor: (show: boolean) => void;
  addLog: (log: Omit<GameLog, 'id' | 'timestamp'>) => void;
  clearLogs: () => void;
  abortGame: () => void;
  clearRoomState: () => void;
  setIsSpectator: (isSpectator: boolean) => void;
  setHunterShootOnGuardHealDeath: (v: boolean) => void;
  setWolfCurrentSpeaker: (speakerId: string | null) => void;
  setWolfSpeakerOrder: (order: string[]) => void;
  setWolfVotes: (votes: Record<string, string>) => void;
  addWolfVote: (playerId: string, targetId: string) => void;
  setWolfDiscussionRound: (round: number | ((prev: number) => number)) => void;
  setWolfVoteComplete: (complete: boolean) => void;
  setWolfKillComplete: (complete: boolean) => void;
  setWolfKillTarget: (targetId: string | null) => void;
  setWolfDecision: (playerId: string, decision: { targetId: string; intention: string; reason: string }) => void;
  resetWolfChatState: () => void;
  
  setThinkingPlayer: (playerId: string, progress: number) => void;
  removeThinkingPlayer: (playerId: string) => void;
  
  setDayDiscussionRound: (round: number) => void;
  setDayVoteCount: (count: number) => void;
  setTiePlayers: (players: string[]) => void;
  setTieDebateRound: (round: number) => void;
  setIsInTieDebate: (isIn: boolean) => void;
  setDayPhase: (phase: DayPhaseState | ((prev: DayPhaseState) => DayPhaseState)) => void;
  setDayInputFocused: (v: boolean) => void;
  resetDayState: () => void;
  /** 联机模式（B批）：把服务端个性化快照整包灌入本地 store，供复用现有 UI 组件 */
  applyOnlineSnapshot: (snap: Snapshot) => void;
}

const defaultAIConfig: AIConfig = structuredClone(AI_DEFAULTS);

/** 客户端只保存可公开的 provider/model 参数；密钥只能由服务端持有。 */
const stripApiKeys = (config: AIConfig): AIConfig => ({
  ...config,
  siliconflow: { ...config.siliconflow, apiKey: '' },
  deepseek: { ...config.deepseek, apiKey: '' },
  local: { ...config.local, apiKey: '' },
});

export const useGameStore = create<GameStore>()(
  persist(
    (set) => ({
      currentUser: null,
      currentRoom: null,
      rooms: [],
      gameState: null,
      players: [],
      messages: [],
      wolfChatMessages: [],
      aiConfig: stripApiKeys(defaultAIConfig),
      isHost: false,
      myRole: null,
      showSettings: false,
      showMonitor: false,
      logs: [],
      isGameAborted: false,
      isSpectator: false,
      hunterShootOnGuardHealDeath: true,
      wolfCurrentSpeaker: null,
      wolfSpeakerOrder: [],
      wolfVotes: {},
      wolfDiscussionRound: 1,
      wolfVoteComplete: false,
      wolfKillComplete: false,
      wolfKillTarget: null,
      wolfDecisions: {},
      thinkingPlayers: {},
      dayDiscussionRound: 1,
      dayVoteCount: 0,
      tiePlayers: [],
      tieDebateRound: 1,
      isInTieDebate: false,
      dayInputFocused: false,

      setCurrentUser: (user) => set({ currentUser: user }),
      setCurrentRoom: (room) => set({ currentRoom: room }),
      setRooms: (rooms) => set({ rooms }),
      setGameState: (state) => set((s) => ({ gameState: typeof state === 'function' ? state(s.gameState) : state })),
      setPlayers: (players) => set({ players }),
      updatePlayerAIConfig: (playerId, config) => set((state) => ({
        players: state.players.map((p) =>
          p.id === playerId ? { ...p, aiConfig: config } : p
        ),
      })),
      addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
      setMessages: (messages) => set({ messages }),
      addWolfChatMessage: (message) => set((state) => ({ wolfChatMessages: [...state.wolfChatMessages, message] })),
      setWolfChatMessages: (messages) => set({ wolfChatMessages: messages }),
      setAIConfig: (config) => set({ aiConfig: stripApiKeys(config) }),
      setIsHost: (isHost) => set({ isHost }),
      setMyRole: (role) => set({ myRole: role }),
      setShowSettings: (show) => set({ showSettings: show }),
      setShowMonitor: (show) => set({ showMonitor: show }),
      addLog: (log) => set((state) => ({
        logs: [...state.logs, { ...log, id: Math.random().toString(36).substring(2, 11), timestamp: new Date() }],
      })),
      clearLogs: () => set({ logs: [] }),
      abortGame: () => set({ isGameAborted: true }),
      clearRoomState: () => set({
        currentRoom: null,
        gameState: null,
        players: [],
        messages: [],
        wolfChatMessages: [],
        logs: [],
        isHost: false,
        myRole: null,
        isGameAborted: false,
        isSpectator: false,
        wolfCurrentSpeaker: null,
        wolfSpeakerOrder: [],
        wolfVotes: {},
        wolfDiscussionRound: 1,
        wolfVoteComplete: false,
        wolfKillComplete: false,
        wolfDecisions: {},
        dayDiscussionRound: 1,
        dayVoteCount: 0,
        tiePlayers: [],
        tieDebateRound: 1,
        isInTieDebate: false,
        dayInputFocused: false,
      }),
      setWolfCurrentSpeaker: (speakerId) => set({ wolfCurrentSpeaker: speakerId }),
      setWolfSpeakerOrder: (order) => set({ wolfSpeakerOrder: order }),
      setWolfVotes: (votes) => set({ wolfVotes: votes }),
      addWolfVote: (playerId, targetId) => set((state) => ({
        wolfVotes: { ...state.wolfVotes, [playerId]: targetId },
      })),
      setWolfDiscussionRound: (round) => set((state) => ({ wolfDiscussionRound: typeof round === 'function' ? round(state.wolfDiscussionRound) : round as number })),
      setWolfVoteComplete: (complete) => set({ wolfVoteComplete: complete }),
      setWolfKillComplete: (complete) => set({ wolfKillComplete: complete }),
      setWolfKillTarget: (targetId) => set({ wolfKillTarget: targetId }),
      setWolfDecision: (playerId, decision) => set((state) => ({
        wolfDecisions: { ...state.wolfDecisions, [playerId]: decision },
      })),
      setThinkingPlayer: (playerId, progress) => set((state) => ({
        thinkingPlayers: { ...state.thinkingPlayers, [playerId]: progress },
      })),
      removeThinkingPlayer: (playerId) => set((state) => {
        const newThinkingPlayers = { ...state.thinkingPlayers };
        delete newThinkingPlayers[playerId];
        return { thinkingPlayers: newThinkingPlayers };
      }),
      resetWolfChatState: () => set({
        wolfCurrentSpeaker: null,
        wolfSpeakerOrder: [],
        wolfVotes: {},
        wolfDiscussionRound: 1,
        wolfVoteComplete: false,
        wolfKillComplete: false,
        wolfKillTarget: null,
        wolfDecisions: {},
      }),
      setDayDiscussionRound: (round) => set({ dayDiscussionRound: round }),
      setDayVoteCount: (count) => set({ dayVoteCount: count }),
      setTiePlayers: (players) => set({ tiePlayers: players }),
      setTieDebateRound: (round) => set({ tieDebateRound: round }),
      setIsInTieDebate: (isIn) => set({ isInTieDebate: isIn }),
      setDayPhase: (phase) => set((state) => {
        if (!state.gameState) return state;
        return {
          gameState: {
            ...state.gameState,
            dayPhase: typeof phase === 'function' ? phase(state.gameState.dayPhase) : phase,
          },
        };
      }),
      setDayInputFocused: (v) => set({ dayInputFocused: v }),
      resetDayState: () => set({
        dayDiscussionRound: 1,
        dayVoteCount: 0,
        tiePlayers: [],
        tieDebateRound: 1,
        isInTieDebate: false,
      }),
      setIsSpectator: (isSpectator) => set({ isSpectator }),
      setHunterShootOnGuardHealDeath: (v) => set({ hunterShootOnGuardHealDeath: v }),
      applyOnlineSnapshot: (snap) => set((state) => {
        const messages = snap.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
        const wolfChatMessages = snap.wolfChatMessages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
        const room: Room | null = snap.roomId
          ? {
              id: snap.roomId,
              name: snap.roomName,
              maxPlayers: snap.players.length,
              currentPlayers: snap.players.length,
              status: snap.gameState?.phase === 'ended' ? 'ended' : snap.gameState ? 'playing' : 'waiting',
              hostId: snap.hostId,
              createdAt: new Date(),
              aiPlayerCount: snap.players.filter((p) => p.isAI).length,
            }
          : state.currentRoom;
        const wolfKillTarget =
          snap.gameState?.nightActions.find((a) => a.action === 'kill')?.targetId ?? null;
        return {
          currentRoom: room,
          players: snap.players,
          gameState: snap.gameState,
          messages,
          wolfChatMessages,
          myRole: snap.myRole,
          isHost: snap.isHost,
          isSpectator: snap.isSpectator,
          wolfCurrentSpeaker: snap.wolfCurrentSpeaker,
          wolfSpeakerOrder: snap.wolfSpeakerOrder,
          wolfVotes: snap.wolfVotes,
          wolfDiscussionRound: snap.wolfDiscussionRound,
          wolfVoteComplete: snap.wolfVoteComplete,
          wolfKillComplete: snap.wolfVoteComplete,
          wolfKillTarget,
          wolfDecisions: snap.wolfDecisions,
          thinkingPlayers: { ...(snap.thinkingPlayers || {}) },
          dayDiscussionRound: snap.dayDiscussionRound,
          dayVoteCount: snap.dayVoteCount,
          tiePlayers: snap.tiePlayers,
          tieDebateRound: snap.tieDebateRound,
          isInTieDebate: snap.isInTieDebate,
          isGameAborted: false,
        };
      }),
    }),
    {
      name: 'wolf-game-storage',
      partialize: (state) => ({
        aiConfig: stripApiKeys(state.aiConfig),
        currentUser: state.currentUser,
        hunterShootOnGuardHealDeath: state.hunterShootOnGuardHealDeath,
      }),
      migrate: (persistedState: any, version) => {
        // 迁移旧格式的 aiConfig
        if (persistedState && persistedState.aiConfig) {
          const oldConfig = persistedState.aiConfig;
          // 检查是否是旧格式（没有 siliconflow 或 local 字段）
          if (!oldConfig.siliconflow || !oldConfig.local) {
            // 创建新格式的配置
            const migratedConfig: AIConfig = {
              ...stripApiKeys(defaultAIConfig),
              apiType: oldConfig.apiType || AI_DEFAULTS.apiType,
              defaultBehavior: oldConfig.defaultBehavior || 'random',
            };
            // 尝试从旧配置迁移数据
            if (oldConfig.model) {
              migratedConfig.siliconflow.model = oldConfig.model;
              migratedConfig.local.model = oldConfig.model;
            }
            if (typeof oldConfig.temperature === 'number') {
              migratedConfig.siliconflow.temperature = oldConfig.temperature;
              migratedConfig.local.temperature = oldConfig.temperature;
            }
            if (typeof oldConfig.maxTokens === 'number') {
              migratedConfig.siliconflow.maxTokens = oldConfig.maxTokens;
              migratedConfig.local.maxTokens = oldConfig.maxTokens;
            }
            if (oldConfig.localApiUrl) {
              migratedConfig.local.apiUrl = oldConfig.localApiUrl;
            }
            persistedState.aiConfig = migratedConfig;
          }
        }
        if (persistedState?.aiConfig) persistedState.aiConfig = stripApiKeys(persistedState.aiConfig);
        return persistedState;
      },
    }
  )
);
