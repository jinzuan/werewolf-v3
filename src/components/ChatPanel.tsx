import { useState, useRef, useEffect } from 'react';
import { Send, User, Bot, SkipForward, Mic, MicOff } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import type { Message } from '../types';

interface ChatPanelProps {
  onSendMessage: (content: string) => void;
  onNextSpeaker?: () => void;
}

export const ChatPanel = ({ onSendMessage, onNextSpeaker }: ChatPanelProps) => {
  const { messages, currentUser, players, thinkingPlayers, gameState, setDayInputFocused } = useGameStore();
  
  const displayMessages = messages.filter(m => m.type !== 'wolf_chat');
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  
  const messageCountRef = useRef(displayMessages.length);
  
  const isDayTime = gameState?.phase === 'day';
  const isLastWords = gameState?.phase === 'lastWords';
  const currentSpeakerPlayer = gameState?.currentSpeaker ? players.find(p => p.id === gameState.currentSpeaker) : null;
  
  const isMyTurnById = currentUser?.id === gameState?.currentSpeaker;
  const isMyTurnByName = currentUser?.name === currentSpeakerPlayer?.name;
  const isMyTurnDay = isDayTime && (isMyTurnById || isMyTurnByName);
  const isMyTurnLastWords = isLastWords && gameState?.lastWordsPlayer === currentUser?.id;
  const isMyTurn = isMyTurnDay || isMyTurnLastWords;
  
  const isAlive = players.find(p => p.id === currentUser?.id)?.isAlive ?? true;
  // v2.4.3 任务B2：自由讨论阶段输入框常驻，真人可随时插话（计入配额，不打断当前发言）
  const isFreeDiscuss = isDayTime && gameState?.dayPhase?.phase === 'free_discussion';
  const canFreeInterject = isFreeDiscuss && isAlive && !isMyTurnDay;
  const isInputDisabled = !isAlive || (!isDayTime && !isLastWords) || (!isMyTurn && !canFreeInterject);
  
  useEffect(() => {
    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) return;
    
    const newMessageCount = displayMessages.length;
    
    if (newMessageCount > messageCountRef.current) {
      const isNearBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 200;
      
      if (isNearBottom) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
      
      messageCountRef.current = newMessageCount;
    }
  }, [displayMessages.length]);
  
  useEffect(() => {
    const messagesContainer = messagesContainerRef.current;
    if (!messagesContainer) return;
    
    const handleScroll = () => {
      const isNearBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 200;
      if (!isNearBottom) {
        messageCountRef.current = displayMessages.length;
      }
    };
    
    messagesContainer.addEventListener('scroll', handleScroll);
    return () => messagesContainer.removeEventListener('scroll', handleScroll);
  }, [displayMessages.length]);

  useEffect(() => {
    if (isMyTurn && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isMyTurn]);

  const getPlayerById = (playerId: string) => {
    return players.find((p) => p.id === playerId);
  };

  const handleSend = () => {
    if (input.trim()) {
      setIsTyping(true);
      onSendMessage(input.trim());
      setInput('');
      setTimeout(() => setIsTyping(false), 300);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      handleSend();
    }
  };

  const getMessageStyle = (type: Message['type']) => {
    switch (type) {
      case 'system':
        return 'bg-gradient-to-r from-yellow-500/15 to-orange-500/10 text-yellow-300 border border-yellow-500/30';
      case 'whisper':
        return 'bg-gradient-to-r from-blue-500/15 to-indigo-500/10 text-blue-300 border border-blue-500/30';
      case 'night_action':
        return 'bg-gradient-to-r from-purple-500/15 to-violet-500/10 text-purple-300 border border-purple-500/30';
      default:
        return 'bg-wolf-purple/5 text-wolf-text border border-wolf-purple/15';
    }
  };

  return (
    <div className="flex flex-col h-full card-glass overflow-hidden">
      <div className="px-4 py-4 border-b border-wolf-purple/15 relative">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-wolf-purple/35 to-wolf-purple-light/25 flex items-center justify-center border border-wolf-purple/35">
                <span className="text-lg">💬</span>
              </div>
              <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-green-400 rounded-full border-2 border-[#1a132e] animate-pulse" />
            </div>
            <div>
              <h3 className="font-bold text-wolf-text text-lg">聊天频道</h3>
              <p className="text-xs text-wolf-text/50">{displayMessages.length} 条消息</p>
            </div>
          </div>
          {gameState?.phase === 'night' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-purple-500/15 to-indigo-500/10 border border-purple-500/25">
              <span className="text-sm text-purple-300">🌙 夜晚阶段</span>
            </div>
          )}
        </div>
      </div>

      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
        {displayMessages.map((message, index) => {
          
          const player = getPlayerById(message.playerId);
          const isMe = currentUser?.id === message.playerId;
          const isAI = player?.isAI;

          return (
            <div
              key={message.id}
              className={`rounded-2xl p-4 border backdrop-blur-xl transition-all duration-300 hover:bg-white/[0.03] animate-slide-up ${getMessageStyle(message.type)} ${
                isMe ? 'border-wolf-purple/40 bg-gradient-to-br from-wolf-purple/15 to-wolf-purple-light/10' : ''
              }`}
              style={{ animationDelay: `${index * 25}ms` }}
            >
              <div className="flex items-center gap-2 mb-2.5">
                <div className={`relative w-8 h-8 rounded-full flex items-center justify-center overflow-hidden ${
                  isAI 
                    ? 'bg-gradient-to-br from-blue-500/35 to-blue-600/25 border border-blue-500/35' 
                    : isMe
                    ? 'bg-gradient-to-br from-wolf-purple/35 to-wolf-purple-light/25 border border-wolf-purple/35'
                    : 'bg-gradient-to-br from-wolf-purple/25 to-wolf-purple-light/15 border border-wolf-purple/25'
                }`}>
                  <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent" />
                  {isAI ? (
                    <Bot className="w-4 h-4 text-blue-400 relative z-10" />
                  ) : (
                    <User className="w-4 h-4 text-wolf-purple-light relative z-10" />
                  )}
                </div>
                <span className={`text-sm font-semibold ${
                  isMe ? 'text-wolf-purple-light' : 'text-wolf-text'
                }`}>
                  {message.playerName}
                </span>
                {isAI && (
                  <span className="text-xs text-blue-400/70 bg-blue-500/10 px-1.5 py-0.5 rounded-full">AI</span>
                )}
                <span className="text-xs text-wolf-text/40 ml-auto">
                  {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                {message.type === 'whisper' && (
                  <span className="text-xs text-blue-400 bg-blue-500/15 px-2 py-0.5 rounded-full ml-1">悄悄说</span>
                )}
                {message.type === 'night_action' && (
                  <span className="text-xs text-purple-400 bg-purple-500/15 px-2 py-0.5 rounded-full ml-1">夜晚行动</span>
                )}
              </div>
              <p className="text-sm text-wolf-text/85 leading-relaxed break-words">{message.content}</p>
            </div>
          );
        })}
        {isTyping && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-wolf-purple/5 border border-wolf-purple/10 animate-slide-up">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-wolf-purple/35 to-wolf-purple-light/25 flex items-center justify-center">
              <User className="w-3.5 h-3.5 text-wolf-purple-light" />
            </div>
            <div className="typing-indicator">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        
        {isDayTime && Object.keys(thinkingPlayers).length > 0 && (
          <div className="space-y-2">
            {Object.entries(thinkingPlayers).map(([playerId, progress]) => {
              const player = players.find(p => p.id === playerId);
              if (!player) return null;
              return (
                <div
                  key={playerId}
                  className="rounded-2xl p-4 border backdrop-blur-xl bg-gradient-to-r from-blue-500/10 to-cyan-500/5 border-blue-500/20 animate-slide-up"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className="relative w-8 h-8 rounded-full bg-gradient-to-br from-blue-500/35 to-blue-600/25 border border-blue-500/35 flex items-center justify-center">
                      <Bot className="w-4 h-4 text-blue-400" />
                      <div className="absolute inset-0 animate-ping rounded-full bg-blue-500/20" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-blue-300">{player.name}</span>
                        <span className="text-xs text-blue-400/70 bg-blue-500/10 px-1.5 py-0.5 rounded-full">AI</span>
                        <span className="text-xs text-blue-400/60">正在思考中...</span>
                      </div>
                      <div className="w-full bg-blue-500/10 rounded-full h-1.5 mt-1.5 overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-300 relative"
                          style={{ width: `${progress}%` }}
                        >
                          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" />
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-blue-400/70 font-medium">{progress}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t border-wolf-purple/15 relative">
        {(isDayTime || isLastWords) && currentSpeakerPlayer && (
          <div className={`px-4 py-2.5 mb-3 rounded-xl ${
            isLastWords 
              ? 'bg-gradient-to-r from-orange-500/10 to-red-500/5 border border-orange-500/20' 
              : 'bg-gradient-to-r from-yellow-500/10 to-orange-500/5 border border-yellow-500/20'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <div className={`absolute inset-0 rounded-full blur animate-pulse ${
                    isLastWords ? 'bg-orange-500/30' : 'bg-yellow-500/30'
                  }`} />
                  <div className={`relative w-6 h-6 rounded-full flex items-center justify-center ${
                    isLastWords 
                      ? 'bg-gradient-to-br from-orange-500/35 to-red-500/25' 
                      : 'bg-gradient-to-br from-yellow-500/35 to-orange-500/25'
                  }`}>
                    <span className="text-xs">{isLastWords ? '💬' : '🎤'}</span>
                  </div>
                </div>
                <span className="text-sm text-wolf-text">
                  {isLastWords ? '遗言阶段' : '当前发言'}: <span className={`font-medium ${isLastWords ? 'text-orange-300' : 'text-yellow-300'}`}>{currentSpeakerPlayer.name}</span>
                </span>
                {isMyTurn && (
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    isLastWords 
                      ? 'text-orange-400 bg-orange-500/20' 
                      : 'text-yellow-400 bg-yellow-500/20'
                  }`}>
                    轮到你了！
                  </span>
                )}
              </div>
              {isMyTurnDay && onNextSpeaker && (
                <button
                  onClick={onNextSpeaker}
                  className="text-xs text-wolf-text/50 hover:text-wolf-text flex items-center gap-1 transition-colors group"
                >
                  <SkipForward className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                  跳过
                </button>
              )}
            </div>
          </div>
        )}
        <div className={`flex gap-3 relative z-50 ${isFocused ? 'scale-[1.01]' : 'scale-100'} transition-transform duration-300`}>
          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              onFocus={() => {
                setIsFocused(true);
                setDayInputFocused(true);
              }}
              onBlur={() => {
                setIsFocused(false);
                setDayInputFocused(false);
              }}
              placeholder={
                isMyTurn
                  ? (isLastWords ? '说你的遗言...' : '输入你的发言...')
                  : canFreeInterject
                  ? '自由讨论中，可随时插话（计入配额，不打断当前发言）...'
                  : isAlive
                  ? '等待你的发言...'
                  : '你已出局，无法发言'
              }
              className={`w-full input-field focus-ring ${isInputDisabled ? 'opacity-70' : ''}`}
              disabled={isInputDisabled}
              readOnly={isInputDisabled}
            />
            {!isInputDisabled && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {isMyTurn ? (
                  <Mic className="w-4 h-4 text-green-400" />
                ) : canFreeInterject ? (
                  <Mic className="w-4 h-4 text-blue-400" />
                ) : (
                  <MicOff className="w-4 h-4 text-wolf-text/40" />
                )}
              </div>
            )}
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim() || isInputDisabled}
            className="btn-primary px-5 py-2.5 disabled:opacity-30 disabled:cursor-not-allowed hover:scale-105 active:scale-95 transition-transform duration-200 relative z-50 overflow-hidden group"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-wolf-purple/30 to-wolf-purple-light/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            <Send className="w-5 h-5 text-white relative z-50" />
          </button>
        </div>
      </div>
    </div>
  );
};
