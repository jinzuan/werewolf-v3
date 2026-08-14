import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { RoomShellContext } from './RoomShellContext';

/** Marks the nested route so existing V3 pages consume the shared header. */
export function RoomLayout({ children }: { children?: ReactNode }) {
  return (
    <RoomShellContext.Provider value>
      {children ?? <Outlet />}
    </RoomShellContext.Provider>
  );
}
