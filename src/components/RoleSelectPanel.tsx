import { useState } from 'react';
import { RefreshCw, Check, Crown, Shuffle, Eye, Sparkles } from 'lucide-react';
import { getRoleInfo, ROLES, ROLE_COLORS } from '../utils/roleConfig';
import type { Player, Role } from '../types';

interface RoleSelectPanelProps {
  players: Player[];
  isHost: boolean;
  currentUser: { id: string; name: string } | null;
  onRedraw: () => void;
  onConfirm: () => void;
  onForceAssign: (playerId: string, role: Role) => void;
  onReassignAll: () => void;
  remainingRedraws: number;
}

export const RoleSelectPanel = ({
  players,
  isHost,
  currentUser,
  onRedraw,
  onConfirm,
  onForceAssign,
  onReassignAll,
  remainingRedraws,
}: RoleSelectPanelProps) => {
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [showForceAssign, setShowForceAssign] = useState(false);
  const [showAllRoles, setShowAllRoles] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  const myPlayer =
    players.find((p) => p.id === currentUser?.id) ??
    players.find((p) => p.name === currentUser?.name) ??
    players.find((p) => p.isHost);
  const selectedPlayer = selectedPlayerId ? players.find((p) => p.id === selectedPlayerId) : null;

  const handleForceAssign = (role: Role) => {
    if (selectedPlayerId) {
      onForceAssign(selectedPlayerId, role);
      setShowForceAssign(false);
      setSelectedPlayerId(null);
    }
  };

  const handleRedraw = () => {
    setIsDrawing(true);
    setTimeout(() => {
      onRedraw();
      setIsDrawing(false);
    }, 500);
  };

  return (
    <div className="card-glass p-6 animate-fade-in">
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(234,179,8,0.15)', border: '1px solid rgba(234,179,8,0.25)' }}>
            <Sparkles className="w-5 h-5 text-yellow-400" />
          </div>
          <h3 className="text-xl font-bold text-purple-100">角色抽取</h3>
        </div>

        {isHost && (
          <div className="flex items-center gap-2">
            {/* 查看所有人身份 */}
            <button
              onClick={() => setShowAllRoles(!showAllRoles)}
              className={`p-2.5 rounded-xl transition-all duration-300 border ${
                showAllRoles
                  ? 'bg-green-600/20 text-green-400 scale-105 border-green-500/30'
                  : 'hover:bg-white/5 text-purple-200/50 border-white/5'
              }`}
              title="查看所有人身份"
            >
              <Eye className="w-5 h-5" />
            </button>

            {/* 指定角色 */}
            <button
              onClick={() => setShowForceAssign(!showForceAssign)}
              className={`p-2.5 rounded-xl transition-all duration-300 border ${
                showForceAssign
                  ? 'bg-yellow-600/20 text-yellow-400 scale-105 border-yellow-500/30'
                  : 'hover:bg-white/5 text-purple-200/50 border-white/5'
              }`}
              title="指定角色（主持人特权）"
            >
              <Crown className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>

      {/* 主持人：查看所有身份 */}
      {showAllRoles && isHost && (
        <div className="mb-6 p-4 rounded-xl animate-fade-in" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Eye className="w-4 h-4 text-green-400" />
            <p className="text-sm text-green-400 font-medium">主持人视角 — 所有玩家身份</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {players.map((player) => {
              const roleInfo = player.role ? getRoleInfo(player.role) : null;
              return (
                <div key={player.id} className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <span className="text-purple-100 font-medium text-sm">{player.name}</span>
                  {roleInfo && (
                    <span className={`flex items-center gap-1 text-sm ${ROLE_COLORS[roleInfo.role]}`}>
                      <span>{roleInfo.icon}</span>
                      <span>{roleInfo.name}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <button
            onClick={() => setShowAllRoles(false)}
            className="mt-3 text-xs text-purple-200/30 hover:text-purple-200/60 transition-colors"
          >
            关闭
          </button>
        </div>
      )}

      {/* 主持人：指定角色 */}
      {showForceAssign && isHost && (
        <div className="mb-6 p-4 rounded-xl animate-fade-in" style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.15)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Crown className="w-4 h-4 text-yellow-400" />
            <p className="text-sm text-yellow-400 font-medium">指定角色</p>
          </div>
          <p className="text-sm text-purple-200/40 mb-3">选择要指定角色的玩家：</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {players.map((player) => (
              <button
                key={player.id}
                onClick={() => setSelectedPlayerId(player.id)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300 border ${
                  selectedPlayerId === player.id
                    ? 'bg-yellow-600/25 text-white scale-105 border-yellow-500/40'
                    : 'bg-white/[0.03] text-purple-200/60 hover:bg-white/10 border-white/5'
                }`}
              >
                {player.name}
              </button>
            ))}
          </div>

          {selectedPlayer && (
            <div>
              <p className="text-sm text-purple-200/40 mb-2">为 <span className="text-purple-100">{selectedPlayer.name}</span> 指定角色：</p>
              <div className="flex flex-wrap gap-2">
                {ROLES.map((roleInfo) => (
                  <button
                    key={roleInfo.role}
                    onClick={() => handleForceAssign(roleInfo.role)}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.03] text-purple-200/60 hover:bg-white/10 hover:scale-105 transition-all duration-300 border border-white/5 text-sm"
                  >
                    <span className="text-lg">{roleInfo.icon}</span>
                    <span>{roleInfo.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => { setShowForceAssign(false); setSelectedPlayerId(null); }}
            className="mt-4 text-xs text-purple-200/30 hover:text-purple-200/60 transition-colors"
          >
            取消
          </button>
        </div>
      )}

      {/* 我的角色展示 */}
      <div className="mb-6">
        <p className="text-center text-purple-200/30 text-sm mb-4">你的身份</p>

        {myPlayer?.role ? (
          <div className="flex justify-center">
            <div
              className={`relative p-8 rounded-2xl transition-all duration-500 w-full max-w-sm ${
                isDrawing ? 'animate-pulse scale-95' : ''
              }`}
              style={{
                background: 'linear-gradient(135deg, rgba(139,92,246,0.15) 0%, rgba(139,92,246,0.06) 100%)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(139,92,246,0.25)',
                boxShadow: '0 8px 40px rgba(0,0,0,0.2), inset 0 1px 0 rgba(139,92,246,0.1)',
              }}
            >
              {/* 顶部光晕 */}
              <div className="absolute top-0 left-0 right-0 h-16 rounded-t-2xl pointer-events-none" style={{ background: 'linear-gradient(to bottom, rgba(139,92,246,0.08), transparent)' }} />

              <div className="relative text-center">
                <div className={`text-7xl mb-4 ${ROLE_COLORS[myPlayer.role]}`} style={{ animation: 'float-gentle 4s ease-in-out infinite', animationDuration: '2s' }}>
                  {getRoleInfo(myPlayer.role).icon}
                </div>
                <h2 className={`text-2xl font-bold mb-2 ${ROLE_COLORS[myPlayer.role]}`}>
                  {getRoleInfo(myPlayer.role).name}
                </h2>
                <p className="text-purple-200/50 text-sm leading-relaxed">
                  {getRoleInfo(myPlayer.role).description}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex justify-center">
            <div className="p-8 rounded-2xl w-full max-w-sm" style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.04)' }}>
              <div className="text-center">
                <div className="text-6xl mb-4 text-purple-200/15">❓</div>
                <p className="text-purple-200/30 text-sm">
                  {!currentUser ? '请先设置昵称' : !myPlayer ? '无法找到你的信息' : '正在分配身份...'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 重新抽卡按钮 */}
      {remainingRedraws > 0 && (
        <div className="flex justify-center mt-6">
          <button
            onClick={handleRedraw}
            disabled={isDrawing}
            className="btn-secondary flex items-center gap-2 px-6 py-3 text-base disabled:opacity-40 disabled:cursor-not-allowed hover:scale-105 transition-transform duration-300"
          >
            <RefreshCw className={`w-5 h-5 ${isDrawing ? 'animate-spin' : ''}`} />
            重新抽取（剩余 {remainingRedraws} 次）
          </button>
        </div>
      )}

      {remainingRedraws === 0 && myPlayer?.role && (
        <p className="text-center text-purple-200/25 text-sm mt-4">已用完重新抽取机会</p>
      )}

      {/* 其他玩家（隐藏身份） */}
      <div className="mt-8 pt-6" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        <p className="text-sm text-purple-200/25 mb-4">其他玩家身份（隐藏）</p>
        <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
          {players.filter((p) => p.id !== currentUser?.id).map((player) => (
            <div
              key={player.id}
              className="p-3 rounded-xl text-center transition-all duration-300"
              style={{
                background: player.isAI ? 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(37,99,235,0.03))' : 'rgba(255,255,255,0.015)',
                border: player.isAI ? '1px solid rgba(59,130,246,0.12)' : '1px solid rgba(255,255,255,0.04)',
              }}
            >
              <div className="text-2xl mb-1 text-purple-200/15">❓</div>
              <p className="text-xs text-purple-200/40 truncate">{player.name}</p>
              {player.isAI && <span className="text-[10px] text-blue-400/50">AI</span>}
            </div>
          ))}
        </div>
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between mt-8 pt-6" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        {isHost && remainingRedraws > 0 && (
          <button
            onClick={onReassignAll}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            <Shuffle className="w-4 h-4" />
            全员重新抽卡
          </button>
        )}

        <button
          onClick={onConfirm}
          className="btn-primary flex items-center gap-2 px-6 py-2.5 text-base"
        >
          <Check className="w-5 h-5" />
          确认身份，开始游戏
        </button>
      </div>

      <p className="text-[11px] text-purple-200/20 text-center mt-4">
        {isHost ? '👁️ 查看身份  |  👑 指定角色' : '点击「重新抽取」更换角色'}
      </p>
    </div>
  );
};
