import { Vote, SkipForward, Check, Bot } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import { PlayerCard } from './PlayerCard';
import { Modal } from './Modal';

interface VoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onVote: (targetId: string) => void;
  onSubmit?: () => void;
  canClose?: boolean;
  onAutoVote?: () => void;
}

export const VoteModal = ({
  isOpen,
  onClose,
  onVote,
  onSubmit,
  canClose = true,
  onAutoVote,
}: VoteModalProps) => {
  const { players, currentUser, isInTieDebate } = useGameStore();
  const gameState = useGameStore((s) => s.gameState);
  const alivePlayers = players.filter((p) => p.isAlive);
  const myVote = gameState?.votes[currentUser?.id || ''];
  const hasVoted = myVote !== undefined;
  const canSkipVote = !isInTieDebate;

  const totalVotes = Object.keys(gameState?.votes || {}).length;
  const voteProgress = `${totalVotes}/${alivePlayers.length}`;
  const allPlayersVoted = alivePlayers.every((p) => gameState?.votes[p.id] !== undefined);

  const handleVote = (targetId: string) => onVote(targetId);
  const handleSkipVote = () => onVote('skip');
  const handleSubmit = () => { if (hasVoted && onSubmit) onSubmit(); };
  const handleAutoVote = () => { if (onAutoVote) onAutoVote(); };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="投票阶段" size="lg" canClose={canClose}>
      {/* 标题区 */}
      <div className="flex items-center gap-3 mb-6">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(249,115,22,0.18)', border: '1px solid rgba(249,115,22,0.2)' }}
        >
          <Vote className="w-5 h-5 text-orange-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-purple-100 font-medium text-sm">投票阶段</p>
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${(totalVotes / (alivePlayers.length || 1)) * 100}%`,
                  background: 'linear-gradient(90deg, #F97316, #F59E0B)',
                }}
              />
            </div>
            <span className="text-[11px] text-purple-200/40 flex-shrink-0">{voteProgress}</span>
          </div>
        </div>
      </div>

      {/* AI 投票进度提示 */}
      {!allPlayersVoted && (
        <div className="mb-5 p-3.5 rounded-xl border flex items-center justify-between" style={{ background: 'rgba(59,130,246,0.06)', borderColor: 'rgba(59,130,246,0.12)' }}>
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-blue-400" />
            <span className="text-xs text-purple-200/45">等待所有玩家投票...</span>
          </div>
          <button
            onClick={handleAutoVote}
            className="px-2.5 py-1 text-[11px] rounded-lg transition-colors duration-200"
            style={{ background: 'rgba(59,130,246,0.15)' }}
          >
            AI 代投
          </button>
        </div>
      )}

      {/* 我的投票结果 */}
      {myVote && myVote !== 'skip' && (
        <div className="mb-5 p-3.5 rounded-xl border" style={{ background: 'rgba(139,92,246,0.06)', borderColor: 'rgba(139,92,246,0.12)' }}>
          <div className="flex items-center justify-between">
            <span className="text-xs text-purple-200/45">你的投票：</span>
            <span className="text-sm text-purple-300 font-medium">
              {players.find((p) => p.id === myVote)?.name}
            </span>
          </div>
          <p className="text-[11px] text-yellow-400/50 mt-0.5">（点击其他玩家可更改投票）</p>
        </div>
      )}

      {myVote === 'skip' && (
        <div className="mb-5 p-3.5 rounded-xl border" style={{ background: 'rgba(107,114,128,0.06)', borderColor: 'rgba(107,114,128,0.1)' }}>
          <div className="flex items-center justify-between">
            <span className="text-xs text-purple-200/45">你的投票：</span>
            <span className="text-sm text-gray-400 font-medium">弃票</span>
          </div>
          <p className="text-[11px] text-yellow-400/50 mt-0.5">（点击其他玩家可更改投票）</p>
        </div>
      )}

      {/* 玩家列表 */}
      <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1 scrollbar-thin">
        {alivePlayers.map((player) => {
          const playerVote = gameState?.votes[player.id];
          const hasPlayerVoted = playerVote !== undefined;
          return (
            <div key={player.id} className="relative">
              <PlayerCard
                player={player}
                isSelected={myVote === player.id}
                onSelect={currentUser ? () => handleVote(player.id) : undefined}
              />
              {hasPlayerVoted && (
                <div
                  className="absolute top-2 right-2 px-2 py-0.5 rounded-full text-[10px]"
                  style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(74,222,128,0.8)' }}
                >
                  {playerVote === 'skip'
                    ? '弃票'
                    : players.find((p) => p.id === playerVote)?.name || '未知'}
                </div>
              )}
            </div>
          );
        })}

        {/* 弃票选项 */}
        {canSkipVote && currentUser && (
          <button
            onClick={handleSkipVote}
            className={`w-full p-3.5 rounded-xl border transition-all duration-200 flex items-center gap-3 ${
              myVote === 'skip' ? 'border-opacity-40' : 'hover:border-gray-500/20'
            }`}
            style={
              myVote === 'skip'
                ? { background: 'rgba(107,114,128,0.1)', borderColor: 'rgba(107,114,128,0.3)' }
                : { background: 'rgba(255,255,255,0.01)', borderColor: 'rgba(255,255,255,0.04)' }
            }
          >
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
              style={myVote === 'skip' ? { background: 'rgba(107,114,128,0.15)' } : { background: 'rgba(107,114,128,0.05)' }}
            >
              <SkipForward className={`w-4 h-4 ${myVote === 'skip' ? 'text-gray-400' : 'text-gray-500'}`} />
            </div>
            <div className="flex-1 text-left">
              <p className={`text-sm font-medium ${myVote === 'skip' ? 'text-gray-300' : 'text-purple-200/60'}`}>弃票</p>
              <p className="text-[11px] text-purple-200/30">本轮不投票给任何人</p>
            </div>
            {myVote === 'skip' && (
              <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: 'rgba(107,114,128,0.2)' }}>
                <span className="text-[10px] text-gray-300">✓</span>
              </div>
            )}
          </button>
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="mt-6 pt-5" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 btn-secondary py-2.5 text-sm">
            {hasVoted ? '关闭' : '取消'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!hasVoted}
            className="flex-1 btn-primary py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <Check className="w-4 h-4" />
            确认投票
          </button>
        </div>

        {!allPlayersVoted && (
          <p className="text-[11px] text-yellow-400/50 text-center mt-2">
            {hasVoted ? `已投票，等待其他玩家... (${voteProgress})` : '请先投票'}
          </p>
        )}
      </div>

      {!currentUser && (
        <p className="mt-3 text-center text-sm text-orange-400/60">请先登录以参与投票</p>
      )}

      {isInTieDebate && (
        <p className="mt-3 text-center text-sm text-yellow-400/60">
          ⚔️ 平票争辩阶段，必须投票给争辩双方之一
        </p>
      )}
    </Modal>
  );
};
