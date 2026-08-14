import type { ReactNode } from 'react';

interface MatchShellProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function MatchShell({ left, center, right, footer, className = '' }: MatchShellProps) {
  return (
    <div className={`v3-match-layout ${className}`}>
      <aside className="v3-match-layout__left">{left}</aside>
      <section className="v3-match-layout__center">{center}</section>
      <aside className="v3-match-layout__right">{right}</aside>
      {footer ? <footer className="v3-match-layout__footer">{footer}</footer> : null}
    </div>
  );
}
