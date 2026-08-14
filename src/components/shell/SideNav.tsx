import { Gamepad2, House, Settings } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useV3Store } from '../../stores/v3Store';

export function SideNav() {
  const roomCode = useV3Store((state) => state.session?.roomCode);
  const navItems = [
    { to: '/', label: '大厅', icon: House },
    ...(roomCode
      ? [{
          to: `/room/${roomCode}`,
          label: '房间',
          icon: Gamepad2,
        }]
      : []),
    { to: '/settings', label: '设置', icon: Settings },
  ];

  return (
    <nav className="v3-side-nav" aria-label="主导航">
      {navItems.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          title={label}
          className={({ isActive }) => isActive ? 'is-active' : undefined}
        >
          <Icon size={18} aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
