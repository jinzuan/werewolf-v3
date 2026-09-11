import type { GlassSurfaceRole } from './glassTypes';

export type { GlassSurfaceRole } from './glassTypes';

export type GlassSurfaceRecord = {
  host: HTMLElement;
  role: GlassSurfaceRole;
  priority: number;
  lens: HTMLSpanElement | null;
  native: boolean;
  visible: boolean;
  width: number;
  height: number;
  generatedRole: boolean;
  generatedMotion: boolean;
};

export type GlassSurfaceRegistryCallbacks = {
  onRegister?: (record: GlassSurfaceRecord) => void;
  onRemove?: (record: GlassSurfaceRecord) => void;
  onVisibility?: (record: GlassSurfaceRecord, visible: boolean) => void;
  onResize?: (record: GlassSurfaceRecord) => void;
};

export type GlassSurfaceRegistry = {
  records: ReadonlyMap<HTMLElement, GlassSurfaceRecord>;
  refresh(root?: ParentNode): void;
  dispose(): void;
};

export type GlassSurfaceRegistryEnvironment = Readonly<{
  document?: Document;
  intersectionObserver?: typeof IntersectionObserver | null;
  resizeObserver?: typeof ResizeObserver | null;
  mutationObserver?: typeof MutationObserver | null;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
}>;

const NATIVE_SELECTOR = 'input,select,textarea';
const EXCLUDED_SELECTOR = [
  '.drag-segmented__option',
  '[data-glass-owner="none"]',
  '[data-glass-role="none"]',
].join(',');

const ROLE_SELECTORS: ReadonlyArray<readonly [GlassSurfaceRole, string]> = [
  ['navigation', '.v3-topbar,.v3-room-header,.v3-mobile-match-nav'],
  ['segmented', '.drag-segmented,.v3-segmented'],
  ['field', '.v3-input,input,select,textarea'],
  ['panel', [
    '.v3-card', '.v3-stage-summary', '.v3-event-details', '.v3-modal',
    '.v3-lobby-hero', '.v3-lobby-room-section', '.v3-room-row',
    '.v3-player-panel', '.v3-chat-panel', '.v3-chat-input', '.v3-action-panel',
    '.v3-result-hero', '.v3-advanced-info', '.v3-join-advanced',
    '.ww-role-card', '.ww-role-reveal__face', '.v3-wolf-team__card',
    '.waiting-room__intro', '.waiting-room__players', '.waiting-room__side',
    '.waiting-room__actions', '.waiting-room__config', '.waiting-room__checks',
    '.waiting-room__spectators',
  ].join(',')],
  ['control', [
    'button', 'a.v3-button', 'label.v3-button', '.v3-target-grid button',
    '.v3-action-tabs button', '.v3-mobile-room-meta__code',
  ].join(',')],
  ['item', [
    '.v3-badge', '.ww-status', '.v3-alert', '.v3-sync-status',
    '.v3-chat-bubble', '.v3-player-seat', '.ww-seat', '.v3-event-item',
    '.v3-current-speaker', '.v3-discussion-queue', '.v3-vote-status',
    '.v3-mobile-private-result', '.v3-event-private', '.v3-spectate-identity',
    '.v3-monitor-identity-row', '.v3-mobile-room-meta > div',
    '.v3-inline-note',
  ].join(',')],
];

const ALL_SELECTOR = [
  '[data-glass-role]:not([data-glass-role="none"])',
  ...ROLE_SELECTORS.map(([, selector]) => selector),
].join(',');

const ROLE_SET = new Set<GlassSurfaceRole>([
  'navigation', 'panel', 'control', 'field', 'segmented', 'item',
]);

// A class-attribute storm (React re-renders, animations) can queue tens of
// thousands of records in a single batch. Above this bound we abandon the
// record-by-record path and fall back to one coalesced full reconciliation so
// the observer can never accumulate an unbounded backlog.
const MAX_MUTATION_BATCH = 200;

const priorityFor = (host: HTMLElement, role: GlassSurfaceRole): number => {
  const explicit = host.dataset.glassPriority;
  if (explicit === 'critical') return 100;
  if (explicit === 'high') return 78;
  if (explicit === 'low') return 22;
  if (explicit) {
    const numeric = Number(explicit);
    if (Number.isFinite(numeric)) return Math.max(0, Math.min(100, numeric));
  }
  if (role === 'navigation') return 90;
  if (role === 'panel') return 65;
  if (role === 'field' || role === 'segmented') return 55;
  if (role === 'control') return 48;
  return 20;
};

const resolveRole = (host: HTMLElement): GlassSurfaceRole | null => {
  const explicit = host.dataset.glassGeneratedRole === 'true'
    ? undefined
    : host.dataset.glassRole;
  if (explicit && ROLE_SET.has(explicit as GlassSurfaceRole)) {
    return explicit as GlassSurfaceRole;
  }
  for (const [role, selector] of ROLE_SELECTORS) {
    if (host.matches(selector)) return role;
  }
  return null;
};

const canOwnLens = (host: HTMLElement): boolean => !host.matches(NATIVE_SELECTOR);

const isSegmentedDescendantWithoutOwnership = (host: HTMLElement): boolean => {
  const segmented = host.closest('[data-glass-role="segmented"],.drag-segmented,.v3-segmented');
  return Boolean(segmented && segmented !== host && host.dataset.glassOwner !== 'self');
};

const isExcluded = (host: HTMLElement): boolean => (
  host.matches(EXCLUDED_SELECTOR) || isSegmentedDescendantWithoutOwnership(host)
);

const createLens = (host: HTMLElement): HTMLSpanElement => {
  const lens = host.ownerDocument.createElement('span');
  lens.className = 'ww-glass-lens';
  lens.setAttribute('aria-hidden', 'true');
  host.prepend(lens);
  return lens;
};

/**
 * Central compatibility adapter for legacy V3 markup. Shared components add
 * data-glass-role directly; older feature markup is mapped here so selectors
 * never spread through the optical engine and stylesheets again.
 */
export const startGlassSurfaceRegistry = (
  callbacks: GlassSurfaceRegistryCallbacks = {},
  environment: GlassSurfaceRegistryEnvironment = {},
): GlassSurfaceRegistry => {
  const documentRef = environment.document ?? document;
  const view = documentRef.defaultView;
  const elementConstructor = view?.HTMLElement
    ?? (typeof HTMLElement === 'function' ? HTMLElement : null);
  const isHtmlElement = (value: unknown): value is HTMLElement => (
    elementConstructor
      ? value instanceof elementConstructor
      : Boolean(value && typeof value === 'object' && (value as Node).nodeType === 1)
  );
  const defaultIntersectionObserver = typeof IntersectionObserver === 'function'
    ? IntersectionObserver
    : null;
  const defaultResizeObserver = typeof ResizeObserver === 'function' ? ResizeObserver : null;
  const defaultMutationObserver = typeof MutationObserver === 'function' ? MutationObserver : null;
  const IntersectionObserverImpl = environment.intersectionObserver === undefined
    ? view?.IntersectionObserver ?? defaultIntersectionObserver
    : environment.intersectionObserver;
  const ResizeObserverImpl = environment.resizeObserver === undefined
    ? view?.ResizeObserver ?? defaultResizeObserver
    : environment.resizeObserver;
  const MutationObserverImpl = environment.mutationObserver === undefined
    ? view?.MutationObserver ?? defaultMutationObserver
    : environment.mutationObserver;
  const requestFrame = environment.requestAnimationFrame
    ?? view?.requestAnimationFrame?.bind(view)
    ?? ((callback: FrameRequestCallback) => globalThis.setTimeout(
      () => callback(Date.now()),
      16,
    ) as unknown as number);
  const cancelFrame = environment.cancelAnimationFrame
    ?? view?.cancelAnimationFrame?.bind(view)
    ?? ((handle: number) => globalThis.clearTimeout(handle));
  const records = new Map<HTMLElement, GlassSurfaceRecord>();
  const resizeTargets = new Set<HTMLElement>();
  const pendingTargets = new Set<HTMLElement>();
  let resizeFrame = 0;
  let fallbackFrame = 0;
  let mutationFrame = 0;
  let fullRefreshPending = false;
  let mutationObserver: MutationObserver | null = null;
  let disposed = false;

  type IntersectionHandle = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>;
  type ResizeHandle = Pick<ResizeObserver, 'observe' | 'unobserve' | 'disconnect'>;
  const noIntersectionObserver: IntersectionHandle = {
    observe() {},
    unobserve() {},
    disconnect() {},
  };
  const noResizeObserver: ResizeHandle = {
    observe() {},
    unobserve() {},
    disconnect() {},
  };
  let hasIntersectionObserver = false;
  let hasResizeObserver = false;

  const updateVisibility = (record: GlassSurfaceRecord, visible: boolean) => {
    if (record.visible === visible) return;
    record.visible = visible;
    record.host.dataset.glassVisible = visible ? 'true' : 'false';
    callbacks.onVisibility?.(record, visible);
  };

  const nearViewport = (host: HTMLElement): boolean => {
    if (!host.isConnected) return false;
    const rect = host.getBoundingClientRect();
    const width = Math.max(0, view?.innerWidth ?? documentRef.documentElement.clientWidth);
    const height = Math.max(0, view?.innerHeight ?? documentRef.documentElement.clientHeight);
    return rect.right > 0 && rect.left < width && rect.bottom > -96 && rect.top < height + 96;
  };

  const measure = (host: HTMLElement) => {
    const record = records.get(host);
    if (!record) return;
    const rect = host.getBoundingClientRect();
    if (Math.abs(rect.width - record.width) <= 2 && Math.abs(rect.height - record.height) <= 2) return;
    record.width = rect.width;
    record.height = rect.height;
    callbacks.onResize?.(record);
  };

  const remove = (host: HTMLElement) => {
    const record = records.get(host);
    if (!record) return;
    resizeTargets.delete(host);
    intersectionObserver.unobserve(host);
    resizeObserver.unobserve(host);
    callbacks.onRemove?.(record);
    record.lens?.remove();
    host.classList.remove('ww-glass-surface', 'ww-glass-native', 'ww-glass-has-lens');
    host.removeAttribute('data-glass-visible');
    host.removeAttribute('data-glass-quality');
    host.style.removeProperty('--ww-glass-instance-optics');
    if (record.generatedRole) {
      delete host.dataset.glassRole;
      delete host.dataset.glassGeneratedRole;
    }
    if (record.generatedMotion) {
      delete host.dataset.glassMotion;
      delete host.dataset.glassGeneratedMotion;
    }
    records.delete(host);
  };

  const repairStructure = (record: GlassSurfaceRecord) => {
    const { host } = record;
    host.classList.add('ww-glass-surface');
    if (record.native) host.classList.add('ww-glass-native');
    else host.classList.remove('ww-glass-native');
    if (record.native) return;

    if (!record.lens || record.lens.parentElement !== host) {
      record.lens?.remove();
      record.lens = createLens(host);
    } else if (host.firstElementChild !== record.lens) {
      host.prepend(record.lens);
    }
    host.classList.add('ww-glass-has-lens');
  };

  const install = (host: HTMLElement) => {
    const existing = records.get(host);
    if (existing) {
      repairStructure(existing);
      return;
    }
    if (isExcluded(host)) return;
    const role = resolveRole(host);
    if (!role) return;
    const generatedRole = !host.dataset.glassRole;
    if (generatedRole) {
      host.dataset.glassRole = role;
      host.dataset.glassGeneratedRole = 'true';
    }
    const generatedMotion = role === 'control' && !host.dataset.glassMotion;
    if (generatedMotion) {
      host.dataset.glassMotion = 'control';
      host.dataset.glassGeneratedMotion = 'true';
    }
    const native = host.matches(NATIVE_SELECTOR);
    const lens = canOwnLens(host) ? createLens(host) : null;
    host.classList.add('ww-glass-surface');
    if (lens) host.classList.add('ww-glass-has-lens');
    if (native) host.classList.add('ww-glass-native');
    const rect = host.getBoundingClientRect();
    const record: GlassSurfaceRecord = {
      host,
      role,
      priority: priorityFor(host, role),
      lens,
      native,
      visible: false,
      width: rect.width,
      height: rect.height,
      generatedRole,
      generatedMotion,
    };
    records.set(host, record);
    intersectionObserver.observe(host);
    if (role !== 'item') resizeObserver.observe(host);
    callbacks.onRegister?.(record);
    if (!hasIntersectionObserver) updateVisibility(record, nearViewport(host));
  };

  const intersectionObserver: IntersectionHandle = (() => {
    if (!IntersectionObserverImpl) return noIntersectionObserver;
    try {
      const observer = new IntersectionObserverImpl((entries) => {
        for (const entry of entries) {
          const record = records.get(entry.target as HTMLElement);
          if (!record) continue;
          const visible = entry.isIntersecting && entry.intersectionRatio > 0;
          updateVisibility(record, visible);
        }
      }, { root: null, rootMargin: '96px 0px', threshold: [0, .01] });
      hasIntersectionObserver = true;
      return observer;
    } catch {
      return noIntersectionObserver;
    }
  })();

  const scheduleResize = () => {
    if (disposed || resizeFrame) return;
    resizeFrame = requestFrame(() => {
      resizeFrame = 0;
      const targets = [...resizeTargets];
      resizeTargets.clear();
      targets.forEach(measure);
    });
  };

  const resizeObserver: ResizeHandle = (() => {
    if (!ResizeObserverImpl) return noResizeObserver;
    try {
      const observer = new ResizeObserverImpl((entries) => {
        entries.forEach((entry) => resizeTargets.add(entry.target as HTMLElement));
        scheduleResize();
      });
      hasResizeObserver = true;
      return observer;
    } catch {
      return noResizeObserver;
    }
  })();

  const reconcile = (host: HTMLElement) => {
    const record = records.get(host);
    const role = isExcluded(host) ? null : resolveRole(host);
    if (!role) {
      if (record) remove(host);
      return;
    }
    const native = host.matches(NATIVE_SELECTOR);
    if (!record) {
      install(host);
      return;
    }
    if (record.role !== role || record.native !== native) {
      remove(host);
      install(host);
      return;
    }
    if (record.generatedMotion) {
      if (host.dataset.glassMotion && host.dataset.glassMotion !== 'control') {
        record.generatedMotion = false;
        if (host.dataset.glassGeneratedMotion !== undefined) {
          delete host.dataset.glassGeneratedMotion;
        }
      } else if (
        host.dataset.glassMotion !== 'control'
        || host.dataset.glassGeneratedMotion !== 'true'
      ) {
        // Guarded write: setAttribute with an identical value still emits a
        // MutationRecord, which would make the observer feed on itself.
        host.dataset.glassMotion = 'control';
        host.dataset.glassGeneratedMotion = 'true';
      }
    }
    record.priority = priorityFor(host, role);
    repairStructure(record);
  };

  const refresh = (root: ParentNode = documentRef) => {
    if (isHtmlElement(root)) reconcile(root);
    records.forEach((_record, host) => {
      if (root === documentRef || (isHtmlElement(root) && root.contains(host))) reconcile(host);
    });
    root.querySelectorAll<HTMLElement>(ALL_SELECTOR).forEach(reconcile);
  };

  const removeTree = (root: Node) => {
    if (!isHtmlElement(root)) return;
    [...records.keys()].forEach((host) => {
      if (host === root || root.contains(host)) remove(host);
    });
  };

  const flushMutationQueue = () => {
    mutationFrame = 0;
    if (disposed) return;
    try {
      if (fullRefreshPending) {
        fullRefreshPending = false;
        pendingTargets.clear();
        refresh();
        return;
      }
      const targets = [...pendingTargets];
      pendingTargets.clear();
      targets.forEach((target) => {
        if (target.isConnected) reconcile(target);
      });
    } finally {
      // Consume everything our own reconciliation just wrote. This is the key
      // that stops the observer from feeding on itself.
      mutationObserver?.takeRecords();
    }
  };

  const scheduleMutationFlush = () => {
    if (disposed || mutationFrame) return;
    mutationFrame = requestFrame(flushMutationQueue);
  };

  const handleMutationRecords = (items: MutationRecord[]) => {
    if (items.length > MAX_MUTATION_BATCH) {
      // Threshold guard: never walk a pathological batch. Drop the per-record
      // work, still release removed trees, and do one coalesced full pass.
      for (const item of items) {
        if (item.type !== 'attributes') item.removedNodes.forEach(removeTree);
      }
      pendingTargets.clear();
      fullRefreshPending = true;
      scheduleMutationFlush();
      return;
    }
    for (const item of items) {
      if (item.type === 'attributes') {
        // Class/data-* churn is coalesced: one reconcile per target per frame.
        if (isHtmlElement(item.target)) pendingTargets.add(item.target);
        continue;
      }
      item.removedNodes.forEach(removeTree);
      item.addedNodes.forEach((node) => {
        if (isHtmlElement(node)) refresh(node);
      });
      if (isHtmlElement(item.target)) reconcile(item.target);
    }
    if (pendingTargets.size > 0) scheduleMutationFlush();
  };

  const scheduleFallbackMeasurements = () => {
    if (disposed || fallbackFrame) return;
    fallbackFrame = requestFrame(() => {
      fallbackFrame = 0;
      records.forEach((record) => {
        if (!hasIntersectionObserver) updateVisibility(record, nearViewport(record.host));
        if (!hasResizeObserver && record.role !== 'item') measure(record.host);
      });
    });
  };

  refresh();
  const mutations = (() => {
    if (!MutationObserverImpl) return null;
    try {
      mutationObserver = new MutationObserverImpl((items) => {
        handleMutationRecords(items);
        // Drain records produced by our own synchronous DOM writes so the
        // observer cannot enqueue a follow-up batch from its own work.
        mutationObserver?.takeRecords();
      });
      return mutationObserver;
    } catch {
      return null;
    }
  })();
  if (documentRef.body) {
    mutations?.observe(documentRef.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-glass-role', 'data-glass-owner', 'data-glass-priority', 'data-glass-motion'],
    });
  }
  const needsFallbackMeasurements = !hasIntersectionObserver || !hasResizeObserver;
  if (needsFallbackMeasurements) {
    view?.addEventListener('scroll', scheduleFallbackMeasurements, { capture: true, passive: true });
    view?.addEventListener('resize', scheduleFallbackMeasurements);
  }

  return {
    records,
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      mutations?.disconnect();
      intersectionObserver.disconnect();
      resizeObserver.disconnect();
      if (resizeFrame) cancelFrame(resizeFrame);
      if (fallbackFrame) cancelFrame(fallbackFrame);
      if (mutationFrame) cancelFrame(mutationFrame);
      resizeTargets.clear();
      pendingTargets.clear();
      fullRefreshPending = false;
      if (needsFallbackMeasurements) {
        view?.removeEventListener('scroll', scheduleFallbackMeasurements, true);
        view?.removeEventListener('resize', scheduleFallbackMeasurements);
      }
      [...records.keys()].forEach(remove);
    },
  };
};
