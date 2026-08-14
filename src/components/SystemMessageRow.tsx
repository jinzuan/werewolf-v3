import { Info } from 'lucide-react';
import type { Message } from '../types';

export function SystemMessageRow({ message }: { message: Pick<Message, 'content' | 'timestamp'> }) {
  return <div className="day-system-row"><Info size={15} /><span>{message.content}</span><time>{new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>;
}
