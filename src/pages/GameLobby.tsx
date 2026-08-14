import { useState } from 'react';
import { Plus, Users, Sparkles, Zap, Gamepad2, UsersRound, X, Gamepad, Bot, Globe, History } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { RoomCard } from '../components/RoomCard';
import { generateRoomId, createPlayer } from '../utils/gameLogic';
import type { Room, Player } from '../types';
import { AI_DEFAULTS } from '../../shared/config/aiDefaults';

interface GameLobbyProps {
  onNavigate: (path: string) => void;
}

const AI_NAMES = ['小明', '小红', '大壮', '小美', '老王', '小李', '阿强', '小芳'];

export const GameLobby = ({ onNavigate }: GameLobbyProps) => {
  const { rooms, setRooms, setCurrentRoom, setPlayers, setIsHost, setMyRole, currentUser, setCurrentUser, aiConfig, hunterShootOnGuardHealDeath, setHunterShootOnGuardHealDeath } = useGameStore();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [playerCount, setPlayerCount] = useState(6);
  const [aiCount, setAiCount] = useState(5);
  const [userName, setUserName] = useState('');
  const [showNameModal, setShowNameModal] = useState(!currentUser);

  /* ---- 创建房间 ---- */
  const createRoom = () => {
    if (!roomName.trim() || playerCount < 4 || playerCount > 12 || !currentUser) return;

    const room: Room = {
      id: generateRoomId(),
      name: roomName.trim(),
      maxPlayers: playerCount,
      currentPlayers: 1 + aiCount,
      status: 'waiting',
      hostId: generateRoomId(),
      createdAt: new Date(),
      aiPlayerCount: aiCount,
      settings: {
        hunterShootOnGuardHealDeath,
      },
    };

    const hostPlayer = { ...createPlayer(room.id, currentUser.name, false, true, 0), isReady: true };

    const behaviors: Array<'aggressive' | 'conservative' | 'random'> = ['aggressive', 'conservative', 'random'];
    const config = {
      ...AI_DEFAULTS,
      ...aiConfig,
      siliconflow: { ...AI_DEFAULTS.siliconflow, ...aiConfig?.siliconflow },
      deepseek: { ...AI_DEFAULTS.deepseek, ...aiConfig?.deepseek },
      local: { ...AI_DEFAULTS.local, ...aiConfig?.local },
    };

    const aiPlayers: Player[] = [];
    for (let i = 0; i < aiCount; i++) {
      aiPlayers.push({
        ...createPlayer(room.id, AI_NAMES[i % AI_NAMES.length], true, false, i + 1),
        isReady: true,
        aiConfig: {
          model: config.apiType === 'siliconflow' ? config.siliconflow.model : config.apiType === 'deepseek' ? config.deepseek.model : config.local.model,
          temperature: (config.apiType === 'siliconflow' ? config.siliconflow.temperature : config.apiType === 'deepseek' ? config.deepseek.temperature : config.local.temperature) + (Math.random() - 0.5) * 0.2,
          maxTokens: config.apiType === 'siliconflow' ? config.siliconflow.maxTokens : config.apiType === 'deepseek' ? config.deepseek.maxTokens : config.local.maxTokens,
          behavior: behaviors[i % behaviors.length],
        },
      });
    }

    setRooms([room, ...rooms]);
    setCurrentRoom(room);
    setPlayers([hostPlayer, ...aiPlayers]);
    setIsHost(true);
    setMyRole(null);
    setShowCreateModal(false);
    onNavigate(`/room/${room.id}`);
  };

  /* ---- 和 AI 游玩：一键快速开局（真人 + 11 名 AI，12 人标准板子） ---- */
  const quickStart = () => {
    if (!currentUser) return;
    setRoomName('与 AI 对局');
    setPlayerCount(12);
    setAiCount(11);
    // 等待状态更新后复用 createRoom（直接构造房间）
    const room: Room = {
      id: generateRoomId(),
      name: '与 AI 对局',
      maxPlayers: 12,
      currentPlayers: 12,
      status: 'waiting',
      hostId: generateRoomId(),
      createdAt: new Date(),
      aiPlayerCount: 11,
      settings: { hunterShootOnGuardHealDeath },
    };
    const hostPlayer = { ...createPlayer(room.id, currentUser.name, false, true, 0), isReady: true };
    const behaviors: Array<'aggressive' | 'conservative' | 'random'> = ['aggressive', 'conservative', 'random'];
    const config = {
      apiType: aiConfig?.apiType || AI_DEFAULTS.apiType,
      siliconflow: { ...AI_DEFAULTS.siliconflow, ...aiConfig?.siliconflow },
      deepseek: { ...AI_DEFAULTS.deepseek, ...aiConfig?.deepseek },
      local: { ...AI_DEFAULTS.local, ...aiConfig?.local },
    };
    const aiPlayers: Player[] = [];
    for (let i = 0; i < 11; i++) {
      aiPlayers.push({
        ...createPlayer(room.id, AI_NAMES[i % AI_NAMES.length], true, false, i + 1),
        isReady: true,
        aiConfig: {
          model: config.apiType === 'siliconflow' ? config.siliconflow.model : config.apiType === 'deepseek' ? config.deepseek.model : config.local.model,
          temperature: (config.apiType === 'siliconflow' ? config.siliconflow.temperature : config.apiType === 'deepseek' ? config.deepseek.temperature : config.local.temperature) + (Math.random() - 0.5) * 0.2,
          maxTokens: config.apiType === 'siliconflow' ? config.siliconflow.maxTokens : config.apiType === 'deepseek' ? config.deepseek.maxTokens : config.local.maxTokens,
          behavior: behaviors[i % behaviors.length],
        },
      });
    }
    setRooms([room, ...rooms]);
    setCurrentRoom(room);
    setPlayers([hostPlayer, ...aiPlayers]);
    setIsHost(true);
    setMyRole(null);
    onNavigate(`/room/${room.id}`);
  };

  /* ---- 加入房间 ---- */
  const joinRoom = (roomId: string, asHost: boolean = false) => {
    const room = rooms.find((r) => r.id === roomId);
    if (!room || room.status !== 'waiting' || !currentUser) return;

    room.currentPlayers += 1;
    setRooms(rooms.map((r) => (r.id === roomId ? room : r)));

    const player = createPlayer(room.id, currentUser.name, false, asHost, room.currentPlayers);
    player.id = currentUser.id;
    setCurrentRoom(room);
    setPlayers([player]);
    setIsHost(asHost);
    setMyRole(null);
    onNavigate(`/room/${roomId}`);
  };

  /* ---- 设置用户名 ---- */
  const handleSetUserName = () => {
    if (userName.trim()) {
      setCurrentUser({ id: generateRoomId(), name: userName.trim() });
      setShowNameModal(false);
    }
  };

  /* ========================
     昵称输入模态框
     ======================== */
  if (showNameModal) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
        {/* 背景光晕 */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-[20%] left-[15%] w-80 h-80 bg-purple-700/8 rounded-full blur-3xl animate-breath" />
          <div className="absolute bottom-[15%] right-[10%] w-96 h-96 bg-purple-600/5 rounded-full blur-3xl animate-breath [animation-delay:1000ms]" />
        </div>

        <div className="card-glass-elevated w-full max-w-md p-8 relative z-10 animate-fade-in">
          {/* 标题区 */}
          <div className="text-center mb-8">
            <div className="relative inline-block mb-6">
              <div className="absolute inset-[-8px] bg-purple-600/20 rounded-2xl blur-2xl animate-pulse-glow" />
              <div
                className="relative w-20 h-20 rounded-2xl flex items-center justify-center text-4xl"
                style={{
                  background: 'linear-gradient(135deg, rgba(139,92,246,0.35), rgba(168,85,247,0.18))',
                  border: '1px solid rgba(139,92,246,0.35)',
                  boxShadow: '0 0 40px rgba(139,92,246,0.18)',
                }}
              >
                🐺
              </div>
            </div>
            <h2 className="text-2xl font-bold text-gradient mb-1">狼人杀 · AI 对局</h2>
            <p className="text-sm text-purple-200/40">输入昵称，开始你的推理之旅</p>
          </div>

          {/* 输入区 */}
          <div className="space-y-5">
            <div>
              <label className="block text-sm text-purple-200/50 mb-2">你的昵称</label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSetUserName()}
                placeholder="输入昵称..."
                className="input-field text-lg"
                autoFocus
              />
            </div>
            <button
              onClick={handleSetUserName}
              disabled={!userName.trim()}
              className="w-full btn-primary text-lg py-4 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:active:scale-100 transition-transform duration-300"
            >
              进入大厅
            </button>
          </div>

          {/* 特性标签 */}
          <div className="mt-8 flex items-center justify-center gap-5">
            {[
              { icon: Zap, label: 'AI 驱动', color: 'text-purple-300/60' },
              { icon: Gamepad2, label: '多人对战', color: 'text-purple-300/60' },
              { icon: Bot, label: '智能 AI', color: 'text-blue-400/60' },
            ].map(({ icon: Icon, label, color }) => (
              <div key={label} className="flex items-center gap-1.5 text-xs text-purple-200/35">
                <Icon className={`w-3.5 h-3.5 ${color}`} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ========================
     大厅主界面
     ======================== */
  return (
    <div className="min-h-screen p-4 md:p-8 relative overflow-hidden">

      {/* 背景装饰 */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-16 left-8 w-72 h-72 bg-purple-700/6 rounded-full blur-3xl" />
        <div className="absolute bottom-16 right-8 w-96 h-96 bg-purple-600/4 rounded-full blur-3xl" />
        <div className="absolute top-[45%] left-[30%] w-60 h-60 bg-purple-800/3 rounded-full blur-3xl" />
      </div>

      <div className="max-w-6xl mx-auto relative z-10">

        {/* 顶部栏 */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl md:text-3xl font-bold text-gradient">游戏大厅</h2>
            <p className="text-sm text-purple-200/40 mt-1">选择房间加入，或创建新房间开始游戏</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('/reviews')}
              className="btn-secondary flex items-center gap-2 hover:scale-[1.03] active:scale-[0.97] transition-transform duration-300"
              title="查看联机对局复盘存档"
            >
              <History className="w-5 h-5" />
              <span className="hidden sm:inline">复盘回看</span>
            </button>
            <button
              onClick={() => onNavigate('/online')}
              className="btn-secondary flex items-center gap-2 hover:scale-[1.03] active:scale-[0.97] transition-transform duration-300 border-green-500/30 text-green-300"
              title="双浏览器 / 手机+电脑同房，AI 服务端托管"
            >
              <Globe className="w-5 h-5" />
              <span className="hidden sm:inline">联机对战</span>
            </button>
            <button
              onClick={quickStart}
              className="btn-secondary flex items-center gap-2 hover:scale-[1.03] active:scale-[0.97] transition-transform duration-300"
              title="真人 + 11 名 AI，标准 12 人局快速开局"
            >
              <Gamepad className="w-5 h-5" />
              <span className="hidden sm:inline">和 AI 游玩</span>
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="btn-primary flex items-center gap-2 hover:scale-[1.03] active:scale-[0.97] transition-transform duration-300"
            >
              <Plus className="w-5 h-5" />
              <span className="hidden sm:inline">创建房间</span>
            </button>
          </div>
        </div>

        {/* 房间列表 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
          {rooms.length === 0 ? (
            <div className="col-span-full text-center py-20 animate-fade-in">
              <div className="relative inline-block mb-6">
                <div className="absolute inset-0 bg-purple-600/10 rounded-3xl blur-2xl" />
                <div className="relative w-32 h-32 card-glass rounded-3xl flex items-center justify-center">
                  <UsersRound className="w-14 h-14 text-purple-300/30" />
                </div>
              </div>
              <h3 className="text-xl font-semibold text-purple-100/60 mb-2">暂无房间</h3>
              <p className="text-purple-200/30 text-sm">点击右上角按钮创建新房间</p>
            </div>
          ) : (
            rooms.map((room, index) => (
              <div
                key={room.id}
                className="animate-fade-in"
                style={{ animationDelay: `${index * 80}ms` }}
              >
                <RoomCard room={room} onJoin={joinRoom} />
              </div>
            ))
          )}
        </div>

        {/* 功能说明卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              icon: Sparkles,
              title: 'AI 智能对手',
              desc: '与不同性格的 AI 玩家进行精彩对决',
              gradient: 'from-blue-500/30 to-cyan-500/10',
              border: 'border-blue-500/25',
              iconColor: 'text-blue-400',
            },
            {
              icon: Users,
              title: '多人在线',
              desc: '支持 4–12 人同时游戏，邀请好友一起玩',
              gradient: 'from-green-500/30 to-emerald-500/10',
              border: 'border-green-500/25',
              iconColor: 'text-green-400',
            },
            {
              icon: Zap,
              title: '快速开始',
              desc: '一键创建房间，AI 自动补齐玩家',
              gradient: 'from-purple-500/30 to-violet-500/10',
              border: 'border-purple-500/25',
              iconColor: 'text-purple-300',
            },
          ].map(({ icon: Icon, title, desc, gradient, border, iconColor }) => (
            <div
              key={title}
              className={`
                group card-glass p-5 flex items-start gap-4
                hover:scale-[1.02] active:scale-[0.98]
                transition-transform duration-300
              `}
            >
              <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${gradient} border ${border} flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform duration-300`}>
                <Icon className={`w-5 h-5 ${iconColor}`} />
              </div>
              <div>
                <h4 className="font-semibold text-purple-100/80 mb-1">{title}</h4>
                <p className="text-xs text-purple-200/35 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* 页脚署名 */}
        <footer className="text-center text-xs text-purple-200/30 mt-10 pb-2">
          作者/贡献：Trae（AI）、opencode（AI）、苏达（AI）、雲鵺（AI）、金钻、空枝
        </footer>

      </div>

      {/* ========================
          创建房间模态框
         ======================== */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setShowCreateModal(false)}
        >
          {/* 背景遮罩 */}
          <div
            className="absolute inset-0"
            style={{
              background: 'radial-gradient(ellipse at center, rgba(15,10,30,0.88), rgba(0,0,0,0.95))',
              backdropFilter: 'blur(12px)',
            }}
          />

          <div
            className="relative w-full max-w-lg card-glass-elevated p-6 animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 标题 */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600/40 to-purple-500/20 flex items-center justify-center border border-purple-500/30">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-purple-100">创建房间</h3>
                  <p className="text-xs text-purple-200/40">设置游戏房间参数</p>
                </div>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors duration-200"
              >
                <X className="w-4 h-4 text-purple-200/40 hover:text-red-400 transition-colors" />
              </button>
            </div>

            <div className="space-y-5">
              {/* 房间名 */}
              <div>
                <label className="block text-sm text-purple-200/50 mb-2">房间名称</label>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="输入房间名称..."
                  className="input-field"
                />
              </div>

              {/* 总玩家数 */}
              <div>
                <label className="block text-sm text-purple-200/50 mb-2">
                  总玩家数：<span className="text-purple-300 font-medium">{playerCount}</span>
                </label>
                <input
                  type="range"
                  min={4}
                  max={12}
                  value={playerCount}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setPlayerCount(v);
                    setAiCount(Math.min(aiCount, v - 1));
                  }}
                  className="w-full accent-purple-500"
                />
                <div className="flex justify-between text-[10px] text-purple-200/25 mt-1">
                  <span>4 人</span>
                  <span>12 人</span>
                </div>
              </div>

              {/* AI 玩家数 */}
              <div>
                <label className="block text-sm text-purple-200/50 mb-2">
                  AI 玩家数：<span className="text-blue-400 font-medium">{aiCount}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, playerCount - 1)}
                  value={aiCount}
                  onChange={(e) => setAiCount(Math.min(Number(e.target.value), playerCount - 1))}
                  className="w-full accent-blue-500"
                />
                <div className="flex justify-between text-[10px] text-purple-200/25 mt-1">
                  <span>0</span>
                  <span>最多 {playerCount - 1} 人</span>
                </div>
              </div>

              {/* 猎人同守同救开枪 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm text-purple-200/50">猎人同守同救致死可开枪</label>
                  <span className={`text-xs font-medium ${hunterShootOnGuardHealDeath ? 'text-green-400' : 'text-purple-200/35'}`}>
                    {hunterShootOnGuardHealDeath ? '开启' : '关闭'}
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hunterShootOnGuardHealDeath}
                  onClick={() => setHunterShootOnGuardHealDeath(!hunterShootOnGuardHealDeath)}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-300 ${
                    hunterShootOnGuardHealDeath ? 'bg-green-500/40' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform duration-300 ${
                      hunterShootOnGuardHealDeath ? 'translate-x-[22px] bg-green-400' : 'translate-x-0.5 bg-purple-200/60'
                    }`}
                  />
                </button>
                <p className="text-[10px] text-purple-200/25 mt-1.5">关闭后，猎人在"被刀+同守同救"致死时无法开枪</p>
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 btn-secondary"
                >
                  取消
                </button>
                <button
                  onClick={createRoom}
                  disabled={!roomName.trim() || playerCount < 4}
                  className="flex-1 btn-primary disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:active:scale-100"
                >
                  创建房间
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
