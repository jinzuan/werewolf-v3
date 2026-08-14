import { useState } from 'react';
import {
  Plus, KeyRound, Eye, Bot, History, Settings2, X, Zap,
} from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { createOnlineRoom, joinOnlineRoom, getServerUrl, setServerUrl, connect } from '../net/socket';
import { useOnlineStore } from '../stores/onlineStore';
import { saveOnlineMeta } from '../net/roomMeta';
import type { RoomCreateOptions } from '../net/protocol';

interface OnlineLobbyProps {
  onNavigate: (path: string) => void;
}

export const OnlineLobby = ({ onNavigate }: OnlineLobbyProps) => {
  const currentUser = useGameStore((s) => s.currentUser);
  const [name, setName] = useState(currentUser?.name || localStorage.getItem('wolf-online-name') || '');
  const [serverUrl, setServerUrlState] = useState(getServerUrl());
  const [showServerCfg, setShowServerCfg] = useState(false);
  const [roomName, setRoomName] = useState('联机房');
  const [playerCount, setPlayerCount] = useState(6);
  const [aiCount, setAiCount] = useState(5);
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [joinCode, setJoinCode] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [spectate, setSpectate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setServerError = useOnlineStore((s) => s.setServerError);

  const nick = name.trim() || '玩家' + Math.floor(Math.random() * 100);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      setServerUrl(serverUrl.trim());
      const opts: RoomCreateOptions = {
        roomName: roomName.trim() || '联机房间',
        maxPlayers: playerCount,
        aiCount: aiCount,
        name: nick,
        reviewEnabled,
        spectator: false,
      };
      const res = await createOnlineRoom(opts);
      if (!res.ok || !res.roomCode || !res.playerId) {
        setError(res.message || '创建房间失败');
        return;
      }
      const token = res.token || '';
      saveOnlineMeta(res.roomCode, { playerId: res.playerId, name: nick, spectator: false, token });
      localStorage.setItem('wolf-online-name', nick);
      onNavigate(`/online-room/${res.roomCode}`);
    } catch (e) {
      setError('连接失败，请确认服务端已启动且地址正确');
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const handleQuickAuto = async () => {
    setBusy(true);
    setError(null);
    try {
      setServerUrl(serverUrl.trim());
      const res = await createOnlineRoom({
        roomName: 'AI 自跑对局',
        maxPlayers: 12,
        aiCount: 12,
        name: nick,
        reviewEnabled: false,
        auto: true,
      });
      if (!res.ok || !res.roomCode) {
        setError(res.message || '创建失败');
        return;
      }
      const token = res.token || '';
      saveOnlineMeta(res.roomCode, { playerId: res.spectatorId || '', name: nick, spectator: true, token });
      onNavigate(`/online-room/${res.roomCode}`);
    } catch {
      setError('连接失败，请确认服务端已启动');
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      setServerUrl(serverUrl.trim());
      const res = await joinOnlineRoom(code, nick, spectate, joinToken.trim());
      if (!res.ok) {
        setError(res.message || '加入房间失败');
        return;
      }
      const pid = res.playerId || res.spectatorId || '';
      const token = res.token || joinToken.trim();
      saveOnlineMeta(code, { playerId: pid, name: nick, spectator: !!res.spectatorId || spectate, token });
      localStorage.setItem('wolf-online-name', nick);
      onNavigate(`/online-room/${code}`);
    } catch {
      setError('连接失败，请确认服务端已启动');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-16 right-8 w-80 h-80 bg-cyan-700/6 rounded-full blur-3xl" />
        <div className="absolute bottom-16 left-8 w-96 h-96 bg-emerald-700/4 rounded-full blur-3xl" />
      </div>

      <div className="max-w-5xl mx-auto relative z-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl md:text-3xl font-bold text-gradient">🌐 联机对战</h2>
            <p className="text-sm text-purple-200/40 mt-1">双浏览器 / 手机 + 电脑同房：AI 在服务端托管，实时同步</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setShowServerCfg(!showServerCfg)} className="btn-secondary flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              <span className="hidden sm:inline">服务器</span>
            </button>
            <button onClick={() => onNavigate('/reviews')} className="btn-secondary flex items-center gap-2">
              <History className="w-4 h-4" />
              复盘回看
            </button>
          </div>
        </div>

        {showServerCfg && (
          <div className="card-glass p-4 mb-6">
            <label className="block text-sm text-purple-200/50 mb-2">服务器地址（手机同房填电脑的局域网 IP，如 http://192.168.x.x:3001）</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrlState(e.target.value)}
                onBlur={() => { setServerUrl(serverUrl.trim()); connect(serverUrl.trim()); }}
                className="input-field flex-1"
                placeholder="http://localhost:3001"
              />
              <button
                onClick={() => { setServerUrl(serverUrl.trim()); connect(serverUrl.trim()); setServerError(null); }}
                className="btn-primary"
              >
                连接
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 创建房间 */}
          <div className="card-glass-elevated p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500/30 to-emerald-500/15 flex items-center justify-center border border-green-500/25">
                <Plus className="w-5 h-5 text-green-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-purple-100">创建联机房间</h3>
                <p className="text-xs text-purple-200/40">真人 + AI 混局，AI 由服务端驱动</p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-purple-200/50 mb-2">你的昵称</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="输入昵称..." />
              </div>
              <div>
                <label className="block text-sm text-purple-200/50 mb-2">房间名称</label>
                <input type="text" value={roomName} onChange={(e) => setRoomName(e.target.value)} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-purple-200/50 mb-2">总人数：<span className="text-green-400 font-medium">{playerCount}</span></label>
                  <input type="range" min={4} max={12} value={playerCount}
                    onChange={(e) => { const v = Number(e.target.value); setPlayerCount(v); setAiCount(Math.min(aiCount, v - 1)); }}
                    className="w-full accent-green-500" />
                </div>
                <div>
                  <label className="block text-sm text-purple-200/50 mb-2">AI 数：<span className="text-cyan-400 font-medium">{aiCount}</span></label>
                  <input type="range" min={0} max={Math.max(0, playerCount - 1)} value={aiCount}
                    onChange={(e) => setAiCount(Math.min(Number(e.target.value), playerCount - 1))}
                    className="w-full accent-cyan-500" />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="block text-sm text-purple-200/50">局后团队复盘</label>
                <button
                  role="switch" aria-checked={reviewEnabled}
                  onClick={() => setReviewEnabled(!reviewEnabled)}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-300 ${reviewEnabled ? 'bg-green-500/40' : 'bg-white/10'}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform duration-300 ${reviewEnabled ? 'translate-x-[22px] bg-green-400' : 'translate-x-0.5 bg-purple-200/60'}`} />
                </button>
              </div>
              <button onClick={handleCreate} disabled={busy} className="w-full btn-primary py-3 disabled:opacity-50">
                创建房间
              </button>
            </div>
          </div>

          {/* 加入房间 */}
          <div className="card-glass-elevated p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/30 to-indigo-500/15 flex items-center justify-center border border-blue-500/25">
                <KeyRound className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-purple-100">加入房间</h3>
                <p className="text-xs text-purple-200/40">输入房间码加入，对局进行中会进入观战</p>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-purple-200/50 mb-2">你的昵称</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="输入昵称..." />
              </div>
              <div>
                <label className="block text-sm text-purple-200/50 mb-2">房间码</label>
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                  className="input-field font-mono tracking-[0.4em] text-center text-lg"
                  placeholder="ABC12"
                  maxLength={5}
                />
              </div>
              <div>
                <label className="block text-sm text-purple-200/50 mb-2">
                  进入令牌 <span className="text-purple-200/30">（向房主索要）</span>
                </label>
                <input
                  type="text"
                  value={joinToken}
                  onChange={(e) => setJoinToken(e.target.value.trim())}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                  className="input-field font-mono text-center"
                  placeholder="建房后由房主分享的令牌"
                  autoComplete="off"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  role="switch" aria-checked={spectate}
                  onClick={() => setSpectate(!spectate)}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-300 ${spectate ? 'bg-blue-500/40' : 'bg-white/10'}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform duration-300 ${spectate ? 'translate-x-[22px] bg-blue-400' : 'translate-x-0.5 bg-purple-200/60'}`} />
                </button>
                <span className="text-sm text-purple-200/50 flex items-center gap-1.5"><Eye className="w-4 h-4" /> 以观战身份进入</span>
              </div>
              <button onClick={handleJoin} disabled={busy || !joinCode.trim()} className="w-full btn-primary py-3 disabled:opacity-50">
                加入房间
              </button>
            </div>
          </div>
        </div>

        {/* 斗蛐蛐 */}
        <div className="card-glass p-6 mt-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-500/30 to-amber-500/15 flex items-center justify-center border border-yellow-500/25">
                <Bot className="w-5 h-5 text-yellow-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-purple-100">斗蛐蛐模式（AI 自跑观战）</h3>
                <p className="text-xs text-purple-200/40 mt-0.5">服务端自动开一局 12 人纯 AI 局，全程自动打完并生成复盘存档，可实时观战</p>
              </div>
            </div>
            <button onClick={handleQuickAuto} disabled={busy} className="btn-primary flex items-center gap-2 disabled:opacity-50">
              <Zap className="w-4 h-4" /> 一键开一局
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-6 p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-sm flex items-start gap-2">
            <X className="w-4 h-4 mt-0.5" /> {error}
          </div>
        )}

        <p className="mt-8 text-center text-xs text-purple-200/30">
          服务端命令：<code className="text-cyan-400/70">npm run server</code>；AI 中转配置读取 test-ai-config.json
        </p>
      </div>
    </div>
  );
};
