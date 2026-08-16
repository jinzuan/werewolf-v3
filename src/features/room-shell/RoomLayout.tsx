import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { useV3Store } from '../../stores/v3Store';
import { RoomShellContext } from './RoomShellContext';
import { sceneForRoom } from './scene';

/** Marks the nested route so existing V3 pages consume the shared header. */
export function RoomLayout({ children }: { children?: ReactNode }) {
  const room = useV3Store((state) => state.room);
  const snapshot = useV3Store((state) => state.snapshot);
  const scene = sceneForRoom(room?.status, snapshot?.gameState);

  return (
    <RoomShellContext.Provider value={{ inRoom: true, scene }}>
      {children ?? <Outlet />}
    </RoomShellContext.Provider>
  );
}
