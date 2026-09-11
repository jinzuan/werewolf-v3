import type { LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';

export interface MobileMatchNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface MobileMatchNavProps {
  items: readonly MobileMatchNavItem[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  unreadCounts?: Readonly<Record<string, number>>;
}

/** Compact room navigation shown only when the viewport is phone-sized. */
export function MobileMatchNav({
  items,
  active,
  onChange,
  ariaLabel = '手机端对局分区',
  unreadCounts = {},
}: MobileMatchNavProps) {
  const navigation = (
    <nav className="v3-mobile-match-nav" aria-label={ariaLabel} data-glass-role="navigation" data-glass-priority="critical">
      {items.map(({ id, label, icon: Icon }) => {
        const unread = Math.max(0, Math.floor(unreadCounts[id] ?? 0));
        const unreadLabel = unread > 99 ? '99+' : unread.toString();
        return (
          <button
            key={id}
            type="button"
            data-glass-role="control"
            data-glass-motion="control"
            className={[
              active === id ? 'is-active' : '',
              unread > 0 ? 'is-unread' : '',
            ].filter(Boolean).join(' ') || undefined}
            aria-current={active === id ? 'page' : undefined}
            aria-label={unread > 0 ? `${label}，${unread}条未读` : undefined}
            onClick={() => onChange(id)}
          >
            <span className="v3-mobile-match-nav__icon">
              <Icon size={18} aria-hidden="true" />
              {unread > 0 ? (
                <span className="v3-mobile-match-nav__badge" aria-hidden="true">{unreadLabel}</span>
              ) : null}
            </span>
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );

  // Keep the dock outside the scrolling room body. This also avoids an
  // ancestor animation/containment context turning `position: fixed` into a
  // content-relative bar on mobile browsers.
  return typeof document === 'undefined'
    ? navigation
    : createPortal(navigation, document.body);
}
