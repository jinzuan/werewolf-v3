import { Users, Vote } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';

interface VoteResultPanelProps {
  visible?: boolean;
}

export const VoteResultPanel = ({ visible }: VoteResultPanelProps) => {
  const { gameState, players } = useGameStore();
  
  if (!visible || !gameState) return null;
  
  const votes = gameState.votes;
  
  // 统计投票结果
  const voteCounts: Record<string, number> = {};
  Object.values(votes).forEach(targetId => {
    if (targetId) {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
  });
  
  // 按票数降序排序
  const sortedResults = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
  
  const getPlayerName = (id: string) => {
    return players.find(p => p.id === id)?.name || '未知';
  };
  
  if (sortedResults.length === 0) {
    return (
      <div className="card-glass p-4">
        <div className="flex items-center gap-2 mb-3">
          <Vote className="w-5 h-5 text-orange-400" />
          <h3 className="font-semibold text-wolf-text">投票结果</h3>
        </div>
        <p className="text-sm text-wolf-text/50">暂无投票记录</p>
      </div>
    );
  }
  
  return (
    <div className="card-glass p-4 animate-fade-scale-in">
      <div className="flex items-center gap-2 mb-3">
        <Vote className="w-5 h-5 text-orange-400" />
        <h3 className="font-semibold text-wolf-text">投票结果</h3>
      </div>
      
      <div className="space-y-2">
        {sortedResults.map(([targetId, count], index) => (
          <div 
            key={targetId}
            className={`p-3 rounded-xl transition-all ${
              index === 0 
                ? 'bg-gradient-to-r from-orange-500/20 to-red-500/10 border border-orange-500/30' 
                : 'bg-wolf-purple/5 border border-wolf-purple/15'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`text-lg ${index === 0 ? 'text-orange-400 font-bold' : 'text-wolf-text'}`}>
                  {getPlayerName(targetId)}
                </span>
                {index === 0 && (
                  <span className="px-2 py-0.5 text-xs bg-orange-500/30 text-orange-300 rounded-full">
                    最高票
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Users className="w-3.5 h-3.5 text-wolf-text/50" />
                <span className="text-sm font-medium text-wolf-text">{count}票</span>
              </div>
            </div>
            
            {/* 投票进度条 */}
            <div className="h-2 bg-white/5 rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full transition-all duration-500 ${
                  index === 0 ? 'bg-gradient-to-r from-orange-500 to-red-500' : 'bg-gradient-to-r from-wolf-purple to-wolf-purple-light'
                }`}
                style={{ 
                  width: `${Math.min((count / Object.keys(votes).length) * 100, 100)}%` 
                }}
              />
            </div>
            
            {/* 投票人列表 */}
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(votes)
                .filter(([, votedId]) => votedId === targetId)
                .map(([voterId]) => (
                  <span 
                    key={voterId}
                    className="px-2 py-0.5 text-xs bg-white/[0.03] text-wolf-text/60 rounded-full"
                  >
                    {getPlayerName(voterId)}
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
