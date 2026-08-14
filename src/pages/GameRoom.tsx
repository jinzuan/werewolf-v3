import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Play, RotateCcw, LogOut, Eye, EyeOff, Trophy, SkipForward, AlertTriangle, X, BookOpen, Moon, Vote, Target } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { PlayerCard } from '../components/PlayerCard';
import { ChatTabs } from '../components/ChatTabs';
import { VoteModal } from '../components/VoteModal';
import { NightActionModal } from '../components/NightActionModal';
import { WolfVoteModal } from '../components/WolfVoteModal';
import { RoleSelectPanel } from '../components/RoleSelectPanel';
import { SystemMessagesPanel } from '../components/SystemMessagesPanel';
import { MyRolePanel } from '../components/MyRolePanel';
import { WaitingGame } from '../components/WaitingGame';
import { GameProgressPanel } from '../components/GameProgressPanel';
import { VoteResultPanel } from '../components/VoteResultPanel';
import { HunterShootPanel } from '../components/HunterShootPanel';
import { RulePanel } from '../components/RulePanel';
import { SituationPanel } from '../components/SituationPanel';
import { assignRoles, createInitialGameState, generateRoomId, checkWinCondition, processNightActions, determineVoteResult, getPhaseText, getAlivePlayers, getDeadPlayers, reassignRole, forceAssignRole, reassignAllRoles } from '../utils/gameLogic';
import { callAIApi, generateAIThought, generateAIVoteDecision, setLogCallback, setAborted, getAborted, setThinkingCallback, setRemoveThinkingCallback, resetExperienceCache, resetSpeechRepeatCache } from '../utils/aiClient';
import { getRoleInfo } from '../utils/roleConfig';
import { initGameMemory, clearGameMemory, appendMemoryNote } from '../utils/memorySystem';
import { archiveGameLogs } from '../utils/gameLogArchive';
import { addReviewInsight, buildReviewPrompt } from '../utils/experienceReview';
import type { Message, Role, Player, DayPhaseState } from '../types';

interface GameRoomProps {
  onNavigate: (path: string) => void;
}

export const GameRoom = ({ onNavigate }: GameRoomProps) => {
  const params = useParams<{ id: string }>();
  
  const {
    currentRoom,
    players,
    setPlayers,
    gameState,
    setGameState,
    messages,
    addMessage,
    wolfChatMessages,
    addWolfChatMessage,
    isHost,
    myRole,
    setMyRole,
    currentUser,
    aiConfig,
    clearRoomState,
    addLog,
    logs,
    clearLogs,
    abortGame,
    wolfCurrentSpeaker,
    setWolfCurrentSpeaker,
    wolfSpeakerOrder,
    setWolfSpeakerOrder,
    wolfVotes,
    setWolfVotes,
    addWolfVote,
    wolfDiscussionRound,
    setWolfDiscussionRound,
    wolfVoteComplete,
    wolfKillComplete,
    setWolfVoteComplete,
    setWolfKillComplete,
    setWolfKillTarget,
    setWolfDecision,
    resetWolfChatState,
    thinkingPlayers,
    setThinkingPlayer,
    removeThinkingPlayer,
    dayDiscussionRound,
    setDayDiscussionRound,
    dayVoteCount,
    setDayVoteCount,
    tiePlayers,
    setTiePlayers,
    tieDebateRound,
    setTieDebateRound,
    isInTieDebate,
    setIsInTieDebate,
    resetDayState,
    isSpectator,
    setIsSpectator,
    dayInputFocused,
  } = useGameStore();

  const [showRoles, setShowRoles] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [winnerTeam, setWinnerTeam] = useState<'wolf' | 'good' | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [nightProcessed, setNightProcessed] = useState(false);
  const [roleSelectDone, setRoleSelectDone] = useState(false);
  const [redrawCount, setRedrawCount] = useState(0);
  const [showRules, setShowRules] = useState(false);
  const [selectedKillTarget, setSelectedKillTarget] = useState<string | null>(null);
  const [showVoteModal, setShowVoteModal] = useState(false);
  const [showNightActionModal, setShowNightActionModal] = useState(false);
  const [showWolfVoteModal, setShowWolfVoteModal] = useState(false);
  const [showWaitingGame, setShowWaitingGame] = useState(false);
  const [showRoleDetail, setShowRoleDetail] = useState<{ role: Role; show: boolean }>({ role: 'villager', show: false });
  const [guardianActionCompleteState, setGuardianActionCompleteState] = useState(false);
  const [aiVotingComplete, setAiVotingComplete] = useState(false);
  
  // 游戏历史记录 - 确保AI知道自己做了什么
  const [gameHistory, setGameHistory] = useState<any>({
    nightResults: [],
    votes: {},
    deadPlayers: [],
    skillUsage: {}, // 记录每个玩家的技能使用情况
    playerKnowledge: {}, // 玩家信息库，实时记录每个玩家的发言和投票
    timeline: [] // 游戏时间线
  });
  const lastWolfSpeakerId = useRef<string | null>(null);
  const wolfSpeakerProcessing = useRef(false);
  const hasWolfTieDiscussion = useRef(false);
  const witchActionProcessed = useRef(false);
  const seerActionProcessed = useRef(false);
  const wolfVoteCompleteRef = useRef(false);
  const nightHunterShoot = useRef(false); // S1：猎人夜里被狼刀死后待开枪
  const pendingHunterShootRef = useRef(false); // v2.4.4：被投票出局的猎人 → 遗言完毕后待开枪
  const handleNextWolfSpeakerRef = useRef<(() => void) | null>(null);
  
  const MAX_REDRAW = 3;

  // v2.4.3 自由讨论系统常量
  const DISCUSS_QUOTA = 5; // 每人自由讨论发言/插话配额
  const FREE_DISCUSS_MAX_ROUNDS = 4; // 自由讨论最多轮数（v2.4.9 任务3：3→4）
  const AFK_TIMEOUT_MS = 180000; // 真人挂机保护：3 分钟无输入自动跳过（输入框活跃时绝不切）

  useEffect(() => {
    console.log('=== GameRoom 初始化检查 ===');
    console.log('路由参数 id:', params.id);
    console.log('currentRoom:', currentRoom);
    console.log('currentRoom?.id:', currentRoom?.id);
    console.log('players.length:', players.length);
    console.log('players:', players);
    console.log('gameStarted:', gameStarted);
    
    if (params.id && (!currentRoom || currentRoom.id !== params.id)) {
      console.log('⚠️ 房间ID不匹配！路由参数:', params.id, 'currentRoom.id:', currentRoom?.id);
    }
    
    if (currentRoom && players.length > 0 && !gameStarted) {
      console.log('设置游戏未开始状态');
    }
  }, [currentRoom, players.length, gameStarted, params.id]);

  useEffect(() => {
    if (gameState?.phase === 'vote' && !showVoteModal) {
      setTimeout(() => {
        setShowVoteModal(true);
      }, 300);
    }
  }, [gameState?.phase]);

  // v2.3 任务 D1：观战模式（死亡玩家/旁观者）自动打开全场身份视角
  useEffect(() => {
    if (isSpectator && gameStarted && gameState && gameState.phase !== 'roleSelect') {
      setShowRoles(true);
    }
  }, [isSpectator, gameStarted, gameState]);

  const addSystemMessage = useCallback((content: string) => {
    const message: Message = {
      id: generateRoomId(),
      roomId: currentRoom?.id || '',
      playerId: 'system',
      playerName: '系统',
      content,
      timestamp: new Date(),
      type: 'system',
    };
    addMessage(message);
  }, [addMessage, currentRoom?.id]);

  const startGame = useCallback(() => {
    if (!isHost || players.length < 4) return;

    // 经验库 v1：每局开局重置，重新随机注入
    resetExperienceCache();
    // v2.4.5-A A1：开局清空复读比对窗口（本轮+上轮发言基准从零开始）
    resetSpeechRepeatCache();
    nightHunterShoot.current = false;
    pendingHunterShootRef.current = false;

    // v2.3 任务 E：新局开始时清空当前对局日志（上一局日志已在对局结束时归档）
    clearLogs();

    addLog({
      type: 'info',
      title: '游戏开始',
      message: `游戏已启动，共 ${players.length} 名玩家`,
    });

    const assignedPlayers = assignRoles(players);
    setPlayers(assignedPlayers);

    winnerArchiveRef.current = false;

    // v2.3 任务 B：开局预填每个 AI 玩家的记忆库（人设/公共信息/身份边界/经验库链接）
    initGameMemory(currentRoom!.id, assignedPlayers);

    const myPlayer = assignedPlayers.find((p) => p.id === currentUser?.id);
    if (myPlayer?.role) {
      setMyRole(myPlayer.role);
    }

    const playerIds = assignedPlayers.map((p) => p.id);
    const initialState = createInitialGameState(currentRoom!.id, playerIds);
    initialState.phase = 'roleSelect';
    setGameState(initialState);
    setGameStarted(true);
    setWinnerTeam(null);
    setRoleSelectDone(false);
    setRedrawCount(0);
    addLog({
      type: 'info',
      title: '进入角色选择阶段',
      message: '请抽取并确认你的角色',
    });
  }, [isHost, players, setPlayers, currentUser, setMyRole, currentRoom?.id, setGameState, addLog]);

  const handleRedrawRole = useCallback(() => {
    if (!currentUser || gameState?.phase !== 'roleSelect' || redrawCount >= MAX_REDRAW) return;

    const updatedPlayers = reassignRole(players, currentUser.id);
    setPlayers(updatedPlayers);

    const myPlayer = updatedPlayers.find((p) => p.id === currentUser?.id);
    if (myPlayer?.role) {
      setMyRole(myPlayer.role);
    }

    setRedrawCount(prev => prev + 1);
    addLog({
      type: 'info',
      title: '重新抽卡',
      message: `${currentUser.name} 重新抽取了角色`,
      playerName: currentUser.name,
    });
  }, [currentUser, players, setPlayers, setMyRole, gameState?.phase, redrawCount, addLog]);

  const handleForceAssignRole = useCallback((playerId: string, role: Role) => {
    if (!isHost) return;

    const updatedPlayers = forceAssignRole(players, playerId, role);
    setPlayers(updatedPlayers);

    const targetPlayer = updatedPlayers.find((p) => p.id === playerId);
    const myPlayer = updatedPlayers.find((p) => p.id === currentUser?.id);
    
    if (myPlayer?.role) {
      setMyRole(myPlayer.role);
    }

    addLog({
      type: 'info',
      title: '主持人指定角色',
      message: `主持人将 ${targetPlayer?.name} 指定为 ${getRoleInfo(role).name}`,
    });
  }, [isHost, players, setPlayers, currentUser, setMyRole, addLog]);

  const handleReassignAllRoles = useCallback(() => {
    if (!isHost || redrawCount >= MAX_REDRAW) return;

    const updatedPlayers = reassignAllRoles(players);
    setPlayers(updatedPlayers);

    const myPlayer = updatedPlayers.find((p) => p.id === currentUser?.id);
    if (myPlayer?.role) {
      setMyRole(myPlayer.role);
    }

    setRedrawCount(prev => prev + 1);
    addLog({
      type: 'info',
      title: '全员重新抽卡',
      message: '主持人触发了全员重新抽卡',
    });
  }, [isHost, players, setPlayers, currentUser, setMyRole, redrawCount, addLog]);

  const confirmRoles = useCallback(() => {
    if (!gameState) return;

    setRoleSelectDone(true);

    // v2.3 任务 B：抽卡/换卡阶段结束后，按最终角色重新预填记忆库（防人设信息与身份不符）
    if (currentRoom) {
      initGameMemory(currentRoom.id, players);
    }

    // 重要：确认角色时必须更新 myRole
    // 使用和 RoleSelectPanel 相同的逻辑查找玩家
    const myPlayer = players.find((p) => p.id === currentUser?.id) || 
                     players.find((p) => p.name === currentUser?.name) ||
                     players.find((p) => p.isHost);
    if (myPlayer?.role) {
      setMyRole(myPlayer.role);
    }

    addLog({
      type: 'success',
      title: '角色选择完成',
      message: `狼人: ${players.filter(p => p.role === 'wolf').map(p => p.name).join(', ')}, 预言家: ${players.find(p => p.role === 'seer')?.name}, 女巫: ${players.find(p => p.role === 'witch')?.name}, 猎人: ${players.find(p => p.role === 'hunter')?.name}`,
    });

    const wolfPlayers = players.filter(p => p.role === 'wolf' && p.isAlive);
    
    // 让真实玩家优先发言，AI玩家在后
    const sortedWolfIds = wolfPlayers
      .sort((a, b) => {
        // 真实玩家排在前面，AI玩家排在后面
        if (a.isAI !== b.isAI) {
          return a.isAI ? 1 : -1;
        }
        // 同类型玩家随机排序
        return Math.random() - 0.5;
      })
      .map(p => p.id);
    
    console.log('=== 狼队发言顺序初始化 ===');
    console.log('狼队成员:', wolfPlayers.map(p => ({ id: p.id, name: p.name, isAI: p.isAI })));
    console.log('发言顺序:', sortedWolfIds);
    
    // 重置狼人讨论状态
    lastWolfSpeakerId.current = null;
    wolfSpeakerProcessing.current = false;
    hasWolfTieDiscussion.current = false;
    witchActionProcessed.current = false;
    seerActionProcessed.current = false;
    wolfVoteCompleteRef.current = false;
    
    setWolfSpeakerOrder(sortedWolfIds);
    setWolfCurrentSpeaker(sortedWolfIds[0] || null);
    setWolfDiscussionRound(1);
    setWolfVotes({});
    setWolfVoteComplete(false);
    setWolfKillComplete(false);

    setGameState({
      ...gameState,
      phase: 'night',
      actionTimeLeft: 0,
    });
    setNightProcessed(false);
    addSystemMessage('🌙 天黑请闭眼，狼人开始行动');
    
    setTimeout(() => {
      if (['seer', 'witch'].includes(myRole || '')) {
        setShowNightActionModal(true);
      }
    }, 500);
  }, [gameState, players, currentUser, setMyRole, addLog, addSystemMessage, setGameState, setWolfSpeakerOrder, setWolfCurrentSpeaker, setWolfDiscussionRound, myRole, currentRoom]);

  // ==================== v2.4.3 自由讨论状态机（round1 → free_discussion → voting） ====================

  const isSkipResponse = (text: string): boolean => {
    const t = (text || '').replace(/[，。！？!？\s]/g, '');
    return !t || t === '过' || t === '跳过' || t === '过过' || t === '没话说';
  };

  const timeStrNow = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  // 事件流记录跳过（qc_events 可分析）
  const recordSkipEvent = (playerId: string) => {
    const p = players.find(x => x.id === playerId);
    if (!p) return;
    addLog({ type: 'info', title: `${p.name} 跳过`, message: `${p.name} 选择跳过发言`, playerName: p.name });
    setGameHistory(prev => ({
      ...prev,
      timeline: [
        ...prev.timeline,
        { time: timeStrNow(), day: gameState?.day || 1, phase: '跳过', event: `${p.name} 跳过发言`, actor: p.name },
      ].slice(-20),
    }));
  };

  // 事件流记录插话（qc_events 可分析）
  const recordInterjectEvent = (playerId: string) => {
    const p = players.find(x => x.id === playerId);
    if (!p) return;
    addLog({ type: 'info', title: `${p.name} 插话`, message: `${p.name} 插话发言`, playerName: p.name });
    setGameHistory(prev => ({
      ...prev,
      timeline: [
        ...prev.timeline,
        { time: timeStrNow(), day: gameState?.day || 1, phase: '插话', event: `${p.name} 插话发言`, actor: p.name },
      ].slice(-20),
    }));
  };

  // 任务E：自由讨论/白天发言后，把与自己相关的对话压缩进记忆库（memorySystem）
  const updateMemoryForSpeech = useCallback((speakerName: string, speech: string) => {
    const aliveAIs = getAlivePlayers(players).filter(p => p.isAI && p.name !== speakerName);
    aliveAIs.forEach(ai => {
      if (speech.includes(ai.name) || speech.includes(speakerName)) {
        appendMemoryNote(ai.name, `第${gameState?.day || 1}天 ${speakerName}: ${speech.slice(0, 80)}`);
      }
    });
  }, [players, gameState?.day]);

  // 任务B1：AI 插话判断 —— 在别人发言后，被点名/质疑/重要反驳 → 加入 interjectQueue（每轮限一次，受配额约束）
  const maybeTriggerInterjections = useCallback((speech: string, speakerId: string) => {
    const st = useGameStore.getState().gameState;
    if (!st || st.phase !== 'day' || st.dayPhase.phase !== 'free_discussion') return;
    const dp = st.dayPhase;
    const aliveAIs = useGameStore.getState().players.filter(p => p.isAI && p.id !== speakerId);
    const additions: string[] = [];
    aliveAIs.forEach(ai => {
      if ((dp.usedCount[ai.id] || 0) >= DISCUSS_QUOTA) return;
      if (dp.interjectedThisRound.includes(ai.id)) return;
      const named = speech.includes(ai.name);
      const should = named ? Math.random() < 0.8 : Math.random() < 0.03;
      if (should) additions.push(ai.id);
    });
    if (additions.length === 0) return;
    setGameState(prev => {
      if (!prev || prev.phase !== 'day') return prev;
      const pdp = prev.dayPhase;
      // 被点名者优先插到队列头
      return {
        ...prev,
        dayPhase: {
          ...pdp,
          interjectQueue: [...additions, ...pdp.interjectQueue],
          interjectedThisRound: [...pdp.interjectedThisRound, ...additions],
        },
      };
    });
  }, [setGameState]);

  // 进入投票（讨论结束：轮数满 / 全员跳过 / 无人发言 / 配额满）
  const enterVotingNow = useCallback((dp: DayPhaseState, reason: string) => {
    Object.keys(thinkingPlayers).forEach(pid => removeThinkingPlayer(pid));
    lastWolfSpeakerId.current = null;
    wolfSpeakerProcessing.current = false;
    setIsProcessing(false);
    addSystemMessage(`🗳️ ${reason}，进入投票阶段！`);
    setGameState(prev => prev ? {
      ...prev,
      phase: 'vote',
      currentSpeaker: null,
      speechTimeLeft: 0,
      dayPhase: { ...dp, phase: 'voting' },
    } : prev);
    setAiVotingComplete(false);
    setTimeout(() => setShowVoteModal(true), 500);
  }, [thinkingPlayers, removeThinkingPlayer, addSystemMessage, setIsProcessing, setGameState, setAiVotingComplete]);

  // v2.4.3 核心：白天发言轮转状态机（round1 按序保底 → free_discussion 轮流+插话+配额 → voting）
  const advanceDayTurn = useCallback((opts: { skipped: boolean; afk?: boolean; fromSpeakerId?: string }) => {
    const st = useGameStore.getState().gameState; // 读最新状态，同批加入的插话可立即插队优先
    if (!st || st.phase !== 'day' || winnerTeam) return;
    if (opts.fromSpeakerId && st.currentSpeaker !== opts.fromSpeakerId) return; // 防并发推进（插话不打断当前发言）
    const dp: DayPhaseState = st.dayPhase || {
      phase: 'round1', queue: [], interjectQueue: [], usedCount: {}, discussionRounds: 1, allSkipped: true, interjectedThisRound: [], sorterId: null,
    };
    const speakerId = st.currentSpeaker || '';
    const speaker = players.find(p => p.id === speakerId);
    const aliveIds = getAlivePlayers(players).map(p => p.id);
    const quotaOk = (id: string) => (dp.usedCount[id] || 0) < DISCUSS_QUOTA;

    if (opts.skipped && speaker) {
      addSystemMessage(`⏭️ ${speaker.name} ${opts.afk ? '长时间未发言（挂机跳过）' : '选择跳过'}`);
      recordSkipEvent(speaker.id);
    }

    // 更新配额与全员跳过标记（只有真正发言才消耗配额 / 清除 allSkipped）
    let usedCount = dp.usedCount;
    let allSkipped = dp.allSkipped;
    if (speakerId && !opts.skipped) {
      allSkipped = false;
      if (dp.phase === 'free_discussion') {
        usedCount = { ...usedCount, [speakerId]: (usedCount[speakerId] || 0) + 1 };
      }
    }

    // —— round1：按序发言，可跳过；全部跳过 → 直接进投票；否则进入自由讨论 ——
    if (dp.phase === 'round1') {
      const queue = dp.queue;
      const idx = queue.indexOf(speakerId);
      const nextIdx = idx + 1;
      if (nextIdx < queue.length) {
        setGameState({ ...st, currentSpeaker: queue[nextIdx], speechTimeLeft: 0, dayPhase: { ...dp, usedCount, allSkipped } });
        return;
      }
      if (allSkipped) {
        enterVotingNow({ ...dp, usedCount, allSkipped }, '全员跳过，一致同意投票');
        return;
      }
      const shuffled = [...aliveIds].sort(() => Math.random() - 0.5);
      setDayDiscussionRound(1);
      addSystemMessage(`🔔 第一轮发言结束，进入自由讨论（每人最多发言/插话 ${DISCUSS_QUOTA} 次，可跳过）`);
      setGameState({
        ...st,
        speakerOrder: shuffled,
        currentSpeaker: shuffled[0] || null,
        speechTimeLeft: 0,
        dayPhase: {
          phase: 'free_discussion',
          queue: shuffled,
          interjectQueue: [],
          usedCount,
          discussionRounds: 1,
          allSkipped: true,
          interjectedThisRound: [],
          sorterId: dp.sorterId ?? null,
        },
      });
      return;
    }

    // —— free_discussion ——
    // a) 插话队列优先（被点名者插队到队头；等当前说完，绝不打断正在思考/发言的 AI）
    const interjectEligible = dp.interjectQueue.filter(id => aliveIds.includes(id) && quotaOk(id));
    if (interjectEligible.length > 0) {
      const [first, ...rest] = interjectEligible;
      const interjectName = players.find(p => p.id === first)?.name || '';
      addSystemMessage(`⚡ ${interjectName} 被点名/质疑，插话发言（优先插队）`);
      recordInterjectEvent(first);
      setGameState({ ...st, currentSpeaker: first, speechTimeLeft: 0, dayPhase: { ...dp, interjectQueue: rest, usedCount, allSkipped } });
      return;
    }

    // b) 队列轮转（跳过超配额者）
    const queue = dp.queue;
    const idx = queue.indexOf(speakerId);
    let next: string | null = null;
    let wrapped = false;
    if (queue.length > 0) {
      for (let i = 1; i <= queue.length; i++) {
        const pos = (idx + i) % queue.length;
        const cand = queue[pos];
        if (aliveIds.includes(cand) && quotaOk(cand)) {
          next = cand;
          wrapped = pos <= idx;
          break;
        }
      }
    }

    if (next) {
      if (wrapped) {
        // 本轮结束
        if (allSkipped) {
          enterVotingNow({ ...dp, usedCount, allSkipped }, '本轮无人发言/全员跳过，提前投票');
          return;
        }
        if (dp.discussionRounds >= FREE_DISCUSS_MAX_ROUNDS) {
          enterVotingNow({ ...dp, usedCount, allSkipped }, `讨论已满 ${FREE_DISCUSS_MAX_ROUNDS} 轮`);
          return;
        }
        const newRounds = dp.discussionRounds + 1;
        setDayDiscussionRound(newRounds);
        addSystemMessage(`🔔 自由讨论第 ${newRounds} 轮开始`);
        setGameState({
          ...st,
          currentSpeaker: next,
          speechTimeLeft: 0,
          dayPhase: { ...dp, usedCount, allSkipped: true, discussionRounds: newRounds, interjectedThisRound: [] },
        });
        return;
      }
      setGameState({ ...st, currentSpeaker: next, speechTimeLeft: 0, dayPhase: { ...dp, usedCount, allSkipped } });
      return;
    }

    // c) 无人可发言（配额全部用完）→ 强制进投票
    enterVotingNow({ ...dp, usedCount, allSkipped }, '所有玩家发言配额已用完');
  }, [gameState, winnerTeam, players, addSystemMessage, setGameState, setDayDiscussionRound, enterVotingNow]);

  const advanceDayTurnRef = useRef(advanceDayTurn);
  useEffect(() => { advanceDayTurnRef.current = advanceDayTurn; }, [advanceDayTurn]);

  // v2.4.3 任务C：真人跳过按钮（任意阶段可跳过）
  const handleSkipSpeech = useCallback(() => {
    advanceDayTurnRef.current({ skipped: true, fromSpeakerId: gameState?.currentSpeaker || undefined });
  }, [gameState?.currentSpeaker]);

  // 获取投票结果，支持检测平局
  const getVoteResult = (votes: Record<string, string>): { result: string | null; tiePlayers: string[] } => {
    const voteCount: Record<string, number> = {};
    Object.values(votes).forEach((targetId) => {
      if (targetId) {
        voteCount[targetId] = (voteCount[targetId] || 0) + 1;
      }
    });

    let maxVotes = 0;
    let result: string | null = null;
    const tiePlayers: string[] = [];

    Object.entries(voteCount).forEach(([id, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        result = id;
        tiePlayers.length = 0;
        tiePlayers.push(id);
      } else if (count === maxVotes) {
        tiePlayers.push(id);
      }
    });

    // 如果有多个玩家票数相同且最高，则是平局
    if (tiePlayers.length > 1) {
      return { result: null, tiePlayers };
    }

    return { result, tiePlayers: [] };
  };

  const endVoting = useCallback(() => {
    if (!gameState || !isHost || winnerTeam) return;

    const { result, tiePlayers: roundTiePlayers } = getVoteResult(gameState.votes);
    const currentVoteCount = dayVoteCount + 1;

    if (!result && roundTiePlayers.length > 0) {
      // 平局情况
      if (currentVoteCount === 1) {
        // 第一次投票平局，进入平票争辩
        setTiePlayers(roundTiePlayers);
        setIsInTieDebate(true);
        setTieDebateRound(1);
        handleTieDebate();
      } else {
        // 第二次投票（争辩后）仍然平局，无人被处决
        addSystemMessage('⚔️ 争辩后投票仍然平局，无人被处决！');
        // 进入下一天
        resetDayState();
        
        // 重置狼人讨论状态
        lastWolfSpeakerId.current = null;
        wolfSpeakerProcessing.current = false;
        hasWolfTieDiscussion.current = false;
        
        setGameState({ 
          ...gameState, 
          phase: 'night', 
          votes: {},
          actionDone: {} 
        });
        setNightProcessed(false);
        addSystemMessage('🌙 天黑请闭眼');
        return;
      }
    } else if (!result) {
      // 没有投票结果（无人投票）
      addSystemMessage('投票结果平局，无人被处决');
      
      // 直接进入夜晚
      const wolfPlayers = players.filter(p => p.role === 'wolf' && p.isAlive);
      const wolfIds = wolfPlayers.map(p => p.id).sort(() => Math.random() - 0.5);
      
      lastWolfSpeakerId.current = null;
      wolfSpeakerProcessing.current = false;
      hasWolfTieDiscussion.current = false;
      witchActionProcessed.current = false;
      seerActionProcessed.current = false;
      wolfVoteCompleteRef.current = false;
      
      setWolfSpeakerOrder(wolfIds);
      setWolfCurrentSpeaker(wolfIds[0] || null);
      setWolfDiscussionRound(1);
      setWolfVotes({});
      setWolfVoteComplete(false);
      setWolfKillComplete(false);

      setGameState({
        ...gameState,
        phase: 'night',
        day: gameState.day + 1,
        votes: {},
        nightActions: [],
        actionDone: {},
        actionTimeLeft: 0,
        guardianLastTarget: gameState.guardianLastTarget,
        guardianActionComplete: false,
      });
      setNightProcessed(false);
      addSystemMessage('🌙 夜晚降临...');
    } else {
      // 有投票结果
      const votedPlayer = players.find((p) => p.id === result);
      if (votedPlayer) {
        // v2.4.4 任务 C：出局公告完整（谁被投票出局）+ 写入 deadPlayers
        addSystemMessage(`【公告】第${gameState.day}天 被投票出局：${votedPlayer.name}`);
        setGameHistory(prev => ({
          ...prev,
          deadPlayers: [
            ...(prev.deadPlayers || []),
            { name: votedPlayer.name, role: votedPlayer.role, day: gameState.day, reason: '被投票出局' },
          ],
        }));

        setPlayers(players.map((p) =>
          p.id === result ? { ...p, isAlive: false } : p
        ));

        // 检查当前玩家是否被投票出局，如果死亡且游戏未结束，则进入观战模式
        const myPlayerCheck = players.find(p => p.id === currentUser?.id);
        if (myPlayerCheck && myPlayerCheck.id === result) {
          setTimeout(() => {
            setIsSpectator(true);
            addSystemMessage('💀 你被投票出局，进入观战模式');
          }, 100);
        }
        
        // v2.4.4 任务 B：猎人被票出局 → 先遗言，再开枪（遗言 → 开枪目标+理由）
        if (votedPlayer.role === 'hunter') {
          pendingHunterShootRef.current = true;
          addSystemMessage(`💬 ${votedPlayer.name}（猎人）被投票出局，可以先说遗言`);
          setGameState({
            ...gameState,
            phase: 'lastWords',
            lastWordsPlayer: result,
            currentSpeaker: result,
            speechTimeLeft: 60,
          });
        } else {
          // 进入遗言阶段
          setGameState({
            ...gameState,
            phase: 'lastWords',
            lastWordsPlayer: result,
            currentSpeaker: result,
            speechTimeLeft: 60,
          });
          addSystemMessage(`💬 ${votedPlayer.name} 可以说遗言`);
        }
      }
    }
  }, [gameState, isHost, players, setPlayers, addSystemMessage, winnerTeam, setGameState, setWolfSpeakerOrder, setWolfCurrentSpeaker, setWolfDiscussionRound, currentUser, setIsSpectator, dayVoteCount, resetDayState, getVoteResult]);

  // 夜晚结算后统一进入白天（被 night 结算与"夜里被刀的猎人开枪后"共用）
  const transitionToDay = useCallback((updatedPlayers: Player[], fromState: typeof gameState) => {
    if (!fromState) return;

    const alivePlayerIds = getAlivePlayers(updatedPlayers).map(p => p.id);

    // 检查当前玩家是否死亡，如果死亡且游戏未结束，则进入观战模式
    const myPlayer = updatedPlayers.find(p => p.id === currentUser?.id);
    if (myPlayer && !myPlayer.isAlive) {
      setIsSpectator(true);
      addSystemMessage('💀 你已死亡，进入观战模式');
    }

    lastWolfSpeakerId.current = null;
    wolfSpeakerProcessing.current = false;
    hasWolfTieDiscussion.current = false;
    witchActionProcessed.current = false;
    seerActionProcessed.current = false;
    wolfVoteCompleteRef.current = false;

    setWolfVotes({});
    setWolfVoteComplete(false);
    setWolfKillComplete(false);
    setSelectedKillTarget(null);

    const wolfIds = updatedPlayers.filter(p => p.role === 'wolf' && p.isAlive).map(p => p.id);
    setWolfSpeakerOrder(wolfIds.sort(() => Math.random() - 0.5));
    setWolfCurrentSpeaker(wolfIds[0] || null);
    setWolfDiscussionRound(1);

    // 重置白天讨论轮数
    setDayDiscussionRound(1);

    const randomSpeakerOrder = [...alivePlayerIds].sort(() => Math.random() - 0.5);
    setGameState({
      ...fromState,
      phase: 'day',
      day: fromState.day + 1,
      nightActions: [],
      actionDone: {},
      actionTimeLeft: 0,
      guardianLastTarget: fromState.guardianLastTarget,
      guardianActionComplete: false,
      speakerOrder: randomSpeakerOrder,
      currentSpeaker: randomSpeakerOrder[0] || null,
      votes: {},
      // v2.4.3：进入白天 → 第一轮回合发言（保底），全员跳过则直接进投票
      dayPhase: {
        phase: 'round1',
        queue: randomSpeakerOrder,
        interjectQueue: [],
        usedCount: {},
        discussionRounds: 1,
        allSkipped: true,
        interjectedThisRound: [],
        sorterId: null,
      },
    });

    setNightProcessed(false);
    setGuardianActionCompleteState(false);
    addSystemMessage('☀️ 天亮了！所有人请睁眼');
  }, [currentUser, addSystemMessage, setWolfVotes, setWolfVoteComplete, setWolfKillComplete, setSelectedKillTarget, setWolfSpeakerOrder, setWolfCurrentSpeaker, setWolfDiscussionRound, setDayDiscussionRound, setGameState, setNightProcessed, setGuardianActionCompleteState, setIsSpectator]);

  const handleHunterShoot = useCallback((targetId: string) => {
    if (!gameState || !isHost || winnerTeam) return;
    if (gameState.phase !== 'hunterShoot') return;

    const hunterPlayer = players.find(p => p.id === gameState.lastWordsPlayer);
    const targetPlayer = players.find(p => p.id === targetId);
    
    if (!hunterPlayer || !targetPlayer) return;

    // v2.4.4 任务 D：猎人开枪带理由（公开理由，供所有玩家看到）
    const shootReason = `${targetPlayer.name} 的发言/票型可疑，我带走他`;
    addSystemMessage(`🔫 ${hunterPlayer.name}（猎人）开枪带走 ${targetPlayer.name}（理由：${shootReason}）`);

    // 标记目标玩家死亡
    const updatedPlayers = players.map((p) =>
      p.id === targetId ? { ...p, isAlive: false } : p
    );
    setPlayers(updatedPlayers);

    // v2.4.4 任务 C：猎人枪写入 deadPlayers（死讯完整：谁/何时/怎么死）
    setGameHistory(prev => ({
      ...prev,
      deadPlayers: [
        ...(prev.deadPlayers || []),
        { name: targetPlayer.name, role: targetPlayer.role, day: gameState.day, reason: '猎人枪' },
      ],
    }));

    // 检查当前玩家是否被猎人带走
    if (currentUser?.id === targetId) {
      setTimeout(() => {
        setIsSpectator(true);
        addSystemMessage('💀 你被猎人开枪带走，进入观战模式');
      }, 100);
    }

    // S1：猎人夜里被狼刀死 → 开枪后直接进入白天（当天死讯已公布）
    if (nightHunterShoot.current) {
      nightHunterShoot.current = false;

      const winner = checkWinCondition(updatedPlayers);
      if (winner) {
        setWinnerTeam(winner);
        setGameState({ ...gameState, phase: 'ended', winner });
        addSystemMessage(winner === 'wolf' ? '🐺 狼人获胜！' : '✨ 好人阵营获胜！');
        return;
      }

      transitionToDay(updatedPlayers, gameState);
      return;
    }

    // v2.4.4 任务 B：被投票出局的猎人 → 遗言已在开枪前说完，开枪后直接进入夜晚
    const winnerAfter = checkWinCondition(updatedPlayers);
    if (winnerAfter) {
      setWinnerTeam(winnerAfter);
      setGameState({ ...gameState, phase: 'ended', winner: winnerAfter });
      addSystemMessage(winnerAfter === 'wolf' ? '🐺 狼人获胜！' : '✨ 好人阵营获胜！');
      return;
    }

    const wolfPlayers = updatedPlayers.filter(p => p.role === 'wolf' && p.isAlive);
    const wolfIds = wolfPlayers.map(p => p.id).sort(() => Math.random() - 0.5);
    lastWolfSpeakerId.current = null;
    wolfSpeakerProcessing.current = false;
    hasWolfTieDiscussion.current = false;
    witchActionProcessed.current = false;
    seerActionProcessed.current = false;
    wolfVoteCompleteRef.current = false;
    setWolfSpeakerOrder(wolfIds);
    setWolfCurrentSpeaker(wolfIds[0] || null);
    setWolfDiscussionRound(1);
    setWolfVotes({});
    setWolfVoteComplete(false);
    setWolfKillComplete(false);

    setGameState({
      ...gameState,
      phase: 'night',
      day: gameState.day + 1,
      votes: {},
      nightActions: [],
      actionDone: {},
      actionTimeLeft: 0,
      guardianLastTarget: gameState.guardianLastTarget,
      guardianActionComplete: false,
      lastWordsPlayer: null,
      hunterShootTarget: targetId,
    });
    setNightProcessed(false);
    addSystemMessage('🌙 夜晚降临...');
  }, [gameState, isHost, players, setPlayers, addSystemMessage, winnerTeam, setGameState, currentUser, setIsSpectator, checkWinCondition, transitionToDay, setWolfSpeakerOrder, setWolfCurrentSpeaker, setWolfDiscussionRound, setWolfVotes, setWolfVoteComplete, setWolfKillComplete, setNightProcessed]);

  const endLastWords = useCallback(() => {
    if (!gameState || !isHost || winnerTeam) return;

    const updatedPlayers = players;
    const winner = checkWinCondition(updatedPlayers);
    if (winner) {
      setWinnerTeam(winner);
      setGameState({ ...gameState, phase: 'ended', winner });
      addSystemMessage(winner === 'wolf' ? '🐺 狼人获胜！' : '✨ 好人阵营获胜！');
      return;
    }

    // v2.4.4 任务 B：被投票出局的猎人遗言完毕 → 进入开枪阶段（遗言 → 开枪目标+理由）
    if (pendingHunterShootRef.current) {
      pendingHunterShootRef.current = false;
      const lastWordsPlayer = players.find(p => p.id === gameState.lastWordsPlayer);
      setGameState({ ...gameState, phase: 'hunterShoot', hunterShootTarget: null, lastWordsPlayer: gameState.lastWordsPlayer });
      addSystemMessage(`🔫 ${lastWordsPlayer?.name || ''}（猎人）请选择开枪目标（理由也要说明）`);
      return;
    }

    const wolfPlayers = updatedPlayers.filter(p => p.role === 'wolf' && p.isAlive);
    const wolfIds = wolfPlayers.map(p => p.id).sort(() => Math.random() - 0.5);
    
    lastWolfSpeakerId.current = null;
    wolfSpeakerProcessing.current = false;
    hasWolfTieDiscussion.current = false;
    witchActionProcessed.current = false;
    seerActionProcessed.current = false;
    wolfVoteCompleteRef.current = false;
    
    setWolfSpeakerOrder(wolfIds);
    setWolfCurrentSpeaker(wolfIds[0] || null);
    setWolfDiscussionRound(1);
    setWolfVotes({});
    setWolfVoteComplete(false);
    setWolfKillComplete(false);

    setGameState({
      ...gameState,
      phase: 'night',
      day: gameState.day + 1,
      votes: {},
      nightActions: [],
      actionDone: {},
      actionTimeLeft: 0,
      guardianLastTarget: gameState.guardianLastTarget,
      guardianActionComplete: false,
      lastWordsPlayer: null,
      hunterShootTarget: null,
    });
    setNightProcessed(false);
    addSystemMessage('🌙 夜晚降临...');
  }, [gameState, isHost, players, addSystemMessage, checkWinCondition, winnerTeam, setGameState, setWolfSpeakerOrder, setWolfCurrentSpeaker, setWolfDiscussionRound, setWinnerTeam, setNightProcessed]);

  const sendMessage = useCallback((content: string) => {
    if (!currentUser) return;

    const message: Message = {
      id: generateRoomId(),
      roomId: currentRoom?.id || '',
      playerId: currentUser.id,
      playerName: currentUser.name,
      content,
      timestamp: new Date(),
      type: 'public',
    };
    addMessage(message);
    
    // 实时更新玩家信息库 - 记录当前玩家的发言
    setGameHistory(prev => {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      
      return {
        ...prev,
        playerKnowledge: {
          ...prev.playerKnowledge,
          [currentUser.name]: {
            ...prev.playerKnowledge?.[currentUser.name],
            name: currentUser.name,
            suspiciousLevel: prev.playerKnowledge?.[currentUser.name]?.suspiciousLevel || 50,
            notes: [
              ...(prev.playerKnowledge?.[currentUser.name]?.notes ? [prev.playerKnowledge[currentUser.name].notes] : []),
              `第${gameState?.day || 1}天发言: ${content}`
            ].slice(-5).join(' | ')
          }
        },
        timeline: [
          ...prev.timeline,
          {
            time: timeStr,
            day: gameState?.day || 1,
            phase: gameState?.phase === 'lastWords' ? '遗言' : '白天发言',
            event: `${currentUser.name}发言: ${content.substring(0, 30)}${content.length > 30 ? '...' : ''}`,
            actor: currentUser.name
          }
        ].slice(-20)
      };
    });
    
    // 白天发言逻辑：轮到自己发言 → 发送后推进状态机；自由讨论非自己回合 → 计为插话（计入配额，不打断当前 AI）
    if (gameState?.phase === 'day' && gameState?.dayPhase?.phase === 'free_discussion' && gameState?.currentSpeaker !== currentUser.id) {
      const meId = currentUser.id;
      const meName = currentUser.name;
      const me = players.find(p => p.id === meId);
      if (me && me.isAlive) {
        const dp = gameState.dayPhase;
        const usedCount = { ...dp.usedCount, [meId]: (dp.usedCount[meId] || 0) + 1 };
        const interjectedThisRound = dp.interjectedThisRound.includes(meId)
          ? dp.interjectedThisRound
          : [...dp.interjectedThisRound, meId];
        addSystemMessage(`⚡ ${meName} 插话发言`);
        recordInterjectEvent(meId);
        setGameState({ ...gameState, dayPhase: { ...dp, usedCount, allSkipped: false, interjectedThisRound } });
      }
    } else if (gameState?.phase === 'day' && gameState?.currentSpeaker === currentUser.id) {
      advanceDayTurnRef.current({ skipped: false, fromSpeakerId: currentUser.id });
    }
    
    // 遗言发言逻辑：如果轮到自己说遗言，发送消息后结束遗言阶段
    if (gameState?.phase === 'lastWords' && gameState?.lastWordsPlayer === currentUser.id) {
      endLastWords();
    }

    // 任务E：记忆库联动（白天/遗言发言后压缩与自己相关的对话）
    updateMemoryForSpeech(currentUser.name, content);

    // 任务B1：真人发言后，AI 判断是否被点名/质疑 → 插话
    if (gameState?.phase === 'day') {
      maybeTriggerInterjections(content, currentUser.id);
    }
  }, [currentUser, currentRoom?.id, addMessage, gameState?.phase, gameState?.currentSpeaker, gameState?.lastWordsPlayer, endLastWords, gameState?.day, gameState?.dayPhase, players, addSystemMessage, setGameState, recordInterjectEvent, updateMemoryForSpeech, maybeTriggerInterjections]);

  const sendWolfChatMessage = useCallback((content: string) => {
    if (!currentUser || myRole !== 'wolf') return;

    const message: Message = {
      id: generateRoomId(),
      roomId: currentRoom?.id || '',
      playerId: currentUser.id,
      playerName: currentUser.name,
      content,
      timestamp: new Date(),
      type: 'wolf_chat',
    };
    addWolfChatMessage(message);
    
    // 更新最后发言者 ID，以便 AI 能够继续发言
    lastWolfSpeakerId.current = currentUser.id;
    
    setTimeout(() => {
      if (handleNextWolfSpeakerRef.current) {
        handleNextWolfSpeakerRef.current();
      } else {
        console.error('handleNextWolfSpeakerRef.current 未设置！');
      }
    }, 0);
  }, [currentUser, myRole, currentRoom?.id, addWolfChatMessage]);

  const handleStartVote = useCallback(() => {
    if (!gameState || gameState.phase !== 'day' || winnerTeam) return;
    
    // v2.4.3：第一轮（round1）保底发言未完成时不允许发起投票；进入自由讨论后即可投票
    if (gameState.dayPhase?.phase === 'round1') {
      addLog({
        type: 'warning',
        title: '无法发起投票',
        message: '第一轮发言阶段不能发起投票，请先完成第一轮发言（或等待全员跳过）',
      });
      addSystemMessage('🔔 第一轮发言尚未完成，暂不能发起投票');
      return;
    }
    
    addSystemMessage('🔔 玩家发起投票！');
    
    // 中断所有正在思考的AI玩家
    Object.keys(thinkingPlayers).forEach(playerId => {
      removeThinkingPlayer(playerId);
    });
    
    // 重置发言状态
    wolfSpeakerProcessing.current = false;
    lastWolfSpeakerId.current = null;
    setIsProcessing(false);
    
    // 进入投票阶段（dayPhase → voting）
    setGameState(prev => prev ? { ...prev, phase: 'vote', currentSpeaker: null, dayPhase: { ...prev.dayPhase, phase: 'voting' } } : prev);
    setAiVotingComplete(false);
    setTimeout(() => {
      setShowVoteModal(true);
    }, 500);
  }, [gameState, winnerTeam, addSystemMessage, addLog, thinkingPlayers, removeThinkingPlayer]);

  const handleVote = useCallback((targetId: string) => {
    if (!currentUser || !gameState || winnerTeam) return;

    const newVotes = { ...gameState.votes };
    newVotes[currentUser.id] = targetId;
    setGameState({ ...gameState, votes: newVotes });
  }, [currentUser, gameState, winnerTeam, setGameState]);

  // 处理AI玩家的自动投票（人类玩家自己投票）
  const handleAutoAllVotes = useCallback(async () => {
    const alivePlayers = getAlivePlayers(players);
    const currentVotes = gameState?.votes || {};
    
    // 只给AI玩家进行自动投票，人类玩家需要自己投票
    const unvotedAIPlayers = alivePlayers.filter(p => p.isAI && currentVotes[p.id] === undefined);
    
    if (unvotedAIPlayers.length === 0) {
      addLog({
        type: 'info',
        title: 'AI投票完成',
        message: '所有AI玩家已完成投票，等待人类玩家投票',
      });
      votingInProgress.current = false;
      return;
    }
    
    addLog({
      type: 'info',
      title: '开始AI投票',
      message: `正在为 ${unvotedAIPlayers.length} 名AI玩家进行投票`,
    });
    
    for (const player of unvotedAIPlayers) {
      if (getAborted()) return;
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const { targetId } = await generateAIVoteDecision(
        aiConfig,
        player.role!,
        player.name,
        players,
        messages,
        '投票',
        gameState?.day || 1,
        tiePlayers,
        isInTieDebate,
        player.id
      );
      
      setGameState(prev => ({
        ...prev!,
        votes: { ...prev!.votes, [player.id]: targetId || 'skip' }
      }));
      
      const targetPlayer = targetId && targetId !== 'skip' 
        ? players.find(p => p.id === targetId)
        : null;
      
      addLog({
        type: 'info',
        title: `${player.name} 投票`,
        message: `${player.name} 投票给 ${targetPlayer?.name || '弃票'}`,
        playerName: player.name,
      });
    }
  }, [players, gameState, tiePlayers, isInTieDebate, setGameState, aiConfig, messages, addLog]);

  const handleAIRevote = useCallback(async () => {
    const alivePlayers = getAlivePlayers(players);
    const aiPlayers = alivePlayers.filter(p => p.isAI);
    // 任务2：加投（PK）阶段强制平票约束，禁止弃票
    const revoteTiePlayers = tiePlayers;
    
    for (const aiPlayer of aiPlayers) {
      if (getAborted()) return;
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const { targetId } = await generateAIVoteDecision(
        aiConfig,
        aiPlayer.role!,
        aiPlayer.name,
        players,
        messages,
        '投票',
        gameState?.day || 1,
        revoteTiePlayers,
        true,
        aiPlayer.id
      );
      
      // 任务2：加投阶段禁止弃票，若AI仍返回 skip/空，强制投给一个平票玩家
      let finalTargetId = targetId;
      if (finalTargetId === 'skip' || !finalTargetId) {
        // v2.4 任务 A-3：PK 阶段强制投票也不能投自己
        const tieTargets = alivePlayers.filter(p => revoteTiePlayers.includes(p.id) && p.id !== aiPlayer.id);
        if (tieTargets.length > 0) {
          finalTargetId = tieTargets[Math.floor(Math.random() * tieTargets.length)].id;
          const tieTargetName = tieTargets.find(t => t.id === finalTargetId)?.name;
          addLog({
            type: 'warning',
            title: `${aiPlayer.name} 强制投票`,
            message: `${aiPlayer.name} 加投阶段未选择目标，已强制投给 ${tieTargetName}`,
            playerName: aiPlayer.name,
          });
        }
      }
      
      if (finalTargetId) {
        setGameState(prev => ({
          ...prev!,
          votes: { ...prev!.votes, [aiPlayer.id]: finalTargetId }
        }));
        
        const targetPlayer = players.find(p => p.id === finalTargetId);
        addLog({
          type: 'info',
          title: `${aiPlayer.name} 投票`,
          message: `${aiPlayer.name} 投票给 ${targetPlayer?.name || '未知'}`,
          playerName: aiPlayer.name,
        });
      }
    }
  }, [players, gameState, tiePlayers, setGameState, aiConfig, messages, addLog]);

  // 投票阶段自动让AI进行投票
  const votingInProgress = useRef(false);
  
  useEffect(() => {
    if (!gameState || gameState.phase !== 'vote' || winnerTeam) return;
    
    // 防止重复调用
    if (votingInProgress.current) {
      return;
    }
    
    votingInProgress.current = true;
    
    // 等待模态框显示后，自动触发AI投票
    setTimeout(() => {
      if (isHost) {
        handleAutoAllVotes().finally(() => {
          votingInProgress.current = false;
          setAiVotingComplete(true);
        });
      } else {
        votingInProgress.current = false;
      }
    }, 1000);
  }, [gameState?.phase, winnerTeam, isHost, handleAutoAllVotes]);

  // 处理平票争辩
  const handleTieDebate = useCallback(async () => {
    if (!gameState || tiePlayers.length !== 2) return;

    const player1 = players.find(p => p.id === tiePlayers[0]);
    const player2 = players.find(p => p.id === tiePlayers[1]);

    if (!player1 || !player2) return;

    addSystemMessage(`⚔️ 平票争辩开始！${player1.name} vs ${player2.name}`);

    // 平票争辩，至多6轮
    for (let i = 0; i < 6; i++) {
      if (getAborted()) return;

      setTieDebateRound(i + 1);
      addSystemMessage(`🔔 争辩第${i + 1}轮`);

      // 玩家1发言（如果是AI）
      if (player1.isAI) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (getAborted()) return;

        const response = await callAIApi(
          aiConfig,
          player1.role!,
          player1.name,
          players,
          messages,
          '平票争辩',
          gameState.day,
          gameState.nightActions,
          gameHistory
        );

        addMessage({
          id: generateRoomId(),
          roomId: currentRoom?.id || '',
          playerId: player1.id,
          playerName: player1.name,
          content: response,
          timestamp: new Date(),
          type: 'public',
        });
      }

      // 玩家2发言（如果是AI）
      if (player2.isAI) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (getAborted()) return;

        const response = await callAIApi(
          aiConfig,
          player2.role!,
          player2.name,
          players,
          messages,
          '平票争辩',
          gameState.day,
          gameState.nightActions,
          gameHistory
        );

        addMessage({
          id: generateRoomId(),
          roomId: currentRoom?.id || '',
          playerId: player2.id,
          playerName: player2.name,
          content: response,
          timestamp: new Date(),
          type: 'public',
        });
      }
    }

    // 争辩结束，进入重新投票阶段
    addSystemMessage('🔔 争辩结束，进入重新投票阶段！');
    setIsInTieDebate(false);
    setAiVotingComplete(false);
    setGameState({ ...gameState, phase: 'vote', votes: {} });
    handleAIRevote();
  }, [gameState, tiePlayers, players, aiConfig, messages, addSystemMessage, callAIApi, addMessage, currentRoom?.id, generateRoomId, setIsInTieDebate, setGameState, handleAIRevote, gameHistory]);

  useEffect(() => {
    if (!gameState || gameState.phase !== 'vote' || winnerTeam) return;
    if (!isHost) return;
    if (!aiVotingComplete) return;

    const alivePlayers = getAlivePlayers(players);
    const allPlayersVoted = alivePlayers.every(p => gameState.votes[p.id] !== undefined);

    if (allPlayersVoted && Object.keys(gameState.votes).length > 0) {
      const timer = setTimeout(() => {
        endVoting();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [gameState?.votes, gameState?.phase, winnerTeam, isHost, players, endVoting, aiVotingComplete]);

  useEffect(() => {
    if (!gameState || gameState.phase !== 'hunterShoot' || winnerTeam) return;
    if (!isHost) return;

    const hunterPlayer = players.find(p => p.id === gameState.lastWordsPlayer);
    
    if (hunterPlayer?.isAI) {
      const handleAIHunterShoot = async () => {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (getAborted() || gameState.phase !== 'hunterShoot') return;

        const alivePlayers = players.filter(p => p.isAlive);
        if (alivePlayers.length === 0) {
          handleHunterShoot('');
          return;
        }

        const targetPlayer = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
        handleHunterShoot(targetPlayer.id);
      };
      
      handleAIHunterShoot();
    }
  }, [gameState?.phase, gameState?.lastWordsPlayer, isHost, winnerTeam, players, handleHunterShoot]);

  useEffect(() => {
    if (!gameState || gameState.phase !== 'lastWords' || winnerTeam) return;
    if (!isHost) return;
    
    const lastWordsPlayer = players.find(p => p.id === gameState.lastWordsPlayer);
    
    if (lastWordsPlayer?.isAI) {
      // AI玩家，让他发言
      const handleAILastWords = async () => {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (getAborted() || gameState.phase !== 'lastWords') return;
        
        const response = await callAIApi(
          aiConfig,
          lastWordsPlayer.role!,
          lastWordsPlayer.name,
          players,
          messages,
          '遗言',
          gameState.day,
          gameState.nightActions,
          gameHistory
        );
        
        addMessage({
          id: generateRoomId(),
          roomId: currentRoom?.id || '',
          playerId: lastWordsPlayer.id,
          playerName: lastWordsPlayer.name,
          content: response,
          timestamp: new Date(),
          type: 'public',
        });
        
        // 发言结束后进入夜晚
        await new Promise(resolve => setTimeout(resolve, 1500));
        endLastWords();
      };
      
      handleAILastWords();
    } else if (gameState.speechTimeLeft <= 0) {
      // 遗言时间结束，进入夜晚
      endLastWords();
    }
  }, [gameState?.speechTimeLeft, gameState?.phase, gameState?.lastWordsPlayer, isHost, winnerTeam, endLastWords, players, aiConfig, messages, addMessage, currentRoom?.id, gameHistory]);

  const handleNightAction = useCallback((action: 'kill' | 'check' | 'heal' | 'poison' | 'guard', targetId: string) => {
    addLog({
      type: 'info',
      title: 'handleNightAction 被调用',
      message: `action: ${action}, targetId: ${targetId}`,
      details: `currentUser: ${JSON.stringify(currentUser)}, gameState.phase: ${gameState?.phase}, winnerTeam: ${winnerTeam}`,
    });
    
    if (!currentUser || !gameState || winnerTeam) {
      addLog({
        type: 'error',
        title: 'handleNightAction 提前返回',
        message: '条件检查失败',
        details: `currentUser: ${!!currentUser}, gameState: ${!!gameState}, winnerTeam: ${!!winnerTeam}`,
      });
      return;
    }

    // 找到当前玩家在玩家列表中的实际对象
    // 优先按ID查找，如果找不到则按名称查找
    let myPlayer = players.find(p => p.id === currentUser.id);
    
    // 如果按ID找不到，尝试按名称查找
    if (!myPlayer) {
      myPlayer = players.find(p => p.name === currentUser.name);
    }
    
    // 如果还是找不到，尝试找主持人（用于调试）
    if (!myPlayer) {
      myPlayer = players.find(p => p.isHost);
    }
    
    addLog({
      type: 'info',
      title: '查找玩家',
      message: `当前用户ID: ${currentUser.id}, 当前用户名: ${currentUser.name}, 找到玩家: ${!!myPlayer}`,
      details: `玩家列表ID: ${players.map(p => p.id).join(', ')}, 玩家列表名称: ${players.map(p => p.name).join(', ')}`,
    });
    
    // 必须使用玩家列表中的真实ID，否则行动进度无法正确更新
    if (!myPlayer) {
      addLog({
        type: 'error',
        title: '找不到玩家',
        message: `无法在玩家列表中找到当前用户 ${currentUser.name}`,
        details: `currentUser: ${JSON.stringify(currentUser)}, players: ${JSON.stringify(players)}`,
      });
      return;
    }
    
    const playerId = myPlayer.id;
    const playerRole = myPlayer.role;

    // 使用玩家ID来设置actionDone，确保与进度检查时的键一致
    const newActions = [...gameState.nightActions, { playerId: playerId, action, targetId }];
    const newActionDone = { ...gameState.actionDone, [playerId]: true };
    
    // 如果是守卫行动，更新守卫状态
    const isGuardianAction = playerRole === 'guardian' && action === 'guard';
    
    // 如果是女巫行动，更新药剂状态
    const isWitchAction = playerRole === 'witch' && (action === 'heal' || action === 'poison');
    const newWitchHasHealPotion = action === 'heal' ? false : gameState.witchHasHealPotion;
    const newWitchHasPoisonPotion = action === 'poison' ? false : gameState.witchHasPoisonPotion;
    
    if (isGuardianAction) {
      setGuardianActionCompleteState(true);
      addLog({
        type: 'success',
        title: '守卫行动完成',
        message: `${currentUser.name} 选择守护 ${players.find(p => p.id === targetId)?.name || '未知目标'}`,
        details: `actionDone[${currentUser.id}] = true`,
      });
    }
    
    if (isWitchAction) {
      addLog({
        type: 'success',
        title: '女巫行动',
        message: action === 'heal' 
          ? `${currentUser.name} 使用解药救了 ${players.find(p => p.id === targetId)?.name || '未知目标'}`
          : `${currentUser.name} 使用毒药毒杀了 ${players.find(p => p.id === targetId)?.name || '未知目标'}`,
        details: `actionDone[${currentUser.id}] = true`,
      });
    }
    
    if (action === 'check') {
      addLog({
        type: 'success',
        title: '预言家行动完成',
        message: `${currentUser.name} 查验了 ${players.find(p => p.id === targetId)?.name || '未知目标'}`,
        details: `actionDone[${playerId}] = true, 玩家角色: ${playerRole}`,
      });
    }
    
    const targetPlayer = players.find((p) => p.id === targetId);
    
    // 记录人类玩家的行动到gameHistory
    if (action === 'check') {
      const targetRole = targetPlayer?.role;
      const isWolf = targetRole === 'wolf';
      setGameHistory(prev => ({
        ...prev,
        skillUsage: {
          ...prev.skillUsage,
          [currentUser.name]: {
            ...prev.skillUsage?.[currentUser.name],
            [`第${gameState.day}晚查验`]: { result: `查验了${targetPlayer?.name}，结果：${isWolf ? '狼人' : '好人'}` }
          }
        }
      }));
    } else if (action === 'heal') {
      setGameHistory(prev => ({
        ...prev,
        skillUsage: {
          ...prev.skillUsage,
          [currentUser.name]: {
            ...prev.skillUsage?.[currentUser.name],
            [`第${gameState.day}晚解药`]: { result: `使用解药救了${targetPlayer?.name}` }
          }
        }
      }));
    } else if (action === 'poison') {
      setGameHistory(prev => ({
        ...prev,
        skillUsage: {
          ...prev.skillUsage,
          [currentUser.name]: {
            ...prev.skillUsage?.[currentUser.name],
            [`第${gameState.day}晚毒药`]: { result: `使用毒药毒死了${targetPlayer?.name}` }
          }
        }
      }));
    } else if (action === 'guard') {
      setGameHistory(prev => ({
        ...prev,
        skillUsage: {
          ...prev.skillUsage,
          [currentUser.name]: {
            ...prev.skillUsage?.[currentUser.name],
            [`第${gameState.day}晚守护`]: { result: `守护了${targetPlayer?.name}` }
          }
        }
      }));
    }
    
    addLog({
      type: 'info',
      title: '夜间行动调试',
      message: `${currentUser.name} 行动，准备更新状态`,
      details: `当前 actionDone: ${JSON.stringify(gameState.actionDone)}, 玩家ID: ${currentUser.id}`,
      playerName: currentUser.name,
    });
    
    const stateUpdates: Record<string, any> = {
      nightActions: newActions,
      actionDone: newActionDone,
    };
    
    if (isGuardianAction) {
      stateUpdates.guardianActionComplete = true;
      stateUpdates.guardianLastTarget = targetId;
    }
    
    if (isWitchAction) {
      stateUpdates.witchHasHealPotion = newWitchHasHealPotion;
      stateUpdates.witchHasPoisonPotion = newWitchHasPoisonPotion;
      stateUpdates.witchAntidoteUsed = action === 'heal' ? true : gameState.witchAntidoteUsed;
    }
    
    addLog({
      type: 'info',
      title: '准备更新游戏状态',
      message: `即将更新 actionDone`,
      details: `newActionDone: ${JSON.stringify(newActionDone)}, stateUpdates: ${JSON.stringify(Object.keys(stateUpdates))}`,
    });
    
    setGameState({ 
      ...gameState, 
      ...stateUpdates,
      actionDone: newActionDone,
    });
    
    addLog({
      type: 'success',
      title: '游戏状态更新完成',
      message: `${currentUser.name} 的 ${action} 行动已记录`,
      details: `actionDone[${playerId}]: ${newActionDone[playerId]}`,
    });
    
    const actionNames: Record<string, string> = { kill: '击杀', check: '查验', heal: '救治', poison: '毒杀', guard: '守护' };
    
    addLog({
      type: 'info',
      title: '夜间行动',
      message: `${currentUser.name} ${actionNames[action]} ${targetPlayer?.name}`,
      playerName: currentUser.name,
    });
    
    addLog({
      type: 'success',
      title: '行动进度更新',
      message: `${currentUser.name} 的行动已完成`,
      details: `actionDone[${playerId}] = ${newActionDone[playerId]}`,
      playerName: currentUser.name,
    });
    
    if (action === 'check') {
      const targetRole = targetPlayer?.role;
      if (targetRole) {
        const isWolf = targetRole === 'wolf';
        addSystemMessage(`你查验了 ${targetPlayer?.name}，${isWolf ? '他是狼人（坏人）' : '他是好人'}`);
      }
    }
    
    if (action === 'guard') {
      addSystemMessage(`你守护了 ${targetPlayer?.name}`);
    }
    
    if (action === 'heal') {
      addSystemMessage(`你使用解药救了 ${targetPlayer?.name}`);
    }
    
    if (action === 'poison') {
      addSystemMessage(`你使用毒药毒杀了 ${targetPlayer?.name}`);
    }
  }, [currentUser, gameState, winnerTeam, setGameState, players, addLog, setGuardianActionCompleteState, setGameHistory]);

  const handleSkipNight = useCallback(() => {
    if (!currentUser || !gameState || winnerTeam) return;
    
    addLog({
      type: 'info',
      title: '跳过行动调试',
      message: `${currentUser.name} 跳过夜晚行动，准备更新状态`,
      details: `当前 actionDone: ${JSON.stringify(gameState.actionDone)}, 玩家ID: ${currentUser.id}`,
      playerName: currentUser.name,
    });
    
    // 找到当前玩家在玩家列表中的实际对象
    // 优先按ID查找，如果找不到则按名称查找
    let myPlayer = players.find(p => p.id === currentUser.id);
    
    // 如果按ID找不到，尝试按名称查找
    if (!myPlayer) {
      myPlayer = players.find(p => p.name === currentUser.name);
    }
    
    // 如果还是找不到，尝试找主持人（用于调试）
    if (!myPlayer) {
      myPlayer = players.find(p => p.isHost);
    }
    
    // 必须使用玩家列表中的真实ID，否则行动进度无法正确更新
    if (!myPlayer) {
      addLog({
        type: 'error',
        title: '找不到玩家',
        message: `无法在玩家列表中找到当前用户 ${currentUser.name}`,
        details: `currentUser: ${JSON.stringify(currentUser)}, players: ${JSON.stringify(players)}`,
      });
      return;
    }
    
    const playerId = myPlayer.id;
    
    addLog({
      type: 'info',
      title: '跳过行动 - 玩家匹配',
      message: `找到玩家: ${myPlayer.name}, 使用ID: ${playerId}`,
      details: `玩家列表ID: ${players.map(p => p.id).join(', ')}`,
    });
    
    const newActionDone = { ...gameState.actionDone, [playerId]: true };
    setGameState({ ...gameState, actionDone: newActionDone });
    
    addLog({
      type: 'success',
      title: '跳过行动完成',
      message: `${currentUser.name} 已跳过夜晚行动`,
      details: `actionDone[${playerId}] = true`,
    });
  }, [currentUser, gameState, winnerTeam, setGameState, players]);

  const restartGame = useCallback(() => {
    clearRoomState();
    setShowRoles(false);
    setShowRules(false);
    setGameStarted(false);
    setWinnerTeam(null);
    setNightProcessed(false);
    setRoleSelectDone(false);
    setRedrawCount(0);
    resetWolfChatState();
    clearGameMemory();
    onNavigate('/');
  }, [clearRoomState, onNavigate, resetWolfChatState]);

  const leaveRoom = useCallback(() => {
    clearRoomState();
    setAborted(false);
    resetWolfChatState();
    clearGameMemory();
    onNavigate('/');
  }, [clearRoomState, onNavigate, resetWolfChatState]);

  const handleAbortGame = useCallback(() => {
    abortGame();
    setAborted(true);
    addLog({
      type: 'warning',
      title: '游戏已中止',
      message: '游戏进程已被中止，停止所有AI调用',
    });
    addSystemMessage('⚠️ 游戏已中止，所有AI操作已停止');
    setShowAbortConfirm(false);
  }, [abortGame, addLog, addSystemMessage]);

  // v2.4.5-A A4：局后复盘 → 更新对应职业经验库（后台跑，不阻塞对局；每职业生成 1 条有效经验）
  const runGameReview = useCallback(async (winner: 'wolf' | 'good' | null) => {
    try {
      const aiPlayers = players.filter(p => p.isAI);
      const rolesToReview = [...new Set(aiPlayers.map(p => p.role).filter(Boolean))] as Role[];
      if (rolesToReview.length === 0 || !aiConfig || getAborted()) return;

      const deadSummary = (gameHistory.deadPlayers || [])
        .map((d: { name: string; day: number; reason?: string }) => {
          const r = String(d.reason || '');
          if (r.includes('投票')) return `${d.name}第${d.day}天被票`;
          if (r.includes('毒')) return `${d.name}第${d.day}晚被毒`;
          if (r.includes('枪')) return `${d.name}第${d.day}天被枪`;
          return `${d.name}第${d.day}晚被刀`;
        })
        .slice(-8)
        .join('；');
      const summary = `本局共 ${players.filter(p => !p.isAlive).length} 人死亡（${deadSummary || '无'}）`;

      for (const role of rolesToReview) {
        if (getAborted()) break;
        const playerOfRole = aiPlayers.find(p => p.role === role);
        if (!playerOfRole) continue;
        const reviewPrompt = buildReviewPrompt(role, winner, summary);
        const reviewText = await callAIApi(
          aiConfig,
          role,
          playerOfRole.name,
          players,
          messages,
          '复盘',
          gameState?.day || 1,
          undefined,
          gameHistory,
          undefined,
          undefined,
          undefined,
          playerOfRole.id,
          reviewPrompt
        );
        const lines = reviewText.split('\n').map(l => l.trim()).filter(Boolean);
        const insightLine = lines.find(l => /^[-•*]|^\d+[.、]|^[一二三四五六]/.test(l)) || lines[0] || '';
        if (insightLine) {
          const added = addReviewInsight(role, insightLine.replace(/^[-•*]\s*|\d+[.、]\s*/, ''));
          if (added) {
            addLog({
              type: 'success',
              title: '复盘经验归并',
              message: `${getRoleInfo(role).name} 复盘心得已写入待归并经验池`,
              details: insightLine.slice(0, 100),
            });
          }
        }
      }
    } catch (e) {
      console.warn('局后复盘经验归并失败（不影响对局）:', e);
    }
  }, [players, aiConfig, messages, gameHistory, gameState?.day, addLog]);

  // v2.3 任务 E：对局结束时自动归档日志（默认保留最近 3 局，第 4 局删最早）
  const winnerArchiveRef = useRef(false);
  useEffect(() => {
    if (!winnerTeam || !gameState) return;
    if (winnerArchiveRef.current) return;
    winnerArchiveRef.current = true;
    archiveGameLogs({
      roomId: currentRoom?.id || 'local',
      roomName: currentRoom?.name || '未命名房间',
      winner: winnerTeam,
      day: gameState.day,
      logs,
    });
    addLog({
      type: 'success',
      title: '对局日志已归档',
      message: '本局日志已保存（最近 3 局内）',
    });
    // v2.4.5-A A4：对局结束后台跑一次复盘（更新对应职业经验库）
    void runGameReview(winnerTeam);
  }, [winnerTeam, gameState, currentRoom, logs, addLog, runGameReview]);

  const handleWolfVote = useCallback((targetId: string) => {
    if (!currentUser) return;
    const isCurrentUserWolf = players.some(p => p.id === currentUser.id && p.role === 'wolf' && p.isAlive);
    if (!isCurrentUserWolf) return;
    
    addWolfVote(currentUser.id, targetId);
    
    const targetPlayer = players.find(p => p.id === targetId);
    const targetName = targetId === 'skip' ? '跳过' : (targetPlayer?.name || '未知');
    setWolfDecision(currentUser.id, {
      targetId,
      intention: targetName,
      reason: '玩家手动投票',
    });
    
    addLog({
      type: 'info',
      title: `${currentUser.name} 投票`,
      message: `${currentUser.name} 投票 ${targetName}`,
      playerName: currentUser.name,
    });
  }, [currentUser, players, addWolfVote, setWolfDecision, addLog]);

  const handleOpenWolfVoteModal = useCallback(() => {
    const isCurrentUserWolf = currentUser && players.some(p => p.id === currentUser.id && p.role === 'wolf' && p.isAlive);
    
    // 检查是否有守卫，如果有，必须等待守卫行动完成
    const hasGuardian = players.some(p => p.role === 'guardian' && p.isAlive);
    const guardianDone = !hasGuardian || guardianActionCompleteState;
    
    // 只有守卫行动完成后，狼人才能投票（预言家随时可以行动）
    if (isCurrentUserWolf && !wolfVotes[currentUser?.id || ''] && guardianDone) {
      setShowWolfVoteModal(true);
    } else if (isCurrentUserWolf && !wolfVotes[currentUser?.id || ''] && !guardianDone) {
      // 如果条件不满足，给用户提示
      addLog({
        type: 'info',
        title: '等待守卫行动',
        message: '请等待守卫行动完成后再投票',
      });
    }
  }, [players, wolfVotes, currentUser, guardianActionCompleteState, addLog]);

  const handleNextWolfSpeaker = useCallback(() => {
    console.log('=== handleNextWolfSpeaker ===');
    console.log('wolfCurrentSpeaker:', wolfCurrentSpeaker);
    console.log('wolfSpeakerOrder:', wolfSpeakerOrder);
    
    if (!wolfCurrentSpeaker || !wolfSpeakerOrder.length) {
      console.log('返回：没有当前发言者或发言顺序为空');
      return;
    }

    const currentIndex = wolfSpeakerOrder.indexOf(wolfCurrentSpeaker);
    console.log('当前索引:', currentIndex);
    
    if (currentIndex === -1) {
      console.error('当前发言者不在发言顺序中！');
      // 如果当前发言者不在顺序中，设置为第一个
      setWolfCurrentSpeaker(wolfSpeakerOrder[0]);
      return;
    }
    
    const nextIndex = (currentIndex + 1) % wolfSpeakerOrder.length;
    console.log('下一个索引:', nextIndex);
    console.log('下一个发言者:', wolfSpeakerOrder[nextIndex]);
    
    if (nextIndex === 0) {
      console.log('进入下一轮讨论');
      setWolfDiscussionRound(prev => prev + 1);
    }
    
    setWolfCurrentSpeaker(wolfSpeakerOrder[nextIndex]);
  }, [wolfCurrentSpeaker, wolfSpeakerOrder, setWolfDiscussionRound]);

  // 将函数赋值给 ref，以便在 sendWolfChatMessage 中使用
  useEffect(() => {
    handleNextWolfSpeakerRef.current = handleNextWolfSpeaker;
  }, [handleNextWolfSpeaker]);

  const handleExecuteKill = useCallback((targetId: string, fromOneVoteRight: boolean = false) => {
    if (!currentUser) return;
    
    const isCurrentUserWolf = players.some(p => p.id === currentUser.id && p.role === 'wolf' && p.isAlive);
    if (!isCurrentUserWolf && !fromOneVoteRight) return;

    setWolfVoteComplete(true);
    setWolfKillComplete(true);
    
    const targetPlayer = players.find(p => p.id === targetId);
    const targetName = targetId === 'skip' ? '跳过' : (targetPlayer?.name || '未知');
    
    if (targetId === 'skip') {
      setSelectedKillTarget(null);
      setWolfKillTarget(null);
      addLog({
        type: 'info',
        title: '狼人决定',
        message: '狼人决定今晚不杀人',
      });
      
      setWolfDecision(currentUser.id, {
        targetId,
        intention: '跳过',
        reason: fromOneVoteRight ? '玩家使用一票决定权选择跳过' : '玩家投票跳过',
      });
      
      const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
      const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
      wolfPlayerIds.forEach(id => newActionDone[id] = true);
      newActionDone['wolf_team'] = true;
      
      if (gameState) {
        setGameState({ ...gameState, actionDone: newActionDone });
      }
    } else {
      setSelectedKillTarget(targetId);
      setWolfKillTarget(targetId);
      
      setWolfDecision(currentUser.id, {
        targetId,
        intention: targetName,
        reason: fromOneVoteRight ? '玩家使用一票决定权击杀' : '玩家投票击杀',
      });
      
      const newActions = [...(gameState?.nightActions || []), { playerId: currentUser.id, action: 'kill' as const, targetId }];
      const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
      const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
      wolfPlayerIds.forEach(id => newActionDone[id] = true);
      newActionDone['wolf_team'] = true;
      
      if (gameState) {
        setGameState({ ...gameState, nightActions: newActions, actionDone: newActionDone });
      }
    }
  }, [currentUser, players, gameState, setGameState, setWolfKillTarget, addLog, setWolfDecision]);

  // 处理所有狼人投票完成
  const handleAllWolfVotes = useCallback(() => {
    // 只有在夜晚阶段才能调用 handleAllWolfVotes
    if (gameState?.phase !== 'night') {
      addLog({
        type: 'warning',
        title: '错误调用',
        message: `handleAllWolfVotes 在非夜晚阶段被调用，当前阶段: ${gameState?.phase}`,
      });
      return;
    }
    
    const wolfTeam = players.filter(p => p.role === 'wolf' && p.isAlive);
    const hasHumanWolf = wolfTeam.some(p => !p.isAI);
    
    // 如果有真实玩家，只使用玩家的投票结果
    if (hasHumanWolf) {
      const humanWolf = wolfTeam.find(p => !p.isAI);
      if (!humanWolf || wolfVotes[humanWolf.id] === undefined) {
        addLog({
          type: 'warning',
          title: '等待玩家投票',
          message: '等待真实玩家投票...',
        });
        return;
      }
      
      const targetId = wolfVotes[humanWolf.id];
      
      setWolfVoteComplete(true);
      setWolfKillComplete(true);
      
      if (targetId === 'skip') {
        setSelectedKillTarget(null);
        setWolfKillTarget(null);
        addLog({
          type: 'info',
          title: '狼人决定',
          message: `${humanWolf.name} 决定今晚不杀人`,
        });
        
        setWolfDecision(humanWolf.id, {
          targetId,
          intention: '跳过',
          reason: '玩家决定跳过',
        });
        
        const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
        const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
        wolfPlayerIds.forEach(id => newActionDone[id] = true);
        newActionDone['wolf_team'] = true;
        
        if (gameState) {
          setGameState({ ...gameState, actionDone: newActionDone });
        }
        return;
      }
      
      const targetPlayer = players.find(p => p.id === targetId);
      if (!targetPlayer) {
        addLog({
          type: 'error',
          title: '投票错误',
          message: `找不到投票目标 ${targetId}`,
        });
        return;
      }
      
      setSelectedKillTarget(targetId);
      setWolfKillTarget(targetId);
      
      setWolfDecision(humanWolf.id, {
        targetId,
        intention: targetPlayer.name,
        reason: '玩家投票决定',
      });
      
      addLog({
        type: 'info',
        title: '狼人决定',
        message: `${humanWolf.name} 决定击杀 ${targetPlayer.name}`,
      });
      
      const newActions = [...(gameState?.nightActions || []), { playerId: humanWolf.id, action: 'kill' as const, targetId }];
      const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
      const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
      wolfPlayerIds.forEach(id => newActionDone[id] = true);
      newActionDone['wolf_team'] = true;
      
      if (gameState) {
        setGameState({ ...gameState, nightActions: newActions, actionDone: newActionDone });
      }
      return;
    }
    
    // 纯 AI 狼人团队的投票处理逻辑
    const voteCount: Record<string, number> = {};
    Object.values(wolfVotes).forEach((targetId) => {
      if (targetId) {
        voteCount[targetId] = (voteCount[targetId] || 0) + 1;
      }
    });

    let maxVotes = 0;
    let targetId: string | null = null;
    let hasTie = false;

    Object.entries(voteCount).forEach(([id, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        targetId = id;
        hasTie = false;
      } else if (count === maxVotes) {
        hasTie = true;
      }
    });

    if (hasTie) {
      // 有平局，检查是否已经给过额外讨论机会
      if (!hasWolfTieDiscussion.current) {
        // 还没有给过额外讨论机会，再给一回合讨论
        hasWolfTieDiscussion.current = true;
        addLog({
          type: 'info',
          title: '狼人投票有争议',
          message: '狼人投票结果有争议，增加一回合讨论',
        });
        // 重置投票，让狼人重新讨论
        setWolfVotes({});
        setWolfDiscussionRound(prev => prev + 1);
        // 重置发言状态，允许所有狼人重新发言
        lastWolfSpeakerId.current = '';
        wolfSpeakerProcessing.current = false;
        // 先设置为null，然后在下一帧设置为第一个发言人，确保useEffect触发
        setWolfCurrentSpeaker(null);
        setTimeout(() => {
          // 在重新开始讨论前重置争议标志，允许后续再次争议时继续讨论
          hasWolfTieDiscussion.current = false;
          setWolfCurrentSpeaker(wolfSpeakerOrder[0] || null);
        }, 0);
        return;
      } else {
          // 已经给过额外讨论机会，还是平局
          // 如果玩家是狼人，让玩家决定
          const humanWolf = wolfTeam.find(p => !p.isAI);
          if (humanWolf && humanWolf.id === currentUser?.id) {
            // 玩家是狼人，让玩家决定
            addLog({
              type: 'info',
              title: '狼人投票有争议',
              message: '投票结果仍然有争议，请你决定击杀目标',
            });
            setWolfVotes({});
            // 触发新一轮讨论，让玩家发言
            setWolfDiscussionRound(prev => prev + 1);
            setWolfCurrentSpeaker(null);
            setTimeout(() => {
              setWolfCurrentSpeaker(currentUser?.id || null);
            }, 0);
            return;
          } else {
          // 没有人类狼人或玩家不是狼人，执行随机击杀或不杀人
          const aliveTargets = players.filter(p => p.isAlive && p.role !== 'wolf');
          if (aliveTargets.length > 0 && Math.random() > 0.5) {
            // 50%概率随机击杀一个目标
            const randomIndex = Math.floor(Math.random() * aliveTargets.length);
            targetId = aliveTargets[randomIndex].id;
            addLog({
              type: 'info',
              title: '狼人投票有争议',
              message: `投票结果有争议，随机选择击杀 ${aliveTargets[randomIndex].name}`,
            });
            // 设置投票完成状态
            setWolfVoteComplete(true);
            setWolfKillComplete(true);
            setSelectedKillTarget(targetId);
            setWolfKillTarget(targetId);
            
            const newActions = [...(gameState?.nightActions || []), { playerId: 'system', action: 'kill' as const, targetId }];
            const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
            const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
            wolfPlayerIds.forEach(id => newActionDone[id] = true);
            newActionDone['wolf_team'] = true;
            
            if (gameState) {
              setGameState({ ...gameState, nightActions: newActions, actionDone: newActionDone });
            }
            return;
          } else {
            // 50%概率不杀人
            setWolfVoteComplete(true);
            setWolfKillComplete(true);
            setSelectedKillTarget(null);
            setWolfKillTarget(null);
            
            const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
            const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
            wolfPlayerIds.forEach(id => newActionDone[id] = true);
            newActionDone['wolf_team'] = true;
            
            if (gameState) {
              setGameState({ ...gameState, actionDone: newActionDone });
            }
            addLog({
              type: 'info',
              title: '狼人投票有争议',
              message: '投票结果有争议，狼人决定今晚不杀人',
            });
            return;
          }
        }
      }
    }
    
    if (!targetId) {
      // 没有目标，不杀人
      setWolfVoteComplete(true);
      setWolfKillComplete(true);
      setSelectedKillTarget(null);
      setWolfKillTarget(null);
      
      const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
      const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
      wolfPlayerIds.forEach(id => newActionDone[id] = true);
      newActionDone['wolf_team'] = true;
      
      if (gameState) {
        setGameState({ ...gameState, actionDone: newActionDone });
      }
      return;
    }

    if (targetId === 'skip') {
      // 投票结果是跳过
      setWolfVoteComplete(true);
      setWolfKillComplete(true);
      setSelectedKillTarget(null);
      setWolfKillTarget(null);
      
      const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
      const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
      wolfPlayerIds.forEach(id => newActionDone[id] = true);
      newActionDone['wolf_team'] = true;
      
      if (gameState) {
        setGameState({ ...gameState, actionDone: newActionDone });
      }
      
      // 夜晚不显示结果，白天才公布
      return;
    }

    // 正常执行击杀
    setWolfVoteComplete(true);
    setWolfKillComplete(true);
    setSelectedKillTarget(targetId);
    setWolfKillTarget(targetId);
    
    const newActions = [...(gameState?.nightActions || []), { playerId: currentUser?.id || 'system', action: 'kill' as const, targetId }];
    const wolfPlayerIds = players.filter(p => p.role === 'wolf').map(p => p.id);
    const newActionDone: Record<string, boolean> = { ...gameState?.actionDone };
    wolfPlayerIds.forEach(id => newActionDone[id] = true);
    newActionDone['wolf_team'] = true;
    
    if (gameState) {
      setGameState({ ...gameState, nightActions: newActions, actionDone: newActionDone });
    }
    
    // 夜晚不显示击杀结果，白天才公布
  }, [wolfVotes, players, gameState, currentUser, setGameState, setWolfKillTarget, wolfSpeakerOrder, setWolfVotes, setWolfDiscussionRound, setWolfCurrentSpeaker, addLog]);

  // 这个 useEffect 只在纯 AI 狼人团队时才自动处理投票
  // 如果有真实玩家在狼人组，需要等待玩家投票
  useEffect(() => {
    if (!gameState || gameState.phase !== 'night') return;
    if (wolfVoteComplete) {
      addLog({
        type: 'info',
        title: '狼人投票跳过',
        message: '狼人投票已完成，跳过处理',
      });
      return;
    }
    
    // 狼人不需要等待守卫行动，守卫和狼人是同时行动的
    // 在狼人杀规则中，狼人先杀人，守卫后守护，女巫最后用药
    
    const wolfTeam = players.filter(p => p.role === 'wolf' && p.isAlive);
    const hasHumanWolf = wolfTeam.some(p => !p.isAI);
    
    // 如果有真实玩家在狼人组，不自动处理投票
    if (hasHumanWolf) {
      const humanWolf = wolfTeam.find(p => !p.isAI);
      const humanWolfVoted = humanWolf && wolfVotes[humanWolf.id] !== undefined;
      
      if (humanWolfVoted) {
        addLog({
          type: 'info',
          title: '玩家投票完成',
          message: `真实玩家 ${humanWolf!.name} 已投票，执行击杀`,
        });
        handleAllWolfVotes();
      }
      return;
    }
    
    const allVoted = wolfTeam.every(p => wolfVotes[p.id] !== undefined);
    
    addLog({
      type: 'info',
      title: '狼人投票检查',
      message: `所有狼人已投票: ${allVoted}, 讨论轮数: ${wolfDiscussionRound}`,
      details: `狼人团队: ${wolfTeam.map(p => p.name).join(', ')}, 投票情况: ${JSON.stringify(wolfVotes)}`,
    });
    
    // 只有纯 AI 狼人团队才在所有投票且至少讨论2轮后自动处理
    if (allVoted && wolfTeam.length > 0 && wolfDiscussionRound >= 2) {
      addLog({
        type: 'info',
        title: '狼人投票处理',
        message: '所有狼人已投票，执行击杀',
      });
      handleAllWolfVotes();
    }
  }, [wolfVotes, wolfDiscussionRound]);

  // AI狼人自动投票（根据讨论内容，确保发言和投票一致）
  // 注意：如果狼人组有真实玩家存活，AI不投票，只参与讨论
  const handleAIWolfVote = useCallback(async (aiPlayer: Player) => {
    if (aiPlayer.role !== 'wolf' || !aiPlayer.isAI) return;
    
    const wolfTeam = players.filter(p => p.role === 'wolf' && p.isAlive);
    const hasHumanWolf = wolfTeam.some(p => !p.isAI);
    
    if (hasHumanWolf) {
      addLog({
        type: 'info',
        title: `${aiPlayer.name} 不投票`,
        message: `狼人组有真实玩家，AI ${aiPlayer.name} 只参与讨论，不投票`,
        playerName: aiPlayer.name,
      });
      return;
    }
    
    // v2.3 任务 C3：狼人可刀任何人（含狼队友自刀），也可空刀；可刀目标 = 所有存活玩家
    const aliveTargets = players.filter(p => p.isAlive);
    if (aliveTargets.length === 0) return;
    
    const targetNames = aliveTargets.map(p => p.name);
    
    let mentionedTarget: string | null = null;
    let foundInOwnMessage = false;
    
    // 首先查找该狼人自己发言中的明确投票目标（{目标名称}格式）
    for (let i = wolfChatMessages.length - 1; i >= 0; i--) {
      const msg = wolfChatMessages[i];
      if (msg.playerId === aiPlayer.id) {
        // 优先查找 {目标名称} 格式 - 这是最明确的投票意图
        const voteMatch = msg.content.match(/\{([^}]+)\}/);
        if (voteMatch) {
          const voteTarget = voteMatch[1].trim();
          if (targetNames.includes(voteTarget)) {
            mentionedTarget = voteTarget;
            foundInOwnMessage = true;
            break;
          } else if (voteTarget === '跳过' || voteTarget === 'skip' || voteTarget === '不杀') {
            mentionedTarget = 'skip';
            foundInOwnMessage = true;
            break;
          }
        }
        // 如果没有找到明确的投票格式，不自动推断，需要进一步判断
        break;
      }
    }
    
    // 如果自己发言中没有明确投票格式，查找自己发言中提到的目标（只匹配"刀/杀/投/票"后面紧跟的名字）
    if (!mentionedTarget) {
      for (let i = wolfChatMessages.length - 1; i >= 0; i--) {
        const msg = wolfChatMessages[i];
        if (msg.playerId === aiPlayer.id) {
          // 只匹配明确的攻击意图："刀XX"、"杀XX"、"投XX"、"票XX"
          for (const name of targetNames) {
            const attackRegex = new RegExp(`(刀|杀|投|票)\\s*${name}`, 'gi');
            if (attackRegex.test(msg.content)) {
              mentionedTarget = name;
              foundInOwnMessage = true;
              break;
            }
          }
          if (!mentionedTarget) {
            // 检查是否明确表示跳过
            if (msg.content.includes('跳过') || 
                msg.content.includes('不杀') || 
                msg.content.includes('平安夜') ||
                msg.content.includes('不投')) {
              mentionedTarget = 'skip';
              foundInOwnMessage = true;
            }
          }
          break;
        }
      }
    }
    
    // 统一处理投票目标
    let targetId: string;
    let actualTargetName: string;
    
    if (mentionedTarget === 'skip') {
      targetId = 'skip';
      actualTargetName = '跳过';
      addLog({
        type: 'info',
        title: `${aiPlayer.name} 投票决定`,
        message: `${aiPlayer.name} 投票跳过（讨论中说: ${mentionedTarget}）`,
        playerName: aiPlayer.name,
        details: `发言内容中找到 {${mentionedTarget}}`,
      });
    } else if (mentionedTarget) {
      const targetPlayer = aliveTargets.find(p => p.name === mentionedTarget);
      if (targetPlayer) {
        targetId = targetPlayer.id;
        actualTargetName = targetPlayer.name;
        addLog({
          type: 'info',
          title: `${aiPlayer.name} 投票决定`,
          message: `${aiPlayer.name} 投票 ${actualTargetName}（讨论中说: ${mentionedTarget}）`,
          playerName: aiPlayer.name,
          details: `发言内容中找到 {${mentionedTarget}}`,
        });
      } else {
        const randomIndex = Math.floor(Math.random() * aliveTargets.length);
        targetId = aliveTargets[randomIndex].id;
        actualTargetName = aliveTargets[randomIndex].name;
        addLog({
          type: 'warning',
          title: `${aiPlayer.name} 投票决定`,
          message: `${aiPlayer.name} 随机投票 ${actualTargetName}（讨论中提到的 ${mentionedTarget} 不存在）`,
          playerName: aiPlayer.name,
          details: `发言内容中找到 {${mentionedTarget}}，但目标不存在，已随机选择`,
        });
      }
    } else {
      // 自己没有明确表态，随机选择
      const randomIndex = Math.floor(Math.random() * aliveTargets.length);
      targetId = aliveTargets[randomIndex].id;
      actualTargetName = aliveTargets[randomIndex].name;
      addLog({
        type: 'info',
        title: `${aiPlayer.name} 投票决定`,
        message: `${aiPlayer.name} 随机投票 ${actualTargetName}`,
        playerName: aiPlayer.name,
        details: '发言中未找到 {目标} 格式，已随机选择',
      });
    }
    
    addWolfVote(aiPlayer.id, targetId);
    
    setWolfDecision(aiPlayer.id, {
      targetId,
      intention: actualTargetName,
      reason: mentionedTarget ? `讨论中明确说要杀${mentionedTarget}` : '讨论中未明确目标',
    });
    
    addLog({
      type: 'success',
      title: `${aiPlayer.name} 投票完成`,
      message: `${aiPlayer.name} 已投票给 ${actualTargetName}`,
      playerName: aiPlayer.name,
      details: `投票目标ID: ${targetId}`,
    });
  }, [players, wolfChatMessages, addWolfVote, addLog, setWolfDecision]);

  // 守卫、预言家、女巫行动逻辑
  const guardianProcessed = useRef(false);
  const seerModalShown = useRef(false);
  const witchModalShown = useRef(false);
  
  useEffect(() => {
    // 当游戏阶段变化时重置处理标志
    if (gameState?.phase !== 'night') {
      guardianProcessed.current = false;
      seerActionProcessed.current = false;
      witchActionProcessed.current = false;
      seerModalShown.current = false;
      witchModalShown.current = false;
    }
  }, [gameState?.phase]);
  
  useEffect(() => {
    if (!gameState || !players.length || winnerTeam || isProcessing || gameState.phase !== 'night') return;
    
    // 检查守卫是否已经行动过
    if (!gameState.guardianActionComplete && !guardianProcessed.current) {
      const guardianPlayer = players.find(p => p.role === 'guardian' && p.isAlive);
      if (guardianPlayer && !guardianPlayer.isAI) {
        // 如果是真实玩家守卫，显示行动弹窗
        setShowNightActionModal(true);
        guardianProcessed.current = true;
        addLog({
          type: 'info',
          title: '守卫行动',
          message: '等待守卫行动',
        });
      }
    }
    
    // 检查预言家是否已经行动过（只处理人类预言家，AI预言家在其他地方处理）
    const seerPlayer = players.find(p => p.role === 'seer' && p.isAlive);
    if (seerPlayer && !gameState.actionDone[seerPlayer.id] && !seerModalShown.current && !seerPlayer.isAI) {
      // 如果是真实玩家预言家，显示行动弹窗
      setShowNightActionModal(true);
      seerModalShown.current = true;
      addLog({
        type: 'info',
        title: '预言家行动',
        message: '等待预言家行动',
      });
    }
  }, [gameState, players, winnerTeam, isProcessing, addLog]);

  useEffect(() => {
    if (!gameState || gameState.phase !== 'night' || !wolfVoteComplete) return;
    if (witchModalShown.current) return;
    
    const witchPlayer = players.find(p => p.role === 'witch' && p.isAlive);
    if (!witchPlayer) return;
    
    if (!witchPlayer.isAI) {
      // 如果是真实玩家女巫，在狼人投票完成后显示行动弹窗
      setShowNightActionModal(true);
      witchModalShown.current = true;
      addLog({
        type: 'info',
        title: '女巫行动',
        message: '等待女巫行动',
      });
    }
    // AI女巫的行动移到另一个专门的effect中处理，避免重复
  }, [gameState, players, wolfVoteComplete, addLog]);
  
  useEffect(() => {
    if (!gameState || !players.length || winnerTeam || isProcessing || gameState.phase !== 'night') return;
    
    // 守卫AI行动逻辑保持不变
    if (gameState.guardianActionComplete || guardianProcessed.current) return;
    
    const guardianPlayer = players.find(p => p.role === 'guardian' && p.isAlive);
    if (!guardianPlayer) return;
    
    if (!guardianPlayer.isAI) {
      return; // 已经在上面的effect中处理过了
    }
    
    // AI守卫调用API行动
    const executeGuardianAction = async () => {
      guardianProcessed.current = true;
      setIsProcessing(true);
      
      try {
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        
        if (getAborted() || winnerTeam) {
          setIsProcessing(false);
          return;
        }
        
        // 检查是否已经行动过（防止重复）
        if (gameState.guardianActionComplete) {
          setIsProcessing(false);
          return;
        }
        
        const guardianThought = await generateAIThought(
          aiConfig,
          guardianPlayer.role!,
          guardianPlayer.name,
          players,
          messages,
          'night',
          gameState.day,
          gameState.nightActions,
          gameHistory,
          guardianPlayer.id
        );
        
        if (getAborted() || winnerTeam) {
          setIsProcessing(false);
          return;
        }
        
        // 解析AI返回的目标
        const alivePlayers = players.filter(p => p.isAlive && p.id !== guardianPlayer.id);
        if (alivePlayers.length === 0) {
          setIsProcessing(false);
          return;
        }
        
        // 找出可以守护的目标（不能守护上一晚守护的目标）
        const availableTargets = alivePlayers.filter(p => p.id !== gameState.guardianLastTarget);
        const finalTargets = availableTargets.length > 0 ? availableTargets : alivePlayers;
        
        // 尝试从AI回复中提取目标
        let targetId: string | null = null;
        const targetNames = finalTargets.map(p => p.name);
        
        // 详细记录AI回复以便调试
        addLog({
          type: 'info',
          title: '守卫AI回复',
          message: `AI回复内容: ${guardianThought}`,
          details: `可用目标: ${targetNames.join(', ')}`,
        });
        
        // 检查AI回复是否是乱码（包含非中文字符）
        const isGarbage = !/[\u4e00-\u9fa5]/.test(guardianThought) && guardianThought.length > 0;
        if (isGarbage) {
          addLog({
            type: 'warning',
            title: '守卫AI回复异常',
            message: 'AI回复看起来是乱码，将使用随机选择',
            details: `原始回复: ${guardianThought}`,
          });
        }
        
        // 尝试多种匹配模式：
        // 1. "守卫守护:小明" - 两个守护后跟冒号
        // 2. "守卫守护小明" - 两个守护后直接跟名字
        // 3. "守护:小明" - 单个守护后跟冒号
        // 4. "守护小明" - 单个守护后直接跟名字
        // 5. 直接匹配名字
        let extractedName = '';
        
        // 如果不是乱码，尝试解析AI回复
        if (!isGarbage) {
          // 模式1: 守卫守护:目标 或 守卫守护：目标
          const pattern1 = /守卫守护[:：]\s*(\S+)/;
          const match1 = guardianThought.match(pattern1);
          if (match1) {
            extractedName = match1[1].trim();
            addLog({
              type: 'info',
              title: '守卫AI解析',
              message: `模式1匹配成功: ${extractedName}`,
            });
          }
          
          // 模式2: 守卫守护目标（无冒号）
          if (!extractedName) {
            for (const name of targetNames) {
              const pattern2 = new RegExp(`守卫守护${name}`);
              if (pattern2.test(guardianThought)) {
                extractedName = name;
                addLog({
                  type: 'info',
                  title: '守卫AI解析',
                  message: `模式2匹配成功: ${extractedName}`,
                });
                break;
              }
            }
          }
          
          // 模式3: 守护:目标 或 守护：目标
          if (!extractedName) {
            const pattern3 = /守护[:：]\s*(\S+)/;
            const match3 = guardianThought.match(pattern3);
            if (match3) {
              extractedName = match3[1].trim();
              addLog({
                type: 'info',
                title: '守卫AI解析',
                message: `模式3匹配成功: ${extractedName}`,
              });
            }
          }
          
          // 模式4: 守护目标（无冒号）
          if (!extractedName) {
            for (const name of targetNames) {
              const pattern4 = new RegExp(`守护${name}`);
              if (pattern4.test(guardianThought)) {
                extractedName = name;
                addLog({
                  type: 'info',
                  title: '守卫AI解析',
                  message: `模式4匹配成功: ${extractedName}`,
                });
                break;
              }
            }
          }
          
          // 模式5: 直接匹配名字（作为备用）
          if (!extractedName) {
            for (const name of targetNames) {
              if (guardianThought.includes(name)) {
                extractedName = name;
                addLog({
                  type: 'info',
                  title: '守卫AI解析',
                  message: `模式5匹配成功: ${extractedName}`,
                });
                break;
              }
            }
          }
        }
        
        if (extractedName) {
          for (const name of targetNames) {
            if (extractedName === name || extractedName.includes(name) || name.includes(extractedName)) {
              const targetPlayer = finalTargets.find(p => p.name === name);
              if (targetPlayer) {
                targetId = targetPlayer.id;
                addLog({
                  type: 'success',
                  title: '守卫AI解析成功',
                  message: `匹配到目标: ${name}`,
                });
                break;
              }
            }
          }
        }
        
        // 如果没有找到目标，随机选择
        if (!targetId) {
          const randomIndex = Math.floor(Math.random() * finalTargets.length);
          targetId = finalTargets[randomIndex].id;
          addLog({
            type: 'warning',
            title: '守卫随机选择',
            message: `没有从AI回复中找到明确目标，随机选择: ${finalTargets[randomIndex].name}`,
            details: `AI回复: ${guardianThought}`,
          });
        }
        
        const target = finalTargets.find(p => p.id === targetId);
        
        // 记录守卫的行动到gameHistory
        setGameHistory(prev => ({
          ...prev,
          skillUsage: {
            ...prev.skillUsage,
            [guardianPlayer.name]: {
              ...prev.skillUsage?.[guardianPlayer.name],
              [`第${gameState.day}晚守护`]: { result: `守护了${target?.name}` }
            }
          }
        }));
        
        // 添加守卫行动
        const newActions = [...gameState.nightActions, { playerId: guardianPlayer.id, action: 'guard' as const, targetId }];
        const newActionDone = { ...gameState.actionDone, [guardianPlayer.id]: true };
        setGuardianActionCompleteState(true);
        setGameState({
          ...gameState,
          nightActions: newActions,
          guardianActionComplete: true,
          guardianLastTarget: targetId,
          actionDone: newActionDone,
        });
        
        addLog({
          type: 'success',
          title: '守卫行动',
          message: `${guardianPlayer.name} 守护了 ${target?.name}`,
          playerName: guardianPlayer.name,
          details: `守护目标：${target?.name}`,
        });
      } finally {
        setIsProcessing(false);
      }
    };
    
    executeGuardianAction();
    
  }, [gameState, players, winnerTeam, isProcessing, setGameState, addLog, aiConfig, messages, gameHistory]);

  useEffect(() => {
    setLogCallback(addLog);
    setAborted(false);
    setThinkingCallback(setThinkingPlayer);
    setRemoveThinkingCallback(removeThinkingPlayer);
    return () => {
      setLogCallback(null);
      setAborted(false);
      setThinkingCallback(null);
      setRemoveThinkingCallback(null);
    };
  }, [addLog, setThinkingPlayer, removeThinkingPlayer]);

  useEffect(() => {
    if (!gameState || !players.length || winnerTeam || nightProcessed || isProcessing || gameState.phase !== 'night') return;
    
    // 检查是否已经在处理夜晚结束逻辑，防止重复触发
    if (isProcessing || nightProcessed) return;

    // 检查各个角色的行动状态
    const aliveGuardians = players.filter(p => p.role === 'guardian' && p.isAlive);
    const hasGuardian = aliveGuardians.length > 0;
    const guardianPlayer = aliveGuardians[0];
    const guardianDone = !hasGuardian || guardianActionCompleteState || aliveGuardians.some(g => gameState.actionDone[g.id]);
    
    const hasSeer = players.some(p => p.role === 'seer' && p.isAlive);
    const seerPlayer = players.find(p => p.role === 'seer' && p.isAlive);
    const seerDone = !hasSeer || (seerPlayer && gameState.actionDone[seerPlayer.id]);
    
    addLog({
      type: 'info',
      title: '预言家状态检查',
      message: `hasSeer: ${hasSeer}, seerPlayer: ${seerPlayer?.name}, seerDone: ${seerDone}`,
      details: `seerPlayer?.id: ${seerPlayer?.id}, actionDone[seerId]: ${gameState.actionDone[seerPlayer?.id || '']}`,
    });
    
    const aliveWitches = players.filter(p => p.role === 'witch' && p.isAlive);
    const hasWitch = aliveWitches.length > 0;
    const witchDone = !hasWitch || aliveWitches.some(w => gameState.actionDone[w.id]);
    
    const wolfPlayers = players.filter(p => p.role === 'wolf' && p.isAlive);
    const wolfActionDone = wolfPlayers.every(p => gameState.actionDone[p.id]) || wolfKillComplete;
    
    // 计算进度：狼人+1, 守卫+1, 预言家+1, 女巫+1，满4格进入白天
    let progress = 0;
    let maxProgress = 0;
    
    // 狼人投票完成 +1
    maxProgress++;
    if (wolfActionDone) progress++;
    
    // 守卫行动完成 +1
    if (hasGuardian) {
      maxProgress++;
      if (guardianDone) progress++;
    }
    
    // 预言家行动完成 +1
    if (hasSeer) {
      maxProgress++;
      if (seerDone) progress++;
    }
    
    // 女巫行动完成 +1
    if (hasWitch) {
      maxProgress++;
      if (witchDone) progress++;
    }
    
    // 调试：打印每个需要行动的玩家及其actionDone状态
    const playerStatus = [
      hasGuardian && `${aliveGuardians.map(g => g.name).join(', ')}(guardian): ${guardianDone ? '已完成' : '未完成'}`,
      hasSeer && `${seerPlayer?.name}(seer): ${seerDone ? '已完成' : '未完成'}`,
      hasWitch && `${aliveWitches.map(w => w.name).join(', ')}(witch): ${witchDone ? '已完成' : '未完成'}`,
    ].filter(Boolean).join(', ');
    
    addLog({
      type: 'info',
      title: '玩家状态检查',
      message: `需要行动的玩家: ${playerStatus}`,
      details: `actionDone完整状态: ${JSON.stringify(gameState.actionDone)}`,
    });
    
    // 所有行动都完成
    const allDone = wolfActionDone && guardianDone && seerDone && witchDone;
    
    // 详细调试日志
    const wolfUnfinished = wolfPlayers.filter(p => !gameState.actionDone[p.id]).map(p => p.name).join(', ');
    
    addLog({
      type: 'info',
      title: '夜晚进度检查',
      message: `进度: ${progress}/${maxProgress} (狼人:${wolfActionDone ? '完成+1' : '未完成'}, 守卫:${guardianDone ? '完成+1' : '未完成'}, 预言家:${seerDone ? '完成+1' : '未完成'}, 女巫:${witchDone ? '完成+1' : '未完成'})`,
      details: `未完成的狼人: ${wolfUnfinished || '无'}, guardianActionCompleteState: ${guardianActionCompleteState}`,
    });

    if (allDone) {
      addLog({
        type: 'info',
        title: '夜晚结束',
        message: '所有夜晚行动已完成，准备进入白天',
      });
      setNightProcessed(true);
      setIsProcessing(true);
      
      setTimeout(async () => {
        const latestGameState = useGameStore.getState().gameState;
        const latestPlayers = useGameStore.getState().players;
        const result = processNightActions(latestPlayers, latestGameState.nightActions);
        const updatedPlayers = result.players;
        setPlayers(updatedPlayers);

        if (result.healed.length > 0) {
          const healedPlayer = latestPlayers.find((p) => p.id === result.healed[0]);
          addLog({
            type: 'success',
            title: '女巫救人',
            message: `女巫使用解药救了 ${healedPlayer?.name}`,
          });
        }
        
        // v2.4.4 任务 C：每晚死讯完整公告（狼刀/女巫毒分开标注，不泄露身份）+ 写入 gameHistory.deadPlayers
        if (result.killed.length > 0 || result.poisoned.length > 0) {
          result.killed.forEach((id) => {
            const killedPlayer = latestPlayers.find((p) => p.id === id);
            if (!killedPlayer) return;
            addLog({
              type: 'error',
              title: '狼人杀人',
              message: `狼人杀死了 ${killedPlayer.name}`,
            });
            addSystemMessage(`【公告】第${latestGameState?.day ?? 1}晚 死亡：${killedPlayer.name}（狼刀）`);
            setGameHistory(prev => ({
              ...prev,
              deadPlayers: [
                ...(prev.deadPlayers || []),
                { name: killedPlayer.name, role: killedPlayer.role, day: latestGameState?.day ?? 1, reason: '狼刀' },
              ],
            }));
          });
          result.poisoned.forEach((id) => {
            const poisonedPlayer = latestPlayers.find((p) => p.id === id);
            if (!poisonedPlayer) return;
            addLog({
              type: 'error',
              title: '女巫毒人',
              message: `女巫使用毒药毒死了 ${poisonedPlayer.name}`,
            });
            addSystemMessage(`【公告】第${latestGameState?.day ?? 1}晚 死亡：${poisonedPlayer.name}（女巫毒）`);
            setGameHistory(prev => ({
              ...prev,
              deadPlayers: [
                ...(prev.deadPlayers || []),
                { name: poisonedPlayer.name, role: poisonedPlayer.role, day: latestGameState?.day ?? 1, reason: '女巫毒' },
              ],
            }));
          });
        } else {
          addSystemMessage('🌙 平安夜，无人死亡');
        }

        // S1：猎人夜里被狼刀死 → 进入猎人开枪阶段（被毒不触发，被救/被守存活则不进入）
        const killedHunter = result.killed
          .map((id) => updatedPlayers.find((p) => p.id === id))
          .find((p) => p && p.role === 'hunter');
        if (killedHunter) {
          // 修复1：同守同救（被刀+被守+被救）致死，且房间设置禁止开枪 → 猎人不能开枪
          const isGuardHealDeath = result.guarded.includes(killedHunter.id) && result.healed.includes(killedHunter.id);
          const allowShoot = currentRoom?.settings?.hunterShootOnGuardHealDeath ?? true;
          if (isGuardHealDeath && !allowShoot) {
            addSystemMessage(`🌑 ${killedHunter.name}（猎人）被神秘力量击杀，无法开枪！`);
          } else {
            nightHunterShoot.current = true;
            setGameState({ ...latestGameState, phase: 'hunterShoot', lastWordsPlayer: killedHunter.id, hunterShootTarget: null });
            addSystemMessage(`🔫 ${killedHunter.name}（猎人）被狼人杀害，可以开枪带走一人！`);
            setIsProcessing(false);
            return;
          }
        }

        const winner = checkWinCondition(updatedPlayers);
        if (winner) {
          setWinnerTeam(winner);
          if (latestGameState) {
            setGameState({ ...latestGameState, phase: 'ended', winner });
          }
          addSystemMessage(winner === 'wolf' ? '🐺 狼人获胜！' : '✨ 好人阵营获胜！');
          setIsProcessing(false);
          return;
        }

        transitionToDay(updatedPlayers, latestGameState);
        setIsProcessing(false);
      }, 2000);
    }
  }, [gameState, gameState?.actionDone, players, winnerTeam, nightProcessed, isProcessing, setPlayers, addSystemMessage, checkWinCondition, setGameState, myRole, addLog, setWolfVotes, setWolfVoteComplete, setWolfKillComplete, setWolfSpeakerOrder, setWolfCurrentSpeaker, setWolfDiscussionRound, guardianActionCompleteState, transitionToDay, currentRoom]);

  useEffect(() => {
    console.log('=== 白天发言 useEffect 触发 ===');
    console.log('gameState:', gameState);
    console.log('gameState?.phase:', gameState?.phase);
    console.log('currentRoom:', currentRoom);
    console.log('winnerTeam:', winnerTeam);
    
    if (!gameState || !currentRoom || winnerTeam) return;
    
    // 如果已经进入投票阶段，不处理白天发言
    if (gameState.phase !== 'day') {
      if (gameState.phase === 'vote') {
        addLog({
          type: 'info',
          title: '跳过AI发言',
          message: '已进入投票阶段，跳过AI发言',
        });
      }
      return;
    }

    const currentSpeakerPlayer = players.find((p) => p.id === gameState.currentSpeaker);
    console.log('currentSpeakerPlayer:', currentSpeakerPlayer);
    
    // 如果当前发言者是真实玩家，不需要处理，玩家可以直接发言
    if (currentSpeakerPlayer && !currentSpeakerPlayer.isAI) {
      // 确保isProcessing是false，让玩家可以发言
      if (isProcessing) {
        setIsProcessing(false);
      }
      return;
    }
    
    // 只有在处理AI发言时才需要检查isProcessing
    if (isProcessing) {
      console.log('正在处理中，跳过');
      return;
    }
    
    if (currentSpeakerPlayer?.isAI && currentSpeakerPlayer.role && !getAborted()) {
      console.log('开始处理AI发言');
      setIsProcessing(true);
      
      setTimeout(async () => {
        // 检查是否已进入投票阶段或被中止
        if (getAborted() || !currentSpeakerPlayer.isAI) {
          setIsProcessing(false);
          return;
        }
        
        // 再次检查游戏阶段，防止在等待期间进入投票阶段
        if (gameState && gameState.phase !== 'day') {
          addLog({
            type: 'info',
            title: 'AI发言取消',
            message: `游戏阶段已变为${gameState.phase}，取消AI发言`,
          });
          setIsProcessing(false);
          return;
        }

        const playerConfig = currentSpeakerPlayer.aiConfig || {
          model: aiConfig.apiType === 'siliconflow' ? aiConfig.siliconflow.model : aiConfig.local.model,
          temperature: aiConfig.apiType === 'siliconflow' ? aiConfig.siliconflow.temperature : aiConfig.local.temperature,
          maxTokens: aiConfig.apiType === 'siliconflow' ? aiConfig.siliconflow.maxTokens : aiConfig.local.maxTokens,
          behavior: aiConfig.defaultBehavior,
        };

        // v2.4.4 任务 A：按阶段区分限长（round1=轮次发言≤100 / free_discussion=自由讨论≤150）
        const speechPhase = gameState.dayPhase?.phase === 'free_discussion' ? '自由讨论' : '白天发言';

        const response = await callAIApi(
          aiConfig,
          currentSpeakerPlayer.role,
          currentSpeakerPlayer.name,
          players,
          messages,
          speechPhase,
          gameState.day,
          gameState.nightActions,
          gameHistory,
          gameState.currentSpeaker || undefined,
          gameState.speakerOrder
        );

        if (!getAborted()) {
          // v2.4.3 任务C：AI 发言生成支持"过/跳过"→ 不发布消息，直接按跳过推进（防卡死兜底）
          if (isSkipResponse(response)) {
            addLog({
              type: 'info',
              title: `${currentSpeakerPlayer.name} 跳过`,
              message: 'AI 选择跳过发言',
              playerName: currentSpeakerPlayer.name,
            });
            advanceDayTurnRef.current({ skipped: true, fromSpeakerId: currentSpeakerPlayer.id });
            setIsProcessing(false);
            return;
          }

          const message: Message = {
            id: generateRoomId(),
            roomId: currentRoom.id,
            playerId: currentSpeakerPlayer.id,
            playerName: currentSpeakerPlayer.name,
            content: response,
            timestamp: new Date(),
            type: 'public',
          };
          addMessage(message);
          
          // 实时更新玩家信息库 - 记录AI的发言
          const now = new Date();
          const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          setGameHistory(prev => ({
            ...prev,
            playerKnowledge: {
              ...prev.playerKnowledge,
              [currentSpeakerPlayer.name]: {
                ...prev.playerKnowledge?.[currentSpeakerPlayer.name],
                name: currentSpeakerPlayer.name,
                suspiciousLevel: prev.playerKnowledge?.[currentSpeakerPlayer.name]?.suspiciousLevel || 50,
                notes: [
                  ...(prev.playerKnowledge?.[currentSpeakerPlayer.name]?.notes ? [prev.playerKnowledge[currentSpeakerPlayer.name].notes] : []),
                  `第${gameState.day}天发言: ${response}`
                ].slice(-5).join(' | ')
              }
            },
            timeline: [
              ...prev.timeline,
              {
                time: timeStr,
                day: gameState.day,
                phase: '白天发言',
                event: `${currentSpeakerPlayer.name}发言: ${response.substring(0, 30)}${response.length > 30 ? '...' : ''}`,
                actor: currentSpeakerPlayer.name
              }
            ].slice(-20)
          }));
          
          // 记录AI的完整回复到日志
          addLog({
            type: 'info',
            title: `${currentSpeakerPlayer.name} 白天发言`,
            message: response.substring(0, 100) + (response.length > 100 ? '...' : ''),
            details: `完整发言内容：\n${response}`,
          });

          // v2.4.3 任务E：自由讨论/白天发言后，压缩与自己相关的对话进记忆库
          updateMemoryForSpeech(currentSpeakerPlayer.name, response);

          // v2.4.3 任务B：AI 插话判断（被点名/质疑 → 加入插话队列，优先插队；不打断当前发言）
          maybeTriggerInterjections(response, currentSpeakerPlayer.id);

          // v2.4.3：按状态机推进（round1 按序 / free_discussion 轮流+插话+配额；全员跳过/轮数满 → 自动投票）
          advanceDayTurnRef.current({ skipped: false, fromSpeakerId: currentSpeakerPlayer.id });
        }

        setIsProcessing(false);
      }, 2000);
    }
  }, [gameState?.currentSpeaker, gameState?.phase, gameState?.day, players, aiConfig, messages, winnerTeam, isProcessing, addMessage, currentRoom, setGameState, addSystemMessage, gameHistory, updateMemoryForSpeech, maybeTriggerInterjections]);

  // v2.4.3 任务D：真人挂机保护 —— 轮到真人且 3 分钟无输入 → 自动跳过（标记"挂机跳过"）；输入框活跃时绝不切
  useEffect(() => {
    if (!gameState || gameState.phase !== 'day' || winnerTeam) return;
    const speakerId = gameState.currentSpeaker;
    const speaker = players.find(p => p.id === speakerId);
    if (!speaker || speaker.isAI) return;
    if (gameState.dayPhase.phase !== 'round1' && gameState.dayPhase.phase !== 'free_discussion') return;

    const timer = setTimeout(() => {
      const latest = useGameStore.getState();
      const st = latest.gameState;
      if (!st || st.phase !== 'day' || st.currentSpeaker !== speakerId) return;
      if (latest.dayInputFocused) return; // 输入框活跃，绝不动（focus/blur 变化会重新计时）
      advanceDayTurnRef.current({ skipped: true, afk: true, fromSpeakerId: speakerId });
    }, AFK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [gameState?.currentSpeaker, gameState?.phase, gameState?.day, gameState?.dayPhase?.phase, players, winnerTeam, dayInputFocused]);



  useEffect(() => {
    // 如果 wolfCurrentSpeaker 为 null，不处理
    if (!wolfCurrentSpeaker) {
      return;
    }
    
    console.log('=== 狼队发言 useEffect 触发 ===');
    console.log('gameState:', gameState ? '存在' : '不存在');
    console.log('gameState?.phase:', gameState?.phase);
    console.log('winnerTeam:', winnerTeam);
    console.log('getAborted():', getAborted());
    console.log('wolfCurrentSpeaker:', wolfCurrentSpeaker);
    console.log('wolfVoteComplete:', wolfVoteComplete);
    
    // 详细检查每个条件
    if (!gameState) {
      console.log('条件不满足：gameState 不存在');
      return;
    }
    if (gameState.phase !== 'night') {
      console.log('条件不满足：不是夜晚阶段，当前阶段:', gameState.phase);
      return;
    }
    if (winnerTeam) {
      console.log('条件不满足：游戏已结束，获胜方:', winnerTeam);
      return;
    }
    if (getAborted()) {
      console.log('条件不满足：游戏已中止');
      return;
    }
    
    // 如果投票已完成，检查是否需要处理狼人击杀
        if (wolfVoteComplete) {
          console.log('狼人投票已完成，检查是否需要处理击杀');
          // 检查是否所有夜晚行动都已完成，如果完成则进入白天
          const wolfTeam = players.filter(p => p.role === 'wolf' && p.isAlive);
          const wolfDone = wolfTeam.every(p => gameState.actionDone[p.id]) || wolfKillComplete;
          const guardianDone = !players.some(p => p.role === 'guardian' && p.isAlive) || gameState.guardianActionComplete;
          const hasSeer = players.some(p => p.role === 'seer' && p.isAlive);
          const seerPlayer = hasSeer ? players.find(p => p.role === 'seer' && p.isAlive) : null;
          const seerDone = !hasSeer || (seerPlayer && gameState.actionDone[seerPlayer.id]) || false;
          const hasWitch = players.some(p => p.role === 'witch' && p.isAlive);
          const witchDone = !hasWitch || players.filter(p => p.role === 'witch' && p.isAlive).some(w => gameState.actionDone[w.id]);
          
          console.log('夜晚行动完成状态 - 狼人:', wolfDone, '守卫:', guardianDone, '预言家:', seerDone, '女巫:', witchDone);
          
          if (wolfDone && guardianDone && seerDone && witchDone) {
            console.log('所有夜晚行动已完成，但需要等待 nightProcessed 逻辑处理');
          }
          return;
        }

    const wolfPlayer = players.find(p => p.id === wolfCurrentSpeaker);
    console.log('wolfPlayer:', wolfPlayer?.name, wolfPlayer?.isAI);
    
    // 只有当当前发言者是 AI 时才自动发言，真实玩家需要手动发言
    if (wolfPlayer?.isAI && wolfPlayer.role === 'wolf' && !getAborted()) {
      // 防止同一个狼人重复发言
      console.log('wolfSpeakerProcessing.current:', wolfSpeakerProcessing.current);
      console.log('lastWolfSpeakerId.current:', lastWolfSpeakerId.current);
      console.log('wolfPlayer.id:', wolfPlayer.id);
      
      if (wolfSpeakerProcessing.current || lastWolfSpeakerId.current === wolfPlayer.id) {
        console.log('阻止重复发言，返回');
        return;
      }
      
      wolfSpeakerProcessing.current = true;
      lastWolfSpeakerId.current = wolfPlayer.id;
      setIsProcessing(true);
      
      setTimeout(async () => {
        // 注意：在这里不重置发言状态，等API调用完成后再重置
        
        if (getAborted() || !wolfPlayer.isAI) {
          wolfSpeakerProcessing.current = false;
          lastWolfSpeakerId.current = null;
          setIsProcessing(false);
          return;
        }

        const playerConfig = wolfPlayer.aiConfig || {
          model: aiConfig.apiType === 'siliconflow' ? aiConfig.siliconflow.model : aiConfig.local.model,
          temperature: aiConfig.apiType === 'siliconflow' ? aiConfig.siliconflow.temperature : aiConfig.local.temperature,
          maxTokens: aiConfig.apiType === 'siliconflow' ? aiConfig.siliconflow.maxTokens : aiConfig.local.maxTokens,
          behavior: aiConfig.defaultBehavior,
        };

        const response = await callAIApi(
          aiConfig,
          wolfPlayer.role,
          wolfPlayer.name,
          players,
          wolfChatMessages,
          '狼人讨论',
          gameState.day,
          gameState.nightActions,
          undefined,
          wolfCurrentSpeaker,
          wolfSpeakerOrder,
          wolfDiscussionRound,
          wolfPlayer.id  // 添加 playerId 参数
        );

        // 在添加消息之前先重置发言状态，防止重复触发
        wolfSpeakerProcessing.current = false;
        lastWolfSpeakerId.current = null;
        setIsProcessing(false);
        
        if (!getAborted()) {
          const message: Message = {
            id: generateRoomId(),
            roomId: currentRoom?.id || '',
            playerId: wolfPlayer.id,
            playerName: wolfPlayer.name,
            content: response,
            timestamp: new Date(),
            type: 'wolf_chat',
          };
          addWolfChatMessage(message);
          
          // 记录AI狼人的完整回复到日志
          addLog({
            type: 'info',
            title: `${wolfPlayer.name} 狼人讨论`,
            message: response.substring(0, 100) + (response.length > 100 ? '...' : ''),
            details: `完整讨论内容：\n${response}`,
          });
        }

        // AI发言后自动投票，但至少要等讨论2轮后才投票
        if (!wolfVotes[wolfPlayer.id] && wolfDiscussionRound >= 2) {
          await handleAIWolfVote(wolfPlayer);
        }

        // 检查是否所有狼人都投票了
        const wolfTeam = players.filter(p => p.role === 'wolf' && p.isAlive);
        const allVoted = wolfTeam.every(p => wolfVotes[p.id] !== undefined);
        
        // 检查AI是否提出结束讨论（至少要讨论2轮才能结束）
        // 增加更多结束讨论的关键词
        const wantsToEnd = wolfDiscussionRound >= 2 && (
                          response.includes('我觉得差不多了') || 
                          response.includes('差不多了') || 
                          response.includes('结束讨论') ||
                          response.includes('可以投票了') ||
                          response.includes('就这样吧') ||
                          response.includes('就这么定了') ||
                          response.includes('同意') ||
                          response.includes('赞成') ||
                          response.includes('没问题') ||
                          response.includes('好的') ||
                          response.includes('OK') ||
                          response.includes('确定') ||
                          response.includes('一致通过') ||
                          response.includes('达成一致'));
        
        if (wantsToEnd) {
          // AI提出结束讨论，让其他狼人表态
          addLog({
            type: 'info',
            title: '狼人讨论',
            message: `${wolfPlayer.name} 提议结束讨论`,
          });
          
          // 统计其他狼人是否同意
          const otherWolves = wolfTeam.filter(p => p.id !== wolfPlayer.id);
          let agreeCount = 0;
          let disagreeCount = 0;
          
          for (const wolf of otherWolves) {
            if (Math.random() > 0.3) {
              // 70%概率同意
              agreeCount++;
              const agreeMsg: Message = {
                id: generateRoomId(),
                roomId: currentRoom?.id || '',
                playerId: wolf.id,
                playerName: wolf.name,
                content: '我没意见',
                timestamp: new Date(),
                type: 'wolf_chat',
              };
              addWolfChatMessage(agreeMsg);
            } else {
              disagreeCount++;
              const disagreeMsg: Message = {
                id: generateRoomId(),
                roomId: currentRoom?.id || '',
                playerId: wolf.id,
                playerName: wolf.name,
                content: '我还有异议',
                timestamp: new Date(),
                type: 'wolf_chat',
              };
              addWolfChatMessage(disagreeMsg);
            }
          }
          
          if (disagreeCount === 0 || agreeCount >= otherWolves.length * 0.5) {
            // 大多数同意，结束讨论
            addLog({
              type: 'info',
              title: '狼人讨论结束',
              message: '其他狼人同意结束讨论，进入投票阶段',
            });
            // 给未投票的AI狼人投票
            for (const p of wolfTeam) {
              if (p.isAI && !wolfVotes[p.id]) {
                await handleAIWolfVote(p);
              }
            }
            setTimeout(() => handleAllWolfVotes(), 500);
          } else {
            // 有异议，继续讨论
            addLog({
              type: 'info',
              title: '狼人讨论',
              message: '有狼人提出异议，继续讨论',
            });
            handleNextWolfSpeaker();
          }
        } else if (allVoted && wolfDiscussionRound >= 2) {
          // 所有狼人都投票了，且至少讨论了2轮
          addLog({
            type: 'info',
            title: '狼人讨论结束',
            message: '所有狼人已投票，进入投票阶段',
            details: `投票情况: ${JSON.stringify(wolfVotes)}, 狼人团队: ${wolfTeam.map(p => p.name).join(', ')}`,
          });
          console.log('=== 所有狼人已投票，调用 handleAllWolfVotes ===');
          console.log('wolfVotes:', wolfVotes);
          console.log('wolfTeam:', wolfTeam.map(p => ({ name: p.name, id: p.id, voted: wolfVotes[p.id] !== undefined })));
          handleAllWolfVotes();
        } else {
          const isPureAIWolfTeam = wolfTeam.length > 0 && wolfTeam.every(p => p.isAI);
          
          // 检查是否有狼人卡住（超过5轮没有新发言者变化）
          if (wolfDiscussionRound >= 5 && !allVoted) {
            addLog({
              type: 'warning',
              title: '狼人讨论异常',
              message: `讨论${wolfDiscussionRound}轮后仍未全部投票，强制完成投票`,
              details: `当前投票情况: ${JSON.stringify(wolfVotes)}, 狼人团队: ${wolfTeam.map(p => p.name).join(', ')}`,
            });
            // 强制给未投票的AI狼人投票
            for (const p of wolfTeam) {
              if (p.isAI && !wolfVotes[p.id]) {
                await handleAIWolfVote(p);
              }
            }
            setTimeout(() => handleAllWolfVotes(), 500);
          } else if (isPureAIWolfTeam && wolfDiscussionRound >= 3) {
            addLog({
              type: 'info',
              title: '狼人讨论结束',
              message: `纯AI狼人团队讨论已进行${wolfDiscussionRound}轮，进入投票阶段`,
            });
            for (const p of wolfTeam) {
              if (p.isAI && !wolfVotes[p.id]) {
                await handleAIWolfVote(p);
              }
            }
            setTimeout(() => handleAllWolfVotes(), 500);
          } else if (wolfDiscussionRound >= 6) {
            // 安全措施：防止无限循环，最多讨论6轮
            addLog({
              type: 'warning',
              title: '狼人讨论强制结束',
              message: `讨论已进行${wolfDiscussionRound}轮，强制进入投票阶段`,
            });
            for (const p of wolfTeam) {
              if (p.isAI && !wolfVotes[p.id]) {
                await handleAIWolfVote(p);
              }
            }
            setTimeout(() => handleAllWolfVotes(), 500);
          } else {
            handleNextWolfSpeaker();
          }
        }
        // 注意：发言状态已在API调用完成后重置
      }, 2000);
    }
  }, [wolfCurrentSpeaker, gameState?.phase, gameState?.day, players, aiConfig, wolfChatMessages, winnerTeam, addWolfChatMessage, handleNextWolfSpeaker, currentRoom, wolfDiscussionRound, setWolfVoteComplete, addLog, wolfVotes, handleAIWolfVote, handleAllWolfVotes]);

  useEffect(() => {
    if (!gameState || gameState.phase !== 'night' || winnerTeam || getAborted() || isProcessing) return;

    const aliveAIPlayers = getAlivePlayers(players).filter((p) => p.isAI && p.role && p.role !== 'wolf');
    const seerPlayers = aliveAIPlayers.filter(p => p.role === 'seer');
    const witchPlayers = aliveAIPlayers.filter(p => p.role === 'witch');

    // 检查预言家是否已经全部行动完成
    const allSeersActed = seerPlayers.every(p => gameState.actionDone[p.id]);
    
    // 如果预言家都已经行动了，直接处理女巫
    if (allSeersActed) {
      seerActionProcessed.current = true;
    }
    
    // 首先处理预言家行动（可以和狼人同时行动）
    const processSeerActions = async () => {
      // 防止重复执行
      if (seerActionProcessed.current) return;
      seerActionProcessed.current = true;
      
      try {
        for (const seerPlayer of seerPlayers) {
        // 检查预言家是否已经行动过
        if (gameState.actionDone[seerPlayer.id]) {
          addLog({
            type: 'info',
            title: '预言家查验',
            message: `${seerPlayer.name} 已经行动过，跳过`,
          });
          continue;
        }
        
        if (getAborted() || winnerTeam) break;
        
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));

        if (getAborted() || winnerTeam) break;

        // 再次检查是否已经行动过（防止重复）
        if (gameState.actionDone[seerPlayer.id]) {
          addLog({
            type: 'info',
            title: '预言家查验',
            message: `${seerPlayer.name} 在等待期间已经行动过，跳过`,
          });
          continue;
        }

        const targetId = await generateAIThought(
          aiConfig,
          seerPlayer.role!,
          seerPlayer.name,
          players,
          messages,
          'night',
          gameState.day,
          gameState.nightActions,
          gameHistory,
          seerPlayer.id
        );

        if (targetId && !getAborted() && !winnerTeam) {
          const newActions = [...gameState.nightActions, { playerId: seerPlayer.id, action: 'check' as const, targetId }];
          const newActionDone = { ...gameState.actionDone, [seerPlayer.id]: true };
          
          // 记录预言家的行动到gameHistory
          const targetPlayer = players.find(p => p.id === targetId);
          const targetRole = targetPlayer?.role;
          const isWolf = targetRole === 'wolf';
          
          setGameHistory(prev => ({
            ...prev,
            skillUsage: {
              ...prev.skillUsage,
              [seerPlayer.name]: {
                ...prev.skillUsage?.[seerPlayer.name],
                [`第${gameState.day}晚查验`]: { result: `查验了${targetPlayer?.name}，结果：${isWolf ? '狼人' : '好人'}` }
              }
            }
          }));
          
          setGameState({ ...gameState, nightActions: newActions, actionDone: newActionDone });
          
          // 记录查验结果到日志
          addLog({
            type: 'info',
            title: '预言家查验',
            message: `${seerPlayer.name} 查验了 ${targetPlayer?.name}，结果：${isWolf ? '狼人 🐺' : '好人 ✨'}`,
            details: `查验目标：${targetPlayer?.name}，身份：${targetRole}`,
          });
        } else if (!getAborted() && !winnerTeam) {
          const newActionDone = { ...gameState.actionDone, [seerPlayer.id]: true };
          setGameState({ ...gameState, actionDone: newActionDone });
        }
        }
      } finally {
        // 重置标志，允许下一晚继续执行
        seerActionProcessed.current = false;
      }
    };

    // 处理预言家行动（可以和狼人同时进行）
    processSeerActions();
  }, [gameState?.phase, gameState?.day, gameHistory]);

  useEffect(() => {
    if (!gameState || gameState.phase !== 'night') return;
    if (!wolfVoteComplete) return;
    
    // 使用一个单独的标志来确保女巫在当前狼人投票完成后只行动一次
    if (wolfVoteCompleteRef.current === wolfVoteComplete) return;
    wolfVoteCompleteRef.current = wolfVoteComplete;
    
    // 狼人投票完成后，触发女巫行动
    const processWitchActions = async () => {
      if (witchActionProcessed.current) return;
      witchActionProcessed.current = true;
      
      try {
        const witchPlayers = players.filter(p => p.role === 'witch' && p.isAlive);
        
        for (const witchPlayer of witchPlayers) {
          if (getAborted() || winnerTeam) break;
          
          if (!witchPlayer.isAI) {
            // 人类女巫等待玩家操作
            addLog({
              type: 'info',
              title: '女巫行动',
              message: '等待人类女巫行动',
            });
            continue;
          }
          
          const currentNightActions = gameState.nightActions;
          const hasKill = currentNightActions.some((a) => a.action === 'kill');
          const killTargetId = currentNightActions.find((a) => a.action === 'kill')?.targetId;
          const killTargetName = killTargetId ? players.find(p => p.id === killTargetId)?.name : null;

          // v2.3 任务 C4：女巫不知道守卫是否守护（守护是否成功由白天死讯体现）。
          // 若女巫把解药用在了被守卫的目标上 → 同守同救 → 该目标死亡（由 processNightActions 处理）。
          const canHeal = hasKill && killTargetId && killTargetName && (gameState.witchHasHealPotion ?? true);
          const canPoison = true;

          // 如果有狼人击杀且目标没有被守卫守护，女巫可以救人或毒人或跳过
          if (canHeal) {
            const witchAction = await generateAIThought(
              aiConfig,
              'witch',
              witchPlayer.name,
              players,
              messages,
              'night',
              gameState.day,
              currentNightActions,
              gameHistory,
              witchPlayer.id,
              gameState.witchAntidoteUsed
            );

            if (getAborted() || winnerTeam) break;

            let actionType = '跳过';
            let actionTargetName = '';
            
            // 尝试匹配标准格式：女巫行动: 救人/毒人/跳过 目标
            let actionMatch = witchAction.match(/女巫行动:\s*(\S+)\s*(\S*)/);
            if (actionMatch) {
              actionType = actionMatch[1];
              actionTargetName = actionMatch[2] ? actionMatch[2].trim() : '';
            } else {
              // 尝试匹配救人格式：救人XXX
              const healMatch = witchAction.match(/救人\s*(\S+)/);
              if (healMatch) {
                actionType = '救人';
                actionTargetName = healMatch[1].trim();
              } else {
                // 尝试匹配毒人格式：毒人XXX
                const poisonMatch = witchAction.match(/毒人\s*(\S+)/);
                if (poisonMatch) {
                  actionType = '毒人';
                  actionTargetName = poisonMatch[1].trim();
                } else if (witchAction.includes('跳过') || witchAction.includes('不行动')) {
                  actionType = '跳过';
                }
              }
            }

            if (actionType === '救人') {
              // 女巫只能救被狼人击杀的目标
              
              // 记录女巫的行动到gameHistory
              setGameHistory(prev => ({
                ...prev,
                skillUsage: {
                  ...prev.skillUsage,
                  [witchPlayer.name]: {
                    ...prev.skillUsage?.[witchPlayer.name],
                    [`第${gameState.day}晚解药`]: { result: `使用解药救了${killTargetName}` }
                  }
                }
              }));
              
              const newActions = [...currentNightActions, { playerId: witchPlayer.id, action: 'heal' as const, targetId: killTargetId }];
              addLog({
                type: 'success',
                title: '女巫救人',
                message: `${witchPlayer.name} 使用解药救了 ${killTargetName}`,
                details: `被救目标：${killTargetName}`,
              });
              const newActionDone = { ...gameState.actionDone, [witchPlayer.id]: true };
              setGameState({ ...gameState, nightActions: newActions, actionDone: newActionDone, witchHasHealPotion: false, witchAntidoteUsed: true });
            } else if (actionType === '毒人') {
              const poisonTarget = players.find(p => p.isAlive && p.name === actionTargetName);
              if (poisonTarget && poisonTarget.id !== killTargetId) {
                
                // 记录女巫的行动到gameHistory
                setGameHistory(prev => ({
                  ...prev,
                  skillUsage: {
                    ...prev.skillUsage,
                    [witchPlayer.name]: {
                      ...prev.skillUsage?.[witchPlayer.name],
                      [`第${gameState.day}晚毒药`]: { result: `使用毒药毒死了${poisonTarget.name}` }
                    }
                  }
                }));
                
                const newActions = [...currentNightActions, { playerId: witchPlayer.id, action: 'poison' as const, targetId: poisonTarget.id }];
                addLog({
                  type: 'error',
                  title: '女巫毒人',
                  message: `${witchPlayer.name} 使用毒药毒死了 ${poisonTarget.name}`,
                  details: `毒杀目标：${poisonTarget.name}`,
                });
                const newActionDone = { ...gameState.actionDone, [witchPlayer.id]: true };
                setGameState({ ...gameState, nightActions: newActions, actionDone: newActionDone, witchHasPoisonPotion: false });
              } else {
                const newActionDone = { ...gameState.actionDone, [witchPlayer.id]: true };
                setGameState({ ...gameState, actionDone: newActionDone });
                addLog({
                  type: 'info',
                  title: '女巫行动',
                  message: `${witchPlayer.name} 选择跳过`,
                });
              }
            } else {
              const newActionDone = { ...gameState.actionDone, [witchPlayer.id]: true };
              setGameState({ ...gameState, actionDone: newActionDone });
              addLog({
                type: 'info',
                title: '女巫行动',
                message: `${witchPlayer.name} 选择跳过`,
              });
            }
          } else {
            // 狼人没有杀人 或者 女巫没有解药，女巫只能选择毒人或跳过（v2.3 C4：不提示守卫信息）
            addLog({
              type: 'info',
              title: '女巫行动',
              message: `${witchPlayer.name} 观察到${hasKill ? '有人被袭击但没有解药可救' : '狼人没有行动'}，准备选择是否使用毒药`,
            });
            
            const witchAction = await generateAIThought(
              aiConfig,
              'witch',
              witchPlayer.name,
              players,
              messages,
              'night',
              gameState.day,
              currentNightActions,
              gameHistory,
              witchPlayer.id,
              gameState.witchAntidoteUsed
            );

            if (getAborted() || winnerTeam) break;

            const actionMatch = witchAction.match(/女巫行动:\s*(毒人|跳过)\s*(\S*)/);
            const actionType = actionMatch ? actionMatch[1] : '跳过';
            const actionTargetName = actionMatch && actionMatch[2] ? actionMatch[2].trim() : '';

            if (actionType === '毒人' && actionTargetName) {
              // 毒人
              const poisonTarget = players.find(p => p.name === actionTargetName && p.isAlive);
              if (poisonTarget) {
                
                // 记录女巫的行动到gameHistory
                setGameHistory(prev => ({
                  ...prev,
                  skillUsage: {
                    ...prev.skillUsage,
                    [witchPlayer.name]: {
                      ...prev.skillUsage?.[witchPlayer.name],
                      [`第${gameState.day}晚毒药`]: { result: `使用毒药毒死了${poisonTarget.name}` }
                    }
                  }
                }));
                
                const newActions = [...currentNightActions, { playerId: witchPlayer.id, action: 'poison' as const, targetId: poisonTarget.id }];
                const newActionDone = { ...gameState.actionDone, [witchPlayer.id]: true };
                setGameState({ ...gameState, nightActions: newActions, actionDone: newActionDone, witchHasPoisonPotion: false });
                
                addLog({
                  type: 'error',
                  title: '女巫毒人',
                  message: `${witchPlayer.name} 使用毒药毒死了 ${poisonTarget.name}`,
                  details: `毒杀目标：${poisonTarget.name}`,
                });
              } else {
                const newActionDone = { ...gameState.actionDone, [witchPlayer.id]: true };
                setGameState({ ...gameState, actionDone: newActionDone });
                addLog({
                  type: 'info',
                  title: '女巫行动',
                  message: `${witchPlayer.name} 选择跳过`,
                });
              }
            } else {
              // 跳过
              const newActionDone = { ...gameState.actionDone, [witchPlayer.id]: true };
              setGameState({ ...gameState, actionDone: newActionDone });
              addLog({
                type: 'info',
                title: '女巫行动',
                message: `${witchPlayer.name} 选择跳过`,
              });
            }
          }
        }
      } finally {
        witchActionProcessed.current = false;
      }
    };
    
    processWitchActions();
  }, [wolfVoteComplete, gameState, players, aiConfig, messages, addLog, setGameState, winnerTeam]);

  const alivePlayers = getAlivePlayers(players);
  const deadPlayers = getDeadPlayers(players);
  const isWolf = myRole === 'wolf';
  const wolfPlayers = players.filter(p => p.role === 'wolf' && p.isAlive);
  const wolfTargetPlayers = alivePlayers;
  const currentSpeakerPlayer = players.find((p) => p.id === gameState?.currentSpeaker);
  const isMyTurn = currentUser?.id === gameState?.currentSpeaker;

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-4">
              <h2 className="text-xl font-bold text-wolf-text">{currentRoom?.name}</h2>
              {currentRoom && (
                <span className="text-sm text-wolf-text/40 font-mono bg-wolf-purple/10 px-2 py-0.5 rounded">
                  {currentRoom.id.slice(-4)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 mt-1">
              <span className="text-sm text-wolf-text/60">
                阶段: 
                <span className={`font-bold ml-1 ${
                  gameState?.phase === 'night' ? 'text-blue-400' : 
                  gameState?.phase === 'day' ? 'text-yellow-400' : 
                  gameState?.phase === 'vote' ? 'text-orange-400' : 
                  'text-wolf-purple'
                }`}>
                  {gameState ? getPhaseText(gameState.phase) : '等待中'}
                </span>
              </span>
              {gameState && (
                <span className="text-sm text-wolf-text/60">
                  第 {gameState.day} 天
                </span>
              )}
              {players.length > 0 && (
                <span className="text-sm text-wolf-text/60">
                  人数: {players.length}人
                </span>
              )}
              {gameState?.phase === 'day' && currentSpeakerPlayer && (
                <span className="text-sm text-yellow-400 font-medium animate-pulse">
                  🗣️ 当前发言: {currentSpeakerPlayer.name}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {isHost && players.length >= 4 && !gameStarted && (
              <button onClick={startGame} className="btn-primary flex items-center gap-2">
                <Play className="w-4 h-4" />
                开始游戏
              </button>
            )}
            {isHost && players.length < 4 && !gameStarted && (
              <span className="text-sm text-yellow-400/70 px-3 py-1.5 rounded-lg bg-yellow-500/10">
                需要至少4名玩家
              </span>
            )}

            <button onClick={() => setShowRoles(!showRoles)} className="p-2 rounded-lg hover:bg-wolf-purple/20 transition-colors">
              {showRoles ? <EyeOff className="w-5 h-5 text-wolf-text" /> : <Eye className="w-5 h-5 text-wolf-text" />}
            </button>
            <button onClick={() => setShowRules(!showRules)} className="p-2 rounded-lg hover:bg-wolf-purple/20 transition-colors" title="查看规则">
              <BookOpen className="w-5 h-5 text-wolf-text" />
            </button>
            {gameStarted && !winnerTeam && (
              <button
                onClick={() => setShowAbortConfirm(true)}
                className="p-2 rounded-lg hover:bg-orange-500/20 transition-colors"
                title="中止游戏（停止所有AI调用）"
              >
                <AlertTriangle className="w-5 h-5 text-orange-400" />
              </button>
            )}
            <button onClick={leaveRoom} className="p-2 rounded-lg hover:bg-red-500/20 transition-colors">
              <LogOut className="w-5 h-5 text-red-400" />
            </button>
          </div>
        </div>

        {winnerTeam && (
          <div className="card p-6 mb-6 text-center">
            <Trophy className={`w-16 h-16 mx-auto mb-4 ${winnerTeam === 'wolf' ? 'text-red-500' : 'text-blue-500'}`} />
            <h3 className="text-2xl font-bold text-wolf-text mb-2">
              {winnerTeam === 'wolf' ? '🐺 狼人阵营获胜！' : '✨ 好人阵营获胜！'}
            </h3>
            <button onClick={restartGame} className="mt-4 btn-primary flex items-center gap-2 mx-auto">
              <RotateCcw className="w-4 h-4" />
              重新开始
            </button>
          </div>
        )}

        {isSpectator && !winnerTeam && (
          <div className="card p-4 mb-6 border-l-4 border-l-wolf-purple bg-wolf-purple/5">
            <div className="flex items-center gap-3">
              <Eye className="w-5 h-5 text-wolf-purple" />
              <div>
                <p className="text-sm font-medium text-wolf-text">👁 观战模式</p>
                <p className="text-xs text-wolf-text/60">
                  你已死亡或以旁观者身份加入，可查看全场完整身份与对局走向。
                </p>
              </div>
            </div>
          </div>
        )}

        <div className={`grid grid-cols-1 lg:grid-cols-12 gap-6 bg-gradient-to-b from-blue-900/10 to-indigo-900/5 p-6 rounded-2xl`}>
          <div className="lg:col-span-3 xl:col-span-3 space-y-4">
            {myRole && gameStarted && gameState?.phase !== 'roleSelect' && (
              <MyRolePanel role={myRole} />
            )}

            <div className="card-glass p-4">
              <h3 className="font-semibold text-wolf-text mb-3">存活玩家 ({alivePlayers.length})</h3>
              <div className="space-y-2">
                {alivePlayers.map((player) => (
                  <PlayerCard
                    key={player.id}
                    player={player}
                    showRole={showRoles || (myRole === 'wolf' && player.role === 'wolf')}
                    isCurrentTurn={gameState?.currentSpeaker === player.id}
                    small
                  />
                ))}
              </div>
            </div>

            {deadPlayers.length > 0 && (
              <div className="card-glass p-4">
                <h3 className="font-semibold text-wolf-text mb-3">死亡玩家 ({deadPlayers.length})</h3>
                <div className="space-y-2">
                  {deadPlayers.map((player) => (
                    <PlayerCard
                      key={player.id}
                      player={player}
                      showRole={showRoles}
                      small
                    />
                  ))}
                </div>
              </div>
            )}

            {!gameStarted && (
              <div className="card p-4">
                <h3 className="font-semibold text-wolf-text mb-3">准备开始</h3>
                <p className="text-sm text-wolf-text/70 mb-4">玩家列表:</p>
                <div className="space-y-2 mb-4">
                  {players.map((p) => {
                    const isMe = p.id === currentUser?.id;
                    return (
                      <div key={p.id} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          {p.isAI && <span className="text-xs text-blue-400">AI</span>}
                          {p.isHost && !p.isAI && <span className="text-xs text-yellow-400">主持人</span>}
                          <span className={isMe ? 'text-wolf-purple' : p.isAI ? 'text-blue-400' : 'text-wolf-text'}>
                            {p.name}{isMe && ' (你)'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {p.isReady ? (
                            <span className="flex items-center gap-1 text-green-400 text-xs">
                              <span>✓</span> 已准备
                            </span>
                          ) : p.isAI ? (
                            <span className="flex items-center gap-1 text-blue-400 text-xs">
                              <span>🤖</span> AI
                            </span>
                          ) : (
                            <span className="text-wolf-text/40 text-xs">等待中</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  {!isHost && players.find(p => p.id === currentUser?.id)?.isReady === false && (
                    <button
                      onClick={() => {
                        setPlayers(players.map(p =>
                          p.id === currentUser?.id ? { ...p, isReady: true } : p
                        ));
                      }}
                      className="flex-1 btn-primary"
                    >
                      准备
                    </button>
                  )}
                  {isHost && (
                    <button
                      onClick={startGame}
                      disabled={players.filter(p => !p.isAI).some(p => !p.isReady)}
                      className={`flex-1 btn-primary ${
                        players.filter(p => !p.isAI).some(p => !p.isReady)
                          ? 'opacity-50 cursor-not-allowed'
                          : ''
                      }`}
                    >
                      开始游戏 ({players.length}/{currentRoom?.maxPlayers})
                    </button>
                  )}
                </div>
                {isHost && players.filter(p => !p.isAI).some(p => !p.isReady) && (
                  <p className="text-xs text-orange-400 text-center mt-2">
                    等待玩家准备...
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="lg:col-span-6 xl:col-span-6 flex flex-col space-y-4">
            {gameState?.phase === 'roleSelect' && (
              <RoleSelectPanel
                players={players}
                isHost={isHost}
                currentUser={currentUser}
                onRedraw={handleRedrawRole}
                onConfirm={confirmRoles}
                onForceAssign={handleForceAssignRole}
                onReassignAll={handleReassignAllRoles}
                remainingRedraws={MAX_REDRAW - redrawCount}
              />
            )}

            {gameStarted && gameState?.phase !== 'roleSelect' && (
              <SystemMessagesPanel messages={messages} />
            )}

            {gameStarted && gameState?.phase !== 'roleSelect' && !winnerTeam && (
              <div className="flex flex-col gap-4 h-[600px]">
                {['seer', 'witch', 'guardian'].includes(myRole || '') && gameState?.phase === 'night' && (
                  <div className="card-glass p-4">
                    <button
                      onClick={() => setShowNightActionModal(true)}
                      className="w-full flex items-center justify-center gap-3 py-4 px-4 rounded-xl bg-gradient-to-r from-indigo-500/20 to-purple-500/10 hover:from-indigo-500/30 hover:to-purple-500/20 border border-indigo-500/20 text-indigo-300 font-medium transition-all"
                    >
                      <Moon className="w-5 h-5" />
                      <span>夜间行动</span>
                      {!gameState?.actionDone[currentUser?.id || ''] && (
                        <span className="ml-auto px-2 py-0.5 text-xs rounded-full bg-yellow-500/20 text-yellow-400">
                          待行动
                        </span>
                      )}
                    </button>
                  </div>
                )}
                {myRole && !isWolf && !['seer', 'witch', 'guardian'].includes(myRole) && (
                  <div className="card-glass p-6 text-center min-h-[120px] flex flex-col items-center justify-center">
                    <div className="w-14 h-14 bg-gradient-to-br from-indigo-500/20 to-purple-500/10 rounded-full flex items-center justify-center mx-auto mb-3">
                      <span className="text-3xl">🌙</span>
                    </div>
                    <p className="text-wolf-text/70 text-base">特殊角色正在行动中...</p>
                    <p className="text-wolf-text/50 text-sm mt-1">请耐心等待夜晚结束</p>
                  </div>
                )}
                
                <div className="flex-1 min-h-[825px]">
                  <ChatTabs
                    messages={messages}
                    wolfChatMessages={wolfChatMessages}
                    onSendMessage={sendMessage}
                    onWolfSendMessage={sendWolfChatMessage}
                    onWolfVote={handleWolfVote}
                    onWolfExecuteKill={handleExecuteKill}
                    onWolfNextSpeaker={handleNextWolfSpeaker}
                    onWolfOpenVoteModal={() => setShowWolfVoteModal(true)}
                    onStartVote={handleStartVote}
                    onNextSpeaker={handleSkipSpeech}
                    canStartVote={gameState?.dayPhase?.phase === 'free_discussion'}
                    wolfPlayers={wolfPlayers}
                    targetPlayers={wolfTargetPlayers}
                    currentUser={currentUser}
                    isWolf={isWolf}
                    wolfVoteComplete={wolfVoteComplete}
                    wolfDiscussionRound={wolfDiscussionRound}
                    isNight={gameState?.phase === 'night'}
                    isDay={gameState?.phase === 'day'}
                    isSpectator={isSpectator}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="lg:col-span-3 xl:col-span-3 space-y-4">
            {gameStarted && gameState?.phase !== 'roleSelect' && (
              <GameProgressPanel />
            )}
            
            {gameStarted && (gameState?.phase === 'vote' || gameState?.phase === 'voting' || gameState?.phase === 'lastWords' || gameState?.phase === 'hunterShoot') && (
              <VoteResultPanel visible={true} />
            )}
            
            {gameStarted && gameState?.phase === 'hunterShoot' && (
              <HunterShootPanel 
                players={players} 
                onShoot={handleHunterShoot}
                isHunter={myRole === 'hunter'}
              />
            )}

            {showRules ? (
              <RulePanel />
            ) : (
              <div className="card-glass p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-wolf-text">游戏规则</h3>
                  <button 
                    onClick={() => setShowRules(true)}
                    className="text-xs text-wolf-purple-light hover:text-wolf-purple"
                  >
                    查看详情
                  </button>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-start gap-2">
                    <span className="text-wolf-purple">🌙</span>
                    <span className="text-wolf-text/70">夜晚：狼人杀人、预言家查验、女巫用药、守卫守护</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-yellow-400">☀️</span>
                    <span className="text-wolf-text/70">白天：玩家依次发言讨论</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-orange-400">🗳️</span>
                    <span className="text-wolf-text/70">投票：处决嫌疑最大的玩家</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-green-400">🏆</span>
                    <span className="text-wolf-text/70">狼人屠边或好人放逐所有狼即获胜</span>
                  </div>
                </div>
              </div>
            )}

            {gameStarted && gameState?.phase !== 'roleSelect' && !showRules && (
              <SituationPanel gameState={gameState} players={players} messages={messages} />
            )}

            {gameStarted && gameState?.phase !== 'roleSelect' && !showRules && (
              <div className="card-glass p-4">
                <h3 className="font-semibold text-wolf-text mb-3">身份牌</h3>
                <div className="grid grid-cols-3 gap-2">
                  {['🐺', '🔮', '🧙', '🔫', '🛡️', '👤'].map((icon, index) => (
                    <div
                      key={index}
                      className="flex flex-col items-center p-2 bg-white/[0.02] rounded-lg border border-white/5 cursor-pointer hover:bg-white/[0.05] hover:border-wolf-purple/20 transition-all"
                      title={['狼人', '预言家', '女巫', '猎人', '守卫', '平民'][index]}
                      onClick={() => setShowRoleDetail({ role: ['wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager'][index] as any, show: true })}
                    >
                      <span className="text-xl">{icon}</span>
                      <span className="text-xs text-wolf-text/50">{['狼人', '预言家', '女巫', '猎人', '守卫', '平民'][index]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {gameStarted && gameState?.phase !== 'roleSelect' && !showRules && (
              <div className="card-glass p-4">
                <button
                  onClick={() => setShowWaitingGame(true)}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-yellow-500/20 to-amber-500/10 hover:from-yellow-500/30 hover:to-amber-500/20 border border-yellow-500/20 text-yellow-400 font-medium transition-all flex items-center justify-center gap-2"
                >
                  <span className="text-xl">🎮</span>
                  <span>等待小游戏</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showAbortConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="card p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <AlertTriangle className="w-8 h-8 text-orange-400" />
              <h3 className="text-xl font-bold text-wolf-text">确认中止游戏</h3>
            </div>
            <p className="text-wolf-text/70 mb-6">
              中止游戏将停止所有AI调用，避免过度消耗Token。游戏将不再自动进行，但你仍可以查看当前状态。
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowAbortConfirm(false)} className="flex-1 btn-secondary">
                取消
              </button>
              <button onClick={handleAbortGame} className="flex-1 btn-primary bg-orange-500 hover:bg-orange-600">
                确认中止
              </button>
            </div>
          </div>
        </div>
      )}

      {showRules && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="card-glass overflow-hidden w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-4 py-3 border-b border-white/5 glass-highlight flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-wolf-purple-light" />
                <h3 className="font-semibold text-wolf-text">游戏规则</h3>
              </div>
              <button onClick={() => setShowRules(false)} className="p-2 hover:bg-white/5 rounded-xl transition-all">
                <X className="w-5 h-5 text-wolf-text/50" />
              </button>
            </div>
            <div className="p-4">
              <RulePanel />
            </div>
          </div>
        </div>
      )}

      <VoteModal
        isOpen={showVoteModal}
        onClose={() => setShowVoteModal(false)}
        onVote={handleVote}
        onSubmit={() => {
          setShowVoteModal(false);
          if (isHost) {
            // 先触发AI投票，确保所有AI玩家完成投票后再结束投票
            handleAutoAllVotes().then(() => {
              setTimeout(() => endVoting(), 500);
            });
          }
        }}
        canClose={true}
        onAutoVote={handleAutoAllVotes}
      />

      <NightActionModal
        isOpen={showNightActionModal}
        onClose={() => setShowNightActionModal(false)}
        onAction={handleNightAction}
        onSkip={handleSkipNight}
      />

      <WolfVoteModal
        isOpen={showWolfVoteModal}
        onClose={() => setShowWolfVoteModal(false)}
        onExecuteKill={(targetId) => handleExecuteKill(targetId, true)}
        wolfPlayers={wolfPlayers}
        targetPlayers={wolfTargetPlayers}
      />

      {showWaitingGame && (
        <WaitingGame onClose={() => setShowWaitingGame(false)} />
      )}

      {showRoleDetail.show && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="card-glass overflow-hidden w-full max-w-md">
            <div className="px-4 py-3 border-b border-white/5 glass-highlight flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xl">{getRoleInfo(showRoleDetail.role).icon}</span>
                <h3 className="font-semibold text-wolf-text">{getRoleInfo(showRoleDetail.role).name}</h3>
              </div>
              <button onClick={() => setShowRoleDetail({ ...showRoleDetail, show: false })} className="p-2 hover:bg-white/5 rounded-xl transition-all">
                <X className="w-5 h-5 text-wolf-text/50" />
              </button>
            </div>
            <div className="p-4">
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-wolf-text/70 mb-2">角色技能</h4>
                <p className="text-sm text-wolf-text">{getRoleInfo(showRoleDetail.role).description}</p>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-wolf-text/70 mb-2">所属阵营</h4>
                <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
                  getRoleInfo(showRoleDetail.role).team === 'wolf' 
                    ? 'bg-red-500/20 text-red-400 border border-red-500/40' 
                    : 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                }`}>
                  {getRoleInfo(showRoleDetail.role).team === 'wolf' ? '🐺 狼人阵营' : '👥 好人阵营'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
