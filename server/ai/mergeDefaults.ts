type AnyRecord = Record<string, unknown>;

const isPlainObject = (value: unknown): value is AnyRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const mergeDefaults = (base: AnyRecord, overrides?: AnyRecord | null): AnyRecord => {
  const output: AnyRecord = { ...base };
  if (!overrides || typeof overrides !== 'object') return output;
  for (const key of Object.keys(overrides)) {
    const value = overrides[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      output[key] = [...value];
    } else if (isPlainObject(value)) {
      const baseValue = output[key];
      output[key] = isPlainObject(baseValue) ? mergeDefaults(baseValue, value) : { ...value };
    } else {
      output[key] = value;
    }
  }
  return output;
};
