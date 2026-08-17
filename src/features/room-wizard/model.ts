import type {
  CreateRoomOptionsV31,
  RoomConfigIssue,
  RoomCreationCatalog,
  RoomMode,
  RoleSetup,
} from '../../../shared/roomContract';
import type { Role } from '../../../shared/types';

export const ROOM_WIZARD_STORAGE_KEY = 'werewolf-v31-room-wizard-draft';
export const ROOM_WIZARD_DRAFT_VERSION = 1 as const;

export const WIZARD_STEPS = [
  { id: 'players', label: '人数与规则', title: '先决定今晚有多少人，约定怎么玩' },
  { id: 'roles', label: '角色与确认', title: '安排角色，确认后点亮村庄' },
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number]['id'];
/** Old deep links and callers remain readable while routing uses two pages. */
export type LegacyWizardStep = WizardStep | 'rules' | 'confirm';

export const WIZARD_STEP_PATHS: Record<LegacyWizardStep, string> = {
  players: '/rooms/new/players',
  roles: '/rooms/new/roles',
  rules: '/rooms/new/rules',
  confirm: '/rooms/new/confirm',
};

const WIZARD_STEP_ALIASES: Record<string, WizardStep> = {
  '1': 'players',
  count: 'players',
  people: 'players',
  players: 'players',
  '2': 'roles',
  roles: 'roles',
  '3': 'players',
  rules: 'players',
  '4': 'roles',
  confirm: 'roles',
  review: 'roles',
};

export const normalizeWizardStep = (value: string | undefined): WizardStep | null =>
  value ? WIZARD_STEP_ALIASES[value.toLowerCase()] ?? null : null;

export const ROLE_KEYS: readonly Role[] = [
  'wolf',
  'seer',
  'witch',
  'hunter',
  'guardian',
  'villager',
];

export const ROLE_LABELS: Record<Role, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guardian: '守卫',
  villager: '村民',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  wolf: '夜间共同选择目标',
  seer: '每晚查验一名玩家',
  witch: '掌握解药与毒药',
  hunter: '出局后可选择开枪',
  guardian: '每晚守护一名玩家',
  villager: '白天讨论并投票',
};

export interface WizardDraft {
  version: typeof ROOM_WIZARD_DRAFT_VERSION;
  catalogVersion: string;
  roomName: string;
  creator: { name: string; avatarId: string };
  mode: RoomMode;
  visibility: 'invite_only' | 'listed';
  maxPlayers: number;
  minHumanPlayers: number;
  computerSeats: number;
  aiFillPolicy: 'none' | 'fixed' | 'fill_to_max';
  roleSetup: RoleSetup;
  rolePresetId?: string;
  rulesetId: string;
  rulesetVersion: string;
  readyPolicy: 'all_connected_humans';
  allowPublicSpectators: boolean;
  reviewEnabled: boolean;
}

export interface WizardIssue {
  path: string;
  message: string;
  errorCode?: string;
  step: LegacyWizardStep;
}

export const roleSetupTotal = (roleSetup: RoleSetup): number =>
  ROLE_KEYS.reduce((total, role) => total + (roleSetup[role] ?? 0), 0);

const emptyRoleSetup = (): RoleSetup =>
  Object.fromEntries(ROLE_KEYS.map((role) => [role, 0])) as RoleSetup;

const firstEnabledPreset = (catalog: RoomCreationCatalog) =>
  catalog.rolePresets.find((preset) => preset.enabled);

/** The first board is always copied from the server catalog, never generated here. */
export const createInitialDraft = (
  catalog: RoomCreationCatalog,
  creatorName = '玩家',
): WizardDraft => {
  const preset = firstEnabledPreset(catalog);
  const maxPlayers = preset?.playerCount ?? catalog.playerCounts[0] ?? 0;
  // A new room should be playable with the creator plus computer players
  // without making them hand-tune a seat split. The server still owns the
  // final validation; this only supplies a useful first draft.
  const mixedByDefault = maxPlayers > 1;
  return {
    version: ROOM_WIZARD_DRAFT_VERSION,
    catalogVersion: catalog.catalogVersion,
    roomName: '月影村·新手局',
    creator: { name: creatorName, avatarId: 'avatar-player' },
    mode: mixedByDefault ? 'mixed' : 'human',
    visibility: 'invite_only',
    maxPlayers,
    minHumanPlayers: mixedByDefault ? 1 : maxPlayers,
    computerSeats: 0,
    aiFillPolicy: mixedByDefault ? 'fill_to_max' : 'none',
    roleSetup: preset ? { ...preset.roleSetup } : emptyRoleSetup(),
    ...(preset ? { rolePresetId: preset.id } : {}),
    rulesetId: preset?.rulesetId ?? '',
    rulesetVersion: preset?.rulesetVersion ?? '',
    readyPolicy: 'all_connected_humans',
    allowPublicSpectators: false,
    reviewEnabled: true,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRoleSetup = (value: unknown): value is RoleSetup =>
  isRecord(value) && ROLE_KEYS.every((role) => Number.isInteger(value[role]));

const isDraft = (value: unknown): value is WizardDraft => {
  if (!isRecord(value) || value.version !== ROOM_WIZARD_DRAFT_VERSION) return false;
  if (!isRecord(value.creator) || typeof value.creator.name !== 'string' || typeof value.creator.avatarId !== 'string') return false;
  return (
    typeof value.catalogVersion === 'string' &&
    typeof value.roomName === 'string' &&
    ['human', 'mixed', 'quick_computer'].includes(value.mode as string) &&
    ['invite_only', 'listed'].includes(value.visibility as string) &&
    Number.isInteger(value.maxPlayers) &&
    Number.isInteger(value.minHumanPlayers) &&
    Number.isInteger(value.computerSeats) &&
    ['none', 'fixed', 'fill_to_max'].includes(value.aiFillPolicy as string) &&
    isRoleSetup(value.roleSetup) &&
    typeof value.rulesetId === 'string' &&
    typeof value.rulesetVersion === 'string' &&
    value.readyPolicy === 'all_connected_humans' &&
    typeof value.allowPublicSpectators === 'boolean' &&
    typeof value.reviewEnabled === 'boolean'
  );
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const readWizardDraft = (
  target: StorageLike | null | undefined,
): WizardDraft | null => {
  if (!target) return null;
  try {
    const raw = target.getItem(ROOM_WIZARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeWizardDraft = (
  target: StorageLike | null | undefined,
  draft: WizardDraft,
): void => {
  if (!target) return;
  try {
    target.setItem(ROOM_WIZARD_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // A draft is a convenience cache; a blocked sessionStorage must not block creation.
  }
};

export const clearWizardDraft = (
  target: StorageLike | null | undefined,
): void => {
  if (!target) return;
  try {
    target.removeItem(ROOM_WIZARD_STORAGE_KEY);
  } catch {
    // Ignore storage failures while leaving the in-memory wizard usable.
  }
};

const issue = (
  path: string,
  message: string,
  step: LegacyWizardStep,
  errorCode?: string,
): WizardIssue => ({ path, message, step, ...(errorCode ? { errorCode } : {}) });

const countMessage = (key: string, params?: Record<string, string | number>): string => {
  if (key.endsWith('too_long')) return `最多${params?.max ?? ''}个字`;
  if (key.includes('role_count_mismatch')) {
    return `角色总数必须与${params?.expected ?? ''}个席位一致`;
  }
  if (key.includes('below_min')) return `该角色至少需要${params?.min ?? 0}个`;
  if (key.includes('above_max')) return `该角色最多${params?.max ?? 0}个`;
  return '';
};

export const messageForIssue = (
  issueValue: Pick<RoomConfigIssue, 'messageKey' | 'params'> | string,
): string => {
  const key = typeof issueValue === 'string' ? issueValue : issueValue.messageKey;
  const params = typeof issueValue === 'string' ? undefined : issueValue.params;
  const formatted = countMessage(key, params);
  if (formatted) return formatted;
  const messages: Record<string, string> = {
    'room.config.object_required': '房间设置不完整。',
    'room.config.room_name_required': '请填写房间名称。',
    'room.config.creator_name_required': '请填写显示名称。',
    'room.config.creator.avatar_required': '请选择村民徽章。',
    'room.config.creator_avatar_required': '请选择村民徽章。',
    'room.config.mode_invalid': '请选择房间模式。',
    'room.config.player_count_invalid': '请选择有效的席位档位。',
    'room.config.ruleset_unavailable_for_player_count': '这个人数档位的规则准备中。',
    RULESET_UNAVAILABLE: '当前规则暂不可用。',
    'room.config.human_mode_no_ai': '朋友房不能设置电脑席。',
    'room.config.human_mode_requires_full_room': '朋友房需要所有席位由真人加入。',
    'room.config.quick_computer_fills_all_seats': '快速电脑局会补满全部席位。',
    'room.config.quick_computer_no_humans': '快速电脑局不需要真人入座。',
    'room.config.mixed_mode_requires_ai': '混合房需要选择电脑补位方式。',
    'room.config.fixed_ai_requires_seats': '固定电脑席至少为1个。',
    'room.config.mixed_mode_requires_human': '混合房至少保留1名真人。',
    'room.config.role_setup_required': '请选择角色配置。',
    'room.config.role_unknown_role': '包含当前规则不认识的角色。',
    'room.config.role_count_invalid': '角色数量必须是非负整数。',
    'room.config.role_count_mismatch': '角色总数与席位数不一致。',
    'room.config.role_count_below_min': '角色数量低于规则允许的下限。',
    'room.config.role_count_above_max': '角色数量超过规则允许的上限。',
    'room.config.catalog_version_mismatch': '规则目录已更新，请重新确认。',
    'room.config.visibility_invalid': '请选择房间可见范围。',
    'room.config.ai_fill_policy_invalid': '请选择电脑补位方式。',
    'room.config.ready_policy_invalid': '当前准备规则不可修改。',
    'room.config.boolean_required': '请选择这一项。',
    'room.config.computer_seats_invalid': '电脑席数量无效。',
    'room.config.minimum_humans_invalid': '最低真人数无效。',
    'room.config.seats_exceed_max_players': '真人席与电脑席不能超过总席位。',
  };
  return messages[key] ?? '请检查这项设置。';
};

const isEnabledCount = (catalog: RoomCreationCatalog, count: number): boolean =>
  catalog.rolePresets.some((preset) => preset.playerCount === count && preset.enabled);

const validatePlayers = (
  draft: WizardDraft,
  catalog: RoomCreationCatalog,
): WizardIssue[] => {
  const issues: WizardIssue[] = [];
  if (!draft.creator.name.trim()) issues.push(issue('creator.name', '请填写显示名称。', 'players'));
  if (draft.creator.name.trim().length > catalog.limits.displayNameMax) {
    issues.push(issue('creator.name', `最多${catalog.limits.displayNameMax}个字。`, 'players'));
  }
  if (!draft.roomName.trim()) issues.push(issue('roomName', '请填写房间名称。', 'players'));
  if (draft.roomName.trim().length > catalog.limits.roomNameMax) {
    issues.push(issue('roomName', `最多${catalog.limits.roomNameMax}个字。`, 'players'));
  }
  if (!Number.isInteger(draft.maxPlayers) || !isEnabledCount(catalog, draft.maxPlayers)) {
    issues.push(issue('maxPlayers', '请选择目录中已启用的人数档位。', 'players', 'RULESET_UNAVAILABLE'));
  }
  if (!draft.creator.avatarId) issues.push(issue('creator.avatarId', '请选择村民徽章。', 'players'));
  if (draft.mode === 'human') {
    if (draft.aiFillPolicy !== 'none') issues.push(issue('aiFillPolicy', '朋友房不能设置电脑席。', 'players'));
    if (draft.computerSeats !== 0) issues.push(issue('computerSeats', '朋友房不能设置电脑席。', 'players'));
    if (draft.minHumanPlayers !== draft.maxPlayers) issues.push(issue('minHumanPlayers', '朋友房需要所有席位由真人加入。', 'players'));
  } else if (draft.mode === 'mixed') {
    if (draft.aiFillPolicy !== 'fixed' && draft.aiFillPolicy !== 'fill_to_max') {
      issues.push(issue('aiFillPolicy', '混合房需要选择电脑补位方式。', 'players'));
    }
    if (draft.aiFillPolicy === 'fixed' && draft.computerSeats <= 0) {
      issues.push(issue('computerSeats', '固定电脑席至少为1个。', 'players'));
    }
    if (draft.aiFillPolicy === 'fill_to_max' && draft.computerSeats !== 0) {
      issues.push(issue('computerSeats', '开局补满不预留固定电脑席。', 'players'));
    }
    if (draft.minHumanPlayers < 1) issues.push(issue('minHumanPlayers', '混合房至少保留1名真人。', 'players'));
  } else {
    if (draft.aiFillPolicy !== 'fill_to_max') issues.push(issue('aiFillPolicy', '快速电脑局会补满全部席位。', 'players'));
    if (draft.computerSeats !== 0) issues.push(issue('computerSeats', '开局补满不预留固定电脑席。', 'players'));
    if (draft.minHumanPlayers !== 0) issues.push(issue('minHumanPlayers', '快速电脑局不需要真人入座。', 'players'));
  }
  if (draft.minHumanPlayers < 0 || draft.minHumanPlayers > draft.maxPlayers) {
    issues.push(issue('minHumanPlayers', '最低真人数无效。', 'players'));
  }
  if (draft.computerSeats < 0 || draft.computerSeats > draft.maxPlayers) {
    issues.push(issue('computerSeats', '电脑席数量无效。', 'players'));
  }
  if (draft.minHumanPlayers + draft.computerSeats > draft.maxPlayers) {
    issues.push(issue('computerSeats', '真人席与电脑席不能超过总席位。', 'players'));
  }
  return issues;
};

const validateRoles = (
  draft: WizardDraft,
  catalog: RoomCreationCatalog,
): WizardIssue[] => {
  const issues: WizardIssue[] = [];
  for (const role of ROLE_KEYS) {
    const value = draft.roleSetup[role];
    const limits = catalog.roleLimits[role];
    if (!Number.isInteger(value) || value < 0) {
      issues.push(issue(`roleSetup.${role}`, '角色数量必须是非负整数。', 'roles'));
      continue;
    }
    if (limits && value < limits.min) issues.push(issue(`roleSetup.${role}`, `该角色至少需要${limits.min}个。`, 'roles'));
    if (limits && value > limits.max) issues.push(issue(`roleSetup.${role}`, `该角色最多${limits.max}个。`, 'roles'));
  }
  const total = roleSetupTotal(draft.roleSetup);
  if (total !== draft.maxPlayers) {
    issues.push(issue('roleSetup', `角色总数必须与${draft.maxPlayers}个席位一致。`, 'roles', 'ROLE_COUNT_MISMATCH'));
  }
  return issues;
};

const validateRules = (draft: WizardDraft): WizardIssue[] => {
  const issues: WizardIssue[] = [];
  if (draft.visibility !== 'invite_only' && draft.visibility !== 'listed') {
    issues.push(issue('visibility', '请选择房间可见范围。', 'rules'));
  }
  if (draft.readyPolicy !== 'all_connected_humans') {
    issues.push(issue('readyPolicy', '当前准备规则不可修改。', 'rules'));
  }
  if (typeof draft.allowPublicSpectators !== 'boolean') issues.push(issue('allowPublicSpectators', '请选择观战设置。', 'rules'));
  if (typeof draft.reviewEnabled !== 'boolean') issues.push(issue('reviewEnabled', '请选择复盘设置。', 'rules'));
  if (!draft.rulesetId || !draft.rulesetVersion) issues.push(issue('rulesetId', '当前规则暂不可用。', 'rules', 'RULESET_UNAVAILABLE'));
  return issues;
};

export const validateWizardStep = (
  draft: WizardDraft,
  step: LegacyWizardStep,
  catalog: RoomCreationCatalog,
): WizardIssue[] => {
  if (step === 'players') return validatePlayers(draft, catalog);
  if (step === 'roles') return [...validatePlayers(draft, catalog), ...validateRoles(draft, catalog)];
  if (step === 'rules') return [...validatePlayers(draft, catalog), ...validateRoles(draft, catalog), ...validateRules(draft)];
  return [...validatePlayers(draft, catalog), ...validateRoles(draft, catalog), ...validateRules(draft)];
};

const uiStepForIssue = (step: LegacyWizardStep): WizardStep =>
  step === 'players' || step === 'rules' ? 'players' : 'roles';

export const issuesForStep = (
  draft: WizardDraft,
  step: WizardStep,
  catalog: RoomCreationCatalog,
): WizardIssue[] => validateWizardStep(draft, 'confirm', catalog)
  .filter((item) => uiStepForIssue(item.step) === step);

export const stepIndex = (step: LegacyWizardStep): number =>
  WIZARD_STEPS.findIndex((item) => item.id === normalizeWizardStep(step));

export const wizardPathForStep = (step: LegacyWizardStep): string =>
  WIZARD_STEP_PATHS[uiStepForIssue(step)];

/** Back navigation is always allowed; forward jumps require every prior step to be complete. */
export const canNavigateToStep = (
  current: LegacyWizardStep,
  target: LegacyWizardStep,
  draft: WizardDraft,
  catalog: RoomCreationCatalog,
): boolean =>
  stepIndex(target) <= stepIndex(current) ||
  WIZARD_STEPS.slice(0, stepIndex(target)).every(
    (item) => validateWizardStep(draft, item.id, catalog).length === 0,
  );

export const stepForIssuePath = (path: string): LegacyWizardStep => {
  if (path.startsWith('roleSetup')) return 'roles';
  if (path === 'visibility' || path === 'readyPolicy' || path === 'allowPublicSpectators' || path === 'reviewEnabled' || path.startsWith('ruleset')) return 'rules';
  return 'players';
};

export const serverIssuesToWizardIssues = (
  issues: readonly RoomConfigIssue[] | undefined,
): WizardIssue[] =>
  (issues ?? []).map((item) => ({
    path: item.path,
    message: messageForIssue(item),
    errorCode: item.errorCode,
    step: stepForIssuePath(item.path),
  }));

export const optionsFromDraft = (draft: WizardDraft): CreateRoomOptionsV31 => ({
  catalogVersion: draft.catalogVersion,
  roomName: draft.roomName.trim(),
  creator: { ...draft.creator, name: draft.creator.name.trim() },
  mode: draft.mode,
  visibility: draft.visibility,
  maxPlayers: draft.maxPlayers,
  minHumanPlayers: draft.minHumanPlayers,
  computerSeats: draft.computerSeats,
  aiFillPolicy: draft.aiFillPolicy,
  roleSetup: { ...draft.roleSetup },
  ...(draft.rolePresetId ? { rolePresetId: draft.rolePresetId } : {}),
  rulesetId: draft.rulesetId,
  rulesetVersion: draft.rulesetVersion,
  readyPolicy: draft.readyPolicy,
  allowPublicSpectators: draft.allowPublicSpectators,
  reviewEnabled: draft.reviewEnabled,
});

export const cloneDraft = (draft: WizardDraft): WizardDraft => ({
  ...draft,
  creator: { ...draft.creator },
  roleSetup: { ...draft.roleSetup },
});
