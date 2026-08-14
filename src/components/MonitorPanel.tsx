import { useEffect, useState } from 'react';
import { Activity, X, ChevronDown, ChevronRight, AlertCircle, CheckCircle, Info, Zap, Clock, History } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { loadArchivedGames } from '../utils/gameLogArchive';
import type { GameLog } from '../types';
import { requestDebug } from '../net/socket';
import { fetchArchives, fetchRoomSummaries } from '../net/socket';
import { useOnlineStore } from '../stores/onlineStore';
import type { ArchiveRecord } from '../net/protocol';

const getLogIcon = (type: GameLog['type']) => {
  switch (type) {
    case 'info':
      return <Info className="w-4 h-4 text-blue-400" />;
    case 'warning':
      return <AlertCircle className="w-4 h-4 text-yellow-400" />;
    case 'error':
      return <AlertCircle className="w-4 h-4 text-red-400" />;
    case 'success':
      return <CheckCircle className="w-4 h-4 text-green-400" />;
    case 'api':
      return <Zap className="w-4 h-4 text-purple-400" />;
    default:
      return <Info className="w-4 h-4 text-gray-400" />;
  }
};

const getLogColor = (type: GameLog['type']) => {
  switch (type) {
    case 'info':
      return 'border-l-blue-400';
    case 'warning':
      return 'border-l-yellow-400';
    case 'error':
      return 'border-l-red-400';
    case 'success':
      return 'border-l-green-400';
    case 'api':
      return 'border-l-purple-400';
    default:
      return 'border-l-gray-400';
  }
};

const formatTime = (date: Date) => {
  return new Date(date).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

export const MonitorPanel = () => {
  const { showMonitor, setShowMonitor, logs, clearLogs, gameState, players, wolfKillComplete } = useGameStore();
  const { connected, roomCode, snapshot, debugLogs, connectionNotice, roomSummaries, setRoomSummaries } = useOnlineStore();
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  // v2.3 任务 E：历史对局视图（最近 3 局，自动轮转）
  const [activeTab, setActiveTab] = useState<'live' | 'history'>('live');
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);
  const [serverArchives, setServerArchives] = useState<ArchiveRecord[]>([]);

  const recentLogs = [...logs].reverse().slice(0, 50);
  const archivedGames = loadArchivedGames();

  useEffect(() => {
    let active = true;
    fetchArchives().then((archives) => {
      if (active) setServerArchives(archives);
    }).catch(() => {
      if (active) setServerArchives([]);
    });
    return () => { active = false; };
  }, [connected, setRoomSummaries]);

  useEffect(() => {
    if (!showMonitor) return;
    let active = true;
    const refresh = () => fetchRoomSummaries().then((rooms) => { if (active) setRoomSummaries(rooms); }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [showMonitor, setRoomSummaries]);

  const getCurrentProgress = () => {
    if (!gameState) return { text: '等待开始', progress: 0 };
    
    const alivePlayers = players.filter(p => p.isAlive).length;

    switch (gameState.phase) {
      case 'waiting':
        return { text: '等待开始', progress: 0 };
      case 'night': {
        const aliveWolves = players.filter(p => p.isAlive && p.role === 'wolf');
        const aliveSeers = players.filter(p => p.isAlive && p.role === 'seer');
        const aliveWitches = players.filter(p => p.isAlive && p.role === 'witch');
        
        let totalActions = 0;
        let actedCount = 0;
        
        if (aliveWolves.length > 0) {
          totalActions++;
          if (gameState.actionDone['wolf_team'] || wolfKillComplete) {
            actedCount++;
          }
        }
        if (aliveSeers.length > 0) {
          totalActions++;
          const seerActed = aliveSeers.some(s => gameState.actionDone[s.id]);
          if (seerActed) {
            actedCount++;
          }
        }
        if (aliveWitches.length > 0) {
          totalActions++;
          const witchActed = aliveWitches.some(w => gameState.actionDone[w.id]);
          if (witchActed) {
            actedCount++;
          }
        }
        
        const nightProgress = totalActions > 0 ? (actedCount / totalActions) * 50 : 50;
        return { text: `🌙 夜晚行动 ${actedCount}/${totalActions}`, progress: nightProgress };
      }
      case 'day': {
        const currentSpeakerIndex = gameState.speakerOrder.indexOf(gameState.currentSpeaker || '');
        const dayProgress = 50 + (currentSpeakerIndex / gameState.speakerOrder.length) * 30;
        const currentSpeaker = players.find(p => p.id === gameState.currentSpeaker);
        return { text: `☀️ ${currentSpeaker?.name || '准备中'} 发言中`, progress: dayProgress };
      }
      case 'vote': {
        const votedPlayers = Object.keys(gameState.votes).length;
        const voteProgress = 80 + (votedPlayers / alivePlayers) * 15;
        return { text: `🗳️ 投票中 ${votedPlayers}/${alivePlayers}`, progress: voteProgress };
      }
      case 'ended':
        return { text: `游戏结束 - ${gameState.winner === 'wolf' ? '狼人胜利' : '好人胜利'}`, progress: 100 };
      default:
        return { text: '未知状态', progress: 0 };
    }
  };

  const progressInfo = getCurrentProgress();
  const debugEnabled = !!snapshot?.isHost && !!snapshot.debugMode;

  const stats = {
    totalLogs: logs.length,
    errorCount: logs.filter(l => l.type === 'error').length,
    apiCount: logs.filter(l => l.type === 'api').length,
    successCount: logs.filter(l => l.type === 'success').length,
  };

  if (!showMonitor) {
    return (
      <button
        onClick={() => setShowMonitor(true)}
        className="fixed right-0 top-1/2 -translate-y-1/2 bg-wolf-purple hover:bg-wolf-purple-light text-white p-3 rounded-l-xl shadow-lg transition-all hover:scale-110 z-40"
        title="打开监控面板"
      >
        <Activity className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div className="fixed right-0 top-0 h-full w-96 bg-wolf-dark border-l border-wolf-purple/30 shadow-2xl z-50 flex flex-col animate-slide-in">
      <div className="p-4 border-b border-wolf-purple/30 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-wolf-purple/20 rounded-lg flex items-center justify-center">
            <Activity className="w-5 h-5 text-wolf-purple" />
          </div>
          <div>
            <h3 className="font-semibold text-wolf-text">游戏监控</h3>
            <p className="text-xs text-wolf-text/50">实时日志与状态</p>
          </div>
        </div>
        <button
          onClick={() => setShowMonitor(false)}
          className="p-2 hover:bg-wolf-card rounded-lg transition-colors"
        >
          <X className="w-5 h-5 text-wolf-text/70" />
        </button>
      </div>

      <div className="p-4 border-b border-wolf-purple/30">
        {roomSummaries.length > 0 && <div className="mb-4 rounded-lg bg-wolf-card/40 p-3"><div className="mb-2 text-xs text-wolf-text/60">房间监控 · {roomSummaries.length} 间</div><div className="space-y-1 text-xs">{roomSummaries.slice(0, 6).map((room) => <div key={room.roomCode} className="flex items-center justify-between gap-2"><span className="truncate text-wolf-text/80">{room.roomName} <span className="text-wolf-text/40">{room.roomCode}</span></span><span className="shrink-0 text-wolf-text/50">{room.onlinePlayers}/{room.playerCount} 在线</span></div>)}</div></div>}
        <div className="mb-4 rounded-lg border border-wolf-purple/20 bg-wolf-card/40 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-wolf-text/70">联机状态</span>
            <span className={connected ? 'text-green-400' : 'text-yellow-400'}>{connected ? '在线' : '重连中'}</span>
          </div>
          {roomCode && <div className="mt-1 text-wolf-text/50">房间 {roomCode} · {connectionNotice || '等待状态'}</div>}
          {!connected && roomCode && <div className="mt-2 text-yellow-300">断线期间请保持页面开启，重连后会恢复房间快照。</div>}
          {debugEnabled && (
            <div className="mt-3 border-t border-wolf-purple/15 pt-2">
              <div className="flex items-center justify-between">
                <span className="text-wolf-purple-light">房主调试通道</span>
                <button className="text-wolf-text/60 hover:text-wolf-text" onClick={() => { if (roomCode) { requestDebug(roomCode, 'debug:snapshot'); requestDebug(roomCode, 'debug:log'); } }}>刷新</button>
              </div>
              <div className="mt-1 text-wolf-text/50">全量玩家 {debugLogs.length ? `· 日志 ${debugLogs.length} 条` : '· 暂无日志'}</div>
              {debugLogs.length > 0 && (
                <div className="mt-2 max-h-32 space-y-1 overflow-y-auto font-mono text-[10px]">
                  {debugLogs.slice(-8).reverse().map((entry) => (
                    <div key={entry.seq} className="flex gap-2 text-wolf-text/60">
                      <span className={entry.level === 'error' ? 'text-red-400' : entry.level === 'warning' ? 'text-yellow-400' : 'text-wolf-purple-light'}>{entry.category}</span>
                      <span className="min-w-0 flex-1 break-words">{entry.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mb-3">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-wolf-text/70">游戏进度</span>
            <span className="text-wolf-text font-medium">{progressInfo.text}</span>
          </div>
          <div className="h-2 bg-wolf-card rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-wolf-purple to-wolf-purple-light transition-all duration-500"
              style={{ width: `${progressInfo.progress}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-wolf-card/50 rounded-lg p-3">
            <div className="text-2xl font-bold text-wolf-text">{stats.totalLogs}</div>
            <div className="text-xs text-wolf-text/50">总日志数</div>
          </div>
          <div className="bg-wolf-card/50 rounded-lg p-3">
            <div className="text-2xl font-bold text-green-400">{stats.successCount}</div>
            <div className="text-xs text-wolf-text/50">成功操作</div>
          </div>
          <div className="bg-wolf-card/50 rounded-lg p-3">
            <div className="text-2xl font-bold text-purple-400">{stats.apiCount}</div>
            <div className="text-xs text-wolf-text/50">API调用</div>
          </div>
          <div className="bg-wolf-card/50 rounded-lg p-3">
            <div className="text-2xl font-bold text-red-400">{stats.errorCount}</div>
            <div className="text-xs text-wolf-text/50">错误</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex gap-1 mb-4 bg-wolf-card/40 rounded-xl p-1">
          <button
            onClick={() => setActiveTab('live')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'live' ? 'bg-wolf-purple/30 text-wolf-text' : 'text-wolf-text/50 hover:text-wolf-text'
            }`}
          >
            <Activity className="w-3.5 h-3.5 inline mr-1" />实时日志
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeTab === 'history' ? 'bg-wolf-purple/30 text-wolf-text' : 'text-wolf-text/50 hover:text-wolf-text'
            }`}
          >
            <History className="w-3.5 h-3.5 inline mr-1" />历史对局
          </button>
        </div>

        {activeTab === 'history' ? (
          <div className="space-y-2">
            {serverArchives.length === 0 && archivedGames.length === 0 ? (
              <div className="text-center py-8 text-wolf-text/50">
                <History className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>暂无历史对局</p>
              </div>
            ) : (
              <>
              {serverArchives.map((archive) => (
                <div key={archive.id} className="bg-wolf-card/30 rounded-lg border-l-4 border-l-blue-400 overflow-hidden">
                  <div className="p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-wolf-text truncate">{archive.roomName}</span>
                      <span className="text-xs font-medium text-blue-400">服务端存档</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-wolf-text/50">
                      <Clock className="w-3 h-3" />
                      <span>{new Date(archive.endedAt).toLocaleString('zh-CN')}</span>
                      <span>第{archive.day}天</span>
                      <span>{archive.playerCount} 人</span>
                    </div>
                    <div className="mt-2 text-xs text-wolf-text/60">复盘消息 {archive.reviewMessages.length} 条 · 心得 {archive.insights.length} 条</div>
                  </div>
                </div>
              ))}
              {archivedGames.map((game) => (
                <div key={game.id} className="bg-wolf-card/30 rounded-lg border-l-4 border-l-wolf-purple overflow-hidden">
                  <div
                    className="p-3 cursor-pointer hover:bg-wolf-card/50 transition-colors"
                    onClick={() => setExpandedGameId(expandedGameId === game.id ? null : game.id)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-wolf-text truncate">{game.roomName}</span>
                      <span className={`text-xs font-medium ${game.winner === 'wolf' ? 'text-red-400' : 'text-green-400'}`}>
                        {game.winner === 'wolf' ? '🐺 狼人胜' : game.winner === 'good' ? '✨ 好人胜' : '未分胜负'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-wolf-text/50">
                      <Clock className="w-3 h-3" />
                      <span>{new Date(game.endedAt).toLocaleString('zh-CN')}</span>
                      <span>第{game.day}天</span>
                      <span>{game.logCount} 条日志</span>
                    </div>
                    {expandedGameId === game.id ? (
                      <ChevronDown className="w-4 h-4 text-wolf-text/40 mt-1" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-wolf-text/40 mt-1" />
                    )}
                  </div>
                  {expandedGameId === game.id && (
                    <div className="px-3 pb-3 space-y-1.5 max-h-80 overflow-y-auto">
                      {game.logs.slice(-40).map((log) => (
                        <div key={log.id} className="flex items-start gap-2 text-xs">
                          {getLogIcon(log.type)}
                          <div className="min-w-0 flex-1">
                            <span className="text-wolf-text/80">{log.title}</span>
                            <span className="text-wolf-text/40 ml-1">{log.message}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              </>
            )}
          </div>
        ) : (
          <>
        <div className="flex justify-between items-center mb-4">
          <h4 className="text-sm font-medium text-wolf-text">实时日志</h4>
          <button
            onClick={clearLogs}
            className="text-xs text-wolf-text/50 hover:text-wolf-text transition-colors"
          >
            清空日志
          </button>
        </div>

        <div className="space-y-2">
          {recentLogs.length === 0 ? (
            <div className="text-center py-8 text-wolf-text/50">
              <Activity className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>暂无日志记录</p>
            </div>
          ) : (
            recentLogs.map((log) => (
              <div
                key={log.id}
                className={`bg-wolf-card/30 rounded-lg border-l-4 ${getLogColor(log.type)} overflow-hidden`}
              >
                <div
                  className="p-3 cursor-pointer hover:bg-wolf-card/50 transition-colors"
                  onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
                >
                  <div className="flex items-start gap-3">
                    {getLogIcon(log.type)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-wolf-text truncate">{log.title}</span>
                        <span className="text-xs text-wolf-text/40 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(log.timestamp)}
                        </span>
                      </div>
                      <p className="text-xs text-wolf-text/60 truncate">{log.message}</p>
                      {log.playerName && (
                        <span className="text-xs text-wolf-purple">{log.playerName}</span>
                      )}
                    </div>
                    {log.details && (
                      expandedLogId === log.id ? (
                        <ChevronDown className="w-4 h-4 text-wolf-text/40 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-wolf-text/40 flex-shrink-0" />
                      )
                    )}
                  </div>
                </div>

                {expandedLogId === log.id && log.details && (
                  <div className="px-3 pb-3">
                    <div className="bg-wolf-dark/50 rounded-lg p-3 text-xs text-wolf-text/70 font-mono overflow-x-auto">
                      {log.details}
                    </div>
                    {log.apiEndpoint && (
                      <div className="mt-2 text-xs text-purple-400">
                        API: {log.apiEndpoint}
                        {log.duration && <span className="ml-2">耗时: {log.duration}ms</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
          </>
        )}
      </div>
    </div>
  );
};
