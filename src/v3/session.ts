import type { ProjectedSnapshot } from '../../shared/events';
import type {
  IdentityCredentials,
  RoomView,
} from '../../shared/protocol';

export const V3_SESSION_KEY = 'werewolf-v3-session';
export const V3_SESSION_VERSION = 2 as const;

export interface V3Session {
  version: typeof V3_SESSION_VERSION;
  actorId: string;
  actorName: string;
  roomCode: string;
  roomId: string;
  credentials: IdentityCredentials;
  mode: 'player' | 'spectator';
  gameId?: string;
  lastSeenSeq: number;
}

export interface V3AuthorityState {
  room: RoomView | null;
  session: V3Session | null;
  snapshot: ProjectedSnapshot | null;
  events: import('../../shared/events').DomainEvent[];
}

export const createEmptyAuthorityState = (): V3AuthorityState => ({
  room: null,
  session: null,
  snapshot: null,
  events: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const createV3Session = (
  room: RoomView,
  credentials: IdentityCredentials,
  actorName: string,
  previous?: Pick<V3Session, 'gameId' | 'lastSeenSeq'>,
): V3Session => ({
  version: V3_SESSION_VERSION,
  actorId: room.viewer.actorId,
  actorName,
  roomCode: room.code,
  roomId: room.id,
  credentials: { ...credentials },
  mode: room.viewer.kind,
  gameId: room.gameId,
  lastSeenSeq:
    previous?.gameId && previous.gameId === room.gameId
      ? previous.lastSeenSeq
      : 0,
});

export const readV3Session = (
  storage: Pick<Storage, 'getItem'>,
): V3Session | null => {
  try {
    const raw = storage.getItem(V3_SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      value.version !== V3_SESSION_VERSION ||
      typeof value.actorId !== 'string' ||
      typeof value.actorName !== 'string' ||
      typeof value.roomCode !== 'string' ||
      typeof value.roomId !== 'string' ||
      !isRecord(value.credentials) ||
      typeof value.credentials.resumeToken !== 'string' ||
      (value.mode !== 'player' && value.mode !== 'spectator') ||
      typeof value.lastSeenSeq !== 'number'
    ) {
      return null;
    }
    return value as unknown as V3Session;
  } catch {
    return null;
  }
};

export const writeV3Session = (
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  session: V3Session | null,
): void => {
  if (session) {
    storage.setItem(V3_SESSION_KEY, JSON.stringify(session));
  } else {
    storage.removeItem(V3_SESSION_KEY);
  }
};

const SENSITIVE_KEYS = new Set([
  'joinToken',
  'resumeToken',
  'omniscientToken',
  'session',
]);

const ROOM_PRIVATE_KEYS = new Set([
  ...SENSITIVE_KEYS,
  'players',
  'role',
  'gameState',
]);

const PUBLIC_SPECTATOR_PRIVATE_STATE_KEYS = [
  'nightActions',
  'actionDone',
  'votes',
  'wolfVotes',
  'wolfSpeakerOrder',
  'wolfCurrentSpeaker',
  'wolfDiscussionRound',
  'wolfVoteComplete',
  'guardianLastTarget',
  'guardianActionComplete',
  'witchHasHealPotion',
  'witchHasPoisonPotion',
  'witchActionComplete',
  'witchAntidoteUsed',
] as const;

const containsKeys = (
  value: unknown,
  forbiddenKeys: ReadonlySet<string>,
  seen = new Set<object>(),
): boolean => {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsKeys(item, forbiddenKeys, seen),
    );
  }
  return Object.entries(value).some(
    ([key, item]) =>
      forbiddenKeys.has(key) ||
      containsKeys(item, forbiddenKeys, seen),
  );
};

export const containsSensitiveKeys = (
  value: unknown,
): boolean => containsKeys(value, SENSITIVE_KEYS);

export const isPublicRoomViewSafe = (room: RoomView): boolean =>
  !containsKeys(room, ROOM_PRIVATE_KEYS);

export const isSnapshotSafeForViewer = (
  snapshot: ProjectedSnapshot,
): boolean => {
  if (containsSensitiveKeys(snapshot)) return false;
  if (snapshot.viewer.kind === 'spectator') {
    if (snapshot.viewer.omniscient) return true;
    return snapshot.players.every((player) => player.role === null) &&
      PUBLIC_SPECTATOR_PRIVATE_STATE_KEYS.every(
        (key) => !hasOwn(snapshot.gameState, key),
      );
  }

  const viewer = snapshot.viewer;
  if (
    viewer.role !== 'wolf' &&
    [
      'wolfVotes',
      'wolfSpeakerOrder',
      'wolfCurrentSpeaker',
      'wolfDiscussionRound',
      'wolfVoteComplete',
    ].some((key) => hasOwn(snapshot.gameState, key))
  ) {
    return false;
  }
  if (
    viewer.role !== 'guardian' &&
    [
      'guardianLastTarget',
      'guardianActionComplete',
    ].some((key) => hasOwn(snapshot.gameState, key))
  ) {
    return false;
  }
  if (
    viewer.role !== 'witch' &&
    [
      'witchHasHealPotion',
      'witchHasPoisonPotion',
      'witchActionComplete',
      'witchAntidoteUsed',
    ].some((key) => hasOwn(snapshot.gameState, key))
  ) {
    return false;
  }
  if (
    (snapshot.gameState.nightActions ?? []).some(
      (action) => action.playerId !== viewer.playerId,
    ) ||
    Object.keys(snapshot.gameState.actionDone ?? {}).some(
      (playerId) => playerId !== viewer.playerId,
    )
  ) {
    return false;
  }
  return snapshot.players.every((player) => {
    if (player.id === viewer.playerId) return true;
    if (viewer.role === 'wolf') {
      return player.role === null || player.role === 'wolf';
    }
    return player.role === null;
  });
};

export const snapshotMatchesSession = (
  snapshot: ProjectedSnapshot,
  session: V3Session,
): boolean => {
  if (
    snapshot.roomId !== session.roomId ||
    (session.gameId !== undefined && snapshot.gameId !== session.gameId)
  ) {
    return false;
  }
  return snapshot.viewer.kind === 'player'
    ? snapshot.viewer.playerId === session.actorId
    : snapshot.viewer.spectatorId === session.actorId;
};

/** RoomView is accepted only for the currently authenticated room identity. */
export const roomViewMatchesSession = (
  room: RoomView,
  session: V3Session,
): boolean =>
  room.id === session.roomId &&
  room.code === session.roomCode &&
  room.viewer.actorId === session.actorId;

/** ACKs and broadcasts use the same monotonic room revision rule. */
export const acceptsRoomRevision = (
  incoming: RoomView,
  current: RoomView | null,
): boolean =>
  current === null ||
  (incoming.id === current.id &&
    incoming.code === current.code &&
    incoming.roomRevision >= current.roomRevision);
