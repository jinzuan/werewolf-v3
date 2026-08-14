import type { ReactNode } from 'react';
import { RoomHeader } from '../../features/room-shell/RoomHeader';
import { useRoomShell } from '../../features/room-shell/RoomShellContext';
import { SideNav } from './SideNav';
import { TopStatusBar } from './TopStatusBar';

interface AppShellProps {
  children: ReactNode;
  title: string;
  eyebrow?: string;
  phase?: string;
  countdown?: string;
  live?: boolean;
  progress?: number;
  connected?: boolean;
}

export function AppShell({ children, ...status }: AppShellProps) {
  const inRoom = useRoomShell();

  return (
    <div className="v3-app-shell">
      {inRoom ? <RoomHeader {...status} /> : <TopStatusBar {...status} />}
      <div className="v3-app-shell__body">
        <SideNav />
        <main className="v3-page">{children}</main>
      </div>
    </div>
  );
}
