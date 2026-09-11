import { GlassFilterPool } from './glassFilterPool';
import { createGlassMotionEngine } from './glassMotionEngine';
import { getGlassProfile } from './glassProfiles';
import { GlassQualityController } from './glassQualityController';
import {
  startGlassSurfaceRegistry,
  type GlassSurfaceRecord,
  type GlassSurfaceRegistry,
} from './glassSurfaceRegistry';
import type { VisualMode } from '../../runtime/visualPreferences';
import type {
  GlassDeviceClass,
  GlassFilterLease,
  GlassQualityAssignment,
  GlassQualityCapabilities,
  GlassQualityCandidate,
  GlassQualityTier,
} from './glassTypes';

type RuntimeSurface = {
  id: string;
  record: GlassSurfaceRecord;
  lease: GlassFilterLease | null;
  signature: string;
  pendingSignature: string;
  desiredSignature: string;
  generation: number;
};

type DesiredOptics = Readonly<{
  signature: string;
  radius: number | undefined;
  strength: 'normal' | 'active';
}>;

export type GlassRuntimeDiagnostics = Readonly<{
  surfaceCount: number;
  visibleCount: number;
  qualities: Readonly<Record<GlassQualityTier, number>>;
  filterPool: ReturnType<GlassFilterPool['snapshot']>;
  deviceClass: GlassDeviceClass;
  performanceDegraded: boolean;
  lastFrameP95: number | null;
}>;

export type GlassRuntime = Readonly<{
  registry: GlassSurfaceRegistry;
  refresh(): void;
  diagnostics(): GlassRuntimeDiagnostics;
  dispose(): void;
}>;

export type GlassRuntimeOptions = Readonly<{
  document?: Document;
  capabilities?: GlassQualityCapabilities;
  filterPool?: GlassFilterPool;
}>;

const detectCapabilities = (documentRef: Document): GlassQualityCapabilities => {
  const view = documentRef.defaultView;
  const supports = view?.CSS?.supports.bind(view.CSS);
  const backdropBlur = Boolean(
    supports?.('backdrop-filter', 'blur(1px)')
    || supports?.('-webkit-backdrop-filter', 'blur(1px)'),
  );
  const urlSyntax = Boolean(
    supports?.('backdrop-filter', 'url("#ww-glass-capability-probe")')
    || supports?.('-webkit-backdrop-filter', 'url("#ww-glass-capability-probe")'),
  );
  // URL backdrop displacement has no trustworthy cross-engine compatibility
  // matrix. Keep the enhanced path conservative; all engines retain Blur.
  const userAgent = view?.navigator.userAgent ?? '';
  const chromium = /(?:Chrome|Chromium|Edg)\//u.test(userAgent)
    && !/(?:Firefox|FxiOS)\//u.test(userAgent);
  return {
    backdropBlur,
    refractSingle: backdropBlur && urlSyntax && chromium,
    refractRgb: backdropBlur && urlSyntax && chromium,
  };
};

const deviceClassFor = (documentRef: Document): GlassDeviceClass => {
  const view = documentRef.defaultView;
  const narrow = view?.matchMedia?.('(max-width: 767px)').matches === true;
  const lowConcurrency = (view?.navigator.hardwareConcurrency ?? 8) <= 4;
  return narrow || lowConcurrency ? 'mobile' : 'desktop';
};

const readVisualMode = (documentRef: Document): VisualMode => {
  const mode = documentRef.documentElement?.dataset.visualMode;
  if (mode === 'frosted' || mode === 'low-transparency' || mode === 'transparent') return mode;
  if (mode === 'original') return 'original';
  return 'frosted';
};

const interactionActive = (record: GlassSurfaceRecord): boolean => {
  if (record.host.hasAttribute('data-glass-motion-state')) return true;
  if (record.host.matches('.drag-segmented--dragging .drag-segmented__slider')) return true;
  return record.host.matches('.drag-segmented--dragging');
};

const qualityCeiling = (
  record: GlassSurfaceRecord,
  visualMode: VisualMode,
): GlassQualityTier | undefined => {
  if (!record.lens && !record.native) return 'solid';
  if (record.role === 'item') {
    const promoted = interactionActive(record)
      || record.host.matches(':is(:hover,:focus-within,.is-speaking,.is-selected,[aria-current="page"],[aria-pressed="true"])');
    if (promoted) return 'refract-single';
    // Tiers with a real visual budget let static visible glass refract instead
    // of collapsing every idle item to solid. The low-transparency tier keeps
    // static items on cheap blur so its reduced budget still reads as glass.
    if (visualMode === 'frosted' || visualMode === 'transparent') return 'refract-single';
    if (visualMode === 'low-transparency') return 'blur';
    return 'solid';
  }
  if (record.host.matches('.drag-segmented__slider')) {
    return record.host.closest('.drag-segmented--dragging') ? 'refract-rgb' : 'solid';
  }
  if (record.role === 'segmented' && record.host.matches('.drag-segmented--dragging')) return 'blur';
  return undefined;
};

const rounded = (value: number, step: number): number => Math.max(step, Math.round(value / step) * step);

const emptyFilterPoolSnapshot = (): ReturnType<GlassFilterPool['snapshot']> => ({
  entryCount: 0,
  pendingEntries: 0,
  referencedEntries: 0,
  totalBytes: 0,
  entries: [],
});

const createDormantRuntime = (documentRef: Document): GlassRuntime => {
  const records = new Map<HTMLElement, GlassSurfaceRecord>();
  const registry: GlassSurfaceRegistry = {
    records,
    refresh() {},
    dispose() {},
  };
  return {
    registry,
    refresh() {},
    diagnostics: () => ({
      surfaceCount: 0,
      visibleCount: 0,
      qualities: {
        'refract-rgb': 0,
        'refract-single': 0,
        blur: 0,
        solid: 0,
      },
      filterPool: emptyFilterPoolSnapshot(),
      deviceClass: deviceClassFor(documentRef),
      performanceDegraded: false,
      lastFrameP95: null,
    }),
    dispose() {},
  };
};

/** Single composition root for optics, quality allocation, surfaces and motion. */
export const createGlassRuntime = (
  options: GlassRuntimeOptions = {},
): GlassRuntime => {
  const documentRef = options.document ?? document;
  if (documentRef.documentElement?.dataset.visualMode === 'original') {
    return createDormantRuntime(documentRef);
  }
  const view = documentRef.defaultView
    ?? (typeof window === 'undefined' ? null : window);
  if (!view) return createDormantRuntime(documentRef);
  const filterPool = options.filterPool ?? new GlassFilterPool();
  const capabilities = options.capabilities ?? detectCapabilities(documentRef);
  let baseDeviceClass = deviceClassFor(documentRef);
  let performanceDegraded = false;
  let lastFrameP95: number | null = null;
  let goodPerformanceSince = 0;
  const qualityController = new GlassQualityController({
    deviceClass: baseDeviceClass,
    capabilities,
    visualMode: readVisualMode(documentRef),
  });
  const surfaces = new Map<HTMLElement, RuntimeSurface>();
  let nextSurfaceId = 0;
  let disposed = false;
  let allocationFrame = 0;
  let performanceFrame = 0;
  let performanceEndsAt = 0;
  let previousPerformanceFrame = 0;
  let continuePerformanceSampling = false;
  const frameIntervals: number[] = [];
  const idleView = view as Window & typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  const idleHandles = new Set<number>();

  const cancelIdleWork = () => {
    if (idleView.cancelIdleCallback) {
      idleHandles.forEach((handle) => {
        try { idleView.cancelIdleCallback?.(handle); }
        catch { /* a callback that already started is rejected by its signature guard */ }
      });
    }
    idleHandles.clear();
  };

  const applyProfileTokens = (record: GlassSurfaceRecord) => {
    const profile = getGlassProfile(record.role);
    record.host.style.setProperty('--ww-glass-rim-width', `${profile.chromaticRim.widthPx}px`);
    record.host.style.setProperty('--ww-glass-instance-rim-opacity', String(profile.chromaticRim.opacity));
    record.host.style.setProperty('--ww-glass-instance-rim-active-opacity', String(profile.chromaticRim.activeOpacity));
    record.host.style.setProperty('--ww-glass-instance-rim-softness', `${profile.chromaticRim.blurPx}px`);
  };

  const clearProfileTokens = (record: GlassSurfaceRecord) => {
    record.host.style.removeProperty('--ww-glass-rim-width');
    record.host.style.removeProperty('--ww-glass-instance-rim-opacity');
    record.host.style.removeProperty('--ww-glass-instance-rim-active-opacity');
    record.host.style.removeProperty('--ww-glass-instance-rim-softness');
  };

  const releaseLease = (surface: RuntimeSurface) => {
    surface.generation += 1;
    surface.lease?.release();
    surface.lease = null;
    surface.signature = '';
    surface.pendingSignature = '';
    surface.desiredSignature = '';
    surface.record.host.style.setProperty('--ww-glass-instance-optics', 'blur(0px)');
  };

  const desiredOpticsFor = (
    surface: RuntimeSurface,
    assignment: GlassQualityAssignment,
  ): DesiredOptics | null => {
    const { record } = surface;
    if (
      (assignment.quality !== 'refract-rgb' && assignment.quality !== 'refract-single')
      || record.width <= 1
      || record.height <= 1
      || (!record.lens && !record.native)
    ) return null;

    let radius: number | undefined;
    try {
      radius = Number.parseFloat(view.getComputedStyle(record.host).borderTopLeftRadius) || undefined;
    } catch {
      radius = undefined;
    }
    const strength = interactionActive(record) ? 'active' : 'normal';
    return {
      radius,
      strength,
      signature: [
        assignment.quality,
        rounded(record.width, 8),
        rounded(record.height, 8),
        rounded(radius ?? 12, 2),
        rounded(view.devicePixelRatio || 1, .25),
        strength,
      ].join(':'),
    };
  };

  const acquireFor = async (
    surface: RuntimeSurface,
    assignment: GlassQualityAssignment,
    desired: DesiredOptics,
  ) => {
    const { record } = surface;
    if (
      disposed
      || surfaces.get(record.host) !== surface
      || surface.desiredSignature !== desired.signature
      || surface.signature === desired.signature
      || surface.pendingSignature === desired.signature
    ) return;

    const generation = ++surface.generation;
    surface.pendingSignature = desired.signature;
    try {
      const lease = await filterPool.acquire({
        role: record.role,
        width: record.width,
        height: record.height,
        radius: desired.radius,
        dpr: view.devicePixelRatio || 1,
        strength: desired.strength,
        quality: assignment.quality,
      });
      if (
        disposed
        || generation !== surface.generation
        || surfaces.get(record.host) !== surface
        || surface.desiredSignature !== desired.signature
      ) {
        lease.release();
        return;
      }
      surface.lease?.release();
      surface.lease = lease;
      surface.signature = desired.signature;
      surface.pendingSignature = '';
      record.host.style.setProperty('--ww-glass-instance-optics', lease.resource.cssFilter);
    } catch {
      if (
        disposed
        || generation !== surface.generation
        || surfaces.get(record.host) !== surface
        || surface.desiredSignature !== desired.signature
      ) return;
      surface.pendingSignature = '';
      surface.lease?.release();
      surface.lease = null;
      surface.signature = '';
      surface.desiredSignature = '';
      record.host.dataset.glassQuality = capabilities.backdropBlur ? 'blur' : 'solid';
      record.host.style.setProperty('--ww-glass-instance-optics', 'blur(0px)');
    }
  };

  const candidates = (): GlassQualityCandidate[] => [...surfaces.values()].map(({ id, record }) => {
    const area = Math.min(
      Math.max(1, view.innerWidth * view.innerHeight),
      Math.max(0, record.width * record.height),
    );
    const interacting = interactionActive(record);
    return {
      id,
      role: record.role,
      visible: record.visible,
      visibleArea: area,
      interacting,
      modal: record.host.matches('.v3-modal'),
      current: record.host.matches(':is(.is-speaking,.is-selected,[aria-current="page"],[aria-pressed="true"])'),
      focused: record.host === documentRef.activeElement || record.host.contains(documentRef.activeElement),
      priority: record.priority * 10,
      maxQuality: qualityCeiling(record, readVisualMode(documentRef)),
    };
  });

  const applyAssignment = (
    surface: RuntimeSurface,
    assignment: GlassQualityAssignment,
  ) => {
    const { record } = surface;
    const desired = desiredOpticsFor(surface, assignment);
    if (!desired) {
      record.host.dataset.glassQuality = (
        assignment.quality === 'refract-rgb' || assignment.quality === 'refract-single'
      )
        ? capabilities.backdropBlur ? 'blur' : 'solid'
        : assignment.quality;
      releaseLease(surface);
      return;
    }

    record.host.dataset.glassQuality = assignment.quality;
    if (surface.desiredSignature !== desired.signature) {
      surface.desiredSignature = desired.signature;
      surface.pendingSignature = '';
      surface.generation += 1;
    }
    if (
      surface.signature === desired.signature
      || surface.pendingSignature === desired.signature
    ) return;

    const run = () => {
      if (
        disposed
        || surfaces.get(record.host) !== surface
        || surface.desiredSignature !== desired.signature
      ) return;
      void acquireFor(surface, assignment, desired);
    };
    if (idleView.requestIdleCallback) {
      let handle = 0;
      try {
        handle = idleView.requestIdleCallback(() => {
          idleHandles.delete(handle);
          run();
        }, { timeout: 180 });
        idleHandles.add(handle);
      } catch {
        run();
      }
    } else {
      run();
    }
  };

  const allocate = () => {
    allocationFrame = 0;
    if (disposed || surfaces.size === 0) return;
    cancelIdleWork();
    const viewportArea = Math.max(1, view.innerWidth * view.innerHeight);
    const allocation = qualityController.allocate(candidates(), viewportArea);
    const byId = new Map([...surfaces.values()].map((surface) => [surface.id, surface]));
    for (const assignment of allocation.assignments) {
      const surface = byId.get(assignment.id);
      if (!surface) continue;
      applyAssignment(surface, assignment);
    }
  };

  const scheduleAllocation = () => {
    if (disposed || allocationFrame) return;
    allocationFrame = view.requestAnimationFrame(allocate);
  };

  const motionEngine = createGlassMotionEngine({ root: documentRef });
  const registry: GlassSurfaceRegistry = startGlassSurfaceRegistry({
    onRegister: (record) => {
      applyProfileTokens(record);
      const id = `glass-surface-${nextSurfaceId += 1}`;
      surfaces.set(record.host, {
        id,
        record,
        lease: null,
        signature: '',
        pendingSignature: '',
        desiredSignature: '',
        generation: 0,
      });
      record.host.dataset.glassQuality = record.role === 'item' ? 'solid' : 'blur';
      scheduleAllocation();
    },
    onVisibility: (record, visible) => {
      if (!visible) {
        const surface = surfaces.get(record.host);
        if (surface) {
          record.host.dataset.glassQuality = 'solid';
          releaseLease(surface);
        }
      }
      scheduleAllocation();
    },
    onResize: (record) => {
      const surface = surfaces.get(record.host);
      if (surface) releaseLease(surface);
      scheduleAllocation();
    },
    onRemove: (record) => {
      const surface = surfaces.get(record.host);
      if (!surface) return;
      const activeMotion = motionEngine.activeElement;
      if (activeMotion && (activeMotion === record.host || record.host.contains(activeMotion))) {
        motionEngine.cancel();
      }
      releaseLease(surface);
      clearProfileTokens(record);
      surfaces.delete(record.host);
      scheduleAllocation();
    },
  }, { document: documentRef });
  const InteractionObserver = view.MutationObserver
    ?? (typeof MutationObserver === 'function' ? MutationObserver : null);
  let interactionObserver: MutationObserver | null = null;
  if (InteractionObserver) {
    interactionObserver = new InteractionObserver((records) => {
      // Consume the delivered batch. The browser already clears its queue, and
      // a pathological class storm collapses into one coalesced rAF allocation
      // instead of per-record recomputation.
      if (records.length > 200) interactionObserver?.takeRecords();
      scheduleAllocation();
    });
  }
  if (documentRef.body) {
    interactionObserver?.observe(documentRef.body, {
      attributes: true,
      subtree: true,
      attributeFilter: [
        'data-glass-motion-state',
        'data-state',
        'class',
        'aria-current',
        'aria-pressed',
      ],
    });
  }

  const performanceStep = (now: number) => {
    performanceFrame = 0;
    if (disposed || documentRef.visibilityState === 'hidden') return;
    if (previousPerformanceFrame) frameIntervals.push(now - previousPerformanceFrame);
    previousPerformanceFrame = now;
    if (now < performanceEndsAt) {
      performanceFrame = view.requestAnimationFrame(performanceStep);
      return;
    }
    const ordered = [...frameIntervals].sort((left, right) => left - right);
    if (ordered.length > 0) {
      const p95 = ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * .95))];
      lastFrameP95 = p95;
      if (p95 > 24) {
        performanceDegraded = true;
        goodPerformanceSince = 0;
        qualityController.setDeviceClass('mobile');
        scheduleAllocation();
      } else if (p95 < 18 && performanceDegraded) {
        goodPerformanceSince ||= now;
        if (now - goodPerformanceSince >= 5_000) {
          performanceDegraded = false;
          qualityController.setDeviceClass(baseDeviceClass);
          scheduleAllocation();
        }
      } else {
        goodPerformanceSince = 0;
      }
    }
    frameIntervals.length = 0;
    previousPerformanceFrame = 0;
    if (continuePerformanceSampling) {
      continuePerformanceSampling = false;
      performanceEndsAt = view.performance.now() + 1_000;
      performanceFrame = view.requestAnimationFrame(performanceStep);
    }
  };

  const samplePerformance = () => {
    if (disposed || documentRef.visibilityState === 'hidden') return;
    if (performanceFrame) {
      continuePerformanceSampling = true;
      return;
    }
    performanceEndsAt = view.performance.now() + 1_000;
    frameIntervals.length = 0;
    previousPerformanceFrame = 0;
    performanceFrame = view.requestAnimationFrame(performanceStep);
  };

  const onInteractionBoundary = () => {
    scheduleAllocation();
    samplePerformance();
  };
  const onResize = () => {
    baseDeviceClass = deviceClassFor(documentRef);
    qualityController.setDeviceClass(performanceDegraded ? 'mobile' : baseDeviceClass);
    scheduleAllocation();
  };
  let fallbackSettleTimer = 0;
  const scheduleFallbackSettleAllocation = () => {
    if (interactionObserver || disposed) return;
    if (fallbackSettleTimer) view.clearTimeout(fallbackSettleTimer);
    fallbackSettleTimer = view.setTimeout(() => {
      fallbackSettleTimer = 0;
      scheduleAllocation();
    }, 1_200);
  };
  const onPointerBoundary = () => {
    onInteractionBoundary();
    scheduleFallbackSettleAllocation();
  };
  const onVisibilityChange = () => {
    if (documentRef.visibilityState !== 'hidden') {
      scheduleAllocation();
      return;
    }
    if (allocationFrame) {
      view.cancelAnimationFrame(allocationFrame);
      allocationFrame = 0;
    }
    if (performanceFrame) {
      view.cancelAnimationFrame(performanceFrame);
      performanceFrame = 0;
    }
    continuePerformanceSampling = false;
    frameIntervals.length = 0;
    previousPerformanceFrame = 0;
    cancelIdleWork();
    surfaces.forEach((surface) => {
      surface.record.host.dataset.glassQuality = 'solid';
      releaseLease(surface);
    });
  };
  documentRef.addEventListener('pointerdown', onPointerBoundary, true);
  documentRef.addEventListener('pointerup', onPointerBoundary, true);
  documentRef.addEventListener('pointercancel', onPointerBoundary, true);
  documentRef.addEventListener('focusin', scheduleAllocation);
  documentRef.addEventListener('focusout', scheduleAllocation);
  documentRef.addEventListener('scroll', samplePerformance, { capture: true, passive: true });
  documentRef.addEventListener('visibilitychange', onVisibilityChange);
  view.addEventListener('resize', onResize);
  scheduleAllocation();

  return {
    registry,
    refresh: () => {
      registry.refresh();
      scheduleAllocation();
    },
    diagnostics: () => {
      const qualities: Record<GlassQualityTier, number> = {
        'refract-rgb': 0,
        'refract-single': 0,
        blur: 0,
        solid: 0,
      };
      let visibleCount = 0;
      surfaces.forEach(({ record }) => {
        if (record.visible) visibleCount += 1;
        const quality = record.host.dataset.glassQuality as GlassQualityTier | undefined;
        if (quality && quality in qualities) qualities[quality] += 1;
      });
      return {
        surfaceCount: surfaces.size,
        visibleCount,
        qualities,
        filterPool: filterPool.snapshot(),
        deviceClass: performanceDegraded ? 'mobile' : baseDeviceClass,
        performanceDegraded,
        lastFrameP95,
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      documentRef.removeEventListener('pointerdown', onPointerBoundary, true);
      documentRef.removeEventListener('pointerup', onPointerBoundary, true);
      documentRef.removeEventListener('pointercancel', onPointerBoundary, true);
      documentRef.removeEventListener('focusin', scheduleAllocation);
      documentRef.removeEventListener('focusout', scheduleAllocation);
      documentRef.removeEventListener('scroll', samplePerformance, true);
      documentRef.removeEventListener('visibilitychange', onVisibilityChange);
      view.removeEventListener('resize', onResize);
      if (allocationFrame) view.cancelAnimationFrame(allocationFrame);
      if (performanceFrame) view.cancelAnimationFrame(performanceFrame);
      if (fallbackSettleTimer) view.clearTimeout(fallbackSettleTimer);
      cancelIdleWork();
      motionEngine.dispose();
      interactionObserver?.disconnect();
      registry.dispose();
      surfaces.forEach(releaseLease);
      surfaces.clear();
      filterPool.dispose();
    },
  };
};

export const startGlassRuntime = (): (() => void) => {
  const runtime = createGlassRuntime();
  return runtime.dispose;
};
