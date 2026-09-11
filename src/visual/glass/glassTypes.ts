import type { VisualMode } from '../../runtime/visualPreferences';

export type GlassSurfaceRole =
  | 'navigation'
  | 'panel'
  | 'control'
  | 'field'
  | 'segmented'
  | 'item';

export type GlassQualityTier = 'refract-rgb' | 'refract-single' | 'blur' | 'solid';

export type GlassFilterMode = 'rgb' | 'single' | 'none';

export type GlassInteractionStrength = 'subtle' | 'normal' | 'active';

export type GlassDeviceClass = 'desktop' | 'mobile';

export interface GlassOpticalProfile {
  displacementPx: number;
  chromaticOffsetPx: number;
  refractionBandPx: number;
  edgeCurve: number;
  saturation: number;
}

export interface GlassChromaticRimProfile {
  widthPx: number;
  opacity: number;
  activeOpacity: number;
  blurPx: number;
  angleDeg: number;
  stops: readonly [
    { readonly offset: number; readonly color: string },
    { readonly offset: number; readonly color: string },
    { readonly offset: number; readonly color: string },
  ];
}

export interface GlassRasterProfile {
  widthBucketPx: number;
  heightBucketPx: number;
  radiusBucketPx: number;
  dprBuckets: readonly number[];
  preferredLongEdgePx: number;
  minimumShortEdgePx: number;
  hardMaximumEdgePx: number;
}

export interface GlassQualityProfile {
  basePriority: number;
  defaultMaxQuality: GlassQualityTier;
}

export interface GlassProfile {
  role: GlassSurfaceRole;
  defaultRadiusPx: number;
  optics: GlassOpticalProfile;
  chromaticRim: GlassChromaticRimProfile;
  raster: GlassRasterProfile;
  quality: GlassQualityProfile;
}

export interface GlassGeometryRequest {
  role: GlassSurfaceRole;
  width: number;
  height: number;
  radius?: number;
  dpr?: number;
  strength?: GlassInteractionStrength;
}

export interface GlassGeometryBucket {
  role: GlassSurfaceRole;
  width: number;
  height: number;
  radius: number;
  dpr: number;
  strength: GlassInteractionStrength;
  mapWidth: number;
  mapHeight: number;
  mapRadius: number;
  mapRefractionBand: number;
  key: string;
}

export interface GlassDisplacementFieldConfig {
  width: number;
  height: number;
  radius: number;
  refractionBand: number;
  edgeCurve?: number;
}

export interface GlassDisplacementSample {
  signedDistance: number;
  distanceToEdge: number;
  edgeStrength: number;
  normalX: number;
  normalY: number;
  red: number;
  blue: number;
  redByte: number;
  edgeByte: number;
  blueByte: number;
}

export interface GlassDisplacementRaster {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export interface GlassFilterChannelSpec {
  channel: 'R' | 'G' | 'B' | 'RGBA';
  scale: number;
  result: string;
}

export interface GlassFilterGraphSpec {
  id: string;
  mode: GlassFilterMode;
  mapUrl: string | null;
  width: number;
  height: number;
  colorInterpolationFilters: 'sRGB';
  neutralByteCorrection: number;
  edgeMaskChannel: 'G';
  cleanCenter: boolean;
  edgeOnly: boolean;
  channels: readonly GlassFilterChannelSpec[];
}

export interface GlassFilterGraphSpecInput {
  id: string;
  mode: GlassFilterMode;
  mapUrl: string | null;
  width: number;
  height: number;
  displacementPx: number;
  chromaticOffsetPx: number;
}

export interface GlassMapResource {
  url: string;
  byteSize: number;
}

export interface GlassFilterGraphMount {
  filterId: string;
  cssFilter: string;
}

export interface GlassFilterPoolEnvironment {
  now(): number;
  createMapResource(raster: GlassDisplacementRaster): Promise<GlassMapResource>;
  createFilterGraph(spec: GlassFilterGraphSpec): GlassFilterGraphMount;
  removeFilterGraph(graph: GlassFilterGraphMount): void;
  revokeMapResource(resource: GlassMapResource): void;
  dispose?(): void;
}

export interface GlassFilterAcquireRequest extends GlassGeometryRequest {
  quality: GlassQualityTier;
}

export interface GlassFilterResource {
  key: string;
  role: GlassSurfaceRole;
  quality: GlassQualityTier;
  mode: GlassFilterMode;
  filterId: string | null;
  cssFilter: string;
  mapUrl: string | null;
  byteEstimate: number;
  geometry: GlassGeometryBucket | null;
}

export interface GlassFilterLease {
  readonly resource: GlassFilterResource;
  readonly released: boolean;
  release(): void;
}

export interface GlassFilterPoolOptions {
  environment?: GlassFilterPoolEnvironment;
  maxBytes?: number;
  idPrefix?: string;
}

export interface GlassFilterPoolSnapshotEntry {
  key: string;
  refCount: number;
  byteEstimate: number;
  lastUsed: number;
  mode: GlassFilterMode;
}

export interface GlassFilterPoolSnapshot {
  entryCount: number;
  pendingEntries: number;
  referencedEntries: number;
  totalBytes: number;
  entries: GlassFilterPoolSnapshotEntry[];
}

export interface GlassQualityCapabilities {
  refractRgb: boolean;
  refractSingle: boolean;
  backdropBlur: boolean;
}

export interface GlassQualityBudgetLimits {
  staticRgbCount: number;
  interactiveRgbCount: number;
  rgbAreaRatio: number;
  maxSingleCount: number;
  refractedAreaRatio: number;
  blurAreaRatio: number;
}

export interface ResolvedGlassQualityBudget extends GlassQualityBudgetLimits {
  deviceClass: GlassDeviceClass;
  viewportArea: number;
  rgbArea: number;
  refractedArea: number;
  blurArea: number;
}

export interface GlassQualityCandidate {
  id: string;
  role: GlassSurfaceRole;
  visible: boolean;
  visibleArea: number;
  interacting?: boolean;
  modal?: boolean;
  current?: boolean;
  focused?: boolean;
  priority?: number;
  priorityBoost?: number;
  maxQuality?: GlassQualityTier;
}

export interface GlassQualityContext {
  deviceClass: GlassDeviceClass;
  viewportArea: number;
  capabilities: GlassQualityCapabilities;
  budget?: Partial<GlassQualityBudgetLimits>;
  /** The active visual tier. When omitted the legacy default budget applies,
   * which keeps pre-visualMode callers and allocation tests unchanged. */
  visualMode?: VisualMode;
  /** True while the runtime has detected degraded frame pacing. Budgets are
   * clamped back toward the strict legacy profile as a performance safety net. */
  degraded?: boolean;
}

export type GlassQualityReason =
  | 'offscreen'
  | 'rgb-budget'
  | 'single-budget'
  | 'blur-budget'
  | 'capability-fallback'
  | 'candidate-ceiling'
  | 'solid-fallback';

export interface GlassQualityAssignment {
  id: string;
  role: GlassSurfaceRole;
  quality: GlassQualityTier;
  reason: GlassQualityReason;
  priority: number;
  visibleArea: number;
}

export interface GlassQualityTotals {
  rgbCount: number;
  staticRgbCount: number;
  interactiveRgbCount: number;
  singleCount: number;
  blurCount: number;
  solidCount: number;
  rgbArea: number;
  refractedArea: number;
  blurArea: number;
}

export interface GlassQualityAllocation {
  assignments: GlassQualityAssignment[];
  totals: GlassQualityTotals;
  budget: ResolvedGlassQualityBudget;
}

export interface GlassQualityControllerOptions {
  deviceClass: GlassDeviceClass;
  capabilities: GlassQualityCapabilities;
  budget?: Partial<GlassQualityBudgetLimits>;
  visualMode?: VisualMode;
  degraded?: boolean;
}
