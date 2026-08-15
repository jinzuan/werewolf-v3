import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Play, Eye, EyeOff, BookOpen, AlertTriangle, LogOut, Trophy, RotateCcw,
  Moon, Users, X, MessageSquare, Wifi, WifiOff, Globe, History,
} from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { useOnlineStore } from '../stores/onlineStore';
import { sendAction, reconnectOnlineRoom, joinOnlineRoom, disconnect, getSocket } from '../net/socket';
import { useOnlineGame } from '../hooks/useOnlineGame';
import { loadOnlineMeta, saveOnlineMeta } from '../net/roomMeta';
import type { ClientAction } from '../net/protocol';

import { ChatTabs } from '../components/ChatTabs';
import { SystemMessagesPanel } from '../components/SystemMessagesPanel';
import { PlayerCard } from '../components/PlayerCard';
import { MyRolePanel } from '../components/MyRolePanel';
import { GameProgressPanel } from '../components/GameProgressPanel';
import { VoteResultPanel } from '../components/VoteResultPanel';
import { RoleSelectPanel } from '../components/RoleSelectPanel';
import { HunterShootPanel } from '../components/HunterShootPanel';
import { VoteModal } from '../components/VoteModal';
import { NightActionModal } from '../components/NightActionModal';
import { WolfVoteModal } from '../components/WolfVoteModal';
import { RulePanel } from '../components/RulePanel';
import { SituationPanel } from '../components/SituationPanel';
import { WaitingGame } from '../components/WaitingGame';
import { getPhaseText } from '../utils/gameLogic';
import { getRoleInfo } from '../utils/roleConfig';
import type { Role } from '../types';

const ReviewStageLabel: Record<string, string> = {
  'team-wolf': '🐺 狼队内部复盘',
  'team-good': '✨ 好人队内部复盘',
  meeting: '🏛️ 全场合议',
  done: '✅ 复盘完成',
};

export const OnlineGameRoom = ({ onNavigate }: { onNavigate: (path: string) => void }) => {
  const { roomCode } = useParams();

  const store = useGameStore();
  const { players, gameState, messages, wolfChatMessages, myRole, isHost, isSpectator, currentUser, currentRoom, wolfVotes, wolfDiscussionRound, wolfVoteComplete } = store;

  const onlineConnected = useOnlineStore((s) => s.connected);
  const snapshot = useOnlineStore((s) => s.snapshot);
  const serverError = useOnlineStore((s) => s.serverError);

  const isCreator = !!snapshot?.isCreator;
  const joinToken = snapshot?.joinToken || '';

  const [meta, setMeta] = useState(() => (roomCode ? loadOnlineMeta(roomCode) : null));
  const [joinError, setJoinError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showVoteModal, setShowVoteModal] = useState(false);
  const [showNightModal, setShowNightModal] = useState(false);
  const [showWolfVoteModal, setShowWolfVoteModal] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [showWaitingGame, setShowWaitingGame] = useState(false);
  const [showReview, setShowReview] = useState(true);
  const [showRoleDetail, setShowRoleDetail] = useState<{ role: Role; show: boolean }>({ role: 'villager', show: false });
  const [reviewInput, setReviewInput] = useState('');

  const playerId = meta?.playerId ?? null;

  useOnlineGame(roomCode || '');

  /* ---------- 连接 / 加入 ---------- */
  useEffect(() => {
    if (!roomCode) return;
    let cancelled = false;
    (async () => {
      setJoinError(null);
      try {
        const m = loadOnlineMeta(roomCode);
        let res;
        if (m?.playerId) {
          res = await reconnectOnlineRoom(roomCode, m.playerId, m.token);
        }
        if (!res?.ok) {
          res = await joinOnlineRoom(roomCode, m?.name || '玩家', true, m?.token);
        }
        if (cancelled) return;
        if (res.ok && res.snapshot) {
          const pid = res.playerId || res.spectatorId || '';
          const spect = !!res.spectatorId;
          const metaObj = { playerId: pid, name: m?.name || '玩家', spectator: spect, token: m?.token || '' };
          setMeta(metaObj);
          saveOnlineMeta(roomCode, metaObj);
          store.setCurrentUser({ id: pid, name: metaObj.name });
          useOnlineStore.getState().setSnapshot(res.snapshot);
          store.applyOnlineSnapshot(res.snapshot);
        } else {
          setJoinError(res?.message || '加入失败，请返回大厅重新加入');
        }
      } catch (e) {
        console.error(e);
        setJoinError('无法连接服务端');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  /* ---------- 断线自动重连：socket 重连后重新绑定房间身份 ---------- */
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const onConnect = () => {
      const m = loadOnlineMeta(roomCode || '');
      if (roomCode && m?.playerId) {
        reconnectOnlineRoom(roomCode, m.playerId, m.token).then((res) => {
          if (res.ok && res.snapshot) {
            useOnlineStore.getState().setSnapshot(res.snapshot);
            store.applyOnlineSnapshot(res.snapshot);
          }
        });
      }
    };
    s.on('connect', onConnect);
    return () => {
      s.off('connect', onConnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  /* ---------- 自动打开行动弹窗 ---------- */
  useEffect(() => {
    if (!gameState || isSpectator) return;
    const me = players.find((p) => p.id === currentUser?.id);
    if (!me || !me.isAlive) {
      setShowVoteModal(false);
      setShowNightModal(false);
      return;
    }
    if ((gameState.phase === 'vote' || gameState.phase === 'voting') && gameState.votes[currentUser?.id || ''] === undefined) {
      setShowVoteModal(true);
    }
    if (gameState.phase === 'night' && ['seer', 'witch', 'guardian'].includes(myRole || '') && !gameState.actionDone[currentUser?.id || '']) {
      setShowNightModal(true);
    }
  }, [gameState?.phase, gameState?.votes, gameState?.actionDone, myRole, players, currentUser?.id, isSpectator, gameState]);

  if (!roomCode) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="card p-8 text-center">
          <p className="text-wolf-text mb-4">缺少房间码</p>
          <button onClick={() => onNavigate('/online')} className="btn-primary">返回联机大厅</button>
        </div>
      </div>
    );
  }

  const doAction = (action: ClientAction) => {
    if (playerId) sendAction(roomCode, playerId, action);
  };

  const alivePlayers = players.filter((p) => p.isAlive);
  const deadPlayers = players.filter((p) => !p.isAlive);
  const isWolf = myRole === 'wolf';
  const wolfPlayers = players.filter((p) => p.role === 'wolf' && p.isAlive);
  const wolfTargetPlayers = alivePlayers;
  const currentSpeakerPlayer = players.find((p) => p.id === gameState?.currentSpeaker);
  const winnerTeam = gameState?.winner ?? null;
  const gameStarted = !!gameState && gameState.phase !== 'waiting';
  const me = players.find((p) => p.id === currentUser?.id);
  const myVoted = gameState && currentUser ? gameState.votes[currentUser.id] !== undefined : false;
  const review = snapshot?.review;

  const startGame = () => doAction({ t: 'start-game' });
  const confirmRoles = () => doAction({ t: 'confirm-roles' });
  const handleReady = () => {
    doAction({ t: 'ready' });
    setReady(true);
  };
  const leaveRoom = () => {
    doAction({ t: 'leave' });
    disconnect();
    onNavigate('/online');
  };
  const handleAbortGame = () => {
    doAction({ t: 'abort' });
    setShowAbortConfirm(false);
  };
  const restartGame = () => doAction({ t: 'restart' });
  const handleKickPlayer = (targetId: string) => doAction({ t: 'kick-player', playerId: targetId });
  const handleDestroyRoom = () => doAction({ t: 'destroy-room' });
  const handleToggleReview = () => doAction({ t: 'set-review', enabled: !(review?.enabled ?? false) });
  const handleVote = (targetId: string) => doAction({ t: 'vote', targetId, reason: '' });
  const handleNightAction = (action: 'kill' | 'check' | 'heal' | 'poison' | 'guard', targetId: string) => {
    doAction({ t: 'night-action', action, targetId });
    setShowNightModal(false);
  };
  const handleSkipNight = () => {
    doAction({ t: 'skip-night' });
    setShowNightModal(false);
  };
  const handleWolfVote = (targetId: string) => doAction({ t: 'wolf-vote', targetId });
  const handleWolfExecuteKill = (targetId: string) => {
    doAction({ t: 'wolf-execute-kill', targetId });
    setShowWolfVoteModal(false);
  };
  const handleWolfNextSpeaker = () => doAction({ t: 'wolf-next-speaker' });
  const handleHunterShoot = (targetId: string) => doAction({ t: 'hunter-shoot', targetId });
  const handleSkipSpeech = () => {
    if (gameState?.phase === 'lastWords') {
      const reason = window.prompt('请填写放弃遗言的理由（例如“懒得说”）')?.trim();
      if (!reason) return;
      doAction({ t: 'skip-speech', reason });
      return;
    }
    doAction({ t: 'skip-speech' });
  };
  const handleStartVote = () => doAction({ t: 'start-vote' });
  const handleReviewSpeak = () => {
    if (reviewInput.trim()) {
      doAction({ t: 'review-speak', content: reviewInput.trim() });
      setReviewInput('');
    }
  };

  const humansReady = players.filter((p) => !p.isAI).every((p) => p.isReady);
  const reviewActive = review && review.stage !== 'idle';

  return (
    <div className="min-h-screen">
      <div className="max-w-[1400px] mx-auto px-3 md:px-5 py-4">

        {/* ===== 顶部状态区 ===== */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg md:text-xl font-bold text-wolf-text">{currentRoom?.name || roomCode}</h2>
                <span className="text-xs text-wolf-text/40 font-mono bg-wolf-purple/10 px-2 py-0.5 rounded">{roomCode}</span>
                {(isHost || isCreator) && joinToken && (
                  <button
                    onClick={() => navigator.clipboard?.writeText(joinToken).catch(() => {})}
                    className="text-xs text-green-400/80 font-mono bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20 hover:bg-green-500/20"
                    title="点击复制进入令牌（凭房间码+令牌可加入/观战）"
                  >
                    🔑 令牌: {joinToken.slice(0, 8)}…
                  </button>
                )}
                {onlineConnected ? (
                  <span className="flex items-center gap-1 text-xs text-green-400"><Wifi className="w-3.5 h-3.5" />已连接</span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-red-400"><WifiOff className="w-3.5 h-3.5" />离线</span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                <span className="text-xs md:text-sm text-wolf-text/60">
                  阶段: <span className={`font-bold ml-1 ${gameState?.phase === 'night' ? 'text-blue-400' : gameState?.phase === 'day' ? 'text-yellow-400' : gameState?.phase === 'vote' || gameState?.phase === 'voting' ? 'text-orange-400' : 'text-wolf-purple'}`}>
                    {gameState ? getPhaseText(gameState.phase) : '等待开始'}
                  </span>
                </span>
                {gameState && <span className="text-xs md:text-sm text-wolf-text/60">第 {gameState.day} 天</span>}
                <span className="text-xs md:text-sm text-wolf-text/60">人数: {players.length}人</span>
                {gameState?.phase === 'day' && currentSpeakerPlayer && (
                  <span className="text-xs text-yellow-400 font-medium animate-pulse">🗣️ 当前发言: {currentSpeakerPlayer.name}</span>
                )}
                {gameState?.phase === 'night' && gameState.wolfCurrentSpeaker && (
                  <span className="text-xs text-red-400/80 font-medium">🐺 狼人讨论中</span>
                )}
                {serverError && <span className="text-xs text-red-400">{serverError}</span>}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {isHost && gameStarted && gameState?.phase === 'roleSelect' && (
              <button onClick={confirmRoles} className="btn-primary flex items-center gap-2 text-sm">
                <Play className="w-4 h-4" /> 确认角色，开局
              </button>
            )}
            {!gameStarted && (
              <button onClick={() => onNavigate('/reviews')} className="btn-secondary flex items-center gap-2 text-sm">
                <History className="w-4 h-4" /> 复盘回看
              </button>
            )}
            <button onClick={() => setShowRoles(!showRoles)} className="p-2 rounded-lg hover:bg-wolf-purple/20 transition-colors" title="显示身份">
              {showRoles ? <EyeOff className="w-5 h-5 text-wolf-text" /> : <Eye className="w-5 h-5 text-wolf-text" />}
            </button>
            <button onClick={() => setShowRules(!showRules)} className="p-2 rounded-lg hover:bg-wolf-purple/20 transition-colors" title="规则">
              <BookOpen className="w-5 h-5 text-wolf-text" />
            </button>
            {gameStarted && !winnerTeam && (isHost || isCreator) && (
              <button onClick={() => setShowAbortConfirm(true)} className="p-2 rounded-lg hover:bg-orange-500/20 transition-colors" title="中止游戏">
                <AlertTriangle className="w-5 h-5 text-orange-400" />
              </button>
            )}
            {(isHost || isCreator) && (
              <button
                onClick={() => { if (window.confirm('销毁房间将断开所有玩家并移除房间，确定？')) handleDestroyRoom(); }}
                className="p-2 rounded-lg hover:bg-red-500/30 transition-colors"
                title="销毁房间"
              >
                <LogOut className="w-5 h-5 text-red-400" />
              </button>
            )}
            <button onClick={leaveRoom} className="p-2 rounded-lg hover:bg-red-500/20 transition-colors" title="离开">
              <LogOut className="w-5 h-5 text-red-400" />
            </button>
          </div>
        </div>

        {joinError && (
          <div className="card p-4 mb-4 border-red-500/30 bg-red-500/10">
            <p className="text-red-300 text-sm mb-3">{joinError}</p>
            <button onClick={() => onNavigate('/online')} className="btn-primary text-sm">返回联机大厅</button>
          </div>
        )}

        {isSpectator && !winnerTeam && (
          <div className="card p-4 mb-4 border-l-4 border-l-wolf-purple bg-wolf-purple/5">
            <div className="flex items-center gap-3">
              <Eye className="w-5 h-5 text-wolf-purple" />
              <div>
                <p className="text-sm font-medium text-wolf-text">👁 观战模式</p>
                <p className="text-xs text-wolf-text/60">你可查看全场完整身份与对局走向。</p>
              </div>
            </div>
          </div>
        )}

        {winnerTeam && (
          <div className="card p-6 mb-4 text-center">
            <Trophy className={`w-16 h-16 mx-auto mb-4 ${winnerTeam === 'wolf' ? 'text-red-500' : 'text-blue-500'}`} />
            <h3 className="text-2xl font-bold text-wolf-text mb-2">{winnerTeam === 'wolf' ? '🐺 狼人阵营获胜！' : '✨ 好人阵营获胜！'}</h3>
            {isHost && (
              <button onClick={restartGame} className="mt-4 btn-primary flex items-center gap-2 mx-auto">
                <RotateCcw className="w-4 h-4" /> 重新开始
              </button>
            )}
          </div>
        )}

        {/* ===== 四区主布局（手机单列 / 平板双列 / 桌面三列） ===== */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[300px_minmax(0,1fr)_310px] gap-4">

          {/* 左：玩家列表 + 身份（手机上排在聊天之后） */}
          <aside className="order-2 md:order-1 space-y-4">
            {myRole && gameStarted && gameState?.phase !== 'roleSelect' && <MyRolePanel role={myRole} />}

            <div className="card-glass p-4">
              <h3 className="font-semibold text-wolf-text mb-3 flex items-center gap-2">
                <Users className="w-4 h-4 text-wolf-purple-light" /> 存活玩家 ({alivePlayers.length})
              </h3>
              <div className="space-y-2">
                {alivePlayers.map((player) => (
                  <PlayerCard
                    key={player.id}
                    player={player}
                    showRole={showRoles || (myRole === 'wolf' && player.role === 'wolf') || isSpectator}
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
                    <PlayerCard key={player.id} player={player} showRole={showRoles || isSpectator} small />
                  ))}
                </div>
              </div>
            )}

            {/* 准备阶段 */}
            {!gameStarted && (
              <div className="card p-4">
                <h3 className="font-semibold text-wolf-text mb-4">准备开始</h3>
                <div className="space-y-2 mb-4">
                  {players.map((p) => {
                    const isMe = p.id === currentUser?.id;
                    return (
                      <div key={p.id} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          {p.isAI && <span className="text-xs text-blue-400">AI</span>}
                          {p.isHost && !p.isAI && <span className="text-xs text-yellow-400">房主</span>}
                          <span className={isMe ? 'text-wolf-purple' : p.isAI ? 'text-blue-400' : 'text-wolf-text'}>{p.name}{isMe && ' (你)'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {isHost && !p.isAI && !p.isHost && !isMe && (
                            <button
                              onClick={() => handleKickPlayer(p.id)}
                              className="text-xs text-red-400 hover:text-red-300 border border-red-500/20 px-1.5 py-0.5 rounded"
                              title="移出房间"
                            >
                              踢出
                            </button>
                          )}
                          {p.isReady ? <span className="text-green-400 text-xs">✓ 已准备</span> : p.isAI ? <span className="text-blue-400 text-xs">🤖 AI</span> : <span className="text-wolf-text/40 text-xs">等待中</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  {!isHost && me && !me.isReady && !ready && (
                    <button onClick={handleReady} className="flex-1 btn-primary">准备</button>
                  )}
                  {isHost && (
                    <button
                      onClick={startGame}
                      disabled={!humansReady || players.length < 4}
                      className={`flex-1 btn-primary ${!humansReady || players.length < 4 ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      开始游戏 ({players.length}人)
                    </button>
                  )}
                </div>
                {isHost && !humansReady && (
                  <p className="text-xs text-orange-400 text-center mt-2">等待所有真人玩家准备...</p>
                )}
              </div>
            )}
          </aside>

          {/* 中：公告 + 聊天流 + 复盘（主区） */}
          <main className="order-1 md:order-2 flex flex-col space-y-4 min-w-0">
            {gameState?.phase === 'roleSelect' && (
              <RoleSelectPanel
                players={players}
                isHost={isHost}
                currentUser={currentUser}
                onRedraw={() => playerId && sendAction(roomCode, playerId, { t: 'redraw-role', playerId })}
                onConfirm={confirmRoles}
                onForceAssign={(pid, role) => doAction({ t: 'force-assign-role', playerId: pid, role })}
                onReassignAll={() => doAction({ t: 'reassign-all' })}
                remainingRedraws={3}
              />
            )}

            {gameStarted && gameState?.phase !== 'roleSelect' && <SystemMessagesPanel messages={messages} />}

            <div className={`flex flex-col gap-3 flex-1 ${gameStarted && gameState?.phase !== 'roleSelect' ? 'lg:h-[calc(100vh-250px)] min-h-[480px]' : 'min-h-[200px]'}`}>
              {gameStarted && gameState?.phase !== 'roleSelect' ? (
                <>
                  {myRole && !isWolf && !['seer', 'witch', 'guardian'].includes(myRole) && gameState?.phase === 'night' && (
                    <div className="card-glass p-4 text-center">
                      <span className="text-2xl">🌙</span>
                      <p className="text-wolf-text/70 text-sm mt-1">特殊角色正在行动中，请稍候...</p>
                    </div>
                  )}
                  <div className="flex-1 min-h-[420px]">
                    <ChatTabs
                      messages={messages}
                      wolfChatMessages={wolfChatMessages}
                      onSendMessage={(c) => doAction({ t: 'speak', content: c })}
                      onWolfSendMessage={(c) => doAction({ t: 'wolf-speak', content: c })}
                      onWolfVote={handleWolfVote}
                      onWolfExecuteKill={handleWolfExecuteKill}
                      onWolfNextSpeaker={handleWolfNextSpeaker}
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
                </>
              ) : !gameStarted ? (
                <div className="card-glass p-6 text-center">
                  <div className="text-4xl mb-3">🐺</div>
                  <p className="text-wolf-text/70">等待房主开始游戏...</p>
                  <p className="text-wolf-text/50 text-sm mt-1">真人玩家请先点击「准备」</p>
                </div>
              ) : null}
            </div>

            {/* 团队复盘面板 */}
            {reviewActive && (
              <div className="card-glass overflow-hidden">
                <div className="px-4 py-3 border-b border-wolf-purple/15 glass-highlight flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-wolf-purple-light" />
                    <h3 className="font-semibold text-wolf-text">{ReviewStageLabel[review.stage] || '团队复盘'}</h3>
                  </div>
                  <button onClick={() => setShowReview(!showReview)} className="p-1.5 rounded-lg hover:bg-white/5 transition-colors">
                    <X className="w-4 h-4 text-wolf-text/50" />
                  </button>
                </div>
                {showReview && (
                  <>
                    <div className="p-4 max-h-[300px] overflow-y-auto space-y-2">
                      {review.messages.length === 0 ? (
                        <p className="text-center text-wolf-text/40 text-sm py-6">复盘即将开始，AI 正在整理心得...</p>
                      ) : (
                        review.messages.map((m) => (
                          <div key={m.id} className={`rounded-xl p-3 border text-sm ${m.playerId === 'system' ? 'bg-gradient-to-r from-yellow-500/10 to-orange-500/5 border-yellow-500/20 text-yellow-300' : 'bg-wolf-purple/5 border-wolf-purple/15 text-wolf-text'}`}>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-semibold">{m.playerName}</span>
                              <span className="text-xs text-wolf-text/40">{new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                            <p className="text-wolf-text/85 leading-relaxed break-words">{m.content}</p>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="p-3 border-t border-wolf-purple/15 flex gap-2">
                      <input
                        type="text"
                        value={reviewInput}
                        onChange={(e) => setReviewInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleReviewSpeak()}
                        placeholder="参与复盘发言..."
                        className="input-field flex-1"
                      />
                      <button onClick={handleReviewSpeak} className="btn-primary px-4">发送</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </main>

          {/* 右：操作 + 进度 + 规则 */}
          <aside className="order-3 space-y-4">
            {gameStarted && gameState?.phase !== 'roleSelect' && (
              <>
                <GameProgressPanel />

                {gameState?.phase === 'night' && ['seer', 'witch', 'guardian'].includes(myRole || '') && me?.isAlive && !gameState.actionDone[currentUser?.id || ''] && (
                  <button
                    onClick={() => setShowNightModal(true)}
                    className="w-full py-3 rounded-xl bg-gradient-to-r from-indigo-500/20 to-purple-500/10 hover:from-indigo-500/30 border border-indigo-500/20 text-indigo-300 font-medium flex items-center justify-center gap-2"
                  >
                    <Moon className="w-4 h-4" /> 夜间行动
                  </button>
                )}

                {gameState?.phase === 'day' && gameState.dayPhase?.phase === 'free_discussion' && me?.isAlive && (
                  <button onClick={handleStartVote} className="w-full py-3 rounded-xl bg-gradient-to-r from-orange-500/20 to-amber-500/10 hover:from-orange-500/30 border border-orange-500/20 text-orange-300 font-medium flex items-center justify-center gap-2">
                    🗳️ 发起投票
                  </button>
                )}

                {gameState?.phase === 'night' && isWolf && me?.isAlive && !wolfVotes[currentUser?.id || ''] && (
                  <button onClick={() => setShowWolfVoteModal(true)} className="w-full py-3 rounded-xl bg-gradient-to-r from-red-500/20 to-rose-500/10 hover:from-red-500/30 border border-red-500/20 text-red-300 font-medium flex items-center justify-center gap-2">
                    🐺 狼群投票
                  </button>
                )}

                {(gameState?.phase === 'vote' || gameState?.phase === 'voting') && (
                  <VoteResultPanel visible={true} />
                )}

                {gameState?.phase === 'hunterShoot' && (
                  <HunterShootPanel players={players} onShoot={handleHunterShoot} isHunter={myRole === 'hunter'} />
                )}

                <button onClick={() => setShowWaitingGame(true)} className="w-full py-3 rounded-xl bg-gradient-to-r from-yellow-500/20 to-amber-500/10 hover:from-yellow-500/30 border border-yellow-500/20 text-yellow-400 font-medium">
                  🎮 等待小游戏
                </button>
              </>
            )}

            {showRules ? (
              <RulePanel />
            ) : (
              <div className="card-glass p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-wolf-text flex items-center gap-2"><Globe className="w-4 h-4 text-wolf-purple-light" /> 房间状态</h3>
                  <button onClick={() => setShowRules(true)} className="text-xs text-wolf-purple-light hover:text-wolf-purple">规则详情</button>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-wolf-text/60">模式</span>
                    <span className="text-wolf-text">{isSpectator ? '👁 观战' : isHost ? '👑 房主' : '🎮 玩家'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-wolf-text/60">我的身份</span>
                    <span className="text-wolf-text">{myRole ? `${getRoleInfo(myRole).icon} ${getRoleInfo(myRole).name}` : '未分配'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-wolf-text/60">AI 托管</span>
                    <span className="text-green-400 text-xs">服务端</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-wolf-text/60">复盘</span>
                    <div className="flex items-center gap-2">
                      <span className={review?.enabled ? 'text-green-400' : 'text-wolf-text/40'}>{review?.enabled ? '开启' : '关闭'}</span>
                      {(isHost || isCreator) && (
                        <button
                          onClick={handleToggleReview}
                          className={`relative w-9 h-5 rounded-full transition-colors duration-300 ${review?.enabled ? 'bg-green-500/40' : 'bg-white/10'}`}
                          title="切换复盘开关"
                        >
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full transition-transform duration-300 ${review?.enabled ? 'translate-x-[18px] bg-green-400' : 'translate-x-0.5 bg-purple-200/60'}`} />
                        </button>
                      )}
                    </div>
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
                    <div key={index} className="flex flex-col items-center p-2 bg-white/[0.02] rounded-lg border border-white/5 cursor-pointer hover:bg-white/[0.05] hover:border-wolf-purple/20 transition-all"
                      onClick={() => setShowRoleDetail({ role: ['wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager'][index] as Role, show: true })}>
                      <span className="text-xl">{icon}</span>
                      <span className="text-xs text-wolf-text/50">{['狼人', '预言家', '女巫', '猎人', '守卫', '平民'][index]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* ===== 弹窗 ===== */}
      {showAbortConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="card p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <AlertTriangle className="w-8 h-8 text-orange-400" />
              <h3 className="text-xl font-bold text-wolf-text">确认中止游戏</h3>
            </div>
            <p className="text-wolf-text/70 mb-6">中止将停止所有 AI 调用，本局提前结束。</p>
            <div className="flex gap-3">
              <button onClick={() => setShowAbortConfirm(false)} className="flex-1 btn-secondary">取消</button>
              <button onClick={handleAbortGame} className="flex-1 btn-primary bg-orange-500 hover:bg-orange-600">确认中止</button>
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
            <div className="p-4"><RulePanel /></div>
          </div>
        </div>
      )}

      <VoteModal
        isOpen={showVoteModal}
        onClose={() => setShowVoteModal(false)}
        onVote={handleVote}
        onSubmit={() => setShowVoteModal(false)}
        canClose={myVoted}
        onAutoVote={() => {}}
      />

      <NightActionModal
        isOpen={showNightModal}
        onClose={() => setShowNightModal(false)}
        onAction={handleNightAction}
        onSkip={handleSkipNight}
      />

      <WolfVoteModal
        isOpen={showWolfVoteModal}
        onClose={() => setShowWolfVoteModal(false)}
        onExecuteKill={handleWolfExecuteKill}
        wolfPlayers={wolfPlayers}
        targetPlayers={wolfTargetPlayers}
      />

      {showWaitingGame && <WaitingGame onClose={() => setShowWaitingGame(false)} />}

      {showRoleDetail.show && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="card-glass overflow-hidden w-full max-w-md">
            <div className="px-4 py-3 border-b border-white/5 glass-highlight flex items-center justify-between">
              <span className="text-xl">{getRoleInfo(showRoleDetail.role).icon}</span>
              <h3 className="font-semibold text-wolf-text">{getRoleInfo(showRoleDetail.role).name}</h3>
              <button onClick={() => setShowRoleDetail({ ...showRoleDetail, show: false })} className="p-2 hover:bg-white/5 rounded-xl transition-all">
                <X className="w-5 h-5 text-wolf-text/50" />
              </button>
            </div>
            <div className="p-4">
              <p className="text-sm text-wolf-text">{getRoleInfo(showRoleDetail.role).description}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
