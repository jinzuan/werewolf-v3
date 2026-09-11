import type { MotionMode } from '../../runtime/visualPreferences';
import {
  blendMotionPoint,
  clamp,
  clampVectorMagnitude,
  computeGlassDeformation,
  isSpringSettled,
  isVectorSpringSettled,
  normalizePressurePoint,
  rubberBandVector,
  samplePointerVelocity,
  stepSpringAxis,
  stepSpringVector,
} from './glassMotionMath';
import type {
  GlassSpatialMotionMode,
  MotionPoint,
  SpringVectorState,
} from './glassMotionMath';

export const GLASS_MOTION_SELECTOR = '[data-glass-motion]';

const DRAG_THRESHOLD_PX = 3.5;
const CLICK_SUPPRESSION_MS = 700;
const STANDARD_PULL_LIMIT = Object.freeze({ x: 44, y: 34 });
const FULL_PULL_LIMIT = Object.freeze({ x: 52, y: 40 });

const MUTATED_STYLE_PROPERTIES = [
  'transform',
  'transform-origin',
  'transition',
  'will-change',
  'z-index',
  '--glass-motion-active',
  '--glass-motion-x',
  '--glass-motion-y',
  '--glass-motion-speed',
  '--glass-motion-scale-x',
  '--glass-motion-scale-y',
  '--glass-motion-rotate',
  '--glass-motion-stretch',
  '--glass-pressure',
  '--glass-pressure-x',
  '--glass-pressure-y',
  '--glass-tilt-x',
  '--glass-tilt-y',
] as const;

type SavedStyleProperty = Readonly<{
  value: string;
  priority: string;
}>;

type InlineStyleSnapshot = ReadonlyMap<string, SavedStyleProperty>;

type MotionPhase = 'pressed' | 'dragging' | 'settling';

type ActiveMotion = {
  element: HTMLElement;
  mode: GlassSpatialMotionMode;
  phase: MotionPhase;
  pointerId: number | null;
  rect: DOMRect;
  startPointer: MotionPoint;
  lastPointer: MotionPoint;
  lastPointerAt: number;
  pointerVelocity: MotionPoint;
  spring: SpringVectorState;
  target: MotionPoint;
  pressure: number;
  pressureVelocity: number;
  targetPressure: number;
  pressurePoint: MotionPoint;
  moved: boolean;
  previousFrameAt: number;
  inlineStyle: InlineStyleSnapshot;
  baseTransform: string;
  previousStateAttribute: string | null;
};

type SuppressedClick = Readonly<{
  element: HTMLElement;
  expiresAt: number;
}>;

export type GlassMotionEngineOptions = Readonly<{
  root?: Document;
  getMode?: () => MotionMode;
  reducedMotionQuery?: MediaQueryList | null;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  readComputedTransform?: (element: HTMLElement) => string;
  isDocumentHidden?: () => boolean;
}>;

export type GlassMotionEngine = Readonly<{
  dispose: () => void;
  cancel: () => void;
  readonly activeElement: HTMLElement | null;
}>;

const defaultRequestAnimationFrame = (callback: FrameRequestCallback): number => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
};

const defaultCancelAnimationFrame = (handle: number): void => {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle);
};

const snapshotInlineStyle = (element: HTMLElement): InlineStyleSnapshot => {
  const snapshot = new Map<string, SavedStyleProperty>();
  for (const property of MUTATED_STYLE_PROPERTIES) {
    snapshot.set(property, {
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    });
  }
  return snapshot;
};

const restoreInlineStyle = (
  element: HTMLElement,
  snapshot: InlineStyleSnapshot,
): void => {
  for (const property of MUTATED_STYLE_PROPERTIES) {
    const saved = snapshot.get(property);
    if (!saved?.value) element.style.removeProperty(property);
    else element.style.setProperty(property, saved.value, saved.priority);
  }
};

const closestMotionElement = (target: EventTarget | null): HTMLElement | null => {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  return candidate?.closest?.(GLASS_MOTION_SELECTOR) as HTMLElement | null ?? null;
};

const resolveMotionElement = (target: EventTarget | null): HTMLElement | null => {
  const element = closestMotionElement(target);
  if (!element) return null;
  if (element.getAttribute('data-glass-motion') === 'none') return null;
  if ((element as HTMLButtonElement).disabled === true) return null;
  if (element.hasAttribute('disabled')) return null;
  if (element.getAttribute('aria-disabled') === 'true') return null;
  return element;
};

const setMotionStateAttribute = (current: ActiveMotion, phase: MotionPhase): void => {
  current.phase = phase;
  current.element.setAttribute('data-glass-motion-state', phase);
};

const readEventTime = (event: Event): number =>
  Number.isFinite(event.timeStamp) ? event.timeStamp : 0;

/**
 * One delegated motion owner for all ordinary glass controls. It never scans
 * the DOM: a pointer event resolves the nearest opted-in control on demand.
 */
export const createGlassMotionEngine = (
  options: GlassMotionEngineOptions = {},
): GlassMotionEngine => {
  const root = options.root ?? (typeof document === 'undefined' ? null : document);
  if (!root) {
    return {
      dispose() {},
      cancel() {},
      activeElement: null,
    };
  }

  const requestFrameImpl = options.requestAnimationFrame ?? defaultRequestAnimationFrame;
  const cancelFrameImpl = options.cancelAnimationFrame ?? defaultCancelAnimationFrame;
  const readComputedTransform = options.readComputedTransform ?? ((element: HTMLElement) => {
    const inline = element.style.getPropertyValue('transform').trim();
    if (inline) return inline;
    if (typeof globalThis.getComputedStyle !== 'function') return '';
    const computed = globalThis.getComputedStyle(element).transform;
    return computed && computed !== 'none' ? computed : '';
  });
  const getMode = options.getMode ?? (() => {
    const value = root.documentElement?.dataset.motion;
    if (value === 'none' || value === 'standard' || value === 'full') return value;
    if (value === 'reduced') return 'none';
    return 'standard';
  });
  const reducedMotionQuery = options.reducedMotionQuery === undefined
    ? typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    : options.reducedMotionQuery;
  const isDocumentHidden = options.isDocumentHidden
    ?? (() => root.visibilityState === 'hidden');

  let active: ActiveMotion | null = null;
  let frameHandle = 0;
  let suppressedClick: SuppressedClick | null = null;
  let disposed = false;

  const effectiveMode = (): MotionMode => reducedMotionQuery?.matches ? 'none' : getMode();

  const stopFrame = (): void => {
    if (frameHandle) cancelFrameImpl(frameHandle);
    frameHandle = 0;
  };

  const restoreMotion = (current: ActiveMotion): void => {
    restoreInlineStyle(current.element, current.inlineStyle);
    if (current.previousStateAttribute === null) {
      current.element.removeAttribute('data-glass-motion-state');
    } else {
      current.element.setAttribute('data-glass-motion-state', current.previousStateAttribute);
    }
  };

  const releaseCapture = (current: ActiveMotion): void => {
    const pointerId = current.pointerId;
    current.pointerId = null;
    if (pointerId === null) return;
    try {
      if (current.element.hasPointerCapture(pointerId)) {
        current.element.releasePointerCapture(pointerId);
      }
    } catch { /* cancellation and DOM removal can release capture first */ }
  };

  const abortActive = (): void => {
    const current = active;
    active = null;
    stopFrame();
    if (!current) return;
    releaseCapture(current);
    restoreMotion(current);
  };

  const render = (current: ActiveMotion): void => {
    const deformation = computeGlassDeformation({
      mode: current.mode,
      position: current.spring.position,
      velocity: current.spring.velocity,
      pressure: current.pressure,
      pressurePoint: current.pressurePoint,
    });
    const style = current.element.style;
    const motionTransform = [
      'perspective(720px)',
      `translate3d(${deformation.translateX.toFixed(3)}px, ${deformation.translateY.toFixed(3)}px, 0)`,
      `rotateX(${deformation.tiltX.toFixed(3)}deg)`,
      `rotateY(${deformation.tiltY.toFixed(3)}deg)`,
      `rotateZ(${deformation.rotateZ.toFixed(3)}deg)`,
      `scale(${deformation.scaleX.toFixed(4)}, ${deformation.scaleY.toFixed(4)})`,
    ].join(' ');
    style.setProperty('transform', current.baseTransform
      ? `${current.baseTransform} ${motionTransform}`
      : motionTransform);
    style.setProperty(
      'transform-origin',
      `${(deformation.pressurePoint.x * 100).toFixed(2)}% ${(deformation.pressurePoint.y * 100).toFixed(2)}%`,
    );
    style.setProperty('--glass-motion-active', '1');
    style.setProperty('--glass-motion-x', `${deformation.translateX.toFixed(3)}px`);
    style.setProperty('--glass-motion-y', `${deformation.translateY.toFixed(3)}px`);
    style.setProperty('--glass-motion-speed', deformation.speed.toFixed(3));
    style.setProperty('--glass-motion-scale-x', deformation.scaleX.toFixed(4));
    style.setProperty('--glass-motion-scale-y', deformation.scaleY.toFixed(4));
    style.setProperty('--glass-motion-rotate', `${deformation.rotateZ.toFixed(3)}deg`);
    style.setProperty('--glass-motion-stretch', deformation.stretch.toFixed(4));
    style.setProperty('--glass-pressure', deformation.pressure.toFixed(4));
    style.setProperty('--glass-pressure-x', `${(deformation.pressurePoint.x * 100).toFixed(2)}%`);
    style.setProperty('--glass-pressure-y', `${(deformation.pressurePoint.y * 100).toFixed(2)}%`);
    style.setProperty('--glass-tilt-x', `${deformation.tiltX.toFixed(3)}deg`);
    style.setProperty('--glass-tilt-y', `${deformation.tiltY.toFixed(3)}deg`);
  };

  const requestMotionFrame = (): void => {
    if (disposed || frameHandle || !active) return;
    frameHandle = requestFrameImpl(stepMotion);
  };

  function stepMotion(now: number): void {
    frameHandle = 0;
    const current = active;
    if (!current) return;
    const mode = effectiveMode();
    if (isDocumentHidden() || mode === 'none' || mode !== current.mode) {
      abortActive();
      return;
    }

    const deltaSeconds = current.previousFrameAt
      ? clamp((now - current.previousFrameAt) / 1000, 1 / 1000, 1 / 30)
      : 1 / 60;
    current.previousFrameAt = now;
    const settling = current.phase === 'settling';
    const springTuning = settling
      ? current.mode === 'full'
        ? { stiffness: 480, damping: 15 }
        : { stiffness: 580, damping: 17 }
      : current.mode === 'full'
        ? { stiffness: 380, damping: 20 }
        : { stiffness: 520, damping: 24 };
    current.spring = stepSpringVector(current.spring, current.target, deltaSeconds, springTuning);
    current.spring = {
      position: current.spring.position,
      velocity: clampVectorMagnitude(
        current.spring.velocity,
        current.mode === 'full' ? 980 : 760,
      ),
    };
    const steppedPressure = stepSpringAxis(
      { position: current.pressure, velocity: current.pressureVelocity },
      current.targetPressure,
      deltaSeconds,
      settling
        ? { stiffness: 360, damping: 22 }
        : { stiffness: 440, damping: 28 },
    );
    current.pressure = steppedPressure.position;
    current.pressureVelocity = steppedPressure.velocity;
    render(current);

    const positionSettled = isVectorSpringSettled(current.spring, current.target);
    const pressureSettled = isSpringSettled(
      { position: current.pressure, velocity: current.pressureVelocity },
      current.targetPressure,
      .002,
      .02,
    );
    if (positionSettled && pressureSettled) {
      if (settling) {
        active = null;
        restoreMotion(current);
      }
      // A held control remains owned but does not keep an idle RAF alive.
      return;
    }
    requestMotionFrame();
  }

  const beginMotion = (event: PointerEvent): void => {
    if (
      event.button !== 0
      || event.isPrimary === false
      || event.defaultPrevented
      || effectiveMode() === 'none'
    ) return;
    const element = resolveMotionElement(event.target);
    if (!element) return;

    abortActive();
    const mode = effectiveMode();
    if (mode === 'none') return;
    const spatialMode: GlassSpatialMotionMode = mode === 'full' ? 'full' : 'standard';
    const point = { x: event.clientX, y: event.clientY };
    const rect = element.getBoundingClientRect();
    const previousStateAttribute = element.getAttribute('data-glass-motion-state');
    active = {
      element,
      mode: spatialMode,
      phase: 'pressed',
      pointerId: event.pointerId,
      rect,
      startPointer: point,
      lastPointer: point,
      lastPointerAt: readEventTime(event),
      pointerVelocity: { x: 0, y: 0 },
      spring: {
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: 0 },
      },
      target: { x: 0, y: 0 },
      pressure: 0,
      pressureVelocity: 0,
      targetPressure: spatialMode === 'full' ? .86 : .5,
      pressurePoint: spatialMode === 'full'
        ? normalizePressurePoint(event.clientX, event.clientY, rect)
        : { x: .5, y: .5 },
      moved: false,
      previousFrameAt: 0,
      inlineStyle: snapshotInlineStyle(element),
      baseTransform: readComputedTransform(element),
      previousStateAttribute,
    };
    element.style.setProperty('transition', 'none');
    element.style.setProperty('will-change', 'transform');
    element.style.setProperty('z-index', 'var(--glass-motion-active-z, 40)');
    element.setAttribute('data-glass-motion-state', 'pressed');
    try { element.setPointerCapture(event.pointerId); }
    catch { /* delegated document listeners remain the fallback */ }
    requestMotionFrame();
  };

  const moveMotion = (event: PointerEvent): void => {
    const current = active;
    if (
      !current
      || current.phase === 'settling'
      || current.pointerId !== event.pointerId
    ) return;
    const delta = {
      x: event.clientX - current.startPointer.x,
      y: event.clientY - current.startPointer.y,
    };
    const travel = Math.hypot(delta.x, delta.y);
    if (!current.moved && travel < DRAG_THRESHOLD_PX) {
      if (current.mode === 'full') {
        current.pressurePoint = normalizePressurePoint(event.clientX, event.clientY, current.rect);
        requestMotionFrame();
      }
      return;
    }
    if (!current.moved) {
      current.moved = true;
      setMotionStateAttribute(current, 'dragging');
    }
    if (event.cancelable) event.preventDefault();

    const nextPointer = { x: event.clientX, y: event.clientY };
    const sampledVelocity = clampVectorMagnitude(samplePointerVelocity(
      current.lastPointer,
      nextPointer,
      Math.max(8, readEventTime(event) - current.lastPointerAt),
    ), 1400);
    current.pointerVelocity = blendMotionPoint(current.pointerVelocity, sampledVelocity, .48);
    current.lastPointer = nextPointer;
    current.lastPointerAt = readEventTime(event);
    const limits = current.mode === 'full' ? FULL_PULL_LIMIT : STANDARD_PULL_LIMIT;
    current.target = rubberBandVector(delta, limits.x, limits.y);
    const injectedVelocity = blendMotionPoint(
      current.spring.velocity,
      current.pointerVelocity,
      current.mode === 'full' ? .24 : .13,
    );
    current.spring = {
      position: current.spring.position,
      velocity: clampVectorMagnitude(
        injectedVelocity,
        current.mode === 'full' ? 920 : 680,
      ),
    };
    if (current.mode === 'full') {
      current.pressurePoint = normalizePressurePoint(event.clientX, event.clientY, current.rect);
      current.targetPressure = clamp(.84 + Math.hypot(
        current.pointerVelocity.x,
        current.pointerVelocity.y,
      ) / 7000, .84, 1);
    }
    requestMotionFrame();
  };

  const finishMotion = (event: PointerEvent, cancelled: boolean): void => {
    const current = active;
    if (
      !current
      || current.phase === 'settling'
      || current.pointerId !== event.pointerId
    ) return;
    releaseCapture(current);
    setMotionStateAttribute(current, 'settling');
    current.target = { x: 0, y: 0 };
    current.targetPressure = 0;
    current.previousFrameAt = 0;
    if (cancelled) {
      current.spring = {
        position: current.spring.position,
        velocity: {
          x: current.spring.velocity.x * .22,
          y: current.spring.velocity.y * .22,
        },
      };
      current.pressureVelocity *= .3;
    } else if (current.moved) {
      const releaseImpulse = blendMotionPoint(
        current.spring.velocity,
        current.pointerVelocity,
        current.mode === 'full' ? .18 : .1,
      );
      current.spring = {
        position: current.spring.position,
        velocity: clampVectorMagnitude(
          releaseImpulse,
          current.mode === 'full' ? 760 : 520,
        ),
      };
      suppressedClick = {
        element: current.element,
        expiresAt: readEventTime(event) + CLICK_SUPPRESSION_MS,
      };
    }
    requestMotionFrame();
  };

  const suppressDraggedClick = (event: MouseEvent): void => {
    const pending = suppressedClick;
    if (!pending) return;
    const eventTime = readEventTime(event);
    if (eventTime > pending.expiresAt) {
      suppressedClick = null;
      return;
    }
    if (closestMotionElement(event.target) !== pending.element) return;
    suppressedClick = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const handleVisibilityChange = (): void => {
    if (isDocumentHidden()) abortActive();
  };
  const handleReducedMotionChange = (): void => {
    if (reducedMotionQuery?.matches) abortActive();
  };
  const handlePointerUp = (event: Event): void => finishMotion(event as PointerEvent, false);
  const handlePointerCancel = (event: Event): void => finishMotion(event as PointerEvent, true);
  const handleLostPointerCapture = (event: Event): void => finishMotion(event as PointerEvent, true);

  root.addEventListener('pointerdown', beginMotion as EventListener, true);
  root.addEventListener('pointermove', moveMotion as EventListener, { capture: true, passive: false });
  root.addEventListener('pointerup', handlePointerUp, true);
  root.addEventListener('pointercancel', handlePointerCancel, true);
  root.addEventListener('lostpointercapture', handleLostPointerCapture, true);
  root.addEventListener('click', suppressDraggedClick as EventListener, true);
  root.addEventListener('visibilitychange', handleVisibilityChange);
  reducedMotionQuery?.addEventListener?.('change', handleReducedMotionChange);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    root.removeEventListener('pointerdown', beginMotion as EventListener, true);
    root.removeEventListener('pointermove', moveMotion as EventListener, true);
    root.removeEventListener('pointerup', handlePointerUp, true);
    root.removeEventListener('pointercancel', handlePointerCancel, true);
    root.removeEventListener('lostpointercapture', handleLostPointerCapture, true);
    root.removeEventListener('click', suppressDraggedClick as EventListener, true);
    root.removeEventListener('visibilitychange', handleVisibilityChange);
    reducedMotionQuery?.removeEventListener?.('change', handleReducedMotionChange);
    suppressedClick = null;
    abortActive();
  };

  return {
    dispose,
    cancel: abortActive,
    get activeElement() { return active?.element ?? null; },
  };
};

/** Convenience lifecycle shape for runtimes that only need a disposer. */
export const startGlassMotionEngine = (
  options: GlassMotionEngineOptions = {},
): (() => void) => {
  const engine = createGlassMotionEngine(options);
  return engine.dispose;
};
