import type { HTMLAttributes } from 'react';
import { cn } from '../lib/utils';

type CardProps = HTMLAttributes<HTMLElement> & {
  tone?: 'surface' | 'raised' | 'danger';
};

export function Card({ tone = 'surface', className, ...props }: CardProps) {
  return (
    <section
      className={cn('v3-card', `v3-card--${tone}`, className)}
      {...props}
    />
  );
}
