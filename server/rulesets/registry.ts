import { RULESET } from '../../src/core/rules';
import type { Role } from '../../shared/types';
import {
  ROLE_KEYS,
  type RoleLimit,
  type RolePreset,
  type RoleSetup,
  type RoomCreationCatalog,
  type RuleSetDefinition,
  type RulesetRegistryLike,
} from './types';

export const CATALOG_VERSION = 'v31-rulesets-3.0.0-stage1';

/** Counts shown by the wizard. Only a count with an audited preset is enabled. */
export const CATALOG_PLAYER_COUNTS = [6, 8, 9, 10, 12] as const;

/**
 * These are catalog data, not a second copy of the default board. The
 * executable 12-player values always come from src/core/rules.ts.
 */
export const DEFAULT_ROLE_LIMITS: Readonly<Record<Role, RoleLimit>> = {
  wolf: { min: 1, max: 6 },
  seer: { min: 0, max: 1 },
  witch: { min: 0, max: 1 },
  hunter: { min: 0, max: 1 },
  guardian: { min: 0, max: 1 },
  villager: { min: 0, max: 12 },
};

const cloneRoleSetup = (roleSetup: RoleSetup): RoleSetup => ({
  wolf: roleSetup.wolf,
  seer: roleSetup.seer,
  witch: roleSetup.witch,
  hunter: roleSetup.hunter,
  guardian: roleSetup.guardian,
  villager: roleSetup.villager,
});

const emptyRoleSetup = (): RoleSetup =>
  Object.fromEntries(ROLE_KEYS.map((role) => [role, 0])) as RoleSetup;

const cloneRuleSet = (definition: RuleSetDefinition): RuleSetDefinition => ({
  id: definition.id,
  schemaVersion: definition.schemaVersion,
  rulesetVersion: definition.rulesetVersion,
  locale: definition.locale,
  values: structuredClone(definition.values),
});

const defaultDefinition: RuleSetDefinition = {
  id: RULESET.id,
  schemaVersion: RULESET.schemaVersion,
  rulesetVersion: RULESET.rulesetVersion,
  locale: RULESET.locale,
  values: RULESET.values,
};

export class RulesetRegistry implements RulesetRegistryLike {
  private readonly definitions: RuleSetDefinition[];
  private readonly catalogVersion: string;

  constructor(
    definitions: readonly RuleSetDefinition[] = [defaultDefinition],
    catalogVersion = CATALOG_VERSION,
  ) {
    this.definitions = definitions.map(cloneRuleSet);
    this.catalogVersion = catalogVersion;
  }

  get(id: string, version?: string): RuleSetDefinition | undefined {
    const definition = this.definitions.find(
      (candidate) =>
        candidate.id === id &&
        (version === undefined || candidate.rulesetVersion === version),
    );
    return definition ? cloneRuleSet(definition) : undefined;
  }

  getRuleset(id: string, version?: string): RuleSetDefinition | undefined {
    return this.get(id, version);
  }

  isAvailable(id: string, version?: string): boolean {
    return this.definitions.some(
      (candidate) =>
        candidate.id === id &&
        (version === undefined || candidate.rulesetVersion === version),
    );
  }

  has(id: string, version?: string): boolean {
    return this.isAvailable(id, version);
  }

  list(): RuleSetDefinition[] {
    return this.definitions.map(cloneRuleSet);
  }

  getCatalog(): RoomCreationCatalog {
    const defaultRuleset = this.get(RULESET.id, RULESET.rulesetVersion);
    const roleSetup = defaultRuleset
      ? (defaultRuleset.values['game.role_setup'] as RoleSetup)
      : undefined;
    const rolePresets: RolePreset[] = CATALOG_PLAYER_COUNTS.map(
      (playerCount) => {
        const enabled =
          playerCount === RULESET.values['game.player_count'] &&
          defaultRuleset !== undefined &&
          roleSetup !== undefined;

        return {
          id:
            enabled || playerCount === RULESET.values['game.player_count']
              ? RULESET.id
              : `${RULESET.id}-${playerCount}p`,
          name: enabled ? '新手均衡' : `${playerCount}人规则准备中`,
          playerCount,
          // Disabled entries are intentionally non-executable placeholders;
          // they never pass validator checks and cannot reach a game session.
          roleSetup: enabled ? cloneRoleSetup(roleSetup) : emptyRoleSetup(),
          rulesetId: RULESET.id,
          rulesetVersion: RULESET.rulesetVersion,
          enabled,
          ...(enabled
            ? {}
            : { unavailableReason: 'RULESET_UNAVAILABLE' }),
        };
      },
    );

    return {
      catalogVersion: this.catalogVersion,
      playerCounts: [...CATALOG_PLAYER_COUNTS],
      rolePresets,
      roleLimits: structuredClone(this.roleLimits()),
      limits: {
        roomNameMax: 64,
        displayNameMax: 32,
        maxSpectators: 100,
      },
    };
  }

  private roleLimits(): Record<Role, RoleLimit> {
    return structuredClone(DEFAULT_ROLE_LIMITS);
  }
}

export const defaultRulesetRegistry = new RulesetRegistry();
