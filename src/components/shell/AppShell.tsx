import { useEffect, useState, type ReactNode } from 'react';
import { RoomHeader } from '../../features/room-shell/RoomHeader';
import { sceneForRoom } from '../../features/room-shell/scene';
import { useRoomShell } from '../../features/room-shell/RoomShellContext';
import { useV3Store } from '../../stores/v3Store';
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
  const room = useV3Store((state) => state.room);
  const snapshot = useV3Store((state) => state.snapshot);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const scene = sceneForRoom(room?.status, snapshot?.gameState);

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
