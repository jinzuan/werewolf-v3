import { BrainCircuit } from 'lucide-react';

export function ThinkingProgress({ name, progress, label = '正在组织行动' }: { name?: string; progress: number; label?: string }) {
  const safeProgress = Math.max(0, Math.min(100, Math.round(progress)));
  return <div className="night-thinking" role="status" aria-label={(name ? name + ' ' : '') + label}><div className="night-thinking__head"><span><BrainCircuit size={16} aria-hidden="true" />{name || 'AI 玩家'}</span><strong>{safeProgress}%</strong></div><div className="night-thinking__track"><span style={{ width: safeProgress + '%' }} /></div><small>{label}</small></div>;
}
