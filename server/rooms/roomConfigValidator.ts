import {
  ROLE_KEYS,
  type CreateRoomOptionsV31,
  type RoleLimit,
  type RoleSetup,
  type RoomConfigIssue,
  type RoomConfigValidationResult,
  type RoomConfigView,
  type RoomCreationCatalog,
  type RoomMode,
  type RulesetRegistryLike,
} from '../rulesets/types';
import { defaultRulesetRegistry } from '../rulesets/registry';

const ROOM_CONFIG = 'INVALID_ROOM_CONFIG' as const;
const ROLE_COUNT = 'ROLE_COUNT_MISMATCH' as const;
const RULESET_UNAVAILABLE = 'RULESET_UNAVAILABLE' as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const issue = (
  path: string,
  messageKey: string,
  errorCode: RoomConfigIssue['errorCode'] = ROOM_CONFIG,
  params?: Record<string, string | number>,
): RoomConfigIssue => ({
  path,
  messageKey,
  errorCode,
  ...(params ? { params } : {}),
});

const cloneRoleSetup = (roleSetup: RoleSetup): RoleSetup => ({
  wolf: roleSetup.wolf,
  seer: roleSetup.seer,
  witch: roleSetup.witch,
  hunter: roleSetup.hunter,
  guardian: roleSetup.guardian,
  villager: roleSetup.villager,
});

const sumRoleSetup = (roleSetup: RoleSetup): number =>
  ROLE_KEYS.reduce((total, role) => total + roleSetup[role], 0);

const addStringIssue = (
  issues: RoomConfigIssue[],
  value: unknown,
  path: string,
  messageKey: string,
  maxLength?: number,
) => {
  if (!isNonEmptyString(value)) {
    issues.push(issue(path, messageKey));
    return;
  }
  if (maxLength !== undefined && value.trim().length > maxLength) {
    issues.push(
      issue(path, `${messageKey}.too_long`, ROOM_CONFIG, { max: maxLength }),
    );
  }
};

const addEnumIssue = <T extends string>(
  issues: RoomConfigIssue[],
  value: unknown,
  path: string,
  allowed: readonly T[],
  messageKey: string,
) => {
  if (!allowed.includes(value as T)) {
    issues.push(issue(path, messageKey));
  }
};

const addIntegerIssue = (
  issues: RoomConfigIssue[],
  value: unknown,
  path: string,
  messageKey: string,
) => {
  if (!Number.isInteger(value)) issues.push(issue(path, messageKey));
};

const getRoleSetup = (
  value: unknown,
  catalog: RoomCreationCatalog,
  issues: RoomConfigIssue[],
): RoleSetup | undefined => {
  if (!isRecord(value)) {
    issues.push(issue('roleSetup', 'room.config.role_setup_required'));
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!(ROLE_KEYS as readonly string[]).includes(key)) {
      issues.push(issue(`roleSetup.${key}`, 'room.config.role_unknown_role'));
    }
  }

  const roleSetup = {} as RoleSetup;
  let valid = true;
  for (const role of ROLE_KEYS) {
    const count = value[role];
    const limits: RoleLimit | undefined = catalog.roleLimits[role];
    if (!Number.isInteger(count) || (count as number) < 0) {
      issues.push(issue(`roleSetup.${role}`, 'room.config.role_count_invalid'));
      valid = false;
      continue;
    }
    if (limits && (count as number) < limits.min) {
      issues.push(
        issue(`roleSetup.${role}`, 'room.config.role_count_below_min', ROOM_CONFIG, {
          min: limits.min,
        }),
      );
      valid = false;
    }
    if (limits && (count as number) > limits.max) {
      issues.push(
        issue(`roleSetup.${role}`, 'room.config.role_count_above_max', ROOM_CONFIG, {
          max: limits.max,
        }),
      );
      valid = false;
    }
    roleSetup[role] = count as number;
  }
  return valid ? roleSetup : undefined;
};

const validateModeRules = (
  input: Record<string, unknown>,
  maxPlayers: number,
  issues: RoomConfigIssue[],
) => {
  const mode = input.mode as RoomMode;
  const aiFillPolicy = input.aiFillPolicy as string;
  const computerSeats = input.computerSeats as number;
  const minHumanPlayers = input.minHumanPlayers as number;

  if (
    typeof computerSeats !== 'number' ||
    !Number.isInteger(computerSeats) ||
    computerSeats < 0 ||
    computerSeats > maxPlayers
  ) {
    issues.push(issue('computerSeats', 'room.config.computer_seats_invalid'));
  }
  if (
    typeof minHumanPlayers !== 'number' ||
    !Number.isInteger(minHumanPlayers) ||
    minHumanPlayers < 0 ||
    minHumanPlayers > maxPlayers
  ) {
    issues.push(issue('minHumanPlayers', 'room.config.minimum_humans_invalid'));
  }

  if (mode === 'human') {
    if (aiFillPolicy !== 'none') {
      issues.push(issue('aiFillPolicy', 'room.config.human_mode_no_ai'));
    }
    if (computerSeats !== 0) {
      issues.push(issue('computerSeats', 'room.config.human_mode_no_ai'));
    }
    if (minHumanPlayers !== maxPlayers) {
      issues.push(
        issue('minHumanPlayers', 'room.config.human_mode_requires_full_room'),
      );
    }
    return;
  }

  if (mode === 'quick_computer') {
    if (aiFillPolicy !== 'fill_to_max') {
      issues.push(
        issue('aiFillPolicy', 'room.config.quick_computer_fills_all_seats'),
      );
    }
    if (computerSeats !== 0) {
      issues.push(
        issue('computerSeats', 'room.config.fill_to_max_has_no_reserved_seats'),
      );
    }
    if (minHumanPlayers !== 0) {
      issues.push(issue('minHumanPlayers', 'room.config.quick_computer_no_humans'));
    }
    return;
  }

  if (mode === 'mixed') {
    if (aiFillPolicy !== 'fixed' && aiFillPolicy !== 'fill_to_max') {
      issues.push(issue('aiFillPolicy', 'room.config.mixed_mode_requires_ai'));
    }
    if (aiFillPolicy === 'fixed' && computerSeats <= 0) {
      issues.push(issue('computerSeats', 'room.config.fixed_ai_requires_seats'));
    }
    if (aiFillPolicy !== 'fixed' && computerSeats !== 0) {
      issues.push(
        issue('computerSeats', 'room.config.fill_to_max_has_no_reserved_seats'),
      );
    }
    if (minHumanPlayers < 1) {
      issues.push(issue('minHumanPlayers', 'room.config.mixed_mode_requires_human'));
    }
    if (
      Number.isInteger(minHumanPlayers) &&
      Number.isInteger(computerSeats) &&
      minHumanPlayers + computerSeats > maxPlayers
    ) {
      issues.push(
        issue('computerSeats', 'room.config.seats_exceed_max_players', ROOM_CONFIG, {
          max: maxPlayers,
        }),
      );
    }
  }
};

const firstErrorCode = (
  issues: readonly RoomConfigIssue[],
): RoomConfigIssue['errorCode'] =>
  issues.find((item) => item.errorCode === RULESET_UNAVAILABLE)?.errorCode ??
  issues.find((item) => item.errorCode === ROLE_COUNT)?.errorCode ??
  ROOM_CONFIG;

export class RoomConfigValidationError extends Error {
  readonly issues: RoomConfigIssue[];
  readonly errorCode: RoomConfigIssue['errorCode'];

  constructor(issues: RoomConfigIssue[]) {
    super('Room configuration is invalid');
    this.name = 'RoomConfigValidationError';
    this.issues = issues;
    this.errorCode = firstErrorCode(issues);
  }
}

export class RoomConfigValidator {
  private readonly registry: RulesetRegistryLike;

  constructor(registry: RulesetRegistryLike = defaultRulesetRegistry) {
    this.registry = registry;
  }

  validate(input: unknown): RoomConfigValidationResult {
    const catalog = this.registry.getCatalog();
    const issues: RoomConfigIssue[] = [];
    if (!isRecord(input)) {
      return {
        ok: false,
        issues: [issue('', 'room.config.object_required')],
        errorCode: ROOM_CONFIG,
      };
    }

    if (input.catalogVersion !== catalog.catalogVersion) {
      issues.push(
        issue('catalogVersion', 'room.config.catalog_version_mismatch', ROOM_CONFIG),
      );
    }
    addStringIssue(
      issues,
      input.roomName,
      'roomName',
      'room.config.room_name_required',
      catalog.limits.roomNameMax,
    );

    if (!isRecord(input.creator)) {
      issues.push(issue('creator', 'room.config.creator_required'));
    } else {
      addStringIssue(
        issues,
        input.creator.name,
        'creator.name',
        'room.config.creator_name_required',
        catalog.limits.displayNameMax,
      );
      addStringIssue(
        issues,
        input.creator.avatarId,
        'creator.avatarId',
        'room.config.creator_avatar_required',
      );
    }

    addEnumIssue(
      issues,
      input.mode,
      'mode',
      ['human', 'mixed', 'quick_computer'] as const,
      'room.config.mode_invalid',
    );
    addEnumIssue(
      issues,
      input.visibility,
      'visibility',
      ['invite_only', 'listed'] as const,
      'room.config.visibility_invalid',
    );
    addEnumIssue(
      issues,
      input.aiFillPolicy,
      'aiFillPolicy',
      ['none', 'fixed', 'fill_to_max'] as const,
      'room.config.ai_fill_policy_invalid',
    );
    if (input.readyPolicy !== 'all_connected_humans') {
      issues.push(issue('readyPolicy', 'room.config.ready_policy_invalid'));
    }
    for (const [path, value] of [
      ['allowPublicSpectators', input.allowPublicSpectators],
      ['reviewEnabled', input.reviewEnabled],
    ] as const) {
      if (typeof value !== 'boolean') {
        issues.push(issue(path, 'room.config.boolean_required'));
      }
    }

    addIntegerIssue(
      issues,
      input.maxPlayers,
      'maxPlayers',
      'room.config.player_count_invalid',
    );
    const maxPlayers = input.maxPlayers as number;
    const hasValidMaxPlayers = Number.isInteger(maxPlayers) && maxPlayers > 0;
    if (hasValidMaxPlayers) {
      const matchingPreset = catalog.rolePresets.find(
        (preset) => preset.playerCount === maxPlayers && preset.enabled,
      );
      if (!matchingPreset) {
        issues.push(
          issue(
            'maxPlayers',
            'room.config.ruleset_unavailable_for_player_count',
            RULESET_UNAVAILABLE,
            { playerCount: maxPlayers },
          ),
        );
      }
    }

    const roleSetup = getRoleSetup(input.roleSetup, catalog, issues);
    if (roleSetup && hasValidMaxPlayers) {
      const roleCount = sumRoleSetup(roleSetup);
      if (roleCount !== maxPlayers) {
        const delta = maxPlayers - roleCount;
        issues.push(
          issue(
            'roleSetup',
            'room.config.role_count_mismatch',
            ROLE_COUNT,
            { expected: maxPlayers, actual: roleCount, delta },
          ),
        );
      }
    }

    if (typeof input.rulesetId !== 'string' || typeof input.rulesetVersion !== 'string') {
      issues.push(issue('rulesetId', 'room.config.ruleset_required', RULESET_UNAVAILABLE));
    } else if (!this.registry.isAvailable(input.rulesetId, input.rulesetVersion)) {
      issues.push(
        issue('rulesetId', 'room.config.ruleset_unavailable', RULESET_UNAVAILABLE),
      );
    }

    const selectedPreset =
      typeof input.rolePresetId === 'string'
        ? catalog.rolePresets.find((preset) => preset.id === input.rolePresetId)
        : undefined;
    if (input.rolePresetId !== undefined && !selectedPreset) {
      issues.push(issue('rolePresetId', 'room.config.role_preset_unknown'));
    } else if (selectedPreset && !selectedPreset.enabled) {
      issues.push(
        issue('rolePresetId', 'room.config.role_preset_unavailable', RULESET_UNAVAILABLE),
      );
    } else if (selectedPreset && selectedPreset.playerCount !== maxPlayers) {
      issues.push(issue('rolePresetId', 'room.config.role_preset_player_count_mismatch'));
    } else if (selectedPreset && roleSetup) {
      const selectedRoleSetup = JSON.stringify(selectedPreset.roleSetup);
      if (selectedRoleSetup !== JSON.stringify(roleSetup)) {
        issues.push(issue('roleSetup', 'room.config.role_preset_setup_mismatch'));
      }
    }

    if (
      typeof input.mode === 'string' &&
      ['human', 'mixed', 'quick_computer'].includes(input.mode)
    ) {
      validateModeRules(input, hasValidMaxPlayers ? maxPlayers : 0, issues);
    }

    if (issues.length > 0) {
      return { ok: false, issues, errorCode: firstErrorCode(issues) };
    }

    const normalizedRoleSetup = selectedPreset
      ? cloneRoleSetup(selectedPreset.roleSetup)
      : cloneRoleSetup(roleSetup as RoleSetup);
    return {
      ok: true,
      config: {
        catalogVersion: catalog.catalogVersion,
        mode: input.mode as CreateRoomOptionsV31['mode'],
        visibility: input.visibility as CreateRoomOptionsV31['visibility'],
        maxPlayers,
        minHumanPlayers: input.minHumanPlayers as number,
        computerSeats: input.computerSeats as number,
        aiFillPolicy: input.aiFillPolicy as CreateRoomOptionsV31['aiFillPolicy'],
        roleSetup: normalizedRoleSetup,
        ...(selectedPreset ? { rolePresetId: selectedPreset.id } : {}),
        rulesetId: input.rulesetId as string,
        rulesetVersion: input.rulesetVersion as string,
        readyPolicy: 'all_connected_humans',
        allowPublicSpectators: input.allowPublicSpectators as boolean,
        reviewEnabled: input.reviewEnabled as boolean,
      },
    };
  }

  validateAndNormalize(input: unknown): RoomConfigValidationResult {
    return this.validate(input);
  }

  normalize(input: unknown): RoomConfigView {
    const result = this.validate(input);
    if (result.ok === false) throw new RoomConfigValidationError(result.issues);
    return result.config;
  }
}

export const validateRoomConfig = (
  input: unknown,
  registry: RulesetRegistryLike = defaultRulesetRegistry,
): RoomConfigValidationResult => new RoomConfigValidator(registry).validate(input);

export const normalizeRoomConfig = (
  input: unknown,
  registry: RulesetRegistryLike = defaultRulesetRegistry,
): RoomConfigView => new RoomConfigValidator(registry).normalize(input);

export const validateAndNormalizeRoomConfig = validateRoomConfig;
