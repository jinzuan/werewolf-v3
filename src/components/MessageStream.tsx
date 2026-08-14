import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../types';

export function MessageStream({ messages, onNewMessages }: { messages: Message[]; onNewMessages?: (count: number) => void }) {
  const [collapsedRounds, setCollapsedRounds] = useState<Record<string, boolean>>({});
  const [unread, setUnread] = useState(0);
  const seenCount = useRef(messages.length);
  useEffect(() => {
    if (messages.length > seenCount.current) {
      const added = messages.length - seenCount.current;
      setUnread((count) => count + added);
      onNewMessages?.(added);
      seenCount.current = messages.length;
    } else if (messages.length < seenCount.current) {
      seenCount.current = messages.length;
    }
  }, [messages.length]);
  const rounds = useMemo(() => messages.reduce<Record<string, Message[]>>((groups, message) => { const key = new Date(message.timestamp).toLocaleDateString('zh-CN'); (groups[key] ||= []).push(message); return groups; }, {}), [messages]);
  const markRead = () => { setUnread(0); onNewMessages?.(0); };
  return <section className="day-message-stream"><header><div><span className="day-eyebrow">时间线</span><strong>{messages.length} 条记录</strong></div>{unread > 0 && <button className="day-new-messages" onClick={markRead} aria-label={`标记 ${unread} 条新消息为已读`}>↓ {unread} 条新消息</button>}</header>{Object.entries(rounds).map(([round, entries]) => <div key={round} className="day-message-round"><button className="day-round-toggle" onClick={() => setCollapsedRounds((value) => ({ ...value, [round]: !value[round] }))} aria-expanded={!collapsedRounds[round]}>{round} · {entries.length} 条消息<span>{collapsedRounds[round] ? '展开' : '折叠'}</span></button>{!collapsedRounds[round] && entries.map((message) => <article className={`day-message day-message--${message.type}`} key={message.id}><strong>{message.playerName}</strong><time>{new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><p>{message.content}</p></article>)}</div>)}</section>;
}
