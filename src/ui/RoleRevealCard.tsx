import { CircleHelp, Eye, EyeOff } from 'lucide-react';
import type { Role } from '../../shared/types';
import { ROLE_LABELS } from '../v3/presentation';
import { roleAssetMap } from './assetRegistry';

interface RoleRevealCardProps {
  role: Role;
  faction: string;
  factionTone: 'village' | 'wolf';
  description: string;
  revealed: boolean;
  infoOpen: boolean;
  onReveal: () => void;
  onToggleInfo: () => void;
}

/** A private, keyboard-accessible identity reveal used during role confirmation. */
export function RoleRevealCard({
  role,
  faction,
  factionTone,
  description,
  revealed,
  infoOpen,
  onReveal,
  onToggleInfo,
}: RoleRevealCardProps) {
  const roleName = ROLE_LABELS[role];
  return (
    <div className={`ww-role-reveal ${revealed ? 'is-revealed' : ''}`}>
      <button
        type="button"
        className="ww-role-reveal__card"
        aria-label={revealed ? `身份是${roleName}` : '揭晓身份牌'}
        aria-pressed={revealed}
        onClick={onReveal}
        data-glass-role="panel"
        data-glass-motion="control"
      >
        <span className="ww-role-reveal__face ww-role-reveal__face--front" aria-hidden={revealed}>
          <span className="ww-role-reveal__moon">✦</span>
          <strong>身份牌</strong>
          <span>点击揭晓</span>
        </span>
        <span className="ww-role-reveal__face ww-role-reveal__face--back" aria-hidden={!revealed}>
          <span className="ww-role-reveal__badge">
            <img src={roleAssetMap[role].src} alt="" aria-hidden="true" />
          </span>
          <span className="ww-role-reveal__body">
            <strong>{roleName}</strong>
            <span className={`ww-role-reveal__faction ww-role-reveal__faction--${factionTone}`}>
              {faction}
            </span>
            <span className="ww-role-reveal__hint">点击卡牌可重新查看</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="ww-role-reveal__info-button"
        aria-label={`${roleName}角色说明`}
        aria-expanded={infoOpen}
        data-glass-role="control"
        data-glass-motion="control"
        onClick={(event) => {
          event.stopPropagation();
          onToggleInfo();
        }}
      >
        {infoOpen ? <EyeOff size={16} /> : <CircleHelp size={16} />}
      </button>
      <div
        className={`ww-role-reveal__popover ${infoOpen ? 'is-open' : ''}`}
        role="status"
        data-glass-role="item"
      >
        <strong>{roleName}怎么玩</strong>
        <span>{description}</span>
      </div>
      <span className="ww-role-reveal__assistive">
        {revealed ? `${roleName}。${description}` : '身份牌尚未揭晓。'}
      </span>
      {!revealed ? <Eye size={15} className="ww-role-reveal__eye" aria-hidden="true" /> : null}
    </div>
  );
}
