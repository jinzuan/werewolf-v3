import type { ReactNode } from 'react';
import type { Role } from '../../shared/types';
import { cn } from '../lib/utils';
import { roleAssetMap } from './assetRegistry';

export type RoleFaction = 'village' | 'wolf' | 'neutral';

interface RoleCardProps {
  role?: Role;
  name: string;
  faction: string;
  factionTone?: RoleFaction;
  description?: string;
  count?: number;
  badge?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function RoleCard({
  role,
  name,
  faction,
  factionTone = 'village',
  description,
  count,
  badge,
  selected = false,
  disabled = false,
  onClick,
}: RoleCardProps) {
  const content = (
    <>
      <span className="ww-role-card__badge">
        {role ? <img src={roleAssetMap[role].src} alt="" aria-hidden="true" /> : badge || '徽'}
      </span>
      <span className="ww-role-card__body">
        <strong>{name}</strong>
        <span className={`ww-role-card__faction ww-role-card__faction--${factionTone}`}>
          {faction}
        </span>
        {description ? <span className="ww-role-card__description">{description}</span> : null}
      </span>
      {count !== undefined ? <span className="ww-role-card__count">{count}</span> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cn('ww-role-card', selected && 'is-selected')}
        disabled={disabled}
        aria-pressed={selected}
        onClick={onClick}
        data-glass-role="panel"
        data-glass-motion="control"
      >
        {content}
      </button>
    );
  }

  return (
    <article
      className={cn('ww-role-card', selected && 'is-selected')}
      data-glass-role="panel"
    >
      {content}
    </article>
  );
}
