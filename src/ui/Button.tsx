import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/utils';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet' | 'icon';
  size?: 'default' | 'action';
};

export function Button({
  variant = 'primary',
  size = 'default',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn('v3-button', `v3-button--${variant}`, `v3-button--${size}`, className)}
      {...props}
    />
  );
}
