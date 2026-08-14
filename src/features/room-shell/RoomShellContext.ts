import { createContext, useContext } from 'react';

export const RoomShellContext = createContext(false);

export const useRoomShell = (): boolean => useContext(RoomShellContext);
