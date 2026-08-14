import type { Player } from '../types';

interface HunterShootPanelProps {
  players: Player[];
  onShoot: (targetId: string) => void;
  isHunter: boolean;
}

export const HunterShootPanel = ({ players, onShoot, isHunter }: HunterShootPanelProps) => {
  const alivePlayers = players.filter(p => p.isAlive);

  return (
    <div className="bg-gradient-to-br from-red-900/30 to-orange-900/20 rounded-2xl border border-red-500/30 p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 bg-gradient-to-br from-red-500 to-orange-500 rounded-lg flex items-center justify-center">
          <span className="text-lg">🔫</span>
        </div>
        <div>
          <h3 className="text-red-400 font-bold">猎人开枪</h3>
          <p className="text-wolf-text/60 text-sm">选择你要带走的目标</p>
        </div>
      </div>

      {isHunter ? (
        <div className="space-y-2">
          {alivePlayers.map((player) => (
            <button
              key={player.id}
              onClick={() => onShoot(player.id)}
              className="w-full p-3 bg-wolf-dark/50 hover:bg-red-500/20 border border-wolf-purple/20 hover:border-red-500/50 rounded-xl transition-all duration-300 flex items-center gap-3 group"
            >
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${
                player.isAI ? 'bg-blue-500/20' : 'bg-wolf-purple/30'
              }`}>
                {player.isAI ? '🤖' : '👤'}
              </div>
              <div className="flex-1 text-left">
                <div className="text-wolf-text font-medium">{player.name}</div>
                <div className="text-wolf-text/50 text-xs">{player.isAI ? 'AI玩家' : '人类玩家'}</div>
              </div>
              <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-red-400">开枪</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-center py-8">
          <div className="text-4xl mb-4">🔫</div>
          <p className="text-wolf-text/70">等待猎人选择开枪目标...</p>
        </div>
      )}
    </div>
  );
};