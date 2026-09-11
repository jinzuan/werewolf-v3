import type { VisualBackgroundSlot } from './visualBackgroundStore';

export const VISUAL_MODES = ['original', 'frosted', 'low-transparency', 'transparent'] as const;
export type VisualMode = (typeof VISUAL_MODES)[number];

export const BACKGROUND_MODES = ['builtin', 'single', 'dual'] as const;
export type BackgroundMode = (typeof BACKGROUND_MODES)[number];

export const BACKGROUND_PRESETS = ['oriental', 'cinematic', 'dream'] as const;
export type BackgroundPreset = (typeof BACKGROUND_PRESETS)[number];

export const MOTION_MODES = ['none', 'standard', 'full'] as const;
export type MotionMode = (typeof MOTION_MODES)[number];

export const COLOR_SCHEMES = ['system', 'light', 'dark'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

export const GLASS_TINT_SCOPES = ['none', 'day', 'night', 'always'] as const;
export type GlassTintScope = (typeof GLASS_TINT_SCOPES)[number];

export const GLASS_TINT_SOURCES = ['auto', 'custom'] as const;
export type GlassTintSource = (typeof GLASS_TINT_SOURCES)[number];

export const ROOM_SCENES = ['lobby', 'dusk', 'night', 'dawn', 'day', 'ended'] as const;
export type VisualRoomScene = (typeof ROOM_SCENES)[number];

export const VISUAL_PREFERENCES_SCHEMA_VERSION = 4 as const;
export const VISUAL_PREFERENCES_STORAGE_KEY = 'werewolf-v3-visual-preferences-v4';
export const LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V3 = 'werewolf-v3-visual-preferences-v3';
export const LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V2 = 'werewolf-v3-visual-preferences-v2';
export const LEGACY_VISUAL_PREFERENCES_STORAGE_KEY = 'werewolf-v3-visual-preferences-v1';
export const LEGACY_MOTION_STORAGE_KEY = 'werewolf-v3-motion-mode';
export const VISUAL_PREFERENCES_CHANGE_EVENT = 'werewolf-v3-visual-preferences-change';
export const VISUAL_BACKGROUND_REVISION_KEY = 'werewolf-v3-visual-background-revision';

export const announceVisualPreferencesChanged = (): void => {
  try {
    globalThis.localStorage?.setItem(VISUAL_BACKGROUND_REVISION_KEY, `${Date.now()}-${Math.random()}`);
  } catch { /* the same-tab event still applies the change */ }
  try { globalThis.dispatchEvent?.(new CustomEvent(VISUAL_PREFERENCES_CHANGE_EVENT)); }
  catch { /* non-browser tests and restricted WebViews have no event target */ }
};

export interface VisualPreferences {
  schemaVersion: typeof VISUAL_PREFERENCES_SCHEMA_VERSION;
  visualMode: VisualMode;
  backgroundMode: BackgroundMode;
  backgroundPreset: BackgroundPreset;
  motionMode: MotionMode;
  colorScheme: ColorScheme;
  tintScope: GlassTintScope;
  tintSource: GlassTintSource;
  tintIntensity: number;
  tintColor: string;
}

export const DEFAULT_VISUAL_PREFERENCES: Readonly<VisualPreferences> = Object.freeze({
  schemaVersion: VISUAL_PREFERENCES_SCHEMA_VERSION,
  visualMode: 'transparent',
  backgroundMode: 'builtin',
  backgroundPreset: 'dream',
  motionMode: 'standard',
  colorScheme: 'system',
  tintScope: 'none',
  tintSource: 'auto',
  tintIntensity: 34,
  tintColor: '#1F4C68',
});

type WriteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const browserStorage = (): Storage | null => {
  try { return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage; }
  catch { return null; }
};

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const normalizeTintColor = (value: unknown): string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
    ? value.toUpperCase()
    : DEFAULT_VISUAL_PREFERENCES.tintColor;

/** Keep the selected hue while forcing daytime glass into a deep, non-black
 * range that improves contrast against bright backgrounds. */
export const deepenGlassTintColor = (value: string): string => {
  const normalized = normalizeTintColor(value);
  const channels = [1, 3, 5].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
  const brightest = Math.max(...channels);
  if (brightest <= 78) return normalized;
  const scale = 78 / brightest;
  return `#${channels.map((channel) => Math.round(channel * scale).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
};

const normalizeTintIntensity = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : DEFAULT_VISUAL_PREFERENCES.tintIntensity;

/**
 * `full` meant the ordinary motion system through schema v3. Schema v4 gives
 * that value a new meaning, so the persisted version must participate in the
 * migration instead of validating the string in isolation.
 */
const normalizeMotionMode = (
  value: unknown,
  sourceSchemaVersion: unknown,
): MotionMode => {
  const version = typeof sourceSchemaVersion === 'number' && Number.isFinite(sourceSchemaVersion)
    ? sourceSchemaVersion
    : VISUAL_PREFERENCES_SCHEMA_VERSION;

  if (version < VISUAL_PREFERENCES_SCHEMA_VERSION) {
    return value === 'reduced' || value === 'none' ? 'none' : 'standard';
  }
  // Accepting the former name here also repairs hand-edited or partially
  // upgraded v4 records without allowing it back into the public type.
  if (value === 'reduced') return 'none';
  return isOneOf(MOTION_MODES, value)
    ? value
    : DEFAULT_VISUAL_PREFERENCES.motionMode;
};

/** Convert persisted, partial, or future-version input to the current schema. */
export const normalizeVisualPreferences = (value: unknown): VisualPreferences => {
  const source = value && typeof value === 'object'
    ? value as Partial<Record<keyof VisualPreferences, unknown>>
    : {};
  return {
    schemaVersion: VISUAL_PREFERENCES_SCHEMA_VERSION,
    visualMode: isOneOf(VISUAL_MODES, source.visualMode)
      ? source.visualMode
      : DEFAULT_VISUAL_PREFERENCES.visualMode,
    backgroundMode: isOneOf(BACKGROUND_MODES, source.backgroundMode)
      ? source.backgroundMode
      : DEFAULT_VISUAL_PREFERENCES.backgroundMode,
    backgroundPreset: isOneOf(BACKGROUND_PRESETS, source.backgroundPreset)
      ? source.backgroundPreset
      : DEFAULT_VISUAL_PREFERENCES.backgroundPreset,
    motionMode: normalizeMotionMode(source.motionMode, source.schemaVersion),
    colorScheme: isOneOf(COLOR_SCHEMES, source.colorScheme)
      ? source.colorScheme
      : DEFAULT_VISUAL_PREFERENCES.colorScheme,
    tintScope: isOneOf(GLASS_TINT_SCOPES, source.tintScope)
      ? source.tintScope
      : DEFAULT_VISUAL_PREFERENCES.tintScope,
    tintSource: isOneOf(GLASS_TINT_SOURCES, source.tintSource)
      ? source.tintSource
      : DEFAULT_VISUAL_PREFERENCES.tintSource,
    tintIntensity: normalizeTintIntensity(source.tintIntensity),
    tintColor: normalizeTintColor(source.tintColor),
  };
};

/** Resolve a player-facing lobby choice without consulting browser globals. */
export const resolveColorScheme = (
  preference: ColorScheme,
  systemPrefersDark: boolean,
): Exclude<ColorScheme, 'system'> => preference === 'system'
  ? systemPrefersDark ? 'dark' : 'light'
  : preference;

const parseStoredPreferences = (
  raw: string | null,
  expectedSchemaVersion?: number,
): VisualPreferences | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (
      expectedSchemaVersion !== undefined
      && (parsed as { schemaVersion?: unknown }).schemaVersion !== expectedSchemaVersion
    ) return null;
    return normalizeVisualPreferences(parsed);
  }
  catch { return null; }
};

/**
 * Load local visual metadata and migrate the old motion-only key when needed.
 * Storage denial never blocks application startup; defaults are returned.
 */
export const loadVisualPreferences = (
  storage: WriteStorage | null = browserStorage(),
): VisualPreferences => {
  if (!storage) return { ...DEFAULT_VISUAL_PREFERENCES };
  let current: VisualPreferences | null;
  let legacyVisualV3: VisualPreferences | null;
  let legacyVisualV2: VisualPreferences | null;
  let legacyVisual: VisualPreferences | null;
  let legacyMotion: string | null;
  try {
    current = parseStoredPreferences(
      storage.getItem(VISUAL_PREFERENCES_STORAGE_KEY),
      VISUAL_PREFERENCES_SCHEMA_VERSION,
    );
    if (current) return current;
    legacyVisualV3 = parseStoredPreferences(
      storage.getItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V3),
      3,
    );
    legacyVisualV2 = parseStoredPreferences(
      storage.getItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V2),
      2,
    );
    legacyVisual = parseStoredPreferences(
      storage.getItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY),
      1,
    );
    legacyMotion = storage.getItem(LEGACY_MOTION_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_VISUAL_PREFERENCES };
  }

  const migrated = normalizeVisualPreferences({
    ...(legacyVisualV3 ?? legacyVisualV2 ?? legacyVisual ?? DEFAULT_VISUAL_PREFERENCES),
    motionMode: legacyVisualV3?.motionMode
      ?? legacyVisualV2?.motionMode
      ?? legacyVisual?.motionMode
      ?? (legacyMotion === 'reduced' ? 'none' : 'standard'),
  });
  try {
    // Remove the old key only after the versioned record is safely written.
    storage.setItem(VISUAL_PREFERENCES_STORAGE_KEY, JSON.stringify(migrated));
    storage.removeItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V3);
    storage.removeItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V2);
    storage.removeItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY);
    if (legacyMotion !== null) storage.removeItem(LEGACY_MOTION_STORAGE_KEY);
  } catch {
    // Keep using the migrated value for this session even if persistence is denied.
  }
  return migrated;
};

/** Save normalized metadata. Image blobs are handled exclusively by IndexedDB. */
export const saveVisualPreferences = (
  value: unknown,
  storage: Pick<Storage, 'setItem'> | null = browserStorage(),
): VisualPreferences => {
  const normalized = normalizeVisualPreferences(value);
  try { storage?.setItem(VISUAL_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized)); }
  catch { /* local preference persistence is optional */ }
  return normalized;
};

/** Clear both current metadata and the legacy motion key. */
export const resetVisualPreferences = (
  storage: Pick<Storage, 'removeItem'> | null = browserStorage(),
): VisualPreferences => {
  try {
    storage?.removeItem(VISUAL_PREFERENCES_STORAGE_KEY);
    storage?.removeItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V3);
    storage?.removeItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V2);
    storage?.removeItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY);
    storage?.removeItem(LEGACY_MOTION_STORAGE_KEY);
  } catch { /* return defaults even when persistence is denied */ }
  return { ...DEFAULT_VISUAL_PREFERENCES };
};

/**
 * Resolve the image slot used by a scene. Single-image mode always uses its
 * dedicated slot; built-in and dual modes share the same day/night mapping.
 */
export const sceneToBackgroundSlot = (
  scene: VisualRoomScene,
  backgroundMode: BackgroundMode = 'dual',
): VisualBackgroundSlot => {
  if (backgroundMode === 'single') return 'single';
  return scene === 'dusk' || scene === 'night' ? 'night' : 'day';
};
