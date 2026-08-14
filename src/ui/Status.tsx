import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/utils';

export type StatusTone =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'night';

interface StatusProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  icon?: ReactNode;
  label: string;
  detail?: string;
}

/** A colour-independent status primitive: the dot is paired with text/icon. */
export function Status({
  tone = 'neutral',
  icon,
  label,
  detail,
  className,
  ...props
}: StatusProps) {
  return (
    <span
      className={cn('ww-status', `ww-status--${tone}`, className)}
      role="status"
      {...props}
    >
      <span className="ww-status__dot" aria-hidden="true" />
      {icon ? <span className="ww-status__icon" aria-hidden="true">{icon}</span> : null}
      <span className="ww-status__label">{label}</span>
      {detail ? <span className="ww-status__detail">{detail}</span> : null}
    </span>
  );
}
