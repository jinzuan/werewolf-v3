import {
  CATALOG_PLAYER_COUNTS,
  CATALOG_VERSION,
  defaultRulesetRegistry,
  RulesetRegistry,
} from '../rulesets/registry';
import {
  RoomConfigValidator,
  validateRoomConfig,
  validateAndNormalizeRoomConfig,
  normalizeRoomConfig,
} from './roomConfigValidator';
import type {
  CreateRoomOptionsV31,
  RoomConfigValidationResult,
  RoomConfigView,
  RoomCreationCatalog,
  RulesetRegistryLike,
} from '../rulesets/types';

/** Application-facing catalog seam. It deliberately has no room persistence side effects. */
export class RoomCatalogService {
  readonly registry: RulesetRegistryLike;
  readonly validator: RoomConfigValidator;

  constructor(registry: RulesetRegistryLike = defaultRulesetRegistry) {
    this.registry = registry;
    this.validator = new RoomConfigValidator(registry);
  }

  getCatalog(): RoomCreationCatalog {
    return this.registry.getCatalog();
  }

  /** Alias used by transports that model catalog.get as a service method. */
  get(): RoomCreationCatalog {
    return this.getCatalog();
  }

  getCreationCatalog(): RoomCreationCatalog {
    return this.getCatalog();
  }

  catalog(): RoomCreationCatalog {
    return this.getCatalog();
  }

  validateConfig(input: unknown): RoomConfigValidationResult {
    return this.validator.validate(input);
  }

  validateRoomConfig(input: unknown): RoomConfigValidationResult {
    return this.validateConfig(input);
  }

  validate(input: unknown): RoomConfigValidationResult {
    return this.validateConfig(input);
  }

  normalizeConfig(input: unknown): RoomConfigView {
    return this.validator.normalize(input);
  }

  normalizeRoomConfig(input: unknown): RoomConfigView {
    return this.normalizeConfig(input);
  }

  normalize(input: unknown): RoomConfigView {
    return this.normalizeConfig(input);
  }
}

export const defaultRoomCatalogService = new RoomCatalogService(
  defaultRulesetRegistry,
);

export {
  CATALOG_PLAYER_COUNTS,
  CATALOG_VERSION,
  RoomConfigValidator,
  RulesetRegistry,
  validateRoomConfig,
  validateAndNormalizeRoomConfig,
  normalizeRoomConfig,
};

export type {
  CreateRoomOptionsV31,
  RoomConfigValidationResult,
  RoomConfigView,
  RoomCreationCatalog,
};
