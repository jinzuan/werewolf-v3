import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKGROUND_MODES,
  BACKGROUND_PRESETS,
  COLOR_SCHEMES,
  DEFAULT_VISUAL_PREFERENCES,
  LEGACY_MOTION_STORAGE_KEY,
  LEGACY_VISUAL_PREFERENCES_STORAGE_KEY,
  LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V2,
  LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V3,
  MOTION_MODES,
  VISUAL_MODES,
  VISUAL_PREFERENCES_SCHEMA_VERSION,
  VISUAL_PREFERENCES_STORAGE_KEY,
  loadVisualPreferences,
  normalizeVisualPreferences,
  resetVisualPreferences,
  saveVisualPreferences,
  sceneToBackgroundSlot,
  deepenGlassTintColor,
  resolveColorScheme,
} from '../visualPreferences';
import {
  MAX_VISUAL_BACKGROUND_BYTES,
  createVisualBackgroundStore,
  validateVisualBackgroundFile,
  validateVisualBackgroundFileBasics,
} from '../visualBackgroundStore';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

test('normalizes invalid and partial visual preferences to stable defaults', () => {
  assert.deepEqual(normalizeVisualPreferences(null), DEFAULT_VISUAL_PREFERENCES);
  assert.deepEqual(normalizeVisualPreferences({
    schemaVersion: 99,
    visualMode: 'unknown',
    backgroundMode: 'remote',
    backgroundPreset: 'unknown',
    motionMode: 'fast',
  }), DEFAULT_VISUAL_PREFERENCES);
  assert.equal(VISUAL_PREFERENCES_SCHEMA_VERSION, 4);
  assert.deepEqual(MOTION_MODES, ['none', 'standard', 'full']);

  for (const visualMode of VISUAL_MODES) {
    for (const backgroundMode of BACKGROUND_MODES) {
      assert.deepEqual(normalizeVisualPreferences({
        schemaVersion: 4,
        visualMode,
        backgroundMode,
        motionMode: 'full',
      }), {
        ...DEFAULT_VISUAL_PREFERENCES,
        visualMode,
        backgroundMode,
        motionMode: 'full',
      });
    }
  }

  for (const backgroundPreset of BACKGROUND_PRESETS) {
    assert.equal(normalizeVisualPreferences({ backgroundPreset }).backgroundPreset, backgroundPreset);
  }
  for (const colorScheme of COLOR_SCHEMES) {
    assert.equal(normalizeVisualPreferences({ colorScheme }).colorScheme, colorScheme);
  }
  assert.deepEqual(normalizeVisualPreferences({
    tintScope: 'always',
    tintSource: 'custom',
    tintIntensity: 140.4,
    tintColor: '#1a2b3c',
  }), {
    ...DEFAULT_VISUAL_PREFERENCES,
    tintScope: 'always',
    tintSource: 'custom',
    tintIntensity: 100,
    tintColor: '#1A2B3C',
  });
});

test('migrates old motion names without collapsing an intentional v4 full mode', () => {
  assert.equal(normalizeVisualPreferences({ schemaVersion: 1, motionMode: 'system' }).motionMode, 'standard');
  assert.equal(normalizeVisualPreferences({ schemaVersion: 2, motionMode: 'reduced' }).motionMode, 'none');
  assert.equal(normalizeVisualPreferences({ schemaVersion: 3, motionMode: 'full' }).motionMode, 'standard');
  assert.equal(normalizeVisualPreferences({ schemaVersion: 4, motionMode: 'none' }).motionMode, 'none');
  assert.equal(normalizeVisualPreferences({ schemaVersion: 4, motionMode: 'standard' }).motionMode, 'standard');
  assert.equal(normalizeVisualPreferences({ schemaVersion: 4, motionMode: 'full' }).motionMode, 'full');
});

test('resolves lobby color scheme from explicit and system preferences', () => {
  assert.equal(resolveColorScheme('system', false), 'light');
  assert.equal(resolveColorScheme('system', true), 'dark');
  assert.equal(resolveColorScheme('light', true), 'light');
  assert.equal(resolveColorScheme('dark', false), 'dark');
});

test('deepens daytime tint without turning the hue black', () => {
  assert.equal(deepenGlassTintColor('#274A59'), '#22414E');
  assert.equal(deepenGlassTintColor('#FFAA55'), '#4E341A');
  assert.equal(deepenGlassTintColor('#102030'), '#102030');
});

test('migrates the legacy motion preference after writing versioned metadata', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_MOTION_STORAGE_KEY, 'reduced');

  const preferences = loadVisualPreferences(storage);
  assert.equal(preferences.motionMode, 'none');
  assert.equal(preferences.visualMode, 'transparent');
  assert.equal(preferences.backgroundMode, 'builtin');
  assert.equal(storage.getItem(LEGACY_MOTION_STORAGE_KEY), null);
  assert.deepEqual(JSON.parse(storage.getItem(VISUAL_PREFERENCES_STORAGE_KEY) ?? ''), preferences);
});

test('migrates v1 visual metadata to the explicit preset and motion schema', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    visualMode: 'transparent',
    backgroundMode: 'single',
    motionMode: 'system',
  }));

  const preferences = loadVisualPreferences(storage);
  assert.deepEqual(preferences, {
    ...DEFAULT_VISUAL_PREFERENCES,
    visualMode: 'transparent',
    backgroundMode: 'single',
  });
  assert.equal(storage.getItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY), null);
});

test('migrates v2 visual metadata while adding tint defaults', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V2, JSON.stringify({
    schemaVersion: 2,
    visualMode: 'transparent',
    backgroundMode: 'builtin',
    backgroundPreset: 'dream',
    motionMode: 'reduced',
  }));

  const preferences = loadVisualPreferences(storage);
  assert.deepEqual(preferences, {
    ...DEFAULT_VISUAL_PREFERENCES,
    visualMode: 'transparent',
    backgroundPreset: 'dream',
    motionMode: 'none',
  });
  assert.equal(storage.getItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V2), null);
});

test('migrates v3 full to standard while preserving every other visual preference', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V3, JSON.stringify({
    schemaVersion: 3,
    visualMode: 'low-transparency',
    backgroundMode: 'dual',
    backgroundPreset: 'cinematic',
    motionMode: 'full',
    colorScheme: 'dark',
    tintScope: 'always',
    tintSource: 'custom',
    tintIntensity: 57,
    tintColor: '#5a2b70',
  }));

  const preferences = loadVisualPreferences(storage);
  assert.deepEqual(preferences, {
    schemaVersion: 4,
    visualMode: 'low-transparency',
    backgroundMode: 'dual',
    backgroundPreset: 'cinematic',
    motionMode: 'standard',
    colorScheme: 'dark',
    tintScope: 'always',
    tintSource: 'custom',
    tintIntensity: 57,
    tintColor: '#5A2B70',
  });
  assert.equal(storage.getItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY_V3), null);
  assert.deepEqual(JSON.parse(storage.getItem(VISUAL_PREFERENCES_STORAGE_KEY) ?? ''), preferences);
});

test('keeps full motion when loading a valid v4 record', () => {
  const storage = new MemoryStorage();
  storage.setItem(VISUAL_PREFERENCES_STORAGE_KEY, JSON.stringify({
    ...DEFAULT_VISUAL_PREFERENCES,
    motionMode: 'full',
  }));

  assert.equal(loadVisualPreferences(storage).motionMode, 'full');
});

test('ignores parseable but invalid v4 metadata and still recovers v1 preferences', () => {
  const storage = new MemoryStorage();
  storage.setItem(VISUAL_PREFERENCES_STORAGE_KEY, '{}');
  storage.setItem(LEGACY_VISUAL_PREFERENCES_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    visualMode: 'frosted',
    backgroundMode: 'builtin',
    motionMode: 'reduced',
  }));

  const preferences = loadVisualPreferences(storage);
  assert.equal(preferences.visualMode, 'frosted');
  assert.equal(preferences.motionMode, 'none');
});

test('storage exceptions safely fall back without leaking errors', async () => {
  const denied = {
    getItem(): string | null { throw new Error('denied'); },
    setItem(): void { throw new Error('denied'); },
    removeItem(): void { throw new Error('denied'); },
  };

  assert.deepEqual(loadVisualPreferences(denied), DEFAULT_VISUAL_PREFERENCES);
  assert.deepEqual(saveVisualPreferences({ visualMode: 'frosted' }, denied), {
    ...DEFAULT_VISUAL_PREFERENCES,
    visualMode: 'frosted',
  });
  assert.deepEqual(resetVisualPreferences(denied), DEFAULT_VISUAL_PREFERENCES);

  const unavailableStore = createVisualBackgroundStore(null);
  assert.equal(await unavailableStore.get('day'), null);
  assert.deepEqual(await unavailableStore.putMany([]), { ok: true, metadata: [] });
  assert.equal(await unavailableStore.delete('night'), false);
  assert.equal(await unavailableStore.clear(), false);
  assert.deepEqual(await unavailableStore.metadata(), []);

  const rejectedStore = createVisualBackgroundStore({
    open(): IDBOpenDBRequest { throw new Error('IndexedDB denied'); },
  } as unknown as IDBFactory);
  assert.equal(await rejectedStore.get('day'), null);
  assert.equal(await rejectedStore.delete('night'), false);
  assert.deepEqual(await rejectedStore.metadata(), []);
});

test('maps room scenes to day, night, and single background slots', () => {
  assert.equal(sceneToBackgroundSlot('lobby'), 'day');
  assert.equal(sceneToBackgroundSlot('dawn'), 'day');
  assert.equal(sceneToBackgroundSlot('day'), 'day');
  assert.equal(sceneToBackgroundSlot('ended'), 'day');
  assert.equal(sceneToBackgroundSlot('dusk'), 'night');
  assert.equal(sceneToBackgroundSlot('night'), 'night');
  assert.equal(sceneToBackgroundSlot('night', 'single'), 'single');
  assert.equal(sceneToBackgroundSlot('day', 'single'), 'single');
});

test('performs dependency-free file type and size validation', async () => {
  assert.deepEqual(
    validateVisualBackgroundFileBasics(new Blob([], { type: 'image/png' })),
    { valid: false, code: 'empty' },
  );
  assert.deepEqual(
    validateVisualBackgroundFileBasics({ size: MAX_VISUAL_BACKGROUND_BYTES + 1, type: 'image/jpeg' }),
    { valid: false, code: 'too-large' },
  );
  assert.deepEqual(
    validateVisualBackgroundFileBasics(new Blob(['x'], { type: 'image/svg+xml' })),
    { valid: false, code: 'unsupported-type' },
  );
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/avif']) {
    assert.deepEqual(
      validateVisualBackgroundFileBasics(new Blob(['x'], { type })),
      { valid: true, code: 'ok' },
    );
  }

  const image = new Blob(['encoded-image'], { type: 'image/webp' });
  assert.deepEqual(await validateVisualBackgroundFile(image, {}), {
    valid: false,
    code: 'decode-unavailable',
  });
  assert.deepEqual(await validateVisualBackgroundFile(image, {
    createImageBitmap: async () => ({ width: 100, height: 50 }),
  }), { valid: true, code: 'ok' });
  assert.deepEqual(await validateVisualBackgroundFile(image, {
    createImageBitmap: async () => { throw new Error('invalid image'); },
  }), { valid: false, code: 'decode-failed' });
});
