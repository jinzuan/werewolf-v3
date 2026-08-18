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
}

/** Compact room navigation shown only when the viewport is phone-sized. */
export function MobileMatchNav({
  items,
  active,
  onChange,
  ariaLabel = '手机端对局分区',
}: MobileMatchNavProps) {
  const navigation = (
    <nav className="v3-mobile-match-nav" aria-label={ariaLabel}>
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={active === id ? 'is-active' : undefined}
          aria-current={active === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          <Icon size={18} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );

  // Keep the dock outside the scrolling room body. This also avoids an
  // ancestor animation/containment context turning `position: fixed` into a
  // content-relative bar on mobile browsers.
  return typeof document === 'undefined'
    ? navigation
    : createPortal(navigation, document.body);
}
