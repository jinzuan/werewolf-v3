import { useState } from 'react';
import { Users, Clock, Play, Crown, User, Unlock, Lock } from 'lucide-react';
import type { Room } from '../types';

interface RoomCardProps {
  room: Room;
  onJoin: (roomId: string, asHost: boolean) => void;
}

export const RoomCard = ({ room, onJoin }: RoomCardProps) => {
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const getStatusColor = (status: Room['status']) => {
    switch (status) {
      case 'waiting':
        return { bg: 'bg-gradient-to-r from-green-400 to-emerald-500', shadow: 'shadow-green-400/50', text: 'text-green-400', border: 'border-green-500/30' };
      case 'playing':
        return { bg: 'bg-gradient-to-r from-red-400 to-rose-500', shadow: 'shadow-red-400/50', text: 'text-red-400', border: 'border-red-500/30' };
      case 'ended':
        return { bg: 'bg-gradient-to-r from-gray-400 to-gray-500', shadow: 'shadow-gray-400/50', text: 'text-gray-400', border: 'border-gray-500/30' };
      default:
        return { bg: 'bg-gradient-to-r from-gray-400 to-gray-500', shadow: 'shadow-gray-400/50', text: 'text-gray-400', border: 'border-gray-500/30' };
    }
  };

  const getStatusText = (status: Room['status']) => {
    switch (status) {
      case 'waiting':
        return '等待中';
      case 'playing':
        return '游戏中';
      case 'ended':
        return '已结束';
      default:
        return '未知';
    }
  };

  const createdAt = new Date(room.createdAt);
  const timeAgo = Math.floor((Date.now() - createdAt.getTime()) / 60000);

  const handleJoin = (asHost: boolean) => {
    onJoin(room.id, asHost);
    setShowJoinModal(false);
  };

  const statusColor = getStatusColor(room.status);
  const canJoin = room.status === 'waiting';

  return (
    <>
      <div 
        className="card-glass p-6 group relative overflow-hidden perspective-hover"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div 
          className={`absolute inset-0 bg-gradient-to-br from-wolf-purple/10 to-transparent opacity-0 transition-opacity duration-500 ${
            isHovered ? 'opacity-100' : ''
          }`} 
        />

        <div className="flex items-start justify-between mb-5 relative z-10">
          <div className="flex-1">
            <h3 className="text-xl font-bold text-wolf-text group-hover:text-gradient transition-all duration-300 line-clamp-1">
              {room.name}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <span className={`w-3 h-3 rounded-full ${statusColor.bg} shadow-lg ${statusColor.shadow} ${room.status === 'waiting' ? 'animate-pulse' : ''}`} />
            </div>
            <span className={`text-sm font-medium ${statusColor.text}`}>
              {getStatusText(room.status)}
            </span>
          </div>
        </div>

        <div className="space-y-4 relative z-10">
          <div className="flex items-center gap-3 text-sm">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 ${
              isHovered ? 'bg-gradient-to-br from-wolf-purple/35 to-wolf-purple-light/25 scale-110' : 'bg-white/8'
            }`}>
              <Users className={`w-5 h-5 transition-colors duration-300 ${isHovered ? 'text-wolf-purple-light' : 'text-wolf-text/60'}`} />
            </div>
            <div>
              <p className="text-wolf-text/50">玩家人数</p>
              <p className="text-wolf-text font-semibold">
                {room.currentPlayers}
                <span className="text-wolf-text/40">/</span>
                {room.maxPlayers}
                {room.aiPlayerCount > 0 && (
                  <span className="text-blue-400 ml-1 font-medium">({room.aiPlayerCount} AI)</span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 ${
              isHovered ? 'bg-gradient-to-br from-wolf-purple/35 to-wolf-purple-light/25 scale-110' : 'bg-white/8'
            }`}>
              <Clock className={`w-5 h-5 transition-colors duration-300 ${isHovered ? 'text-wolf-purple-light' : 'text-wolf-text/60'}`} />
            </div>
            <div>
              <p className="text-wolf-text/50">创建时间</p>
              <p className="text-wolf-text font-semibold">{timeAgo} 分钟前</p>
            </div>
          </div>
        </div>

        <button
          onClick={() => canJoin && setShowJoinModal(true)}
          disabled={!canJoin}
          className={`w-full mt-5 py-3.5 rounded-xl font-semibold transition-all duration-300 flex items-center justify-center gap-2 relative overflow-hidden ${
            canJoin
              ? 'btn-primary hover:scale-[1.02] active:scale-[0.98]'
              : 'bg-white/5 text-wolf-text/30 cursor-not-allowed'
          }`}
        >
          {canJoin ? (
            <>
              <div className="absolute inset-0 bg-gradient-to-r from-wolf-purple/20 to-wolf-purple-light/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              <Play className="w-5 h-5 text-white relative z-10 group-hover:scale-110 transition-transform" />
              <span className="relative z-10">加入房间</span>
            </>
          ) : (
            <>
              <Lock className="w-5 h-5" />
              <span>无法加入</span>
            </>
          )}
        </button>
      </div>

      {showJoinModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xl flex items-center justify-center z-50 p-4">
          <div className="card-glass-elevated p-8 max-w-md w-full animate-fade-scale-in">
            <div className="text-center mb-6">
              <div className="relative inline-block mb-4">
                <div className="absolute inset-0 bg-wolf-purple/20 blur-xl rounded-full" />
                <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-wolf-purple/35 to-wolf-purple-light/25 flex items-center justify-center border border-wolf-purple/35">
                  <Unlock className="w-8 h-8 text-wolf-purple-light" />
                </div>
              </div>
              <h3 className="text-2xl font-bold bg-gradient-to-r from-white to-wolf-purple-light bg-clip-text text-transparent">
                加入房间
              </h3>
              <p className="text-wolf-text/50 mt-2">选择你的角色身份</p>
              <p className="text-sm text-wolf-text/40 mt-1">{room.name}</p>
            </div>

            <div className="space-y-4">
              <button
                onClick={() => handleJoin(true)}
                className="w-full py-4 rounded-xl border border-yellow-500/40 bg-gradient-to-br from-yellow-500/15 to-orange-500/10 hover:from-yellow-500/25 hover:to-orange-500/15 hover:border-yellow-500/60 transition-all duration-300 flex items-center justify-center gap-4 group relative overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-yellow-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <div className="relative w-12 h-12 rounded-xl bg-gradient-to-br from-yellow-400 to-orange-400 flex items-center justify-center group-hover:scale-110 group-hover:rotate-6 transition-all duration-300">
                  <Crown className="w-6 h-6 text-black" />
                </div>
                <div className="relative text-left">
                  <p className="font-semibold text-wolf-text">作为主持人加入</p>
                  <p className="text-xs text-wolf-text/50">拥有游戏控制权限</p>
                </div>
              </button>

              <button
                onClick={() => handleJoin(false)}
                className="w-full py-4 rounded-xl border border-wolf-purple/40 bg-gradient-to-br from-wolf-purple/15 to-wolf-purple-light/10 hover:from-wolf-purple/25 hover:to-wolf-purple-light/15 hover:border-wolf-purple/60 transition-all duration-300 flex items-center justify-center gap-4 group relative overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-wolf-purple/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                <div className="relative w-12 h-12 rounded-xl bg-gradient-to-br from-wolf-purple to-wolf-purple-light flex items-center justify-center group-hover:scale-110 group-hover:-rotate-6 transition-all duration-300">
                  <User className="w-6 h-6 text-white" />
                </div>
                <div className="relative text-left">
                  <p className="font-semibold text-wolf-text">作为普通玩家加入</p>
                  <p className="text-xs text-wolf-text/50">参与游戏体验</p>
                </div>
              </button>
            </div>

            <button
              onClick={() => setShowJoinModal(false)}
              className="w-full mt-6 py-3 rounded-xl bg-white/5 text-wolf-text/60 hover:text-wolf-text hover:bg-white/10 transition-all duration-300 font-medium"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </>
  );
};
