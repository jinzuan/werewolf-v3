import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeGlassDeformation,
  isSpringSettled,
  normalizePressurePoint,
  rubberBand,
  stepSpringAxis,
} from '../glassMotionMath';
import { createGlassMotionEngine } from '../glassMotionEngine';
import type { MotionMode } from '../../../runtime/visualPreferences';

type Listener = (event: Record<string, unknown>) => void;

class FakeEventRoot {
  visibilityState: DocumentVisibilityState = 'visible';
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

class FakeMediaQuery {
  matches = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'change', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'change', listener: () => void): void {
    this.listeners.delete(listener);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }
}

class FakeStyle {
  private readonly values = new Map<string, { value: string; priority: string }>();

  getPropertyValue(name: string): string {
    return this.values.get(name)?.value ?? '';
  }

  getPropertyPriority(name: string): string {
    return this.values.get(name)?.priority ?? '';
  }

  setProperty(name: string, value: string, priority = ''): void {
    this.values.set(name, { value, priority });
  }

  removeProperty(name: string): string {
    const previous = this.getPropertyValue(name);
    this.values.delete(name);
    return previous;
  }
}

class FakeElement {
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = { glassMotion: '' };
  disabled = false;
  capturedPointer: number | null = null;
  private readonly attributes = new Map<string, string>([['data-glass-motion', '']]);

  closest(selector: string): FakeElement | null {
    return selector === '[data-glass-motion]' ? this : null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    } as DOMRect;
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointer = pointerId;
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointer === pointerId;
  }

  releasePointerCapture(pointerId: number): void {
    if (this.capturedPointer === pointerId) this.capturedPointer = null;
  }
}

class FakeFrameScheduler {
  private nextId = 1;
  private now = 0;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  readonly request = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };

  readonly cancel = (id: number): void => {
    this.callbacks.delete(id);
  };

  get pending(): number {
    return this.callbacks.size;
  }

  flush(stepMilliseconds = 1000 / 60): void {
    this.now += stepMilliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.now);
  }

  flushUntilIdle(limit = 600): void {
    for (let index = 0; index < limit && this.pending > 0; index += 1) this.flush();
    assert.equal(this.pending, 0, 'motion loop should become fully idle');
  }
}

const pointerEvent = (
  target: FakeElement,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  target,
  pointerId: 7,
  button: 0,
  isPrimary: true,
  clientX: 50,
  clientY: 20,
  timeStamp: 0,
  cancelable: true,
  preventDefault() {},
  stopImmediatePropagation() {},
  ...overrides,
});

const createHarness = (initialMode: MotionMode = 'standard') => {
  const root = new FakeEventRoot();
  const media = new FakeMediaQuery();
  const scheduler = new FakeFrameScheduler();
  let mode = initialMode;
  const engine = createGlassMotionEngine({
    root: root as unknown as Document,
    getMode: () => mode,
    reducedMotionQuery: media as unknown as MediaQueryList,
    requestAnimationFrame: scheduler.request,
    cancelAnimationFrame: scheduler.cancel,
    readComputedTransform: () => 'none',
    isDocumentHidden: () => root.visibilityState === 'hidden',
  });
  return { engine, media, root, scheduler, setMode: (next: MotionMode) => { mode = next; } };
};

test('math seam keeps rubber banding finite and pressure coordinates local', () => {
  assert.equal(rubberBand(0, 44), 0);
  assert.ok(rubberBand(200, 44) < 44);
  assert.ok(rubberBand(200, 44) > rubberBand(20, 44));
  assert.equal(rubberBand(-200, 44), -rubberBand(200, 44));
  assert.deepEqual(normalizePressurePoint(150, -20, {
    left: 0,
    top: 0,
    width: 100,
    height: 40,
  }), { x: 1, y: 0 });
});

test('underdamped spring overshoots once and then becomes exactly settleable', () => {
  let state = { position: 0, velocity: 0 };
  let maximum = 0;
  for (let index = 0; index < 480; index += 1) {
    state = stepSpringAxis(state, 1, 1 / 120, { stiffness: 180, damping: 13 });
    maximum = Math.max(maximum, state.position);
  }
  assert.ok(maximum > 1.02, 'spring should have a visible but bounded overshoot');
  assert.equal(isSpringSettled(state, 1, .001, .01), true);
});

test('full deformation adds local pressure and directional tilt beyond standard mode', () => {
  const input = {
    position: { x: 22, y: -9 },
    velocity: { x: 560, y: -220 },
    pressure: .9,
    pressurePoint: { x: .82, y: .2 },
  } as const;
  const standard = computeGlassDeformation({ ...input, mode: 'standard' });
  const full = computeGlassDeformation({ ...input, mode: 'full' });

  assert.equal(standard.tiltX, 0);
  assert.equal(standard.tiltY, 0);
  assert.notEqual(full.tiltX, 0);
  assert.notEqual(full.tiltY, 0);
  assert.ok(full.stretch > standard.stretch);
  assert.ok(full.scaleX > 1);
  assert.ok(full.scaleY > 1);
});

test('none mode, opted-out elements, and disabled controls never start RAF', () => {
  const { engine, root, scheduler } = createHarness('none');
  const element = new FakeElement();
  root.dispatch('pointerdown', pointerEvent(element));
  assert.equal(element.capturedPointer, null);
  assert.equal(scheduler.pending, 0);

  engine.dispose();
  const disabledHarness = createHarness('standard');
  element.disabled = true;
  disabledHarness.root.dispatch('pointerdown', pointerEvent(element));
  assert.equal(disabledHarness.scheduler.pending, 0);
  disabledHarness.engine.dispose();

  const optedOutHarness = createHarness('full');
  element.disabled = false;
  element.setAttribute('data-glass-motion', 'none');
  optedOutHarness.root.dispatch('pointerdown', pointerEvent(element));
  assert.equal(optedOutHarness.scheduler.pending, 0);
  assert.equal(element.capturedPointer, null);
  optedOutHarness.engine.dispose();
});

test('standard mode delegates one RAF, suppresses only a real drag, and restores inline style', () => {
  const { engine, root, scheduler } = createHarness('standard');
  const element = new FakeElement();
  element.style.setProperty('transform', 'scale(.98)');

  root.dispatch('pointerdown', pointerEvent(element));
  assert.equal(element.capturedPointer, 7);
  assert.equal(scheduler.pending, 1);
  root.dispatch('pointermove', pointerEvent(element, {
    clientX: 88,
    clientY: 31,
    timeStamp: 16,
  }));
  root.dispatch('pointermove', pointerEvent(element, {
    clientX: 94,
    clientY: 33,
    timeStamp: 24,
  }));
  assert.equal(scheduler.pending, 1, 'all motion shares a single scheduled frame');
  scheduler.flush();
  assert.match(element.style.getPropertyValue('transform'), /translate3d/);

  root.dispatch('pointerup', pointerEvent(element, {
    clientX: 94,
    clientY: 33,
    timeStamp: 32,
  }));
  let prevented = false;
  let stopped = false;
  root.dispatch('click', pointerEvent(element, {
    timeStamp: 33,
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => { stopped = true; },
  }));
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  scheduler.flushUntilIdle();
  assert.equal(element.style.getPropertyValue('transform'), 'scale(.98)');
  assert.equal(element.style.getPropertyValue('--glass-pressure'), '');
  assert.equal(element.getAttribute('data-glass-motion-state'), null);

  engine.dispose();
  assert.equal(root.listenerCount(), 0);
});

test('full mode publishes pressure-centred variables and transfers ownership to one control', () => {
  const { engine, root, scheduler } = createHarness('full');
  const first = new FakeElement();
  const second = new FakeElement();

  root.dispatch('pointerdown', pointerEvent(first, { clientX: 88, clientY: 8 }));
  root.dispatch('pointermove', pointerEvent(first, {
    clientX: 98,
    clientY: 5,
    timeStamp: 12,
  }));
  scheduler.flush();
  assert.equal(first.style.getPropertyValue('--glass-pressure-x'), '98.00%');
  assert.equal(first.style.getPropertyValue('--glass-pressure-y'), '12.50%');
  assert.notEqual(first.style.getPropertyValue('--glass-tilt-y'), '0.000deg');

  root.dispatch('pointerdown', pointerEvent(second, { pointerId: 9, clientX: 20, clientY: 30 }));
  assert.equal(first.style.getPropertyValue('transform'), '');
  assert.equal(first.getAttribute('data-glass-motion-state'), null);
  assert.equal(second.capturedPointer, 9);
  assert.equal(scheduler.pending, 1);

  engine.dispose();
  assert.equal(second.style.getPropertyValue('transform'), '');
  assert.equal(scheduler.pending, 0);
});

test('lost capture, hidden pages, and reduced motion cannot leave a transformed control behind', () => {
  const { engine, media, root, scheduler } = createHarness('full');
  const element = new FakeElement();
  root.dispatch('pointerdown', pointerEvent(element));
  root.dispatch('pointermove', pointerEvent(element, { clientX: 80, timeStamp: 16 }));
  scheduler.flush();
  root.dispatch('lostpointercapture', pointerEvent(element));
  scheduler.flushUntilIdle();
  assert.equal(element.style.getPropertyValue('transform'), '');

  root.dispatch('pointerdown', pointerEvent(element));
  scheduler.flush();
  media.setMatches(true);
  assert.equal(element.style.getPropertyValue('transform'), '');
  assert.equal(scheduler.pending, 0);

  media.setMatches(false);
  root.dispatch('pointerdown', pointerEvent(element));
  scheduler.flush();
  root.visibilityState = 'hidden';
  root.dispatch('visibilitychange');
  assert.equal(element.style.getPropertyValue('transform'), '');
  assert.equal(scheduler.pending, 0);
  engine.dispose();
});
