import { cn } from '../lib/utils';

interface ProgressBarProps {
  value: number;
  max?: number;
  tone?: 'gold' | 'warning' | 'danger';
  label?: string;
  className?: string;
}

export function ProgressBar({
  value,
  max = 100,
  tone = 'gold',
  label = '进度',
  className,
}: ProgressBarProps) {
  const safeMax = max > 0 ? max : 100;
  const percentage = Math.min(100, Math.max(0, (value / safeMax) * 100));

  return (
    <div
      className={cn('v3-progress', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={Math.min(safeMax, Math.max(0, value))}
    >
      <span
        className={cn('v3-progress__fill', `v3-progress__fill--${tone}`)}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}
