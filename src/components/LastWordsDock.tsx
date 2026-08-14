import { MessageCircle, SkipForward } from 'lucide-react';
import { useState } from 'react';

export function LastWordsDock({ enabled, playerName, maxLength = 80, onSubmit, onSkip }: { enabled: boolean; playerName?: string; maxLength?: number; onSubmit: (content: string) => void; onSkip: () => void }) {
  const [content, setContent] = useState('');
  const submit = () => { const value = content.trim(); if (!value || !enabled) return; onSubmit(value); setContent(''); };
  return <section className="day-last-words" aria-labelledby="last-words-title"><header><MessageCircle size={19} /><div><span className="day-eyebrow">遗言阶段</span><h2 id="last-words-title">{playerName || '当前玩家'}的最后发言</h2></div></header><p>这是你在场上的最后一次发言，可以选择跳过。</p><textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={maxLength} disabled={!enabled} placeholder={enabled ? '留下你的遗言…' : '等待遗言阶段开放'} /><div className="day-last-words__footer"><span>{content.length}/{maxLength}</span><div><button className="day-button day-button--quiet" disabled={!enabled} onClick={onSkip}><SkipForward size={16} />跳过遗言</button><button className="day-button day-button--primary" disabled={!enabled || !content.trim()} onClick={submit}>提交遗言</button></div></div></section>;
}
