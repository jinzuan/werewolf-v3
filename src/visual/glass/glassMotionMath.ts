export type GlassSpatialMotionMode = 'standard' | 'full';

export type MotionPoint = Readonly<{
  x: number;
  y: number;
}>;

export type MotionRect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export type SpringAxisState = Readonly<{
  position: number;
  velocity: number;
}>;

export type SpringVectorState = Readonly<{
  position: MotionPoint;
  velocity: MotionPoint;
}>;

export type SpringTuning = Readonly<{
  stiffness: number;
  damping: number;
  maximumStep?: number;
}>;

export type GlassDeformation = Readonly<{
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotateZ: number;
  tiltX: number;
  tiltY: number;
  stretch: number;
  speed: number;
  pressure: number;
  pressurePoint: MotionPoint;
}>;

const DEFAULT_MAXIMUM_STEP = 1 / 30;

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

const finite = (value: number): number => Number.isFinite(value) ? value : 0;

/**
 * Compress an unbounded pointer delta into a short anchored pull. The curve is
 * continuous at zero and approaches, but never reaches, the configured limit.
 */
export const rubberBand = (
  value: number,
  limit: number,
  softness = Math.max(12, limit * .56),
): number => {
  const safeValue = finite(value);
  const safeLimit = Math.max(0, finite(limit));
  const safeSoftness = Math.max(.001, finite(softness));
  if (safeLimit === 0 || safeValue === 0) return 0;
  return Math.sign(safeValue)
    * safeLimit
    * (1 - Math.exp(-Math.abs(safeValue) / safeSoftness));
};

export const rubberBandVector = (
  delta: MotionPoint,
  horizontalLimit: number,
  verticalLimit: number,
): MotionPoint => ({
  x: rubberBand(delta.x, horizontalLimit),
  y: rubberBand(delta.y, verticalLimit),
});

export const normalizePressurePoint = (
  clientX: number,
  clientY: number,
  rect: MotionRect,
): MotionPoint => ({
  x: rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : .5,
  y: rect.height > 0 ? clamp((clientY - rect.top) / rect.height, 0, 1) : .5,
});

export const samplePointerVelocity = (
  previous: MotionPoint,
  next: MotionPoint,
  elapsedMilliseconds: number,
): MotionPoint => {
  const elapsedSeconds = Math.max(.008, finite(elapsedMilliseconds) / 1000);
  return {
    x: (finite(next.x) - finite(previous.x)) / elapsedSeconds,
    y: (finite(next.y) - finite(previous.y)) / elapsedSeconds,
  };
};

export const clampVectorMagnitude = (
  value: MotionPoint,
  maximumMagnitude: number,
): MotionPoint => {
  const x = finite(value.x);
  const y = finite(value.y);
  const magnitude = Math.hypot(x, y);
  const maximum = Math.max(0, finite(maximumMagnitude));
  if (magnitude === 0 || magnitude <= maximum) return { x, y };
  const scale = maximum / magnitude;
  return { x: x * scale, y: y * scale };
};

export const blendMotionPoint = (
  current: MotionPoint,
  next: MotionPoint,
  nextWeight: number,
): MotionPoint => {
  const weight = clamp(nextWeight, 0, 1);
  return {
    x: finite(current.x) * (1 - weight) + finite(next.x) * weight,
    y: finite(current.y) * (1 - weight) + finite(next.y) * weight,
  };
};

/** Semi-implicit Euler is stable enough for this tiny, capped UI spring. */
export const stepSpringAxis = (
  state: SpringAxisState,
  target: number,
  deltaSeconds: number,
  tuning: SpringTuning,
): SpringAxisState => {
  const dt = clamp(deltaSeconds, 1 / 1000, tuning.maximumStep ?? DEFAULT_MAXIMUM_STEP);
  const stiffness = Math.max(0, finite(tuning.stiffness));
  const damping = Math.max(0, finite(tuning.damping));
  const position = finite(state.position);
  const velocity = finite(state.velocity);
  const acceleration = (finite(target) - position) * stiffness - velocity * damping;
  const nextVelocity = velocity + acceleration * dt;
  return {
    position: position + nextVelocity * dt,
    velocity: nextVelocity,
  };
};

export const stepSpringVector = (
  state: SpringVectorState,
  target: MotionPoint,
  deltaSeconds: number,
  tuning: SpringTuning,
): SpringVectorState => {
  const x = stepSpringAxis(
    { position: state.position.x, velocity: state.velocity.x },
    target.x,
    deltaSeconds,
    tuning,
  );
  const y = stepSpringAxis(
    { position: state.position.y, velocity: state.velocity.y },
    target.y,
    deltaSeconds,
    tuning,
  );
  return {
    position: { x: x.position, y: y.position },
    velocity: { x: x.velocity, y: y.velocity },
  };
};

export const isSpringSettled = (
  state: SpringAxisState,
  target: number,
  positionEpsilon = .025,
  velocityEpsilon = .12,
): boolean => Math.abs(state.position - target) <= positionEpsilon
  && Math.abs(state.velocity) <= velocityEpsilon;

export const isVectorSpringSettled = (
  state: SpringVectorState,
  target: MotionPoint,
  positionEpsilon = .035,
  velocityEpsilon = .18,
): boolean => Math.hypot(
  state.position.x - target.x,
  state.position.y - target.y,
) <= positionEpsilon && Math.hypot(state.velocity.x, state.velocity.y) <= velocityEpsilon;

export const computeGlassDeformation = (input: Readonly<{
  mode: GlassSpatialMotionMode;
  position: MotionPoint;
  velocity: MotionPoint;
  pressure: number;
  pressurePoint: MotionPoint;
}>): GlassDeformation => {
  const translateX = finite(input.position.x);
  const translateY = finite(input.position.y);
  const velocityX = finite(input.velocity.x);
  const velocityY = finite(input.velocity.y);
  const pressure = clamp(input.pressure, 0, 1);
  const pressurePoint = {
    x: clamp(input.pressurePoint.x, 0, 1),
    y: clamp(input.pressurePoint.y, 0, 1),
  };
  const speed = Math.min(1400, Math.hypot(velocityX, velocityY));
  const travel = Math.hypot(translateX, translateY);
  const directionalX = translateX + velocityX * .014;
  const directionalY = translateY + velocityY * .014;
  const directionalMagnitude = Math.hypot(directionalX, directionalY) || 1;
  const directionX = directionalX / directionalMagnitude;
  const directionY = directionalY / directionalMagnitude;
  const isFull = input.mode === 'full';
  const stretch = isFull
    ? clamp(travel / 520 + speed / 5200 + pressure * .018, 0, .12)
    : clamp(travel / 680 + speed / 7200, 0, .075);
  const baseScale = 1 + pressure * (isFull ? .026 : .014);
  const scaleX = baseScale
    + stretch * Math.abs(directionX)
    - stretch * .25 * Math.abs(directionY);
  const scaleY = baseScale
    + stretch * Math.abs(directionY)
    - stretch * .25 * Math.abs(directionX);
  const rotateZ = clamp((translateX + velocityX * .009) / 6, -7, 7);
  const tiltX = isFull
    ? clamp((.5 - pressurePoint.y) * pressure * 3.2 - velocityY / 900, -3.4, 3.4)
    : 0;
  const tiltY = isFull
    ? clamp((pressurePoint.x - .5) * pressure * 3.4 + velocityX / 900, -3.6, 3.6)
    : 0;

  return {
    translateX,
    translateY,
    scaleX,
    scaleY,
    rotateZ,
    tiltX,
    tiltY,
    stretch,
    speed,
    pressure,
    pressurePoint,
  };
};
