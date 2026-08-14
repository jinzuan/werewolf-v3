import { useState, useEffect } from 'react';
import { MessageSquare, Dog } from 'lucide-react';
import { ChatPanel } from './ChatPanel';
import { WolfChatPanel } from './WolfChatPanel';
import type { Player, Message } from '../types';

interface ChatTabsProps {
  messages: Message[];
  wolfChatMessages: Message[];
  onSendMessage: (content: string) => void;
  onWolfSendMessage: (content: string) => void;
  onWolfVote: (targetId: string) => void;
  onWolfExecuteKill: (targetId: string) => void;
  onWolfNextSpeaker: () => void;
  onWolfOpenVoteModal: () => void;
  onStartVote: () => void;
  onNextSpeaker?: () => void;
  canStartVote?: boolean;
  wolfPlayers: Player[];
  targetPlayers: Player[];
  currentUser: { id: string; name: string } | null;
  isWolf: boolean;
  wolfVoteComplete: boolean;
  wolfDiscussionRound: number;
  isNight: boolean;
  isDay: boolean;
  isSpectator: boolean;
}

import { Vote } from 'lucide-react';

export const ChatTabs = ({
  messages,
  wolfChatMessages,
  onSendMessage,
  onWolfSendMessage,
  onWolfVote,
  onWolfExecuteKill,
  onWolfNextSpeaker,
  onWolfOpenVoteModal,
  onStartVote,
  onNextSpeaker,
  canStartVote = true,
  wolfPlayers,
  targetPlayers,
  currentUser,
  isWolf,
  wolfVoteComplete,
  wolfDiscussionRound,
  isNight,
  isDay,
  isSpectator,
}: ChatTabsProps) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'wolf'>('chat');
  
  // 白天自动切换到公共频道
  useEffect(() => {
    if (!isNight && activeTab === 'wolf') {
      setActiveTab('chat');
    }
  }, [isNight, activeTab]);

  const tabs = [
    {
      id: 'chat' as const,
      label: '公共聊天',
      icon: MessageSquare,
      color: 'from-wolf-purple to-wolf-purple-light',
      badge: messages.filter(m => m.type !== 'system').length > 0 ? null : null,
    },
    {
      id: 'wolf' as const,
      label: '狼群频道',
      icon: Dog,
      color: 'from-red-500 to-rose-500',
      badge: wolfChatMessages.length > 0 ? wolfChatMessages.length : null,
      show: isWolf && isNight && !isSpectator,
    },
  ];

  const visibleTabs = tabs.filter(tab => tab.show !== false);

  return (
    <div className={`card-glass overflow-hidden h-full flex flex-col ${isNight ? '' : 'bg-black/20'}`}>
      <div className="flex border-b border-white/5">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 font-medium text-sm transition-all duration-300 relative overflow-hidden ${
                isActive 
                  ? 'text-white' 
                  : 'text-wolf-text/50 hover:text-wolf-text hover:bg-white/[0.03]'
              }`}
            >
              {isActive && (
                <div 
                  className={`absolute inset-0 bg-gradient-to-r ${tab.color} opacity-90`}
                />
              )}
              <div className={`relative flex items-center gap-2 ${isActive ? 'scale-110' : ''} transition-transform`}>
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
                {tab.badge && (
                  <span className={`px-1.5 py-0.5 text-xs rounded-full ${
                    isActive ? 'bg-white/20' : 'bg-wolf-purple/30'
                  }`}>
                    {tab.badge}
                  </span>
                )}
                {tab.id === 'wolf' && wolfDiscussionRound > 0 && !wolfVoteComplete && (
                  <span className="px-1.5 py-0.5 text-xs rounded-full bg-orange-500/30 text-orange-300">
                    讨论中
                  </span>
                )}
              </div>
            </button>
          );
        })}
        
        {isDay && (
          <button
            onClick={onStartVote}
            disabled={!canStartVote}
            title={canStartVote ? '发起投票' : '第一轮发言尚未完成，暂不能发起投票'}
            className={`px-4 py-3 font-medium text-sm flex items-center gap-2 transition-all ${
              canStartVote
                ? 'text-orange-400 hover:text-orange-300 hover:bg-white/[0.03]'
                : 'text-wolf-text/30 cursor-not-allowed'
            }`}
          >
            <Vote className="w-4 h-4" />
            <span>发起投票</span>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-hidden relative">
        <div 
          className={`absolute inset-0 transition-opacity duration-200 ${
            activeTab === 'chat' ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <ChatPanel onSendMessage={onSendMessage} onNextSpeaker={onNextSpeaker} />
        </div>
        
        {isWolf && (
          <div 
            className={`absolute inset-0 transition-opacity duration-200 ${
              activeTab === 'wolf' ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <WolfChatPanel
              onSendMessage={onWolfSendMessage}
              onVote={onWolfVote}
              onExecuteKill={onWolfExecuteKill}
              onNextSpeaker={onWolfNextSpeaker}
              onOpenVoteModal={onWolfOpenVoteModal}
              wolfPlayers={wolfPlayers}
              targetPlayers={targetPlayers}
            />
          </div>
        )}
      </div>
    </div>
  );
};
