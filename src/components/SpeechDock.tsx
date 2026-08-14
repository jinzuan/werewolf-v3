import { Send, SkipForward } from 'lucide-react';
import { useEffect, useState } from 'react';

export function SpeechDock({ enabled, interject, maxLength = 80, reason, initialValue = '', onChange, onSubmit, onSkip }: { enabled: boolean; interject?: boolean; maxLength?: number; reason?: string; initialValue?: string; onChange?: (value: string) => void; onSubmit: (text: string) => void; onSkip: () => void }) {
  const [text, setText] = useState('');
  useEffect(() => { setText(initialValue); }, [initialValue]);
  const updateText = (value: string) => { setText(value); onChange?.(value); };
  const disabledReason = reason || (!enabled ? '等待轮到你发言后开放' : '');
  const submit = () => { const value = text.trim(); if (!value || value.length > maxLength || !enabled) return; onSubmit(value); setText(''); onChange?.(''); };
  return <section className="day-speech-dock"><div className="day-speech-dock__meta"><span>{interject ? '插队发言' : '公开发言'}</span><span>{text.length}/{maxLength}</span></div><textarea value={text} onChange={(event) => updateText(event.target.value)} disabled={!enabled} maxLength={maxLength} placeholder={disabledReason || (interject ? '简短表达你的判断…' : '组织好你的发言…')} /><div className="day-speech-dock__actions"><button className="day-button day-button--quiet" disabled={!enabled} onClick={onSkip}><SkipForward size={17} />跳过</button><button className="day-button day-button--primary" disabled={!enabled || !text.trim()} onClick={submit}><Send size={17} />提交发言</button></div></section>;
}
