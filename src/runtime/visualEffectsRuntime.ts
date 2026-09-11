import builtInDayBackground from '../assets/visual/moon-village-day.webp';
import builtInNightBackground from '../assets/visual/moon-village-night.webp';
import cinematicDayBackground from '../assets/visual/cinematic-day.webp';
import cinematicNightBackground from '../assets/visual/cinematic-night.webp';
import dreamDayBackground from '../assets/visual/dream-day.webp';
import dreamNightBackground from '../assets/visual/dream-night.webp';
import { createGlassRuntime, type GlassRuntime } from '../visual/glass/glassRuntime';
import {
  VISUAL_BACKGROUND_REVISION_KEY,
  VISUAL_PREFERENCES_CHANGE_EVENT,
  VISUAL_PREFERENCES_STORAGE_KEY,
  deepenGlassTintColor,
  loadVisualPreferences,
  type BackgroundPreset,
  type VisualPreferences,
} from './visualPreferences';

const cssUrl = (value: string): string => `url(${JSON.stringify(value)})`;
const builtInBackgrounds: Record<BackgroundPreset, { day: string; night: string }> = {
  oriental: { day: builtInDayBackground, night: builtInNightBackground },
  cinematic: { day: cinematicDayBackground, night: cinematicNightBackground },
  dream: { day: dreamDayBackground, night: dreamNightBackground },
};

const applyAttributes = (preferences: VisualPreferences): void => {
  const root = document.documentElement;
  root.dataset.visualMode = preferences.visualMode;
  root.dataset.backgroundMode = preferences.backgroundMode;
  root.dataset.backgroundPreset = preferences.backgroundPreset;
  root.dataset.motion = preferences.motionMode;
  root.dataset.colorScheme = preferences.colorScheme;
  root.dataset.glassTintScope = preferences.tintScope;
  root.dataset.glassTintSource = preferences.tintSource;
  root.style.setProperty('--ww-glass-tint-intensity', String(preferences.tintIntensity));
  if (preferences.tintSource === 'custom') {
    root.style.setProperty('--ww-glass-tint-day', deepenGlassTintColor(preferences.tintColor));
    root.style.setProperty('--ww-glass-tint-night', preferences.tintColor);
  }
};

/** Start local-only visual preferences, background resources and glass optics. */
export const startVisualEffects = (): (() => void) => {
  let objectUrls: string[] = [];
  let generation = 0;
  let tintAbortController: AbortController | null = null;
  let glassRuntime: GlassRuntime | null = null;

  const ensureGlassRuntime = (): GlassRuntime | null => {
    if (glassRuntime) return glassRuntime;
    try {
      glassRuntime = createGlassRuntime();
      return glassRuntime;
    } catch {
      // A browser without the observers/canvas capabilities still receives
      // the background and stable CSS fallback material.
      return null;
    }
  };

  const stopGlassRuntime = () => {
    glassRuntime?.dispose();
    glassRuntime = null;
  };

  const revokeObjectUrls = () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls = [];
  };

  const applyAutomaticTint = async (
    preferences: VisualPreferences,
    sources: {
      day: { value: Blob | string; cacheKey: string };
      night: { value: Blob | string; cacheKey: string };
    },
    currentGeneration: number,
    signal: AbortSignal,
  ) => {
    const root = document.documentElement;
    if (preferences.tintSource === 'custom') {
      root.style.setProperty('--ww-glass-tint-day', deepenGlassTintColor(preferences.tintColor));
      root.style.setProperty('--ww-glass-tint-night', preferences.tintColor);
      return;
    }
    if (preferences.tintScope === 'none' || signal.aborted || currentGeneration !== generation) return;

    const { extractVisualTint } = await import('./visualTintExtractor');
    const extract = async (slot: 'day' | 'night') => {
      if (signal.aborted || currentGeneration !== generation) return;
      try {
        const color = await extractVisualTint(sources[slot].value, {
          cacheKey: sources[slot].cacheKey,
          environment: { signal },
        });
        if (signal.aborted || currentGeneration !== generation) return;
        const resolved = color ?? preferences.tintColor;
        root.style.setProperty(
          `--ww-glass-tint-${slot}`,
          slot === 'day' ? deepenGlassTintColor(resolved) : resolved,
        );
      } catch {
        if (signal.aborted || currentGeneration !== generation) return;
        root.style.setProperty(
          `--ww-glass-tint-${slot}`,
          slot === 'day'
            ? deepenGlassTintColor(preferences.tintColor)
            : preferences.tintColor,
        );
      }
    };

    // Avoid decoding two user-supplied high-resolution images at once.
    if (preferences.tintScope === 'day' || preferences.tintScope === 'always') await extract('day');
    if (signal.aborted || currentGeneration !== generation) return;
    if (preferences.tintScope === 'night' || preferences.tintScope === 'always') await extract('night');
  };

  const apply = async () => {
    const currentGeneration = ++generation;
    tintAbortController?.abort();
    tintAbortController = new AbortController();
    const tintSignal = tintAbortController.signal;
    const preferences = loadVisualPreferences();
    const root = document.documentElement;
    applyAttributes(preferences);
    revokeObjectUrls();

    if (preferences.visualMode === 'original') {
      stopGlassRuntime();
      root.style.setProperty('--ww-visual-day-image', 'none');
      root.style.setProperty('--ww-visual-night-image', 'none');
      return;
    }

    ensureGlassRuntime()?.refresh();
    const fallback = builtInBackgrounds[preferences.backgroundPreset];
    let dayUrl = fallback.day;
    let nightUrl = fallback.night;
    let dayTintSource: Blob | string = fallback.day;
    let nightTintSource: Blob | string = fallback.night;
    let dayTintKey = `builtin:${preferences.backgroundPreset}:day`;
    let nightTintKey = `builtin:${preferences.backgroundPreset}:night`;

    if (preferences.backgroundMode !== 'builtin') {
      try {
        const { visualBackgroundStore } = await import('./visualBackgroundStore');
        const records = preferences.backgroundMode === 'single'
          ? [await visualBackgroundStore.get('single')]
          : await Promise.all([
            visualBackgroundStore.get('day'),
            visualBackgroundStore.get('night'),
          ]);
        if (currentGeneration !== generation) return;

        if (preferences.backgroundMode === 'single' && records[0]) {
          dayUrl = URL.createObjectURL(records[0].blob);
          nightUrl = dayUrl;
          objectUrls = [dayUrl];
          dayTintSource = records[0].blob;
          nightTintSource = records[0].blob;
          dayTintKey = `custom:single:${records[0].metadata.updatedAt}`;
          nightTintKey = dayTintKey;
        } else if (preferences.backgroundMode === 'dual') {
          if (records[0]) {
            dayUrl = URL.createObjectURL(records[0].blob);
            objectUrls.push(dayUrl);
            dayTintSource = records[0].blob;
            dayTintKey = `custom:day:${records[0].metadata.updatedAt}`;
          }
          if (records[1]) {
            nightUrl = URL.createObjectURL(records[1].blob);
            objectUrls.push(nightUrl);
            nightTintSource = records[1].blob;
            nightTintKey = `custom:night:${records[1].metadata.updatedAt}`;
          }
        }
      } catch {
        // IndexedDB denial or corrupt local data falls back to the selected
        // built-in scene without interrupting the app or glass runtime.
      }
    }

    root.style.setProperty('--ww-visual-day-image', cssUrl(dayUrl));
    root.style.setProperty('--ww-visual-night-image', cssUrl(nightUrl));
    await applyAutomaticTint(preferences, {
      day: { value: dayTintSource, cacheKey: dayTintKey },
      night: { value: nightTintSource, cacheKey: nightTintKey },
    }, currentGeneration, tintSignal);
  };

  const refresh = () => { void apply(); };
  const onStorage = (event: StorageEvent) => {
    if (
      !event.key
      || event.key === VISUAL_PREFERENCES_STORAGE_KEY
      || event.key === VISUAL_BACKGROUND_REVISION_KEY
    ) refresh();
  };
  window.addEventListener(VISUAL_PREFERENCES_CHANGE_EVENT, refresh);
  window.addEventListener('storage', onStorage);
  void apply();

  return () => {
    generation += 1;
    window.removeEventListener(VISUAL_PREFERENCES_CHANGE_EVENT, refresh);
    window.removeEventListener('storage', onStorage);
    tintAbortController?.abort();
    revokeObjectUrls();
    stopGlassRuntime();
  };
};
