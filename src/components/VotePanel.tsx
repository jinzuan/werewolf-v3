import { Vote, CheckCircle, Users } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { PlayerCard } from './PlayerCard';

interface VotePanelProps {
  onVote: (targetId: string) => void;
  onEndVoting: () => void;
}

export const VotePanel = ({ onVote, onEndVoting }: VotePanelProps) => {
  const { players, gameState, currentUser, isHost } = useGameStore();
  const alivePlayers = players.filter((p) => p.isAlive);
  const myVote = gameState?.votes[currentUser?.id || ''];

  const getVoteCount = (playerId: string) => {
    return Object.values(gameState?.votes || {}).filter((v) => v === playerId).length;
  };

  const votePercentage = alivePlayers.length > 0 
    ? (Object.keys(gameState?.votes || {}).length / alivePlayers.length) * 100 
    : 0;

  const isVoting = gameState?.phase === 'voting';
  const canVote = currentUser && isVoting && !myVote;

  return (
    <div className="card-glass overflow-hidden">
      <div className="px-4 py-4 border-b border-wolf-purple/15 relative">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500/35 to-amber-500/25 flex items-center justify-center border border-orange-500/35">
                <Vote className="w-5 h-5 text-orange-400" />
              </div>
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-orange-400 rounded-full animate-pulse" />
            </div>
            <div>
              <h3 className="font-bold text-wolf-text text-lg">投票阶段</h3>
              <p className="text-xs text-wolf-text/50">选择要投票出局的玩家</p>
            </div>
          </div>
          {isHost && (
            <button
              onClick={onEndVoting}
              className="btn-accent text-sm px-4 py-2 hover:scale-105 active:scale-95 transition-transform duration-200"
            >
              结束投票
            </button>
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {myVote && (
          <div className="p-4 rounded-xl bg-gradient-to-br from-wolf-purple/20 to-wolf-purple-light/10 border border-wolf-purple/30 animate-slide-up">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-wolf-purple/30 flex items-center justify-center">
                <CheckCircle className="w-4 h-4 text-wolf-purple-light" />
              </div>
              <div className="flex-1">
                <p className="text-sm text-wolf-text/60">你的投票</p>
                <p className="text-wolf-purple-light font-bold">
                  {players.find((p) => p.id === myVote)?.name}
                </p>
              </div>
              <span className="text-xs text-yellow-400/70">点击其他玩家可更改</span>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {alivePlayers.map((player, index) => (
            <div 
              key={player.id} 
              className="relative animate-slide-up"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <PlayerCard
                player={player}
                isSelected={myVote === player.id}
                onSelect={canVote ? () => onVote(player.id) : undefined}
              />
              <div className="absolute top-4 right-4">
                <div className="relative">
                  <div className="bg-wolf-purple/15 backdrop-blur-sm px-3 py-1.5 rounded-full border border-wolf-purple/20 shadow-lg">
                    <div className="flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-wolf-purple-light" />
                      <span className="text-sm font-bold text-wolf-text">{getVoteCount(player.id)}</span>
                    </div>
                  </div>
                  {getVoteCount(player.id) > 0 && (
                    <div className="absolute inset-0 bg-wolf-purple/20 rounded-full animate-ping" />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 rounded-xl bg-gradient-to-br from-wolf-purple/5 to-wolf-purple-light/3 border border-wolf-purple/15">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-wolf-text/60">投票进度</span>
            <span className="text-sm font-medium text-wolf-text">
              {Object.keys(gameState?.votes || {}).length} / {alivePlayers.length}
            </span>
          </div>
          <div className="h-2 bg-white/5 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-wolf-purple to-wolf-purple-light transition-all duration-700 rounded-full relative"
              style={{ width: `${votePercentage}%` }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
