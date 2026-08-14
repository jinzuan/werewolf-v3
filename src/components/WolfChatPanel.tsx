import { useState, useRef, useEffect } from 'react';
import { Send, Dog, Vote, SkipForward, Bot } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import type { Message, Player } from '../types';

interface WolfChatPanelProps {
  onSendMessage: (content: string) => void;
  onVote: (targetId: string) => void;
  onExecuteKill: (targetId: string) => void;
  onNextSpeaker: () => void;
  wolfPlayers: Player[];
  targetPlayers: Player[];
  onOpenVoteModal: () => void;
}

export const WolfChatPanel = ({ 
  onSendMessage, 
  onVote, 
  onExecuteKill,
  onNextSpeaker,
  wolfPlayers,
  targetPlayers,
  onOpenVoteModal,
}: WolfChatPanelProps) => {
  const { 
    wolfChatMessages, 
    currentUser, 
    players,
    wolfCurrentSpeaker,
    wolfSpeakerOrder,
    wolfVotes,
    wolfDiscussionRound,
    wolfVoteComplete,
    thinkingPlayers,
  } = useGameStore();
  
  const wolfThinkingPlayers = Object.entries(thinkingPlayers)
    .filter(([playerId]) => wolfPlayers.some(p => p.id === playerId));
  
  const isCurrentUserWolf = currentUser && wolfPlayers.find(p => p.id === currentUser.id);
  
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [wolfChatMessages]);

  const getPlayerById = (playerId: string) => {
    return players.find((p) => p.id === playerId);
  };

  const handleSend = () => {
    if (input.trim() && canSpeak) {
      onSendMessage(input.trim());
      setInput('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const currentSpeakerPlayer = wolfCurrentSpeaker ? getPlayerById(wolfCurrentSpeaker) : null;
  
  const isMyTurnById = currentUser?.id === wolfCurrentSpeaker;
  const isMyTurnByName = currentUser?.name === currentSpeakerPlayer?.name;
  const isMyTurn = isMyTurnById || isMyTurnByName;
  
  const canSpeak = isMyTurn && !wolfVoteComplete;

  const voteCount = Object.keys(wolfVotes).length;

  return (
    <div className="rounded-2xl overflow-hidden h-full flex flex-col border border-red-500/20" style={{
      background: 'linear-gradient(135deg, rgba(220, 38, 38, 0.1) 0%, rgba(153, 27, 27, 0.05) 50%, rgba(127, 29, 29, 0.1) 100%)',
      backdropFilter: 'blur(20px)',
    }}>
      <div className="px-4 py-3 border-b border-red-500/20 glass-highlight">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500/30 to-rose-500/20 flex items-center justify-center">
              <Dog className="w-4 h-4 text-red-400" />
            </div>
            <h3 className="font-semibold text-wolf-text">狼群频道 🐺</h3>
            <span className="text-xs text-wolf-text/40 bg-white/5 px-2 py-0.5 rounded-full">第{wolfDiscussionRound}轮</span>
          </div>
          <div className="flex items-center gap-2">
            {!wolfVoteComplete && (
              <button
                onClick={onOpenVoteModal}
                className="px-3 py-1.5 rounded-xl text-sm flex items-center gap-1.5 bg-white/5 text-wolf-text/70 hover:bg-white/10 border border-white/5 transition-all group"
              >
                <Vote className="w-4 h-4" />
                投票 ({voteCount}/{wolfPlayers.length})
              </button>
            )}
          </div>
        </div>
      </div>

      {wolfCurrentSpeaker && !wolfVoteComplete && (
        <div className="px-4 py-2 bg-gradient-to-r from-red-500/10 to-rose-500/5 border-b border-red-500/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative">
                <div className="absolute inset-0 bg-yellow-500/30 rounded-full blur animate-ping" />
                <div className="relative w-6 h-6 bg-gradient-to-br from-yellow-500/30 to-orange-500/20 rounded-full flex items-center justify-center">
                  <span className="text-xs">🎤</span>
                </div>
              </div>
              <span className="text-sm text-wolf-text">
                当前发言: <span className="text-red-300 font-medium">{currentSpeakerPlayer?.name}</span>
              </span>
              {isMyTurn && (
                <span className="text-xs text-yellow-400 bg-yellow-500/10 px-2 py-0.5 rounded-full">轮到你了！</span>
              )}
            </div>
            {isMyTurn && (
              <button
                onClick={onNextSpeaker}
                className="text-xs text-wolf-text/50 hover:text-wolf-text flex items-center gap-1 transition-colors"
              >
                <SkipForward className="w-3 h-3" />
                跳过
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px]">
        {wolfChatMessages.map((message) => {
          const player = getPlayerById(message.playerId);
          const isMe = currentUser?.id === message.playerId;
          const isSpeaker = message.playerId === wolfCurrentSpeaker;

          return (
            <div
              key={message.id}
              className={`rounded-xl p-3 border backdrop-blur-sm ${
                isMe 
                  ? 'bg-gradient-to-r from-red-500/15 to-rose-500/10 border-red-500/20' 
                  : isSpeaker 
                    ? 'bg-gradient-to-r from-red-500/10 to-rose-500/5 border-red-500/30'
                    : 'bg-white/[0.02] border-white/5'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                  isSpeaker ? 'bg-gradient-to-br from-yellow-500/30 to-orange-500/20' : 'bg-gradient-to-br from-red-500/30 to-rose-500/20'
                }`}>
                  {isSpeaker ? <span className="text-xs">🎤</span> : <span className="text-xs">🐺</span>}
                </div>
                <span className={`text-sm font-medium ${isMe ? 'text-red-300' : 'text-wolf-text'}`}>
                  {message.playerName}
                </span>
                <span className="text-xs text-wolf-text/30">
                  {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <p className="text-sm text-wolf-text/80 leading-relaxed">{message.content.replace(/\{[^}]+\}/g, '')}</p>
            </div>
          );
        })}
        {wolfChatMessages.length === 0 && (
          <div className="text-center py-8 text-wolf-text/40">
            <p>狼人频道已开启</p>
            <p className="text-sm mt-1">按顺序发言讨论今晚的目标</p>
          </div>
        )}
        
        {wolfThinkingPlayers.length > 0 && (
          <div className="space-y-2">
            {wolfThinkingPlayers.map(([playerId, progress]) => {
              const player = players.find(p => p.id === playerId);
              if (!player) return null;
              return (
                <div
                  key={playerId}
                  className="rounded-xl p-3 border backdrop-blur-sm bg-gradient-to-r from-red-500/15 to-orange-500/10 border-red-500/20 animate-slide-up"
                >
                  <div className="flex items-center gap-3">
                    <div className="relative w-7 h-7 rounded-full bg-gradient-to-br from-red-500/30 to-orange-500/20 border border-red-500/30 flex items-center justify-center">
                      <Bot className="w-3.5 h-3.5 text-red-400" />
                      <div className="absolute inset-0 animate-ping rounded-full bg-red-500/20" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-red-300">{player.name}</span>
                        <span className="text-xs text-red-400/70 bg-red-500/10 px-1.5 py-0.5 rounded-full">🐺 AI</span>
                        <span className="text-xs text-red-400/60">正在思考中...</span>
                      </div>
                      <div className="w-full bg-red-500/10 rounded-full h-1 mt-1 overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-red-500 to-orange-400 rounded-full transition-all duration-300"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-xs text-red-400/70">{progress}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-red-500/20">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={canSpeak ? '轮到你发言...' : '等待其他狼人发言...'}
            className="flex-1 input-field"
            disabled={!canSpeak || !currentUser}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !canSpeak || !currentUser}
            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-red-500 to-rose-500 hover:from-red-400 hover:to-rose-400 disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-lg shadow-red-500/20"
          >
            <Send className="w-5 h-5 text-white" />
          </button>
        </div>
      </div>
    </div>
  );
};