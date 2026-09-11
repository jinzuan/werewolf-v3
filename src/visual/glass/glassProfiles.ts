import type {
  GlassFilterMode,
  GlassGeometryBucket,
  GlassGeometryRequest,
  GlassInteractionStrength,
  GlassProfile,
  GlassQualityTier,
  GlassSurfaceRole,
} from './glassTypes';

export const GLASS_PROFILE_ROLES = [
  'navigation',
  'panel',
  'control',
  'field',
  'segmented',
  'item',
] as const satisfies readonly GlassSurfaceRole[];

const rimStops = [
  { offset: 0, color: 'rgba(102, 238, 255, 0.72)' },
  { offset: 0.52, color: 'rgba(132, 119, 255, 0.62)' },
  { offset: 1, color: 'rgba(255, 191, 125, 0.46)' },
] as const;

const raster = {
  widthBucketPx: 8,
  heightBucketPx: 8,
  radiusBucketPx: 2,
  dprBuckets: [1, 1.5, 2] as const,
  preferredLongEdgePx: 256,
  minimumShortEdgePx: 32,
  hardMaximumEdgePx: 512,
};

export const GLASS_PROFILES: Readonly<Record<GlassSurfaceRole, GlassProfile>> = {
  navigation: {
    role: 'navigation',
    defaultRadiusPx: 20,
    optics: {
      displacementPx: -15,
      chromaticOffsetPx: 0.75,
      refractionBandPx: 22,
      edgeCurve: 1.18,
      saturation: 1.26,
    },
    chromaticRim: {
      widthPx: 1.5,
      opacity: 0.12,
      activeOpacity: 0.2,
      blurPx: 0.55,
      angleDeg: 135,
      stops: rimStops,
    },
    raster: {
      ...raster,
      preferredLongEdgePx: 320,
      minimumShortEdgePx: 40,
    },
    quality: { basePriority: 800, defaultMaxQuality: 'refract-rgb' },
  },
  panel: {
    role: 'panel',
    defaultRadiusPx: 20,
    optics: {
      displacementPx: -18,
      chromaticOffsetPx: 0.9,
      refractionBandPx: 22,
      edgeCurve: 1.2,
      saturation: 1.28,
    },
    chromaticRim: {
      widthPx: 1.75,
      opacity: 0.13,
      activeOpacity: 0.21,
      blurPx: 0.6,
      angleDeg: 135,
      stops: rimStops,
    },
    raster: {
      ...raster,
      preferredLongEdgePx: 320,
      minimumShortEdgePx: 48,
    },
    quality: { basePriority: 700, defaultMaxQuality: 'refract-rgb' },
  },
  control: {
    role: 'control',
    defaultRadiusPx: 14,
    optics: {
      displacementPx: -26,
      chromaticOffsetPx: 1.2,
      refractionBandPx: 8,
      edgeCurve: 1.12,
      saturation: 1.32,
    },
    chromaticRim: {
      widthPx: 1.25,
      opacity: 0.14,
      activeOpacity: 0.24,
      blurPx: 0.45,
      angleDeg: 135,
      stops: rimStops,
    },
    raster,
    quality: { basePriority: 500, defaultMaxQuality: 'refract-rgb' },
  },
  field: {
    role: 'field',
    defaultRadiusPx: 14,
    optics: {
      displacementPx: -22,
      chromaticOffsetPx: 0.9,
      refractionBandPx: 7,
      edgeCurve: 1.14,
      saturation: 1.24,
    },
    chromaticRim: {
      widthPx: 1.1,
      opacity: 0.11,
      activeOpacity: 0.2,
      blurPx: 0.45,
      angleDeg: 135,
      stops: rimStops,
    },
    raster,
    quality: { basePriority: 550, defaultMaxQuality: 'refract-rgb' },
  },
  segmented: {
    role: 'segmented',
    defaultRadiusPx: 16,
    optics: {
      displacementPx: -24,
      chromaticOffsetPx: 1.1,
      refractionBandPx: 8,
      edgeCurve: 1.12,
      saturation: 1.3,
    },
    chromaticRim: {
      widthPx: 1.25,
      opacity: 0.12,
      activeOpacity: 0.23,
      blurPx: 0.45,
      angleDeg: 135,
      stops: rimStops,
    },
    raster,
    quality: { basePriority: 600, defaultMaxQuality: 'refract-rgb' },
  },
  item: {
    role: 'item',
    defaultRadiusPx: 12,
    optics: {
      displacementPx: -18,
      chromaticOffsetPx: 0.7,
      refractionBandPx: 6,
      edgeCurve: 1.16,
      saturation: 1.2,
    },
    chromaticRim: {
      widthPx: 1,
      opacity: 0.1,
      activeOpacity: 0.18,
      blurPx: 0.4,
      angleDeg: 135,
      stops: rimStops,
    },
    raster: {
      ...raster,
      preferredLongEdgePx: 192,
      minimumShortEdgePx: 24,
    },
    quality: { basePriority: 200, defaultMaxQuality: 'refract-single' },
  },
};

const strengthMultiplier: Readonly<Record<GlassInteractionStrength, number>> = {
  subtle: 0.82,
  normal: 1,
  active: 1.22,
};

const positiveFinite = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
};

const bucketUp = (value: number, step: number): number => Math.ceil(value / step) * step;

const nearestBucket = (value: number, buckets: readonly number[]): number => buckets.reduce(
  (nearest, candidate) => (
    Math.abs(candidate - value) < Math.abs(nearest - value) ? candidate : nearest
  ),
  buckets[0],
);

export const getGlassProfile = (role: GlassSurfaceRole): GlassProfile => GLASS_PROFILES[role];

export const filterModeForQuality = (quality: GlassQualityTier): GlassFilterMode => {
  if (quality === 'refract-rgb') return 'rgb';
  if (quality === 'refract-single') return 'single';
  return 'none';
};

export const displacementStrengthMultiplier = (
  strength: GlassInteractionStrength,
): number => strengthMultiplier[strength];

export const displacementMapSize = (
  width: number,
  height: number,
  preferredLongEdge: number,
  minimumShortEdge: number,
  hardMaximumEdge: number,
): { width: number; height: number } => {
  const longEdge = Math.max(1, width, height);
  const shortEdge = Math.max(1, Math.min(width, height));
  const preferredScale = Math.min(1, preferredLongEdge / longEdge);
  const shortEdgeScale = Math.min(1, minimumShortEdge / shortEdge);
  const hardCapScale = Math.min(1, hardMaximumEdge / longEdge);
  const scale = Math.min(hardCapScale, Math.max(preferredScale, shortEdgeScale));
  return {
    width: Math.max(8, Math.round(width * scale)),
    height: Math.max(8, Math.round(height * scale)),
  };
};

export const quantizeGlassGeometry = (request: GlassGeometryRequest): GlassGeometryBucket => {
  const profile = getGlassProfile(request.role);
  const rawWidth = positiveFinite(request.width, 'width');
  const rawHeight = positiveFinite(request.height, 'height');
  const rawDpr = positiveFinite(request.dpr ?? 1, 'dpr');
  const width = bucketUp(rawWidth, profile.raster.widthBucketPx);
  const height = bucketUp(rawHeight, profile.raster.heightBucketPx);
  const maximumRadius = Math.min(width, height) / 2;
  const radius = Math.min(
    maximumRadius,
    bucketUp(
      Math.max(0, request.radius ?? profile.defaultRadiusPx),
      profile.raster.radiusBucketPx,
    ),
  );
  const dpr = nearestBucket(rawDpr, profile.raster.dprBuckets);
  const strength = request.strength ?? 'normal';
  const sourceWidth = width * dpr;
  const sourceHeight = height * dpr;
  const mapSize = displacementMapSize(
    sourceWidth,
    sourceHeight,
    profile.raster.preferredLongEdgePx * dpr,
    profile.raster.minimumShortEdgePx * dpr,
    profile.raster.hardMaximumEdgePx,
  );
  const scale = Math.min(mapSize.width / width, mapSize.height / height);
  const mapRadius = radius * scale;
  const effectiveRefractionBand = Math.min(
    profile.optics.refractionBandPx,
    Math.min(width, height) / 2,
  );
  const mapRefractionBand = effectiveRefractionBand * scale;
  const key = [
    request.role,
    `${width}x${height}`,
    `r${radius}`,
    `d${dpr}`,
    `m${mapSize.width}x${mapSize.height}`,
    strength,
  ].join(':');

  return {
    role: request.role,
    width,
    height,
    radius,
    dpr,
    strength,
    mapWidth: mapSize.width,
    mapHeight: mapSize.height,
    mapRadius,
    mapRefractionBand,
    key,
  };
};
