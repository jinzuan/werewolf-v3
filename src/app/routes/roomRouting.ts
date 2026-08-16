import type { RoomStatus, RoomView } from '../../../shared/protocol';

/** The only view segments that can be selected by a room URL. */
export const ROOM_VIEW_SEGMENTS = [
  'waiting',
  'play',
  'watch',
  'monitor',
  'result',
] as const;

export type RoomViewSegment = (typeof ROOM_VIEW_SEGMENTS)[number];
export type RoomJoinIntent = 'play' | 'watch';

export const WAITING_ROOM_STATUSES: readonly RoomStatus[] = [
  'waiting',
  'ready_check',
  'starting',
];

const isRoomViewSegment = (value: string): value is RoomViewSegment =>
  (ROOM_VIEW_SEGMENTS as readonly string[]).includes(value);

/** Room codes are identifiers, never credentials. Keep their URL form stable. */
export const normalizeRoomCode = (value: string | undefined | null): string =>
  (value ?? '').trim().toUpperCase();

export const roomPath = (
  roomCode: string,
  view?: RoomViewSegment,
): string => {
  const code = normalizeRoomCode(roomCode);
  return `/rooms/${encodeURIComponent(code)}${view ? `/${view}` : ''}`;
};

/** Invitation codes may be in a URL; join/resume credentials may not. */
export const roomJoinPath = (roomCode?: string): string => {
  const code = normalizeRoomCode(roomCode);
  return code
    ? `/rooms/join?code=${encodeURIComponent(code)}`
    : '/rooms/join';
};

/**
 * Build the only URL that is safe to put in an invitation. Credentials are
 * deliberately not accepted by this API; the join page collects the口令 in
 * memory after opening the link.
 */
export const joinInviteUrl = (
  origin: string,
  roomCode: string,
  intent: RoomJoinIntent = 'play',
): string => {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new TypeError('邀请链接 origin 无效');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('邀请链接必须使用 HTTP(S) 同源地址');
  }
  const url = new URL('/rooms/join', base.origin);
  const code = normalizeRoomCode(roomCode);
  if (code) url.searchParams.set('code', code);
  url.searchParams.set('intent', intent === 'watch' ? 'watch' : 'play');
  return url.toString();
};

export const roomStatusLabel = (status: RoomStatus): string => {
  switch (status) {
    case 'waiting':
      return '等待加入';
    case 'ready_check':
      return '准备确认';
    case 'starting':
      return '即将开始';
    case 'playing':
      return '对局进行中';
    case 'ended':
      return '对局已结束';
  }
};

/**
 * Resolve a room URL from server authority. This function deliberately does
 * not inspect a requested mode, local storage mode, or URL query flag.
 */
export const canonicalRoomView = (room: RoomView): RoomViewSegment => {
  if (room.status === 'ended') return 'result';
  if (WAITING_ROOM_STATUSES.includes(room.status)) return 'waiting';
  if (room.viewer.kind === 'player') return 'play';
  return room.viewer.omniscient ? 'monitor' : 'watch';
};

export const canonicalRoomPath = (room: RoomView): string =>
  roomPath(room.code, canonicalRoomView(room));

/** Return the requested child segment, or null for an unknown child path. */
export const requestedRoomView = (
  pathname: string,
): RoomViewSegment | null => {
  const segments = pathname.split('/').filter(Boolean);
  const candidate = segments[segments.length - 1] ?? '';
  return isRoomViewSegment(candidate) ? candidate : null;
};

/** Name kept explicit for route tests and callers that need the decision. */
export const resolveRoomDestination = (
  room: RoomView,
  _requested: RoomViewSegment | null = null,
): RoomViewSegment => canonicalRoomView(room);
