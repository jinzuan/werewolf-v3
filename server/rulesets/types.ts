import type { Role } from '../../shared/types';
import type {
  AIFillPolicy,
  CreateRoomOptionsV31,
  ReadyPolicy,
  RoomConfigIssue as SharedRoomConfigIssue,
  RoomConfigView,
  RoomCreationCatalog as SharedRoomCreationCatalog,
  RoomMode,
  RoomRolePreset,
  RoomVisibility,
  RoleSetup,
} from '../../shared/roomContract';

/**
 * M0 owns the wire DTOs. M1 only adds registry/validation-specific metadata
 * and re-exports the contract types from this server seam.
 */
export type {
  AIFillPolicy,
  CreateRoomOptionsV31,
  ReadyPolicy,
  RoomConfigView,
  RoomMode,
  RoomVisibility,
  RoleSetup,
};

export type { Role } from '../../shared/types';

export const ROLE_KEYS = [
  'wolf',
  'seer',
  'witch',
  'hunter',
  'guardian',
  'villager',
] as const satisfies readonly Role[];

export interface RuleSetDefinition {
  id: string;
  schemaVersion: number;
  rulesetVersion: string;
  locale: string;
  values: Readonly<Record<string, unknown>>;
}

export interface RoleLimit {
  min: number;
  max: number;
}

export type RolePreset = RoomRolePreset;
export type RoomCreationCatalog = SharedRoomCreationCatalog & {
  /** The complete map is supplied by the registry even though M0 allows partial maps. */
  roleLimits: Record<Role, RoleLimit>;
};

export type RoomConfigErrorCode =
  | 'INVALID_ROOM_CONFIG'
  | 'ROLE_COUNT_MISMATCH'
  | 'RULESET_UNAVAILABLE';

export type RoomConfigIssue = Omit<SharedRoomConfigIssue, 'errorCode'> & {
  errorCode: RoomConfigErrorCode;
};

export type RoomConfigValidationResult =
  | { ok: true; config: RoomConfigView }
  | {
      ok: false;
      issues: RoomConfigIssue[];
      errorCode: RoomConfigErrorCode;
    };

export interface RulesetRegistryLike {
  get(id: string, version?: string): RuleSetDefinition | undefined;
  isAvailable(id: string, version?: string): boolean;
  getCatalog(): RoomCreationCatalog;
}
