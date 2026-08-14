import { randomBytes } from 'node:crypto';
import type { Player, Role } from '../../shared/types';
import {
  CURRENT_ROOM_SCHEMA_VERSION,
  type RoomConfigRecord,
  type RoomMember,
  type RoomRecord,
  type RoleSetup,
  type RoomStatus,
} from './types';

export const DEFAULT_RULESET_ID = 'werewolf.v3.default-12p';
export const DEFAULT_RULESET_VERSION = '3.0.0-stage1';
export const DEFAULT_CATALOG_VERSION = 'v3.1';

export const DEFAULT_ROLE_SETUP: RoleSetup = {
  wolf: 4,
  seer: 1,
  witch: 1,
  hunter: 1,
  guardian: 1,
  villager: 4,
};

const ROLE_NAMES: readonly Role[] = [
  'wolf',
  'seer',
  'witch',
  'hunter',
  'guardian',
  'villager',
];

const clone = <T>(value: T): T => structuredClone(value);

const resumeToken = (): string => randomBytes(24).toString('base64url');

const isActiveGame = (status: unknown): boolean =>
  status === 'playing' || status === 'ended' || status === 'starting';

const isFinitePositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const emptyRoleSetup = (): RoleSetup => ({
  wolf: 0,
  seer: 0,
  witch: 0,
  hunter: 0,
  guardian: 0,
  villager: 0,
});

const roleSetupFromPlayers = (players: readonly Player[]): RoleSetup => {
  const setup = emptyRoleSetup();
  for (const player of players) {
    if (player.role && player.role in setup) setup[player.role] += 1;
  }
  return setup;
};

const countRoleSetup = (setup: RoleSetup): number =>
  ROLE_NAMES.reduce((total, role) => total + setup[role], 0);

const hasAssignedRoles = (setup: RoleSetup): boolean =>
  roleSetupTotal(setup) > 0;

const normalizeRoleSetup = (
  value: unknown,
  fallback: RoleSetup,
): RoleSetup => {
  const setup = emptyRoleSetup();
  if (!value || typeof value !== 'object') return clone(fallback);

  for (const role of ROLE_NAMES) {
    const count = (value as Record<string, unknown>)[role];
    setup[role] = isFinitePositiveInteger(count) ? count : 0;
  }
  return hasAssignedRoles(setup) ? setup : clone(fallback);
};

const playerLookup = (room: RoomRecord): Map<string, Player> => {
  const players = room.session?.state.players ?? room.players ?? [];
  return new Map(players.map((player) => [player.id, player]));
};

const normalizeSeatIndex = (
  member: RoomMember,
  player: Player | undefined,
  occupied: Set<number>,
): number | null => {
  if (member.kind !== 'player') return null;

  const preferred =
    typeof member.seatIndex === 'number' &&
    Number.isInteger(member.seatIndex) &&
    member.seatIndex >= 0
      ? member.seatIndex
      : player && Number.isInteger(player.order) && player.order > 0
        ? player.order - 1
        : null;

  if (preferred !== null && !occupied.has(preferred)) {
    occupied.add(preferred);
    return preferred;
  }

  let next = 0;
  while (occupied.has(next)) next += 1;
  occupied.add(next);
  return next;
};

const normalizeMembers = (room: RoomRecord): RoomMember[] => {
  const players = playerLookup(room);
  const occupied = new Set<number>();
  const members = (room.members ?? []).map((source) => {
    const member = clone(source);
    const player = players.get(member.id);
    const isAI = member.isAI ?? player?.isAI ?? false;
    const kind = member.kind ?? 'player';
    const normalized: RoomMember = {
      ...member,
      kind,
      connected: Boolean(member.connected),
      omniscient: Boolean(member.omniscient),
      resumeToken: member.resumeToken || resumeToken(),
      isAI,
      seatIndex:
        kind === 'player'
          ? normalizeSeatIndex(member, player, occupied)
          : null,
      ready:
        kind !== 'player' || isAI
          ? null
          : typeof member.ready === 'boolean'
            ? member.ready
            : Boolean(player?.isReady),
      avatarId: member.avatarId ?? '',
    };
    return normalized;
  });

  // Legacy records occasionally kept a Player without the corresponding
  // member. Preserve the player identity instead of creating a ghost seat.
  const known = new Set(members.map((member) => member.id));
  for (const player of players.values()) {
    if (known.has(player.id)) continue;
    const synthetic: RoomMember = {
      id: player.id,
      name: player.name,
      kind: 'player',
      connected: Boolean(player.isAI),
      omniscient: false,
      resumeToken: resumeToken(),
      avatarId: '',
      isAI: player.isAI,
      seatIndex: normalizeSeatIndex(
        {
          id: player.id,
          name: player.name,
          kind: 'player',
          connected: Boolean(player.isAI),
          omniscient: false,
          resumeToken: '',
        },
        player,
        occupied,
      ),
      ready: player.isAI ? null : Boolean(player.isReady),
    };
    members.push(synthetic);
  }
  return members;
};

const deriveConfig = (room: RoomRecord): RoomConfigRecord => {
  const source = room.config;
  const sessionPlayers = room.session?.state.players ?? room.players ?? [];
  const assignedSetup = roleSetupFromPlayers(sessionPlayers);
  const maxPlayers =
    (source && isFinitePositiveInteger(source.maxPlayers)
      ? source.maxPlayers
      : undefined) ??
    (isFinitePositiveInteger(room.maxPlayers) ? room.maxPlayers : 12);
  const fallbackSetup = isActiveGame(room.status) && hasAssignedRoles(assignedSetup)
    ? assignedSetup
    : maxPlayers === countRoleSetup(DEFAULT_ROLE_SETUP)
      ? DEFAULT_ROLE_SETUP
      : { ...emptyRoleSetup(), villager: maxPlayers };
  const roleSetup = normalizeRoleSetup(source?.roleSetup, fallbackSetup);
  const hasExplicitRuleSet = Boolean(
    source?.rulesetId && source.rulesetVersion && source.catalogVersion,
  );
  const wasMigrated = source === undefined;
  const mode =
    source?.mode ??
    (room.auto
      ? 'quick_computer'
      : sessionPlayers.some((player) => player.isAI)
        ? 'mixed'
        : 'human');
  const aiCount = sessionPlayers.filter((player) => player.isAI).length;

  return {
    ...(source ? clone(source) : {}),
    mode,
    visibility: source?.visibility ?? 'invite_only',
    maxPlayers,
    minHumanPlayers:
      isFinitePositiveInteger(source?.minHumanPlayers) &&
      source.minHumanPlayers <= maxPlayers
        ? source.minHumanPlayers
        : 1,
    aiFillPolicy:
      source?.aiFillPolicy ?? (room.auto ? 'fill_to_max' : 'none'),
    computerSeats:
      isFinitePositiveInteger(source?.computerSeats) ||
      source?.computerSeats === 0
        ? source.computerSeats
        : aiCount,
    roleSetup,
    rulesetId: source?.rulesetId ?? DEFAULT_RULESET_ID,
    rulesetVersion: source?.rulesetVersion ?? DEFAULT_RULESET_VERSION,
    catalogVersion: source?.catalogVersion ?? DEFAULT_CATALOG_VERSION,
    readyPolicy: source?.readyPolicy ?? 'all_connected_humans',
    allowPublicSpectators: source?.allowPublicSpectators ?? false,
    // A migrated waiting record has no proof of the registry/version that
    // created it. Active records derive the display setup from the game that
    // already exists and must never be dealt again.
    rulesetAvailable:
      source?.rulesetAvailable ??
      (hasExplicitRuleSet || isActiveGame(room.status)
        ? true
        : !wasMigrated),
    ...(wasMigrated ? { migratedFrom: 0 } : {}),
  };
};

const normalizeRevision = (value: unknown, fallback = 1): number =>
  isFinitePositiveInteger(value) ? value : fallback;

/** Whether a record needs a storage migration or normalization write. */
export const needsRoomMigration = (room: RoomRecord): boolean =>
  room.schemaVersion !== CURRENT_ROOM_SCHEMA_VERSION ||
  room.roomRevision === undefined ||
  room.configRevision === undefined ||
  room.config === undefined ||
  room.updatedAt === undefined ||
  room.members.some(
    (member) =>
      member.seatIndex === undefined ||
      member.isAI === undefined ||
      member.ready === undefined,
  );

/**
 * Upgrade a legacy room into the current private schema.
 *
 * The function is deliberately idempotent. In particular, it only derives a
 * display role setup for an active legacy game; it never changes `players` or
 * `session`, so restoring an old playing room cannot deal a second time.
 */
export const migrateRoomRecord = (input: RoomRecord): RoomRecord => {
  const room = clone(input);
  const status = room.status as RoomStatus;
  const config = deriveConfig(room);
  const migrated: RoomRecord = {
    ...room,
    code: room.code.toUpperCase(),
    status,
    members: normalizeMembers(room),
    schemaVersion: CURRENT_ROOM_SCHEMA_VERSION,
    roomRevision: normalizeRevision(room.roomRevision),
    configRevision: normalizeRevision(room.configRevision),
    configLocked:
      room.configLocked ??
      (status === 'ready_check' ||
        status === 'starting' ||
        status === 'playing' ||
        status === 'ended'),
    config,
    ...(room.session?.state.gameId || room.gameId
      ? { gameId: room.gameId ?? room.session?.state.gameId }
      : {}),
    recentRoomCommands: (room.recentRoomCommands ?? []).map((command) =>
      clone(command),
    ),
    createdAt: room.createdAt ?? Date.now(),
    updatedAt: room.updatedAt ?? room.createdAt ?? Date.now(),
  };
  return migrated;
};

export const migrateRoomRecords = (rooms: readonly RoomRecord[]): RoomRecord[] =>
  rooms.map(migrateRoomRecord);

export const roleSetupTotal = (setup: RoleSetup): number =>
  ROLE_NAMES.reduce((total, role) => total + (setup[role] ?? 0), 0);

export const hasRoleSetupForPlayers = (
  setup: RoleSetup,
  players: readonly Player[],
): boolean =>
  roleSetupTotal(setup) === players.length &&
  players.every((player) => player.role !== null);
