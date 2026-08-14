import type {
  RoomMemberKind,
  RoomMemberView,
  RoomSummary,
  RoomView,
} from '../../shared/protocol';

/**
 * RoomSummary is a lobby projection.  It can tell us that a room changed,
 * but it cannot tell us who is in the room.  Waiting-room authority therefore
 * comes only from RoomView broadcasts or the explicit room.get fallback.
 */
export const waitingRoomNeedsRefresh = (
  room: RoomView,
  summary: RoomSummary | undefined,
): boolean => {
  if (!['waiting', 'ready_check', 'starting'].includes(room.status)) {
    return false;
  }
  if (!summary || summary.status !== room.status) return true;

  const playerCount = room.members.filter(
    (member) => member.kind === 'player',
  ).length;
  const onlinePlayers = room.members.filter(
    (member) => member.kind === 'player' && member.connected,
  ).length;
  const spectatorCount = room.members.filter(
    (member) => member.kind === 'spectator',
  ).length;
  const readyCount = room.members.filter(
    (member) => member.kind === 'player' && member.ready === true,
  ).length;

  return (
    summary.playerCount !== playerCount ||
    summary.onlinePlayers !== onlinePlayers ||
    summary.spectatorCount !== spectatorCount ||
    summary.readyCount !== readyCount
  );
};

/**
 * Kept as a source-compatible no-op for callers from the pre-M6 store.  A
 * V3.1 summary is never allowed to manufacture members, names, seats, or
 * connection state.  The M6 coordinator does not call this function.
 */
export const projectWaitingRoomSummary = (
  room: RoomView,
  _summary: RoomSummary,
): RoomView => room;

/** True when a member is a real player seat rather than a spectator. */
export const isPlayerMember = (
  member: RoomMemberView,
): boolean => member.kind === 'player' && member.seatIndex !== null;

export const membersOfKind = (
  room: RoomView,
  kind: RoomMemberKind,
): RoomMemberView[] => room.members.filter((member) => member.kind === kind);
