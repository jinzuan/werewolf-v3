import type { GameCommand, GameCommandMeta } from '../../shared/protocol';
import type { CreateRoomOptionsV31 } from '../../shared/roomContract';
import type { Player, Role } from '../../shared/types';
import type { GameSession } from '../session/gameSession';

export const roles: readonly Role[] = [
  'guardian',
  'seer',
  'wolf',
  'wolf',
  'wolf',
  'wolf',
  'witch',
  'hunter',
  'villager',
  'villager',
  'villager',
  'villager',
];

export const createPlayers = (roomId = 'room-1'): Player[] =>
  roles.map((role, index) => ({
    id: `${role}-${index + 1}`,
    roomId,
    name: `${role}-${index + 1}`,
    isAI: false,
    role,
    isAlive: true,
    isHost: index === 0,
    order: index + 1,
    isReady: true,
  }));

/** Build test rooms from the same catalog-backed V3.1 contract as production. */
export const createRoomOptions = (
  rooms: { getCatalog: () => { catalogVersion: string; rolePresets: Array<{
    enabled: boolean;
    playerCount: number;
    roleSetup: Record<Role, number>;
    id: string;
    rulesetId: string;
    rulesetVersion: string;
  }> } },
  roomName = 'V3 test room',
  overrides: Partial<CreateRoomOptionsV31> = {},
): CreateRoomOptionsV31 => {
  const catalog = rooms.getCatalog();
  const preset = catalog.rolePresets.find((item) => item.enabled);
  if (!preset) throw new Error('test catalog has no enabled role preset');
  return {
    catalogVersion: catalog.catalogVersion,
    roomName,
    creator: { name: 'Host', avatarId: 'avatar-player' },
    mode: 'mixed',
    visibility: 'invite_only',
    maxPlayers: preset.playerCount,
    minHumanPlayers: 1,
    computerSeats: 0,
    aiFillPolicy: 'fill_to_max',
    roleSetup: { ...preset.roleSetup },
    rolePresetId: preset.id,
    rulesetId: preset.rulesetId,
    rulesetVersion: preset.rulesetVersion,
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    reviewEnabled: false,
    ...overrides,
  };
};

export const createRequest = (
  rooms: Parameters<typeof createRoomOptions>[0],
  actorId: string,
  createRequestId: string,
  roomName = 'V3 test room',
  overrides: Partial<CreateRoomOptionsV31> = {},
) => ({
  actorId,
  createRequestId,
  options: createRoomOptions(rooms, roomName, overrides),
});

export const startRoom = async (
  rooms: {
    get: (roomCode: string, actorId: string) => Promise<{ roomRevision: number; status: 'waiting' | 'ready_check' }>;
    beginReadyCheck: (identity: unknown, revision: number, commandId: string) => Promise<{ roomRevision: number }>;
    setReady: (identity: unknown, ready: boolean, revision: number, commandId: string) => Promise<{ roomRevision: number }>;
    startGame: (identity: unknown, command: { commandId: string; expectedRoomRevision: number }) => Promise<unknown>;
  },
  identity: unknown & { roomCode?: string; actorId?: string },
  commandPrefix = 'test-start',
) => {
  const typedIdentity = identity as { roomCode: string; actorId: string };
  const current = await rooms.get(typedIdentity.roomCode, typedIdentity.actorId);
  const checking = current.status === 'ready_check'
    ? current
    : await rooms.beginReadyCheck(identity, current.roomRevision, `${commandPrefix}-ready-check`);
  const ready = await rooms.setReady(identity, true, checking.roomRevision, `${commandPrefix}-ready`);
  return rooms.startGame(identity, {
    commandId: `${commandPrefix}-start`,
    expectedRoomRevision: ready.roomRevision,
  });
};

let commandSequence = 0;

export const dispatch = (
  session: GameSession,
  actorId: string,
  command: GameCommand,
) => {
  commandSequence += 1;
  const meta: GameCommandMeta = {
    commandId: `test-${commandSequence}`,
    actorId,
    sentAt: Date.now(),
    roomId: session.serialize().state.roomId,
    gameId: session.gameId,
    expectedStageRevision: session.stageRevision,
  };
  return session.dispatch(meta, command);
};

export const confirmRoles = async (
  session: GameSession,
  players: readonly Player[] = session.players,
): Promise<void> => {
  if (session.serialize().state.gameState.phase !== 'role_confirm') return;
  for (const player of players) {
    await dispatch(session, player.id, {
      type: 'game.confirm_role',
      payload: {},
    });
  }
};

export const initializeSession = async (
  session: GameSession,
  players: readonly Player[] = session.players,
): Promise<void> => {
  await session.initialize();
  await confirmRoles(session, players);
};
