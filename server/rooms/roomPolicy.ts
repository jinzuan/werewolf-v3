import {
  ALLOWED_ROOM_ACTIONS,
  type AllowedRoomAction,
  type RoomCounts,
  type RoomStatus,
  type StartCheck,
  type StartCheckItem,
  type StartCheckKey,
} from '../../shared/roomContract';
import type { ProtocolErrorCode } from '../../shared/protocol';
import { defaultRulesetRegistry } from '../rulesets/registry';
import type { RulesetRegistryLike } from '../rulesets/types';
import {
  countComputerPlayers,
  countHumanPlayers,
  countPlayerMembers,
  inspectSeatLayout,
} from './seatAllocator';
import { roleSetupTotal } from './roomMigration';
import type { RoomMember, RoomRecord } from './types';

export interface RoomPolicyOptions {
  registry?: RulesetRegistryLike;
  /** Optional M1 validator seam for callers that already validate a config. */
  isConfigValid?: (room: RoomRecord) => boolean;
  /** Runtime-only connection fact; it is never persisted with a RoomRecord. */
  isConnected?: (roomCode: string, memberId: string) => boolean;
}

export type RoomPolicyInput = RoomPolicyOptions | RulesetRegistryLike;

export interface PolicyFailure {
  code: ProtocolErrorCode;
  messageKey: string;
  affectedMemberIds?: string[];
  params?: Record<string, string | number>;
}

export class RoomPolicyError extends Error {
  constructor(public readonly failure: PolicyFailure) {
    super(failure.messageKey);
    this.name = 'RoomPolicyError';
  }

  get code(): ProtocolErrorCode {
    return this.failure.code;
  }

  get messageKey(): string {
    return this.failure.messageKey;
  }

  get affectedMemberIds(): string[] {
    return [...(this.failure.affectedMemberIds ?? [])];
  }

  get params(): Record<string, string | number> | undefined {
    return this.failure.params
      ? { ...this.failure.params }
      : undefined;
  }
}

const player = (member: RoomMember): boolean => member.kind === 'player';
const human = (member: RoomMember): boolean => player(member) && !member.isAI;
const statusOf = (room: RoomRecord): RoomStatus => room.status as RoomStatus;
const ROLE_KEYS = ['wolf', 'seer', 'witch', 'hunter', 'guardian', 'villager'] as const;

const normalizeOptions = (options: RoomPolicyInput = {}): RoomPolicyOptions =>
  'isAvailable' in options && 'getCatalog' in options
    ? { registry: options }
    : options;

const configFor = (room: RoomRecord): RoomRecord['config'] => room.config;

const countRoleSetup = (room: RoomRecord): number => {
  const setup = configFor(room)?.roleSetup;
  return setup ? roleSetupTotal(setup) : 0;
};

const isValidConfigShape = (room: RoomRecord): boolean => {
  const config = configFor(room);
  if (!config) return false;
  if (!['human', 'mixed', 'quick_computer'].includes(config.mode)) return false;
  if (!['invite_only', 'listed'].includes(config.visibility)) return false;
  if (!['none', 'fixed', 'fill_to_max'].includes(config.aiFillPolicy)) return false;
  if (config.readyPolicy !== 'all_connected_humans') return false;
  if (
    typeof config.catalogVersion !== 'string' ||
    config.catalogVersion.length === 0 ||
    typeof config.rulesetId !== 'string' ||
    config.rulesetId.length === 0 ||
    typeof config.rulesetVersion !== 'string' ||
    config.rulesetVersion.length === 0 ||
    typeof config.allowPublicSpectators !== 'boolean' ||
    (config.reviewEnabled !== undefined && typeof config.reviewEnabled !== 'boolean') ||
    (config.reviewMode !== undefined && config.reviewMode !== 'rules' && config.reviewMode !== 'ai')
  ) {
    return false;
  }
  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers <= 0) return false;
  if (
    !Number.isInteger(config.minHumanPlayers) ||
    config.minHumanPlayers < 0 ||
    config.minHumanPlayers > config.maxPlayers
  ) {
    return false;
  }
  if (
    !Number.isInteger(config.computerSeats) ||
    config.computerSeats < 0 ||
    config.computerSeats > config.maxPlayers
  ) {
    return false;
  }
  if (!config.roleSetup || typeof config.roleSetup !== 'object') return false;
  const roleSetupKeys = Object.keys(config.roleSetup);
  if (roleSetupKeys.some((key) => !(ROLE_KEYS as readonly string[]).includes(key))) {
    return false;
  }
  if (ROLE_KEYS.some((role) => !(role in config.roleSetup!))) return false;
  if (!Object.values(config.roleSetup).every(
    (count) => Number.isInteger(count) && count >= 0,
  )) {
    return false;
  }
  if (config.mode === 'human') {
    return config.aiFillPolicy === 'none' &&
      config.computerSeats === 0 &&
      config.minHumanPlayers === config.maxPlayers;
  }
  if (config.mode === 'quick_computer') {
    return config.aiFillPolicy === 'fill_to_max' &&
      config.computerSeats === 0 &&
      config.minHumanPlayers === 0;
  }
  if (config.aiFillPolicy === 'fixed') {
    return config.computerSeats > 0 &&
      config.minHumanPlayers + config.computerSeats <= config.maxPlayers;
  }
  return config.aiFillPolicy === 'fill_to_max' && config.computerSeats === 0;
};

const checkItem = (
  key: StartCheckKey,
  passed: boolean,
  messageKey: string,
  params?: Record<string, string | number>,
  affectedMemberIds?: string[],
): StartCheckItem => ({
  key,
  passed,
  messageKey,
  ...(params ? { params } : {}),
  ...(affectedMemberIds && affectedMemberIds.length > 0
    ? { affectedMemberIds: [...affectedMemberIds] }
    : {}),
});

const checkAiFill = (room: RoomRecord): {
  passed: boolean;
  params: Record<string, number>;
  affectedMemberIds: string[];
} => {
  const config = configFor(room);
  if (!config) {
    return {
      passed: false,
      params: { expected: 0, actual: 0, max: 0 },
      affectedMemberIds: [],
    };
  }
  const humans = countHumanPlayers(room.members);
  const computers = countComputerPlayers(room.members);
  const computerIds = room.members
    .filter((member) => player(member) && Boolean(member.isAI))
    .map((member) => member.id);
  let expectedComputers: number;
  switch (config.aiFillPolicy) {
    case 'none':
      expectedComputers = 0;
      break;
    case 'fixed':
      expectedComputers = config.computerSeats;
      break;
    case 'fill_to_max':
      expectedComputers = config.maxPlayers - humans;
      break;
  }
  const finalPlayerCount = humans + expectedComputers;
  const passed =
    expectedComputers >= 0 &&
    finalPlayerCount === config.maxPlayers &&
    computers <= expectedComputers;
  return {
    passed,
    params: {
      expected: expectedComputers,
      actual: computers,
      max: config.maxPlayers,
      missing: Math.max(0, expectedComputers - computers),
    },
    affectedMemberIds: passed ? [] : computerIds,
  };
};

/** Validate the persisted non-secret AI tuning without reading SecretStore. */
const checkAIProviderConfig = (room: RoomRecord): boolean | undefined => {
  const config = configFor(room);
  if (config?.credentialSchemaAmbiguous || config?.credentialRotationRequired) return false;
  if (!config?.aiProviderConfig) return undefined;
  const provider = config.aiProviderConfig;
  const shapeValid =
    ['siliconflow', 'deepseek', 'local', 'custom'].includes(provider.provider) &&
    typeof provider.model === 'string' && provider.model.trim().length > 0 &&
    typeof provider.endpoint === 'string' && provider.endpoint.trim().length > 0 &&
    Number.isFinite(provider.temperature) &&
    Number.isSafeInteger(provider.maxTokens) &&
    ['aggressive', 'conservative', 'random'].includes(provider.behavior);
  if (!shapeValid) return false;
  if (provider.provider === 'siliconflow' || provider.provider === 'deepseek') {
    return typeof config.credentialRef === 'string' && config.credentialRef.length > 0;
  }
  return true;
};

const checkRuleset = (
  room: RoomRecord,
  registry: RulesetRegistryLike,
): boolean => {
  const config = configFor(room);
  return Boolean(
    config &&
      config.rulesetAvailable !== false &&
      typeof config.rulesetId === 'string' &&
      typeof config.rulesetVersion === 'string' &&
      registry.isAvailable(config.rulesetId, config.rulesetVersion),
  );
};

const checkConfig = (
  room: RoomRecord,
  options: RoomPolicyOptions,
): boolean =>
  options.isConfigValid
    ? options.isConfigValid(room)
    : isValidConfigShape(room);

const connectedOf = (
  room: RoomRecord,
  member: RoomMember,
  isConnected?: (roomCode: string, memberId: string) => boolean,
): boolean => isConnected ? isConnected(room.code, member.id) : member.connected !== false;

export const roomCounts = (
  room: RoomRecord,
  isConnected?: (roomCode: string, memberId: string) => boolean,
): RoomCounts => {
  const humans = room.members.filter(human);
  return {
    playerSeats: countPlayerMembers(room.members),
    humanPlayers: humans.length,
    onlineHumanPlayers: humans.filter((member) => connectedOf(room, member, isConnected)).length,
    readyHumanPlayers: humans.filter((member) => member.ready === true).length,
    spectators: room.members.filter((member) => member.kind === 'spectator').length,
  };
};

export const getRoomCounts = roomCounts;

export const evaluateStartCheck = (
  room: RoomRecord,
  options: RoomPolicyInput = {},
): StartCheck => {
  const normalizedOptions = normalizeOptions(options);
  const registry = normalizedOptions.registry ?? defaultRulesetRegistry;
  const config = configFor(room);
  const counts = roomCounts(room, normalizedOptions.isConnected);
  const configValid = checkConfig(room, normalizedOptions);
  const maxPlayers = config?.maxPlayers ?? room.maxPlayers;
  const roleCount = countRoleSetup(room);
  const roleCountPassed =
    configValid && Number.isInteger(maxPlayers) && roleCount === maxPlayers;
  const humans = room.members.filter(human);
  const minimumPassed =
    configValid && humans.length >= (config?.minHumanPlayers ?? Number.MAX_SAFE_INTEGER);
  const onlineFailures = humans
    .filter((member) => !connectedOf(room, member, normalizedOptions.isConnected))
    .map((member) => member.id);
  const readyFailures = humans
    .filter((member) => member.ready !== true)
    .map((member) => member.id);
  const ai = checkAiFill(room);
  const aiProviderConfig = checkAIProviderConfig(room);
  const rulesetAvailable = checkRuleset(room, registry);
  const seatLayout = inspectSeatLayout(room.members, maxPlayers);
  const seatLayoutPassed = seatLayout.valid && counts.playerSeats <= maxPlayers;
  const items: StartCheckItem[] = [
    checkItem(
      'config_valid',
      configValid,
      'room.start.config_valid',
    ),
    checkItem(
      'role_count',
      roleCountPassed && seatLayoutPassed,
      'room.start.role_count',
      {
        expected: maxPlayers,
        actual: roleCount,
        delta: maxPlayers - roleCount,
      },
      seatLayoutPassed
        ? undefined
        : room.members.filter((member) => player(member)).map((member) => member.id),
    ),
    checkItem(
      'minimum_humans',
      minimumPassed,
      'room.start.minimum_humans',
      {
        required: config?.minHumanPlayers ?? 0,
        actual: humans.length,
      },
      minimumPassed ? undefined : humans.map((member) => member.id),
    ),
    checkItem(
      'all_humans_online',
      onlineFailures.length === 0,
      'room.start.all_humans_online',
      { actual: counts.onlineHumanPlayers, total: counts.humanPlayers },
      onlineFailures,
    ),
    checkItem(
      'all_humans_ready',
      readyFailures.length === 0,
      'room.start.all_humans_ready',
      { actual: counts.readyHumanPlayers, total: counts.humanPlayers },
      readyFailures,
    ),
    checkItem(
      'ai_fill',
      ai.passed,
      'room.start.ai_fill',
      ai.params,
      ai.affectedMemberIds,
    ),
    ...(aiProviderConfig === undefined
      ? []
      : [checkItem(
        'ai_provider_config',
        aiProviderConfig,
        'room.start.ai_provider_config',
      )]),
    checkItem(
      'ruleset_available',
      rulesetAvailable,
      'room.start.ruleset_available',
    ),
  ];
  return {
    passed: items.every((item) => item.passed),
    items,
  };
};

export const startCheck = evaluateStartCheck;

const findMember = (
  room: RoomRecord,
  actor: string | Pick<RoomMember, 'id'>,
): RoomMember | undefined =>
  room.members.find((member) => member.id === (typeof actor === 'string' ? actor : actor.id));

const baseReadyCheckCanStart = (check: StartCheck): boolean =>
  check.items.every((item) =>
    item.key === 'all_humans_ready' || item.key === 'all_humans_online'
      ? true
      : item.passed,
  );

const canTransfer = (
  room: RoomRecord,
  isConnected?: (roomCode: string, memberId: string) => boolean,
): boolean =>
  room.members.some(
    (member) =>
      human(member) &&
      member.id !== room.hostId &&
      connectedOf(room, member, isConnected),
  );

export class RoomPolicy {
  readonly options: RoomPolicyOptions;

  constructor(options: RoomPolicyInput = {}) {
    this.options = { ...normalizeOptions(options) };
  }

  evaluateStartCheck(room: RoomRecord): StartCheck {
    return evaluateStartCheck(room, this.options);
  }

  startCheck(room: RoomRecord): StartCheck {
    return this.evaluateStartCheck(room);
  }

  counts(room: RoomRecord): RoomCounts {
    return roomCounts(room, this.options.isConnected);
  }

  allowedRoomActions(
    room: RoomRecord,
    actor: string | Pick<RoomMember, 'id'>,
  ): AllowedRoomAction[] {
    const member = findMember(room, actor);
    if (!member) return [];
    const status = statusOf(room);
    const isHost = member.id === room.hostId;
    const isHumanPlayer = human(member);
    const check = this.evaluateStartCheck(room);
    const actions = new Set<AllowedRoomAction>();

    actions.add('leave');
    if (
      (status === 'waiting' || status === 'ready_check') &&
      (isHost || room.config.allowPublicSpectators === true)
    ) {
      actions.add('invite');
    }
    if (isHost && status === 'waiting' && !room.configLocked) {
      actions.add('update_config');
      actions.add('update_ai_config');
      if (baseReadyCheckCanStart(check)) actions.add('begin_ready_check');
    }
    if (isHost && status === 'ready_check' && !room.configLocked) {
      actions.add('update_config');
    }
    if (isHost && status === 'ready_check') {
      actions.add('cancel_ready_check');
      // AI tuning is an independent host-only patch. Keep it available after
      // rooms enter the default preparation phase; the full room rules remain
      // locked and the patch still clears human readiness when it changes.
      actions.add('update_ai_config');
      if (check.passed && isHumanPlayer) actions.add('start_game');
      if (canTransfer(room, this.options.isConnected)) actions.add('transfer_host');
    }
    if (isHumanPlayer && status === 'ready_check') actions.add('set_ready');
    if ((status === 'waiting' || status === 'ready_check') && member.kind === 'spectator') {
      actions.add('claim_seat');
    }
    const anotherHumanPlayer = room.members.some((candidate) =>
      candidate.id !== member.id && human(candidate) && candidate.kind === 'player',
    );
    if ((status === 'waiting' || status === 'ready_check') && isHumanPlayer && (!isHost || anotherHumanPlayer)) {
      actions.add('become_spectator');
      actions.add('request_seat');
    }
    if ((status === 'waiting' || status === 'ready_check') && member.kind === 'spectator') {
      actions.add('request_seat');
    }
    if (isHost && (status === 'waiting' || status === 'ready_check')) {
      actions.add('add_ai');
      actions.add('kick_player');
      actions.add('respond_seat_request');
    }
    if (isHost && (status === 'waiting' || status === 'ready_check')) {
      actions.add('dissolve');
    }

    return ALLOWED_ROOM_ACTIONS.filter((action) => actions.has(action));
  }

  getAllowedRoomActions(
    room: RoomRecord,
    actor: string | Pick<RoomMember, 'id'>,
  ): AllowedRoomAction[] {
    return this.allowedRoomActions(room, actor);
  }

  isAllowed(
    room: RoomRecord,
    actor: string | Pick<RoomMember, 'id'>,
    action: AllowedRoomAction,
  ): boolean {
    return this.allowedRoomActions(room, actor).includes(action);
  }

  assertAllowed(
    room: RoomRecord,
    actor: string | Pick<RoomMember, 'id'>,
    action: AllowedRoomAction,
  ): void {
    const member = findMember(room, actor);
    if (!member) {
      throw new RoomPolicyError({
        code: 'ACTOR_NOT_FOUND',
        messageKey: 'room.error.actor_not_found',
      });
    }
    if (action === 'set_ready' && !human(member)) {
      throw new RoomPolicyError({
        code: member.kind === 'spectator' ? 'SPECTATOR_READ_ONLY' : 'ACTION_NOT_ALLOWED',
        messageKey: 'room.error.ready_not_allowed',
      });
    }
    if (action === 'start_game') {
      this.assertStartAllowed(room, actor);
      return;
    }
    if (action === 'begin_ready_check') {
      this.assertBeginReadyCheckAllowed(room, actor);
      return;
    }
    if (!this.isAllowed(room, actor, action)) {
      throw new RoomPolicyError({
        code: member.id !== room.hostId &&
          ['update_config', 'update_ai_config', 'begin_ready_check', 'cancel_ready_check', 'start_game', 'transfer_host', 'dissolve', 'add_ai', 'kick_player', 'respond_seat_request'].includes(action)
          ? 'HOST_REQUIRED'
          : 'ACTION_NOT_ALLOWED',
        messageKey: `room.error.${action}_not_allowed`,
      });
    }
  }

  assertActionAllowed = this.assertAllowed.bind(this);

  assertStartAllowed(
    room: RoomRecord,
    actor: string | Pick<RoomMember, 'id'>,
  ): void {
    const member = findMember(room, actor);
    if (!member) {
      throw new RoomPolicyError({
        code: 'ACTOR_NOT_FOUND',
        messageKey: 'room.error.actor_not_found',
      });
    }
    if (member.id !== room.hostId) {
      throw new RoomPolicyError({
        code: 'HOST_REQUIRED',
        messageKey: 'room.error.start_game_not_allowed',
      });
    }
    if (!human(member)) {
      throw new RoomPolicyError({
        code: member.kind === 'spectator' ? 'SPECTATOR_READ_ONLY' : 'ACTION_NOT_ALLOWED',
        messageKey: 'room.error.start_game_not_allowed',
      });
    }
    if (statusOf(room) !== 'ready_check') {
      throw new RoomPolicyError({
        code: 'ACTION_NOT_ALLOWED',
        messageKey: 'room.error.start_game_not_allowed',
      });
    }
    const failed = this.evaluateStartCheck(room).items.find((item) => !item.passed);
    if (!failed) return;
    const codeByKey: Record<StartCheckKey, ProtocolErrorCode> = {
      config_valid: 'INVALID_ROOM_CONFIG',
      role_count: 'ROLE_COUNT_MISMATCH',
      minimum_humans: 'MIN_PLAYERS_NOT_MET',
      all_humans_online: 'MEMBER_OFFLINE',
      all_humans_ready: 'HUMAN_PLAYERS_NOT_READY',
      ai_fill: 'INVALID_ROOM_CONFIG',
      ai_provider_config: 'INVALID_ROOM_CONFIG',
      ruleset_available: 'RULESET_UNAVAILABLE',
    };
    throw new RoomPolicyError({
      code: codeByKey[failed.key],
      messageKey: failed.messageKey,
      affectedMemberIds: failed.affectedMemberIds,
      params: failed.params,
    });
  }

  assertBeginReadyCheckAllowed(
    room: RoomRecord,
    actor: string | Pick<RoomMember, 'id'>,
  ): void {
    const member = findMember(room, actor);
    if (!member) {
      throw new RoomPolicyError({
        code: 'ACTOR_NOT_FOUND',
        messageKey: 'room.error.actor_not_found',
      });
    }
    if (member.id !== room.hostId) {
      throw new RoomPolicyError({
        code: 'HOST_REQUIRED',
        messageKey: 'room.error.begin_ready_check_not_allowed',
      });
    }
    if (statusOf(room) !== 'waiting') {
      throw new RoomPolicyError({
        code: 'ACTION_NOT_ALLOWED',
        messageKey: 'room.error.begin_ready_check_not_allowed',
      });
    }
    const failed = this.evaluateStartCheck(room).items.find(
      (item) =>
        !item.passed &&
        item.key !== 'all_humans_ready' &&
        item.key !== 'all_humans_online',
    );
    if (!failed) return;
    const codeByKey: Partial<Record<StartCheckKey, ProtocolErrorCode>> = {
      config_valid: 'INVALID_ROOM_CONFIG',
      role_count: 'ROLE_COUNT_MISMATCH',
      minimum_humans: 'MIN_PLAYERS_NOT_MET',
      ai_fill: 'INVALID_ROOM_CONFIG',
      ai_provider_config: 'INVALID_ROOM_CONFIG',
      ruleset_available: 'RULESET_UNAVAILABLE',
    };
    throw new RoomPolicyError({
      code: codeByKey[failed.key] ?? 'ACTION_NOT_ALLOWED',
      messageKey: failed.messageKey,
      affectedMemberIds: failed.affectedMemberIds,
      params: failed.params,
    });
  }

  canStart(room: RoomRecord, actor: string | Pick<RoomMember, 'id'>): boolean {
    return this.isAllowed(room, actor, 'start_game');
  }

  canTransition(room: RoomRecord, nextStatus: RoomStatus): boolean {
    const current = statusOf(room);
    return (
      (current === 'waiting' && nextStatus === 'ready_check') ||
      (current === 'ready_check' && (nextStatus === 'waiting' || nextStatus === 'starting')) ||
      (current === 'starting' && (nextStatus === 'ready_check' || nextStatus === 'playing')) ||
      (current === 'playing' && nextStatus === 'ended') ||
      current === nextStatus
    );
  }

  assertTransition(room: RoomRecord, nextStatus: RoomStatus): void {
    if (!this.canTransition(room, nextStatus)) {
      throw new RoomPolicyError({
        code: 'ACTION_NOT_ALLOWED',
        messageKey: 'room.error.invalid_status_transition',
      });
    }
  }
}

export const allowedRoomActions = (
  room: RoomRecord,
  actor: string | Pick<RoomMember, 'id'>,
  options: RoomPolicyOptions = {},
): AllowedRoomAction[] => new RoomPolicy(options).allowedRoomActions(room, actor);
