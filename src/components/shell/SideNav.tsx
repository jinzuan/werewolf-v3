import { Gamepad2, House, Settings, X } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useV3Store } from '../../stores/v3Store';
import { roomPath } from '../../app/routes/roomRouting';

export function SideNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const roomCode = useV3Store((state) => state.session?.roomCode);
  const navItems = [
    { to: '/lobby', label: '大厅', icon: House },
    ...(roomCode
      ? [{
          to: roomPath(roomCode),
          label: '房间',
          icon: Gamepad2,
        }]
      : []),
    { to: '/settings', label: '设置', icon: Settings },
  ];

  return (
    <>
      <button
        type="button"
        className={`v3-side-nav__backdrop${open ? ' is-visible' : ''}`}
        aria-label="关闭导航"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />
      <nav
        id="v3-side-nav"
        className={`v3-side-nav${open ? ' is-open' : ''}`}
        aria-label="主导航"
        aria-hidden={!open}
      >
        <div className="v3-side-nav__header">
          <strong>村庄导航</strong>
          <button type="button" className="v3-button v3-button--icon" aria-label="关闭导航" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="v3-side-nav__items">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/lobby'}
              title={label}
              onClick={onClose}
              className={({ isActive }) => isActive ? 'is-active' : undefined}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </>
  );
}
