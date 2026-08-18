import { randomInt as cryptoRandomInt } from 'node:crypto';

export type SecureRandomIndex = (exclusiveMax: number) => number;

/** Fisher-Yates shuffle used only for AI choice presentation/selection. */
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
      throw new RangeError('Secure random index is outside the selection range.');
    }
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

export const randomElement = <T>(
  values: readonly T[],
  randomIndex: SecureRandomIndex = cryptoRandomInt,
): T | undefined => {
  if (values.length === 0) return undefined;
  const index = randomIndex(values.length);
  if (!Number.isSafeInteger(index) || index < 0 || index >= values.length) {
    throw new RangeError('Secure random index is outside the selection range.');
  }
  return values[index];
};
