import { BrainCircuit } from 'lucide-react';

export function ThinkingBadge({ progress }: { progress: number }) {
  return <div className="day-thinking" aria-label="正在组织发言" role="status">
    <BrainCircuit size={16} aria-hidden="true" />
    <span>正在组织发言</span>
    <span className="day-thinking__progress">{Math.round(progress)}%</span>
  </div>;
}
