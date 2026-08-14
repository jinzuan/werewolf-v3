import type {
  RoomMemberKind,
  RoomMemberView,
  RoomSummary,
  RoomView,
} from '../../shared/protocol';

export const waitingRoomNeedsRefresh = (
  room: RoomView,
  summary: RoomSummary | undefined,
): boolean => {
  if (room.status !== 'waiting') return false;
  if (!summary || summary.status !== 'waiting') return true;

  const playerCount = room.members.filter(
    (member) => member.kind === 'player',
  ).length;
  const onlinePlayers = room.members.filter(
    (member) => member.kind === 'player' && member.connected,
  ).length;
  const spectatorCount = room.members.filter(
    (member) => member.kind === 'spectator',
  ).length;

  return (
    summary.playerCount !== playerCount ||
    summary.onlinePlayers !== onlinePlayers ||
    summary.spectatorCount !== spectatorCount
  );
};

const reconcileMembers = (
  room: RoomView,
  kind: RoomMemberKind,
  targetCount: number,
  targetOnline?: number,
): RoomMemberView[] => {
  const viewerId = room.viewer.actorId;
  const existing = room.members
    .filter((member) => member.kind === kind)
    .map((member) => ({ ...member }));
  const members = [
    ...existing.filter((member) => member.id === viewerId),
    ...existing.filter(
      (member) => member.id !== viewerId && member.isHost,
    ),
    ...existing.filter(
      (member) =>
        member.id !== viewerId && !member.isHost && member.connected,
    ),
    ...existing.filter(
      (member) =>
        member.id !== viewerId && !member.isHost && !member.connected,
    ),
  ].slice(0, targetCount);

  while (members.length < targetCount) {
    const order = members.length + 1;
    members.push({
      id: `summary:${room.id}:${kind}:${order}`,
      name:
        kind === 'player'
          ? `玩家 ${order.toString().padStart(2, '0')}`
          : `观战者 ${order.toString().padStart(2, '0')}`,
      kind,
      connected: true,
      isHost: false,
    });
  }

  if (targetOnline === undefined) return members;
  return members.map((member, index) => ({
    ...member,
    connected: index < targetOnline,
  }));
};

export const projectWaitingRoomSummary = (
  room: RoomView,
  summary: RoomSummary,
): RoomView => ({
  ...room,
  name: summary.roomName,
  maxPlayers: summary.maxPlayers,
  auto: summary.auto,
  debugMode: summary.debugMode,
  members: [
    ...reconcileMembers(
      room,
      'player',
      summary.playerCount,
      summary.onlinePlayers,
    ),
    ...reconcileMembers(room, 'spectator', summary.spectatorCount),
  ],
});
