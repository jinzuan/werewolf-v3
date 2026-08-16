import { createContext, useContext } from 'react';
import type { RoomScene } from './scene';

export interface RoomShellContextValue {
  inRoom: boolean;
  scene: RoomScene;
}

export const RoomShellContext = createContext<RoomShellContextValue>({
  inRoom: false,
  scene: 'lobby',
});

export const useRoomShell = (): RoomShellContextValue => useContext(RoomShellContext);
