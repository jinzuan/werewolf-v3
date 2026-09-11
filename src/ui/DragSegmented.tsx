import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { cn } from '../lib/utils';

export type DragSegmentedOption<Value extends string> = Readonly<{
  value: Value;
  label: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
}>;

export type DragSegmentedProps<Value extends string> = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'onChange'
> & {
  value: Value;
  options: readonly DragSegmentedOption<Value>[];
  onChange: (value: Value) => void;
  ariaLabel: string;
  disabled?: boolean;
  'data-motion'?: 'none' | 'standard' | 'full';
};

type SegmentGeometry<Value extends string> = {
  value: Value;
  left: number;
  top: number;
  width: number;
  height: number;
  center: number;
  disabled: boolean;
};

type SpringGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SpringVelocity = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const ZERO_GEOMETRY: SpringGeometry = { x: 0, y: 0, width: 0, height: 0 };
const ZERO_VELOCITY: SpringVelocity = { x: 0, y: 0, width: 0, height: 0 };
const DRAG_THRESHOLD_PX = 3;
const MAX_POINTER_IMPULSE = 180;
const SETTLE_DISTANCE = 0.08;
const SETTLE_VELOCITY = 0.12;

// Avoid the server-side useLayoutEffect warning while retaining pre-paint
// measurement in the browser.
const useBrowserLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

function cloneGeometry(geometry: SpringGeometry): SpringGeometry {
  return { ...geometry };
}

function geometryFor<Value extends string>(
  segment: SegmentGeometry<Value>,
): SpringGeometry {
  return {
    x: segment.left,
    y: segment.top,
    width: segment.width,
    height: segment.height,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Compresses overscroll rather than stopping the slider abruptly at an edge. */
function rubberBand(value: number, minimum: number, maximum: number, maxExcursion: number) {
  if (value < minimum) return minimum - Math.min(maxExcursion, (minimum - value) * .34);
  if (value > maximum) return maximum + Math.min(maxExcursion, (value - maximum) * .34);
  return value;
}

function nearestEnabledSegment<Value extends string>(
  segments: readonly SegmentGeometry<Value>[],
  center: number,
) {
  let nearest: SegmentGeometry<Value> | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const segment of segments) {
    if (segment.disabled) continue;
    const distance = Math.abs(segment.center - center);
    if (distance < nearestDistance) {
      nearest = segment;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function isSpringSettled(
  current: SpringGeometry,
  target: SpringGeometry,
  velocity: SpringVelocity,
) {
  return (
    Math.abs(current.x - target.x) < SETTLE_DISTANCE &&
    Math.abs(current.y - target.y) < SETTLE_DISTANCE &&
    Math.abs(current.width - target.width) < SETTLE_DISTANCE &&
    Math.abs(current.height - target.height) < SETTLE_DISTANCE &&
    Math.abs(velocity.x) < SETTLE_VELOCITY &&
    Math.abs(velocity.y) < SETTLE_VELOCITY &&
    Math.abs(velocity.width) < SETTLE_VELOCITY &&
    Math.abs(velocity.height) < SETTLE_VELOCITY
  );
}

function stepSpringAxis(
  current: number,
  target: number,
  velocity: number,
  deltaSeconds: number,
  stiffness: number,
  damping: number,
) {
  const acceleration = (target - current) * stiffness - velocity * damping;
  const nextVelocity = velocity + acceleration * deltaSeconds;
  return {
    position: current + nextVelocity * deltaSeconds,
    velocity: nextVelocity,
  };
}

/**
 * Controlled segmented selector with a single shared, draggable visual slider.
 * CSS may skin the stable `drag-segmented*` classes without knowing the motion
 * implementation. Any real option can begin a drag; a short press still uses
 * the native button click and a moved pointer pulls the shared slider.
 */
export function DragSegmented<Value extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
  style,
  'data-motion': dataMotion,
  onKeyDown,
  ...groupProps
}: DragSegmentedProps<Value>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLSpanElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const bridgeRef = useRef<HTMLSpanElement>(null);
  const buttonRefs = useRef(new Map<Value, HTMLButtonElement>());
  const segmentsRef = useRef<SegmentGeometry<Value>[]>([]);
  const valueRef = useRef(value);
  const visualValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const activePointerRef = useRef<number | null>(null);
  const pointerStartRef = useRef({ x: 0, y: 0, time: 0 });
  const pointerLastRef = useRef({ x: 0, y: 0, time: 0 });
  const grabOffsetRef = useRef(0);
  const grabOffsetYRef = useRef(0);
  const suppressNextClickRef = useRef(false);
  const draggedRef = useRef(false);
  const reducedMotionRef = useRef(dataMotion === 'none');
  const mediaQueryRef = useRef<MediaQueryList | null>(null);
  const frameRef = useRef<number | null>(null);
  const reconciliationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousFrameTimeRef = useRef(0);
  const currentRef = useRef<SpringGeometry>(cloneGeometry(ZERO_GEOMETRY));
  const targetRef = useRef<SpringGeometry>(cloneGeometry(ZERO_GEOMETRY));
  const velocityRef = useRef<SpringVelocity>({ ...ZERO_VELOCITY });
  const initializedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);

  valueRef.current = value;
  onChangeRef.current = onChange;

  const writePressurePoint = useCallback((clientX: number, clientY: number) => {
    const root = rootRef.current;
    if (!root || dataMotion !== 'full') return;
    const rect = root.getBoundingClientRect();
    const x = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const y = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    root.style.setProperty('--glass-pressure', '.9');
    root.style.setProperty('--glass-pressure-x', `${(x * 100).toFixed(2)}%`);
    root.style.setProperty('--glass-pressure-y', `${(y * 100).toFixed(2)}%`);
  }, [dataMotion]);

  const clearPressurePoint = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.setProperty('--glass-pressure', '0');
  }, []);

  const writeSliderGeometry = useCallback((geometry: SpringGeometry) => {
    const slider = sliderRef.current;
    if (!slider) return;
    slider.style.setProperty('--drag-segmented-x', `${geometry.x}px`);
    slider.style.setProperty('--drag-segmented-y', `${geometry.y}px`);
    slider.style.setProperty('--drag-segmented-width', `${geometry.width}px`);
    slider.style.setProperty('--drag-segmented-height', `${geometry.height}px`);
    slider.style.transform = `translate3d(${geometry.x}px, ${geometry.y}px, 0)`;
    slider.style.width = `${geometry.width}px`;
    slider.style.height = `${geometry.height}px`;
  }, []);

  const snapTo = useCallback((geometry: SpringGeometry) => {
    currentRef.current = cloneGeometry(geometry);
    targetRef.current = cloneGeometry(geometry);
    velocityRef.current = { ...ZERO_VELOCITY };
    previousFrameTimeRef.current = 0;
    writeSliderGeometry(geometry);
  }, [writeSliderGeometry]);

  const animationStepRef = useRef<(time: number) => void>(() => undefined);

  const requestSpringFrame = useCallback(() => {
    if (frameRef.current !== null || reducedMotionRef.current) return;
    frameRef.current = requestAnimationFrame((time) => {
      animationStepRef.current(time);
    });
  }, []);

  animationStepRef.current = (time: number) => {
    frameRef.current = null;
    if (reducedMotionRef.current) {
      snapTo(targetRef.current);
      return;
    }

    const previousTime = previousFrameTimeRef.current || time;
    // Capping a delayed frame keeps a restored background tab from exploding.
    const deltaSeconds = clamp((time - previousTime) / 1000, 1 / 240, 1 / 30);
    previousFrameTimeRef.current = time;

    const isFollowingPointer = activePointerRef.current !== null;
    const stiffness = isFollowingPointer ? 420 : 180;
    const damping = isFollowingPointer ? 20 : 13;
    const current = currentRef.current;
    const target = targetRef.current;
    const velocity = velocityRef.current;

    for (const axis of ['x', 'y', 'width', 'height'] as const) {
      const stepped = stepSpringAxis(
        current[axis],
        target[axis],
        velocity[axis],
        deltaSeconds,
        stiffness,
        damping,
      );
      current[axis] = stepped.position;
      velocity[axis] = stepped.velocity;
    }

    writeSliderGeometry(current);
    if (isSpringSettled(current, target, velocity)) {
      snapTo(target);
      return;
    }
    requestSpringFrame();
  };

  const cancelSpringFrame = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    previousFrameTimeRef.current = 0;
  }, []);

  const motionIsReduced = useCallback(() => {
    const inheritedReduction = rootRef.current
      ?.closest("[data-motion='none'], [data-motion='reduced']");
    return (
      dataMotion === 'none' ||
      Boolean(inheritedReduction) ||
      Boolean(mediaQueryRef.current?.matches)
    );
  }, [dataMotion]);

  const moveTarget = useCallback((geometry: SpringGeometry, immediate = false) => {
    targetRef.current = cloneGeometry(geometry);
    reducedMotionRef.current = motionIsReduced();
    if (immediate || reducedMotionRef.current || !initializedRef.current) {
      cancelSpringFrame();
      snapTo(geometry);
      return;
    }
    requestSpringFrame();
  }, [cancelSpringFrame, motionIsReduced, requestSpringFrame, snapTo]);

  const measureSegments = useCallback(() => {
    const root = rootRef.current;
    if (!root) return [] as SegmentGeometry<Value>[];
    const rootRect = root.getBoundingClientRect();
    const measured: SegmentGeometry<Value>[] = [];

    for (const option of options) {
      const button = buttonRefs.current.get(option.value);
      if (!button) continue;
      const rect = button.getBoundingClientRect();
      const left = rect.left - rootRect.left;
      measured.push({
        value: option.value,
        left,
        top: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height,
        center: left + rect.width / 2,
        disabled: disabled || Boolean(option.disabled),
      });
    }

    segmentsRef.current = measured;
    const selected = measured.find((segment) => segment.value === visualValueRef.current)
      ?? measured.find((segment) => segment.value === valueRef.current)
      ?? measured.find((segment) => !segment.disabled);
    if (selected && activePointerRef.current === null) {
      const firstMeasurement = !initializedRef.current;
      initializedRef.current = true;
      moveTarget(geometryFor(selected), firstMeasurement);
      setReady(true);
    }
    return measured;
  }, [disabled, moveTarget, options]);

  useBrowserLayoutEffect(() => {
    if (reconciliationTimerRef.current) {
      clearTimeout(reconciliationTimerRef.current);
      reconciliationTimerRef.current = null;
    }
    visualValueRef.current = value;
    measureSegments();
  }, [measureSegments, value]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    mediaQueryRef.current = query;

    const handleMotionPreference = () => {
      reducedMotionRef.current = motionIsReduced();
      if (reducedMotionRef.current) {
        cancelSpringFrame();
        snapTo(targetRef.current);
      }
    };

    handleMotionPreference();
    query?.addEventListener?.('change', handleMotionPreference);
    return () => {
      query?.removeEventListener?.('change', handleMotionPreference);
      mediaQueryRef.current = null;
    };
  }, [cancelSpringFrame, motionIsReduced, snapTo]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const handleResize = () => measureSegments();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(handleResize);

    observer?.observe(root);
    for (const button of buttonRefs.current.values()) observer?.observe(button);
    window.addEventListener('resize', handleResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [measureSegments]);

  useEffect(() => () => {
    cancelSpringFrame();
    if (reconciliationTimerRef.current) {
      clearTimeout(reconciliationTimerRef.current);
      reconciliationTimerRef.current = null;
    }
    activePointerRef.current = null;
    clearPressurePoint();
  }, [cancelSpringFrame, clearPressurePoint]);

  const releasePointerCapture = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const captureOwner = event.target as Element;
    if (
      'hasPointerCapture' in captureOwner &&
      captureOwner.hasPointerCapture(event.pointerId)
    ) {
      captureOwner.releasePointerCapture(event.pointerId);
    }
  };

  const returnToControlledValue = useCallback(() => {
    const controlled = segmentsRef.current.find(
      (segment) => segment.value === valueRef.current,
    );
    visualValueRef.current = valueRef.current;
    if (controlled) moveTarget(geometryFor(controlled));
  }, [moveTarget]);

  const reconcileControlledValue = useCallback((requestedValue: Value) => {
    if (reconciliationTimerRef.current) {
      clearTimeout(reconciliationTimerRef.current);
    }
    reconciliationTimerRef.current = setTimeout(() => {
      reconciliationTimerRef.current = null;
      if (valueRef.current !== requestedValue) returnToControlledValue();
    }, 180);
  }, [returnToControlledValue]);

  const handlePointerDown = (
    option: DragSegmentedOption<Value>,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (
      disabled ||
      option.disabled ||
      event.button !== 0
    ) return;

    // Reduced mode is intentionally a basic click control: no capture,
    // pulling shape, inertial following, ghost, or metaball bridge.
    if (motionIsReduced()) return;

    const segments = measureSegments();
    const selected = segments.find((segment) => segment.value === valueRef.current);
    const rootRect = rootRef.current?.getBoundingClientRect();
    if (!selected || !rootRect) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerRef.current = event.pointerId;
    draggedRef.current = false;
    suppressNextClickRef.current = false;
    pointerStartRef.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    pointerLastRef.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    grabOffsetRef.current = option.value === valueRef.current
      ? event.clientX - rootRect.left - selected.center
      : 0;
    grabOffsetYRef.current = option.value === valueRef.current
      ? event.clientY - rootRect.top - (selected.top + selected.height / 2)
      : 0;
    reducedMotionRef.current = motionIsReduced();
    writePressurePoint(event.clientX, event.clientY);
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    const root = rootRef.current;
    const segments = segmentsRef.current;
    if (!root || segments.length === 0) return;

    const travel = Math.hypot(
      event.clientX - pointerStartRef.current.x,
      event.clientY - pointerStartRef.current.y,
    );
    if (!draggedRef.current && travel < DRAG_THRESHOLD_PX) return;
    draggedRef.current = true;
    suppressNextClickRef.current = true;
    event.preventDefault();

    const rootRect = root.getBoundingClientRect();
    writePressurePoint(event.clientX, event.clientY);
    const selectedWidth = targetRef.current.width || currentRef.current.width;
    const selectedHeight = targetRef.current.height || currentRef.current.height;
    const origin = segments.find((segment) => segment.value === valueRef.current) ?? segments[0];
    const maxExcursion = selectedHeight;
    const minimum = Math.min(...segments.map((segment) => segment.left));
    const maximum = Math.max(
      ...segments.map((segment) => segment.left + segment.width - selectedWidth),
    );
    const pointerCenter = event.clientX - rootRect.left - grabOffsetRef.current;
    const targetX = rubberBand(
      pointerCenter - selectedWidth / 2,
      minimum,
      maximum,
      maxExcursion,
    );
    const pointerCenterY = event.clientY - rootRect.top - grabOffsetYRef.current;
    const targetY = clamp(
      pointerCenterY - selectedHeight / 2,
      origin.top - maxExcursion,
      origin.top + maxExcursion,
    );
    const nearest = nearestEnabledSegment(segments, targetX + selectedWidth / 2);
    const elapsed = Math.max(8, event.timeStamp - pointerLastRef.current.time);
    const pointerVelocity = ((event.clientX - pointerLastRef.current.x) / elapsed) * 1000;
    const pointerVelocityY = ((event.clientY - pointerLastRef.current.y) / elapsed) * 1000;
    pointerLastRef.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };

    // A small capped impulse lets the glass mass pass the cursor briefly when
    // the pointer stops, while the spring still owns the final trajectory.
    if (!reducedMotionRef.current) {
      velocityRef.current.x += clamp(
        pointerVelocity * 0.07,
        -MAX_POINTER_IMPULSE,
        MAX_POINTER_IMPULSE,
      );
      velocityRef.current.y += clamp(
        pointerVelocityY * .07,
        -MAX_POINTER_IMPULSE,
        MAX_POINTER_IMPULSE,
      );
    }
    moveTarget({ ...targetRef.current, x: targetX, y: targetY });

    const ghost = ghostRef.current;
    const bridge = bridgeRef.current;
    if (nearest && ghost && bridge) {
      const movingCenterX = targetX + selectedWidth / 2;
      const movingCenterY = targetY + selectedHeight / 2;
      const targetCenterX = nearest.center;
      const targetCenterY = nearest.top + nearest.height / 2;
      const distance = Math.hypot(targetCenterX - movingCenterX, targetCenterY - movingCenterY);
      const thickness = Math.min(targetRef.current.height, nearest.height) * .52;
      ghost.style.transform = `translate3d(${nearest.left}px, ${nearest.top}px, 0)`;
      ghost.style.width = `${nearest.width}px`;
      ghost.style.height = `${nearest.height}px`;
      bridge.style.width = `${distance}px`;
      bridge.style.height = `${thickness}px`;
      bridge.style.transform = `translate3d(${movingCenterX}px, ${movingCenterY - thickness / 2}px, 0) rotate(${Math.atan2(targetCenterY - movingCenterY, targetCenterX - movingCenterX)}rad)`;
      root.classList.toggle('drag-segmented--merging', nearest.value !== valueRef.current);
    }
  };

  const finishDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled: boolean,
  ) => {
    if (activePointerRef.current !== event.pointerId) return;
    releasePointerCapture(event);
    activePointerRef.current = null;
    rootRef.current?.classList.remove('drag-segmented--merging');
    clearPressurePoint();
    setDragging(false);

    if (cancelled || !draggedRef.current) {
      if (cancelled) suppressNextClickRef.current = false;
      returnToControlledValue();
      return;
    }

    const center = targetRef.current.x + targetRef.current.width / 2;
    const nearest = nearestEnabledSegment(segmentsRef.current, center);
    if (!nearest) {
      returnToControlledValue();
      return;
    }

    visualValueRef.current = nearest.value;
    moveTarget(geometryFor(nearest));
    if (nearest.value !== valueRef.current) {
      onChangeRef.current(nearest.value);
      reconcileControlledValue(nearest.value);
    }
  };

  const activateOption = (option: DragSegmentedOption<Value>) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (disabled || option.disabled || option.value === valueRef.current) return;
    const segment = segmentsRef.current.find((entry) => entry.value === option.value);
    visualValueRef.current = option.value;
    if (segment) moveTarget(geometryFor(segment));
    onChangeRef.current(option.value);
    reconcileControlledValue(option.value);
  };

  const activateByKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    direction: 'previous' | 'next' | 'first' | 'last',
  ) => {
    const enabled = options.filter((option) => !disabled && !option.disabled);
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex((option) => option.value === valueRef.current);
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    if (direction === 'first') nextIndex = 0;
    if (direction === 'last') nextIndex = enabled.length - 1;
    if (direction === 'previous') {
      nextIndex = (Math.max(currentIndex, 0) - 1 + enabled.length) % enabled.length;
    }
    if (direction === 'next') nextIndex = (Math.max(currentIndex, -1) + 1) % enabled.length;
    const next = enabled[nextIndex];
    if (!next) return;

    event.preventDefault();
    buttonRefs.current.get(next.value)?.focus();
    activateOption(next);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      activateByKeyboard(event, 'previous');
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      activateByKeyboard(event, 'next');
    } else if (event.key === 'Home') {
      activateByKeyboard(event, 'first');
    } else if (event.key === 'End') {
      activateByKeyboard(event, 'last');
    }
  };

  const keyboardEntryValue = options.find(
    (option) => option.value === value && !disabled && !option.disabled,
  )?.value ?? options.find((option) => !disabled && !option.disabled)?.value;

  return (
    <div
      {...groupProps}
      ref={rootRef}
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        'drag-segmented',
        dragging && 'drag-segmented--dragging',
        disabled && 'drag-segmented--disabled',
        className,
      )}
      style={{ touchAction: 'pan-y', ...style } as CSSProperties}
      data-motion={dataMotion}
      data-state={dragging ? 'dragging' : 'idle'}
      data-ready={ready ? 'true' : 'false'}
      data-glass-role="segmented"
      data-glass-owner="self"
      onKeyDown={handleKeyDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event, false)}
      onPointerCancel={(event) => finishDrag(event, true)}
      onLostPointerCapture={(event) => {
        if (activePointerRef.current === event.pointerId) finishDrag(event, true);
      }}
    >
      <span
        ref={sliderRef}
        className="drag-segmented__slider"
        aria-hidden="true"
        data-state={dragging ? 'dragging' : 'idle'}
        data-glass-role="control"
        data-glass-owner="self"
        data-glass-motion="slider"
      />
      <span ref={ghostRef} className="drag-segmented__ghost" aria-hidden="true" />
      <span ref={bridgeRef} className="drag-segmented__bridge" aria-hidden="true" />
      {options.map((option) => {
        const selected = option.value === value;
        const optionDisabled = disabled || Boolean(option.disabled);
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) buttonRefs.current.set(option.value, node);
              else buttonRefs.current.delete(option.value);
            }}
            type="button"
            className={cn(
              'drag-segmented__option',
              selected && 'drag-segmented__option--selected',
            )}
            aria-label={option.ariaLabel}
            aria-pressed={selected}
            disabled={optionDisabled}
            tabIndex={option.value === keyboardEntryValue ? 0 : -1}
            data-value={option.value}
            data-selected={selected ? 'true' : 'false'}
            data-glass-owner="none"
            data-glass-motion="none"
            onPointerDown={(event) => handlePointerDown(option, event)}
            onClick={() => activateOption(option)}
          >
            <span className="drag-segmented__label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
