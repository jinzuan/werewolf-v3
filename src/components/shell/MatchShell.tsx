import type { ReactNode } from 'react';

interface MatchShellProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Keeps the shell structural; each view supplies its own projection UI. */
  ariaLabel?: string;
  centerAriaLabel?: string;
  rightAriaLabel?: string;
  mobileSection?: string;
  /** Opts the room workspace into the dedicated wide-screen rail contract. */
  desktop?: boolean;
}

export function MatchShell({
  left,
  center,
  right,
  footer,
  className = '',
  ariaLabel = '对局内容',
  centerAriaLabel = '当前阶段',
  rightAriaLabel = '对局记录',
  mobileSection,
  desktop = false,
}: MatchShellProps) {
  return (
    <div
      className={`v3-match-layout${desktop ? ' v3-desktop-match-layout' : ''} ${className}`.trim()}
      aria-label={ariaLabel}
      data-mobile-section={mobileSection}
      data-layout={desktop ? 'desktop-capable' : undefined}
    >
      <aside className="v3-match-layout__left" aria-label="座位信息">{left}</aside>
      <section className="v3-match-layout__center" aria-label={centerAriaLabel}>{center}</section>
      <aside className="v3-match-layout__right" aria-label={rightAriaLabel}>{right}</aside>
      {footer ? <footer className="v3-match-layout__footer" aria-label="对局补充信息">{footer}</footer> : null}
    </div>
  );
}
