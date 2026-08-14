import type {
  IdentityCredentials,
  RoomAccess,
  RoomCreateOptions,
  RoomSummary,
  RoomView,
} from '../../shared/protocol';
import type { Player, Role } from '../../shared/types';
import type { SessionSnapshot } from '../session/types';

export interface RoomMember {
  id: string;
  name: string;
  kind: 'player' | 'spectator';
  connected: boolean;
  omniscient: boolean;
  resumeToken: string;
}

export interface RoomRecord {
  id: string;
  code: string;
  name: string;
  joinToken: string;
  omniscientToken: string;
  hostId: string;
  maxPlayers: number;
  status: RoomSummary['status'];
  auto: boolean;
  debugMode: boolean;
  members: RoomMember[];
  players: Player[];
  session?: SessionSnapshot;
  createdAt: number;
}

export interface CreateRoomRequest {
  actorId: string;
  options: RoomCreateOptions;
}

export interface JoinRoomRequest {
  actorId: string;
  name: string;
  roomCode: string;
  joinToken?: string;
  spectator?: boolean;
  omniscientToken?: string;
}

export type { IdentityCredentials, RoomAccess, RoomView };

export interface SocketIdentity {
  actorId: string;
  roomCode: string;
  roomId: string;
  kind: RoomMember['kind'];
  omniscient: boolean;
  resumeToken: string;
  gameId?: string;
}

export const ROLE_DECK: readonly Role[] = [
  'wolf',
  'wolf',
  'wolf',
  'wolf',
  'seer',
  'witch',
  'hunter',
  'guardian',
  'villager',
  'villager',
  'villager',
  'villager',
];
