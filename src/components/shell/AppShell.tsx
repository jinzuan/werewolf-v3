import type { ReactNode } from 'react';
import { RoomHeader } from '../../features/room-shell/RoomHeader';
import { useRoomShell } from '../../features/room-shell/RoomShellContext';
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
  pageClassName?: string;
}

export function AppShell({ children, pageClassName, ...status }: AppShellProps) {
  const { inRoom, scene } = useRoomShell();

  return (
    <div className="v3-app-shell" data-scene={scene}>
      {inRoom ? (
        <RoomHeader {...status} scene={scene} />
      ) : (
        <TopStatusBar {...status} scene={scene} />
      )}
      <div className="v3-app-shell__body">
        <main className={`v3-page ${pageClassName ?? ''}`.trim()}>{children}</main>
      </div>
    </div>
  );
}
