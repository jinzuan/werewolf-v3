import { useEffect, useRef } from 'react';
import { Bell, AlertCircle, Info, CheckCircle, Lightbulb, Trophy } from 'lucide-react';
import type { Message } from '../types';

interface SystemMessagesPanelProps {
  messages: Message[];
}

export const SystemMessagesPanel = ({ messages }: SystemMessagesPanelProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages]);

  const systemMessages = messages.filter(m => m.type === 'system');

  const getMessageStyle = (content: string) => {
    if (content.includes('获胜')) {
      return { icon: Trophy, color: 'text-yellow-400', bg: 'from-yellow-500/10 to-orange-500/5', border: 'border-yellow-500/20' };
    }
    if (content.includes('杀死') || content.includes('毒') || content.includes('死亡') || content.includes('死了')) {
      return { icon: AlertCircle, color: 'text-red-400', bg: 'from-red-500/10 to-rose-500/5', border: 'border-red-500/20' };
    }
    if (content.includes('天亮') || content.includes('平安夜')) {
      return { icon: CheckCircle, color: 'text-green-400', bg: 'from-green-500/10 to-emerald-500/5', border: 'border-green-500/20' };
    }
    if (content.includes('查验') || content.includes('身份')) {
      return { icon: Lightbulb, color: 'text-blue-400', bg: 'from-blue-500/10 to-indigo-500/5', border: 'border-blue-500/20' };
    }
    return { icon: Info, color: 'text-wolf-text', bg: 'from-wolf-purple/10 to-wolf-purple-light/5', border: 'border-wolf-purple/20' };
  };

  return (
    <div className="card-glass overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 glass-highlight flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-wolf-purple/30 to-wolf-purple-light/20 flex items-center justify-center">
          <Bell className="w-4 h-4 text-wolf-purple-light" />
        </div>
        <h3 className="font-semibold text-wolf-text">系统提示</h3>
        <span className="text-xs text-wolf-text/40 bg-white/5 px-2 py-0.5 rounded-full">
          {systemMessages.length}
        </span>
      </div>

      <div className="p-4 max-h-[200px] overflow-y-auto space-y-2">
        {systemMessages.length === 0 ? (
          <div className="text-center py-6 text-wolf-text/40">
            <Info className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>暂无系统消息</p>
            <p className="text-xs mt-1">游戏开始后将显示系统提示</p>
          </div>
        ) : (
          systemMessages.map((message, index) => {
            const style = getMessageStyle(message.content);
            const Icon = style.icon;
            
            return (
              <div
                key={index}
                className={`flex items-start gap-3 p-3 rounded-xl bg-gradient-to-r ${style.bg} border ${style.border} animate-fade-in`}
                style={{ animationDelay: `${index * 0.1}s` }}
              >
                <div className={`w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0 ${style.color}`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${style.color}`}>{message.content}</p>
                  <p className="text-xs text-wolf-text/30 mt-1">
                    {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};
