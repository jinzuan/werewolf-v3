import { createContext, useContext, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

const RoomShellContext = createContext(false);

/** Marks the nested route so existing V3 pages consume the shared header. */
export function RoomLayout({ children }: { children?: ReactNode }) {
  return (
    <RoomShellContext.Provider value>
      {children ?? <Outlet />}
    </RoomShellContext.Provider>
  );
}

export const useRoomShell = (): boolean => useContext(RoomShellContext);

