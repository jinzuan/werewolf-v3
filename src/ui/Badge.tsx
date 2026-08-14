import type { HTMLAttributes } from 'react';
import { cn } from '../lib/utils';

type BadgeTone = 'neutral' | 'gold' | 'purple' | 'danger' | 'success' | 'info' | 'warning';

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
};

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn('v3-badge', `v3-badge--${tone}`, className)}
      {...props}
    />
  );
}
