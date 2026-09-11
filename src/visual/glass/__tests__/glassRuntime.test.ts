import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlassRuntime } from '../glassRuntime';
import { startGlassSurfaceRegistry } from '../glassSurfaceRegistry';
import type { GlassFilterPool } from '../glassFilterPool';
import type {
  GlassFilterAcquireRequest,
  GlassFilterLease,
  GlassFilterPoolSnapshot,
} from '../glassTypes';

type Listener = (event: Record<string, unknown>) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === 'function'
      ? listener as unknown as Listener
      : listener.handleEvent.bind(listener) as unknown as Listener;
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener as unknown as Listener);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

class FakeStyle {
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void { this.values.set(name, value); }
  getPropertyValue(name: string): string { return this.values.get(name) ?? ''; }
  getPropertyPriority(): string { return ''; }
  removeProperty(name: string): string {
    const previous = this.getPropertyValue(name);
    this.values.delete(name);
    return previous;
  }
}

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]): void { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]): void { names.forEach((name) => this.values.delete(name)); }
  contains(name: string): boolean { return this.values.has(name); }
  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
  replaceFrom(value: string): void {
    this.values.clear();
    value.split(/\s+/u).filter(Boolean).forEach((name) => this.values.add(name));
  }
  toString(): string { return [...this.values].join(' '); }
}

const dataKey = (attribute: string): string => attribute
  .slice(5)
  .replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());

const splitSelectorList = (selector: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === '(' || character === '[') depth += 1;
    if (character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
};

class FakeElement {
  readonly nodeType = 1;
  readonly style = new FakeStyle();
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  disabled = false;
  rect = { left: 0, top: 0, width: 120, height: 44 };
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

  get className(): string { return this.classList.toString(); }
  set className(value: string) { this.classList.replaceFrom(value); }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get isConnected(): boolean {
    if (this === this.ownerDocument.documentElement) return true;
    return this.parentElement?.isConnected ?? false;
  }

  append(...children: FakeElement[]): void { children.forEach((child) => this.insert(child, false)); }
  prepend(child: FakeElement): void { this.insert(child, true); }
  private insert(child: FakeElement, first: boolean): void {
    child.parentElement?.detach(child);
    child.parentElement = this;
    if (first) this.children.unshift(child);
    else this.children.push(child);
  }
  private detach(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
  }
  remove(): void { this.parentElement?.detach(this); }

  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  setAttribute(name: string, value: string): void {
    if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[dataKey(name)] = value;
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || null;
    if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null; }
  removeAttribute(name: string): void {
    if (name === 'class') this.className = '';
    if (name.startsWith('data-')) delete this.dataset[dataKey(name)];
    this.attributes.delete(name);
  }

  matches(selector: string): boolean {
    return splitSelectorList(selector).some((part) => this.matchesOne(part));
  }
  private matchesOne(selector: string): boolean {
    if (!selector) return false;
    if (selector === '[data-glass-role]:not([data-glass-role="none"])') {
      return Boolean(this.dataset.glassRole) && this.dataset.glassRole !== 'none';
    }
    if (selector.startsWith(':is(') && selector.endsWith(')')) {
      return this.matches(selector.slice(4, -1));
    }
    let depth = 0;
    for (let index = selector.length - 1; index >= 0; index -= 1) {
      const character = selector[index];
      if (character === ')' || character === ']') depth += 1;
      if (character === '(' || character === '[') depth -= 1;
      if (character === ' ' && depth === 0) {
        const ancestorSelector = selector.slice(0, index).trim();
        const ownSelector = selector.slice(index + 1).trim();
        if (!this.matches(ownSelector)) return false;
        let ancestor = this.parentElement;
        while (ancestor) {
          if (ancestor.matches(ancestorSelector)) return true;
          ancestor = ancestor.parentElement;
        }
        return false;
      }
    }
    if (selector === ':hover' || selector === ':focus-within') return false;
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u);
    if (attribute) {
      const value = this.getAttribute(attribute[1]);
      return attribute[2] === undefined ? value !== null : value === attribute[2];
    }
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const tagAndClass = selector.match(/^([a-z]+)\.([\w-]+)$/u);
    if (tagAndClass) {
      return this.tagName.toLowerCase() === tagAndClass[1]
        && this.classList.contains(tagAndClass[2]);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const matches: T[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child as T);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  getBoundingClientRect(): DOMRect {
    const { left, top, width, height } = this.rect;
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
  }

  setPointerCapture(): void {}
  hasPointerCapture(): boolean { return false; }
  releasePointerCapture(): void {}
}

class FrameScheduler {
  private nextId = 1;
  private now = 0;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };
  cancel = (id: number): void => { this.callbacks.delete(id); };
  flush(milliseconds = 16): void {
    this.now += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(this.now));
  }
  get pending(): number { return this.callbacks.size; }
}

class FakeIntersectionObserver {
  readonly observed = new Set<FakeElement>();
  disconnected = false;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    harness: DomHarness,
  ) { harness.intersections.push(this); }
  observe(target: Element): void { this.observed.add(target as unknown as FakeElement); }
  unobserve(target: Element): void { this.observed.delete(target as unknown as FakeElement); }
  disconnect(): void { this.disconnected = true; this.observed.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  emit(target: FakeElement, visible: boolean): void {
    this.callback([{
      target,
      isIntersecting: visible,
      intersectionRatio: visible ? 1 : 0,
    } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

class FakeResizeObserver {
  readonly observed = new Set<FakeElement>();
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback, harness: DomHarness) {
    harness.resizes.push(this);
  }
  observe(target: Element): void { this.observed.add(target as unknown as FakeElement); }
  unobserve(target: Element): void { this.observed.delete(target as unknown as FakeElement); }
  disconnect(): void { this.disconnected = true; this.observed.clear(); }
  emit(...targets: FakeElement[]): void {
    this.callback(targets.map((target) => ({ target }) as unknown as ResizeObserverEntry), this as unknown as ResizeObserver);
  }
}

class FakeMutationObserver {
  disconnected = false;
  constructor(private readonly callback: MutationCallback, harness: DomHarness) {
    harness.mutations.push(this);
  }
  observe(): void {}
  disconnect(): void { this.disconnected = true; }
  takeRecords(): MutationRecord[] { return []; }
  emit(records: Array<{
    target: FakeElement;
    type?: MutationRecordType;
    addedNodes?: NodeList | FakeElement[];
    removedNodes?: NodeList | FakeElement[];
    attributeName?: string | null;
  }>): void {
    this.callback(records.map((record) => ({
      type: record.type ?? 'childList',
      addedNodes: record.addedNodes ?? [],
      removedNodes: record.removedNodes ?? [],
      attributeName: record.attributeName ?? null,
      target: record.target,
    })) as unknown as MutationRecord[], this as unknown as MutationObserver);
  }
}

class FakeWindow extends FakeEventTarget {
  readonly frames = new FrameScheduler();
  readonly performance = { now: () => 0 };
  readonly CSS = { supports: () => true };
  readonly navigator = { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0', hardwareConcurrency: 8 };
  readonly devicePixelRatio = 1;
  readonly innerWidth = 1_000;
  readonly innerHeight = 800;
  readonly HTMLElement = FakeElement;
  readonly requestAnimationFrame = this.frames.request;
  readonly cancelAnimationFrame = this.frames.cancel;
  readonly idleCallbacks = new Map<number, () => void>();
  private nextIdleId = 1;
  requestIdleCallback: ((callback: () => void) => number) | undefined = (callback) => {
    const id = this.nextIdleId++;
    this.idleCallbacks.set(id, callback);
    return id;
  };
  cancelIdleCallback: ((id: number) => void) | undefined = (id) => { this.idleCallbacks.delete(id); };
  IntersectionObserver: typeof IntersectionObserver | undefined;
  ResizeObserver: typeof ResizeObserver | undefined;
  MutationObserver: typeof MutationObserver | undefined;

  constructor(readonly harness: DomHarness) {
    super();
    this.IntersectionObserver = class extends FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) { super(callback, harness); }
    } as unknown as typeof IntersectionObserver;
    this.ResizeObserver = class extends FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) { super(callback, harness); }
    } as unknown as typeof ResizeObserver;
    this.MutationObserver = class extends FakeMutationObserver {
      constructor(callback: MutationCallback) { super(callback, harness); }
    } as unknown as typeof MutationObserver;
  }

  matchMedia(): MediaQueryList {
    return {
      matches: false,
      media: '',
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => true,
    };
  }
  getComputedStyle(): CSSStyleDeclaration {
    return { borderTopLeftRadius: '16px', transform: 'none' } as CSSStyleDeclaration;
  }
  flushIdle(): void {
    const callbacks = [...this.idleCallbacks.values()];
    this.idleCallbacks.clear();
    callbacks.forEach((callback) => callback());
  }
}

class FakeDocument extends FakeEventTarget {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  visibilityState: DocumentVisibilityState = 'visible';
  defaultView: FakeWindow;

  constructor(readonly harness: DomHarness) {
    super();
    this.defaultView = new FakeWindow(harness);
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.append(this.body);
  }
  createElement(tagName: string): FakeElement { return new FakeElement(tagName, this); }
  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    return this.documentElement.querySelectorAll<T>(selector);
  }
}

type DomHarness = {
  document: FakeDocument;
  intersections: FakeIntersectionObserver[];
  resizes: FakeResizeObserver[];
  mutations: FakeMutationObserver[];
};

const createDomHarness = (): DomHarness => {
  const harness = {
    document: null as unknown as FakeDocument,
    intersections: [],
    resizes: [],
    mutations: [],
  };
  harness.document = new FakeDocument(harness);
  return harness;
};

const withDomGlobals = async <T>(harness: DomHarness, callback: () => T | Promise<T>): Promise<T> => {
  const view = harness.document.defaultView;
  const replacements = new Map<string, unknown>([
    ['document', harness.document],
    ['window', view],
    ['HTMLElement', FakeElement],
    ['IntersectionObserver', view.IntersectionObserver],
    ['ResizeObserver', view.ResizeObserver],
    ['MutationObserver', view.MutationObserver],
    ['requestAnimationFrame', view.requestAnimationFrame],
    ['cancelAnimationFrame', view.cancelAnimationFrame],
    ['getComputedStyle', view.getComputedStyle.bind(view)],
    ['matchMedia', view.matchMedia.bind(view)],
  ]);
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of replacements) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    if (value === undefined) delete (globalThis as Record<string, unknown>)[name];
    else Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try { return await callback(); }
  finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
};

class FakeFilterPool {
  readonly requests: GlassFilterAcquireRequest[] = [];
  readonly leases: GlassFilterLease[] = [];
  private readonly pending: Array<(lease: GlassFilterLease) => void> = [];
  disposed = false;
  defer = false;

  acquire = async (request: GlassFilterAcquireRequest): Promise<GlassFilterLease> => {
    this.requests.push(request);
    if (this.defer) return new Promise((resolve) => { this.pending.push(resolve); });
    return this.createLease(request);
  };
  resolveNext(): GlassFilterLease {
    const resolve = this.pending.shift();
    assert.ok(resolve, 'expected one pending filter acquisition');
    const request = this.requests[this.leases.length];
    const lease = this.createLease(request);
    resolve(lease);
    return lease;
  }
  private createLease(request: GlassFilterAcquireRequest): GlassFilterLease {
    let released = false;
    const lease: GlassFilterLease = {
      resource: {
        key: `fake-${this.leases.length + 1}`,
        role: request.role,
        quality: request.quality,
        mode: request.quality === 'refract-rgb' ? 'rgb' : 'single',
        filterId: `fake-${this.leases.length + 1}`,
        cssFilter: `url(#fake-${this.leases.length + 1})`,
        mapUrl: null,
        byteEstimate: 1,
        geometry: null,
      },
      get released() { return released; },
      release: () => { released = true; },
    };
    this.leases.push(lease);
    return lease;
  }
  snapshot = (): GlassFilterPoolSnapshot => ({
    entryCount: this.leases.length,
    pendingEntries: this.pending.length,
    referencedEntries: this.leases.filter((lease) => !lease.released).length,
    totalBytes: this.leases.length,
    entries: [],
  });
  dispose = (): void => { this.disposed = true; };
}

const settlePromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const appendSurface = (
  harness: DomHarness,
  role: string,
  tagName = 'div',
): FakeElement => {
  const host = harness.document.createElement(tagName);
  host.dataset.glassRole = role;
  harness.document.body.append(host);
  return host;
};

test('registry repairs a React-removed lens even when the old lens remains connected elsewhere', async () => {
  const harness = createDomHarness();
  await withDomGlobals(harness, () => {
    const host = appendSurface(harness, 'panel');
    const registry = startGlassSurfaceRegistry();
    const record = registry.records.get(host as unknown as HTMLElement);
    assert.ok(record?.lens);
    const oldLens = record.lens as unknown as FakeElement;

    harness.document.body.append(oldLens);
    harness.mutations[0].emit([{ target: host, removedNodes: [oldLens] as unknown as NodeList }]);

    assert.equal((record.lens as unknown as FakeElement).parentElement, host);
    assert.notEqual(record.lens, oldLens);
    registry.dispose();
  });
});

test('legacy buttons receive generated motion opt-in and cleanup restores their markup', async () => {
  const harness = createDomHarness();
  await withDomGlobals(harness, () => {
    const button = harness.document.createElement('button');
    harness.document.body.append(button);
    const registry = startGlassSurfaceRegistry();

    assert.equal(button.dataset.glassRole, 'control');
    assert.equal(button.dataset.glassMotion, 'control');
    assert.equal(button.dataset.glassGeneratedMotion, 'true');

    registry.dispose();
    assert.equal(button.dataset.glassRole, undefined);
    assert.equal(button.dataset.glassMotion, undefined);
    assert.equal(button.dataset.glassGeneratedMotion, undefined);
  });
});

test('segmented controls own exactly a base lens and an explicit slider lens', async () => {
  const harness = createDomHarness();
  await withDomGlobals(harness, () => {
    const base = harness.document.createElement('div');
    base.className = 'v3-segmented';
    const option = harness.document.createElement('button');
    const slider = harness.document.createElement('span');
    slider.dataset.glassRole = 'control';
    slider.dataset.glassOwner = 'self';
    base.append(option, slider);
    harness.document.body.append(base);

    const registry = startGlassSurfaceRegistry();
    assert.equal(registry.records.has(base as unknown as HTMLElement), true);
    assert.equal(registry.records.has(slider as unknown as HTMLElement), true);
    assert.equal(registry.records.has(option as unknown as HTMLElement), false);
    assert.equal(registry.records.size, 2);
    registry.dispose();
  });
});

test('registry coalesces ResizeObserver batches without dropping earlier targets', async () => {
  const harness = createDomHarness();
  await withDomGlobals(harness, () => {
    const first = appendSurface(harness, 'panel');
    const second = appendSurface(harness, 'panel');
    const resized: FakeElement[] = [];
    const registry = startGlassSurfaceRegistry({
      onResize: (record) => { resized.push(record.host as unknown as FakeElement); },
    });
    first.rect.width = 180;
    second.rect.width = 220;

    harness.resizes[0].emit(first);
    harness.resizes[0].emit(second);
    harness.document.defaultView.frames.flush();

    assert.deepEqual(new Set(resized), new Set([first, second]));
    registry.dispose();
  });
});

test('registry degrades safely when observer APIs are unavailable and cleans fallback listeners', async () => {
  const harness = createDomHarness();
  harness.document.defaultView.IntersectionObserver = undefined;
  harness.document.defaultView.ResizeObserver = undefined;
  harness.document.defaultView.MutationObserver = undefined;
  await withDomGlobals(harness, () => {
    const host = appendSurface(harness, 'panel');
    const registry = startGlassSurfaceRegistry();
    const record = registry.records.get(host as unknown as HTMLElement);
    assert.ok(record);
    assert.equal(record.visible, true);
    registry.dispose();
    assert.equal(harness.document.defaultView.listenerCount(), 0);
    assert.equal(harness.document.defaultView.frames.pending, 0);
  });
});

test('a cancelled idle allocation cannot restore optics after the surface becomes offscreen', async () => {
  const harness = createDomHarness();
  harness.document.defaultView.cancelIdleCallback = undefined;
  const pool = new FakeFilterPool();
  await withDomGlobals(harness, async () => {
    const host = appendSurface(harness, 'control', 'button');
    const runtime = createGlassRuntime({
      document: harness.document as unknown as Document,
      capabilities: { refractRgb: true, refractSingle: true, backdropBlur: true },
      filterPool: pool as unknown as GlassFilterPool,
    });
    harness.intersections[0].emit(host, true);
    harness.document.defaultView.frames.flush();
    assert.equal(harness.document.defaultView.idleCallbacks.size, 1);

    harness.intersections[0].emit(host, false);
    assert.equal(host.dataset.glassQuality, 'solid');
    harness.document.defaultView.flushIdle();
    await settlePromises();
    harness.document.defaultView.frames.flush();

    assert.equal(pool.requests.length, 0);
    assert.equal(host.dataset.glassQuality, 'solid');
    assert.equal(host.style.getPropertyValue('--ww-glass-instance-optics'), 'blur(0px)');
    runtime.dispose();
  });
});

test('an asynchronous lease resolving after React removes its host is released exactly once', async () => {
  const harness = createDomHarness();
  const pool = new FakeFilterPool();
  pool.defer = true;
  await withDomGlobals(harness, async () => {
    const host = appendSurface(harness, 'control', 'button');
    const runtime = createGlassRuntime({
      document: harness.document as unknown as Document,
      capabilities: { refractRgb: true, refractSingle: true, backdropBlur: true },
      filterPool: pool as unknown as GlassFilterPool,
    });
    harness.intersections[0].emit(host, true);
    harness.document.defaultView.frames.flush();
    harness.document.defaultView.flushIdle();
    assert.equal(pool.requests.length, 1);

    host.remove();
    harness.mutations[0].emit([{
      target: harness.document.body,
      removedNodes: [host] as unknown as NodeList,
    }]);
    const lateLease = pool.resolveNext();
    await settlePromises();

    assert.equal(lateLease.released, true);
    assert.equal(runtime.diagnostics().surfaceCount, 0);
    assert.equal(host.style.getPropertyValue('--ww-glass-instance-optics'), '');
    runtime.dispose();
  });
});

test('interactive RGB quality returns to the static budget after motion settles', async () => {
  const harness = createDomHarness();
  harness.document.defaultView.requestIdleCallback = undefined;
  harness.document.defaultView.cancelIdleCallback = undefined;
  const pool = new FakeFilterPool();
  await withDomGlobals(harness, async () => {
    const hosts = Array.from({ length: 4 }, () => appendSurface(harness, 'control', 'button'));
    const runtime = createGlassRuntime({
      document: harness.document as unknown as Document,
      capabilities: { refractRgb: true, refractSingle: true, backdropBlur: true },
      filterPool: pool as unknown as GlassFilterPool,
    });
    hosts.forEach((host) => harness.intersections[0].emit(host, true));
    harness.document.defaultView.frames.flush();
    await settlePromises();
    const active = hosts[3];
    assert.equal(active.dataset.glassQuality, 'refract-single');

    active.setAttribute('data-glass-motion-state', 'pressed');
    harness.mutations[1].emit([{
      type: 'attributes',
      target: active,
      attributeName: 'data-glass-motion-state',
    }]);
    harness.document.defaultView.frames.flush();
    await settlePromises();
    assert.equal(active.dataset.glassQuality, 'refract-rgb');

    active.removeAttribute('data-glass-motion-state');
    harness.mutations[1].emit([{
      type: 'attributes',
      target: active,
      attributeName: 'data-glass-motion-state',
    }]);
    harness.document.defaultView.frames.flush();
    await settlePromises();
    assert.equal(active.dataset.glassQuality, 'refract-single');
    runtime.dispose();
  });
});

test('original mode is a zero-runtime path even if createGlassRuntime is called defensively', async () => {
  const harness = createDomHarness();
  harness.document.documentElement.dataset.visualMode = 'original';
  const pool = new FakeFilterPool();
  await withDomGlobals(harness, () => {
    appendSurface(harness, 'panel');
    const runtime = createGlassRuntime({
      document: harness.document as unknown as Document,
      filterPool: pool as unknown as GlassFilterPool,
    });

    assert.equal(runtime.diagnostics().surfaceCount, 0);
    assert.equal(harness.intersections.length, 0);
    assert.equal(harness.resizes.length, 0);
    assert.equal(harness.mutations.length, 0);
    assert.equal(harness.document.listenerCount(), 0);
    assert.equal(harness.document.defaultView.listenerCount(), 0);
    assert.equal(harness.document.defaultView.frames.pending, 0);
    assert.equal(pool.requests.length, 0);
    runtime.dispose();
    assert.equal(pool.disposed, false, 'an unused injected pool remains owned by its caller');
  });
});

test('unsupported optical capabilities select solid without asking the filter pool for resources', async () => {
  const harness = createDomHarness();
  harness.document.defaultView.requestIdleCallback = undefined;
  const pool = new FakeFilterPool();
  await withDomGlobals(harness, async () => {
    const host = appendSurface(harness, 'panel');
    const runtime = createGlassRuntime({
      document: harness.document as unknown as Document,
      capabilities: { refractRgb: false, refractSingle: false, backdropBlur: false },
      filterPool: pool as unknown as GlassFilterPool,
    });
    harness.intersections[0].emit(host, true);
    harness.document.defaultView.frames.flush();
    await settlePromises();

    assert.equal(host.dataset.glassQuality, 'solid');
    assert.equal(pool.requests.length, 0);
    runtime.dispose();
  });
});

test('capability detection takes the stable solid fallback when CSS backdrop support is absent', async () => {
  const harness = createDomHarness();
  harness.document.defaultView.requestIdleCallback = undefined;
  harness.document.defaultView.CSS.supports = () => false;
  const pool = new FakeFilterPool();
  await withDomGlobals(harness, async () => {
    const host = appendSurface(harness, 'panel');
    const runtime = createGlassRuntime({
      document: harness.document as unknown as Document,
      filterPool: pool as unknown as GlassFilterPool,
    });
    harness.intersections[0].emit(host, true);
    harness.document.defaultView.frames.flush();
    await settlePromises();

    assert.equal(host.dataset.glassQuality, 'solid');
    assert.equal(pool.requests.length, 0);
    runtime.dispose();
  });
});

test('segmented drag transfers refraction from the base to the slider instead of stacking both', async () => {
  const harness = createDomHarness();
  harness.document.defaultView.requestIdleCallback = undefined;
  const pool = new FakeFilterPool();
  await withDomGlobals(harness, async () => {
    const base = appendSurface(harness, 'segmented');
    base.className = 'drag-segmented';
    const slider = harness.document.createElement('span');
    slider.className = 'drag-segmented__slider';
    slider.dataset.glassRole = 'control';
    slider.dataset.glassOwner = 'self';
    base.append(slider);
    const runtime = createGlassRuntime({
      document: harness.document as unknown as Document,
      capabilities: { refractRgb: true, refractSingle: true, backdropBlur: true },
      filterPool: pool as unknown as GlassFilterPool,
    });
    harness.intersections[0].emit(base, true);
    harness.intersections[0].emit(slider, true);
    harness.document.defaultView.frames.flush();
    await settlePromises();
    assert.equal(base.dataset.glassQuality, 'refract-rgb');
    assert.equal(slider.dataset.glassQuality, 'solid');

    base.classList.add('drag-segmented--dragging');
    slider.setAttribute('data-state', 'dragging');
    harness.mutations[1].emit([{
      type: 'attributes',
      target: slider,
      attributeName: 'data-state',
    }]);
    harness.document.defaultView.frames.flush();
    await settlePromises();
    assert.equal(base.dataset.glassQuality, 'blur');
    assert.equal(slider.dataset.glassQuality, 'refract-rgb');

    base.classList.remove('drag-segmented--dragging');
    slider.setAttribute('data-state', 'idle');
    harness.mutations[1].emit([{
      type: 'attributes',
      target: slider,
      attributeName: 'data-state',
    }]);
    harness.document.defaultView.frames.flush();
    await settlePromises();
    assert.equal(base.dataset.glassQuality, 'refract-rgb');
    assert.equal(slider.dataset.glassQuality, 'solid');
    runtime.dispose();
  });
});

test('dispose cancels observers, listeners, RAF, idle work, and releases an eventual pending lease', async () => {
  const harness = createDomHarness();
  const pool = new FakeFilterPool();
  pool.defer = true;
  await withDomGlobals(harness, async () => {
    const host = appendSurface(harness, 'control', 'button');
    const runtime = createGlassRuntime({
      document: harness.document as unknown as Document,
      capabilities: { refractRgb: true, refractSingle: true, backdropBlur: true },
      filterPool: pool as unknown as GlassFilterPool,
    });
    harness.intersections[0].emit(host, true);
    harness.document.defaultView.frames.flush();
    harness.document.defaultView.flushIdle();
    assert.equal(pool.requests.length, 1);

    runtime.dispose();
    assert.equal(harness.document.listenerCount(), 0);
    assert.equal(harness.document.defaultView.listenerCount(), 0);
    assert.equal(harness.document.defaultView.frames.pending, 0);
    assert.equal(harness.document.defaultView.idleCallbacks.size, 0);
    assert.equal(harness.intersections.every((observer) => observer.disconnected), true);
    assert.equal(harness.resizes.every((observer) => observer.disconnected), true);
    assert.equal(harness.mutations.every((observer) => observer.disconnected), true);
    assert.equal(pool.disposed, true);

    const lateLease = pool.resolveNext();
    await settlePromises();
    assert.equal(lateLease.released, true);
  });
});
