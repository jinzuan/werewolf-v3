import { randomInt as cryptoRandomInt } from 'node:crypto';
import type { Role } from '../../shared/types';
import type { RoleSetup } from './types';

/**
 * Keep the order stable for diagnostics and deterministic tests.  The order
 * is not a source of game randomness: buildRoleDeck always shuffles it with
 * a cryptographically secure index generator before it is dealt.
 */
export const ROLE_SETUP_KEYS = [
  'wolf',
  'seer',
  'witch',
  'hunter',
  'guardian',
  'villager',
] as const satisfies readonly Role[];

export type SecureRandomIndex = (exclusiveMax: number) => number;

export type RoleDeckErrorCode =
  | 'INVALID_ROLE_SETUP'
  | 'ROLE_COUNT_MISMATCH';

export class RoleDeckError extends Error {
  readonly name = 'RoleDeckError';

  constructor(
    public readonly code: RoleDeckErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertRoleSetup(value: unknown): asserts value is RoleSetup {
  if (!isPlainRecord(value)) {
    throw new RoleDeckError(
      'INVALID_ROLE_SETUP',
      'A persisted role setup is required before starting a game.',
    );
  }

  for (const key of Object.keys(value)) {
    if (!(ROLE_SETUP_KEYS as readonly string[]).includes(key)) {
      throw new RoleDeckError(
        'INVALID_ROLE_SETUP',
        `Unknown role in persisted role setup: ${key}`,
        { role: key },
      );
    }
  }

  for (const role of ROLE_SETUP_KEYS) {
    const count = value[role];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new RoleDeckError(
        'INVALID_ROLE_SETUP',
        `Role count for ${role} must be a non-negative integer.`,
        { role, count },
      );
    }
  }
}

/** Expand the persisted, versioned role counts without consulting any other deck. */
export const expandRoleSetup = (
  roleSetup: RoleSetup,
  expectedPlayerCount?: number,
): Role[] => {
  assertRoleSetup(roleSetup);
  const deck: Role[] = [];
  for (const role of ROLE_SETUP_KEYS) {
    for (let index = 0; index < roleSetup[role]; index += 1) {
      deck.push(role);
    }
  }

  if (
    expectedPlayerCount !== undefined &&
    (!Number.isSafeInteger(expectedPlayerCount) ||
      expectedPlayerCount < 0 ||
      deck.length !== expectedPlayerCount)
  ) {
    throw new RoleDeckError(
      'ROLE_COUNT_MISMATCH',
      'The persisted role setup does not match the room player count.',
      { expected: expectedPlayerCount, actual: deck.length },
    );
  }
  return deck;
};

/**
 * Fisher-Yates using crypto.randomInt.  The injectable generator is only a
 * test seam; production callers use Node's unbiased cryptographic generator.
 */
export const secureShuffle = <T>(
  values: readonly T[],
  randomIndex: SecureRandomIndex = cryptoRandomInt,
): T[] => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    if (
      !Number.isSafeInteger(swapIndex) ||
      swapIndex < 0 ||
      swapIndex > index
    ) {
      throw new RangeError('Secure random index is outside the shuffle range.');
    }
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

/**
 * Build and securely shuffle the only executable deck for a room start.
 * FINDINGS P0 #3 / protocol-state-machine review: the starter must consume
 * persisted roleSetup and must never fall back to a fixed role list.
 */
export const buildRoleDeck = (
  roleSetup: RoleSetup,
  expectedPlayerCount: number,
  randomIndex: SecureRandomIndex = cryptoRandomInt,
): Role[] => secureShuffle(
  expandRoleSetup(roleSetup, expectedPlayerCount),
  randomIndex,
);
