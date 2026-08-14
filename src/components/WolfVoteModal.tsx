import { useState } from 'react';
import { Vote, Zap, X, SkipForward } from 'lucide-react';
import type { Player } from '../types';
import { useGameStore } from '../stores/gameStore';

interface WolfVoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onExecuteKill: (targetId: string) => void;
  wolfPlayers: Player[];
  targetPlayers: Player[];
}

export const WolfVoteModal = ({
  isOpen,
  onClose,
  onExecuteKill,
  wolfPlayers,
  targetPlayers,
}: WolfVoteModalProps) => {
  const { wolfDiscussionRound, currentUser } = useGameStore();
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  
  const hasHumanWolf = wolfPlayers.some(p => !p.isAI);
  const humanWolf = wolfPlayers.find(p => !p.isAI);

  const handleSelectTarget = (targetId: string) => {
    setSelectedTarget(targetId);
  };

  const handleExecuteKill = () => {
    if (selectedTarget) {
      onExecuteKill(selectedTarget);
      setSelectedTarget(null);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xl flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-xl animate-fade-scale-in">
        <div className="rounded-3xl overflow-hidden" style={{
          background: 'linear-gradient(135deg, rgba(220, 38, 38, 0.15) 0%, rgba(153, 27, 27, 0.08) 50%, rgba(127, 29, 29, 0.12) 100%)',
          backdropFilter: 'blur(24px)',
          border: '1px solid rgba(220, 38, 38, 0.2)',
          boxShadow: '0 25px 80px rgba(0,0,0,0.4), 0 0 60px rgba(220, 38, 38, 0.1)',
        }}>
          <div className="px-6 py-4 border-b border-red-500/20 relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="absolute inset-0 bg-red-500/20 blur-xl rounded-xl" />
                  <div className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-red-500/30 to-rose-500/20 flex items-center justify-center border border-red-500/30">
                    <Vote className="w-5 h-5 text-red-400" />
                  </div>
                </div>
                <div>
                  <h3 className="text-xl font-bold bg-gradient-to-r from-white to-red-300 bg-clip-text text-transparent">
                    狼人投票
                  </h3>
                  <p className="text-xs text-wolf-text/50">讨论第 {wolfDiscussionRound} 轮</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl hover:bg-white/10 transition-all group"
              >
                <X className="w-5 h-5 text-wolf-text/60 group-hover:text-white transition-colors" />
              </button>
            </div>
          </div>

          <div className="p-6 space-y-6">
            {hasHumanWolf && (
              <div className="p-3 rounded-xl bg-gradient-to-r from-yellow-500/20 to-amber-500/10 border border-yellow-500/20">
                <div className="flex items-center gap-2 text-yellow-400 text-sm">
                  <span>👤</span>
                  <span>只有真实玩家 <strong>{humanWolf?.name}</strong> 有投票权，AI 狼人只参与讨论</span>
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center gap-2 mb-3">
                <Zap className="w-4 h-4 text-orange-400" />
                <span className="text-sm font-medium text-wolf-text">一票决定权</span>
                <span className="text-xs text-orange-400/60">(指定击杀目标或跳过)</span>
              </div>

              <div className="space-y-2 mb-3">
                <button
                  onClick={() => handleSelectTarget('skip')}
                  className={`w-full px-4 py-2.5 rounded-xl border text-left transition-all ${
                    selectedTarget === 'skip'
                      ? 'bg-gradient-to-r from-orange-500/30 to-amber-500/20 border-orange-500/40 text-white'
                      : 'bg-white/5 border-white/10 text-wolf-text/70 hover:bg-white/10'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${
                      selectedTarget === 'skip' ? 'bg-orange-500 border-orange-400' : 'border-white/20'
                    }`}>
                      {selectedTarget === 'skip' && <div className="w-2 h-2 bg-white rounded-full" />}
                    </div>
                    <span>🔄 跳过（不杀人）</span>
                  </div>
                </button>
                {targetPlayers.map((player) => (
                  <button
                    key={`instant-${player.id}`}
                    onClick={() => handleSelectTarget(player.id)}
                    className={`w-full px-4 py-2.5 rounded-xl border text-left transition-all ${
                      selectedTarget === player.id
                        ? 'bg-gradient-to-r from-orange-500/30 to-amber-500/20 border-orange-500/40 text-white'
                        : 'bg-white/5 border-white/10 text-wolf-text/70 hover:bg-white/10'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-4 h-4 rounded border flex items-center justify-center transition-all ${
                        selectedTarget === player.id ? 'bg-orange-500 border-orange-400' : 'border-white/20'
                      }`}>
                        {selectedTarget === player.id && <div className="w-2 h-2 bg-white rounded-full" />}
                      </div>
                      <span>👤 {player.name}</span>
                    </div>
                  </button>
                ))}
              </div>

              <button
                onClick={handleExecuteKill}
                disabled={!selectedTarget}
                className={`w-full py-3 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                  selectedTarget
                    ? 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-white shadow-lg shadow-orange-500/20 hover:scale-[1.02] active:scale-[0.98]'
                    : 'bg-white/5 text-wolf-text/30 cursor-not-allowed'
                }`}
              >
                <Zap className="w-5 h-5" />
                使用一票决定权！
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
