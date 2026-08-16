import { useEffect, useState, type ReactNode } from 'react';
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
  const { inRoom, scene } = useRoomShell();
  const [navigationOpen, setNavigationOpen] = useState(false);

  useEffect(() => {
    setNavigationOpen(false);
  }, [inRoom, status.title]);

  return (
    <div className="v3-app-shell" data-scene={scene}>
      {inRoom ? (
        <RoomHeader {...status} scene={scene} onMenu={() => setNavigationOpen(true)} />
      ) : (
        <TopStatusBar {...status} scene={scene} onMenu={() => setNavigationOpen(true)} />
      )}
      <div className="v3-app-shell__body">
        <SideNav open={navigationOpen} onClose={() => setNavigationOpen(false)} />
        <main className="v3-page">{children}</main>
      </div>
    </div>
  );
}
