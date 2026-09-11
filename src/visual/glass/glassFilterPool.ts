import {
  displacementStrengthMultiplier,
  filterModeForQuality,
  getGlassProfile,
  quantizeGlassGeometry,
} from './glassProfiles';
import type {
  GlassDisplacementFieldConfig,
  GlassDisplacementRaster,
  GlassDisplacementSample,
  GlassFilterAcquireRequest,
  GlassFilterChannelSpec,
  GlassFilterGraphMount,
  GlassFilterGraphSpec,
  GlassFilterGraphSpecInput,
  GlassFilterLease,
  GlassFilterMode,
  GlassFilterPoolEnvironment,
  GlassFilterPoolOptions,
  GlassFilterPoolSnapshot,
  GlassFilterResource,
  GlassGeometryBucket,
  GlassMapResource,
} from './glassTypes';

export const NEUTRAL_DISPLACEMENT_CHANNEL = 128;

const SVG_NS = 'http://www.w3.org/2000/svg';
const BYTE_NEUTRAL_CORRECTION = -1 / 510;
const DEFAULT_POOL_BYTES = 8 * 1024 * 1024;

const clamp = (value: number, minimum = 0, maximum = 1): number => (
  Math.min(maximum, Math.max(minimum, value))
);

const smoothstep = (value: number): number => {
  const clamped = clamp(value);
  return clamped * clamped * (3 - (2 * clamped));
};

const toFieldByte = (value: number, neutral: boolean): number => (
  neutral ? NEUTRAL_DISPLACEMENT_CHANNEL : Math.round(clamp(value) * 255)
);

interface RoundedRectDistance {
  signedDistance: number;
  normalX: number;
  normalY: number;
}

const roundedRectDistance = (
  config: GlassDisplacementFieldConfig,
  x: number,
  y: number,
): RoundedRectDistance => {
  const halfWidth = config.width / 2;
  const halfHeight = config.height / 2;
  const radius = clamp(config.radius, 0, Math.min(halfWidth, halfHeight));
  const localX = x - halfWidth;
  const localY = y - halfHeight;
  const signX = localX < 0 ? -1 : 1;
  const signY = localY < 0 ? -1 : 1;
  const qx = Math.abs(localX) - (halfWidth - radius);
  const qy = Math.abs(localY) - (halfHeight - radius);
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const outsideLength = Math.hypot(outsideX, outsideY);
  const signedDistance = outsideLength + Math.min(Math.max(qx, qy), 0) - radius;

  if (outsideLength > Number.EPSILON) {
    return {
      signedDistance,
      normalX: signX * (outsideX / outsideLength),
      normalY: signY * (outsideY / outsideLength),
    };
  }

  if (qx > qy) {
    return { signedDistance, normalX: signX, normalY: 0 };
  }
  if (qy > qx) {
    return { signedDistance, normalX: 0, normalY: signY };
  }
  const diagonal = Math.SQRT1_2;
  return {
    signedDistance,
    normalX: signX * diagonal,
    normalY: signY * diagonal,
  };
};

/**
 * Samples a rounded-rectangle edge-normal field. R stores horizontal normal,
 * B stores vertical normal, and G stores the independent edge mask. The safe
 * centre is represented as exact mathematical 0.5 and the canonical byte 128.
 */
export const sampleRoundedRectDisplacement = (
  config: GlassDisplacementFieldConfig,
  x: number,
  y: number,
): GlassDisplacementSample => {
  const edgeWidth = Math.max(
    Number.EPSILON,
    Math.min(config.refractionBand, Math.min(config.width, config.height) / 2),
  );
  const curve = Math.max(Number.EPSILON, config.edgeCurve ?? 1);
  const distance = roundedRectDistance(config, x, y);
  const distanceToEdge = Math.max(0, -distance.signedDistance);
  const edgeProgress = clamp(1 - (distanceToEdge / edgeWidth));
  const edgeStrength = edgeProgress <= 0
    ? 0
    : Math.pow(smoothstep(edgeProgress), curve);
  const neutral = edgeStrength === 0;
  const red = neutral ? 0.5 : clamp(0.5 + (distance.normalX * edgeStrength * 0.5));
  const blue = neutral ? 0.5 : clamp(0.5 + (distance.normalY * edgeStrength * 0.5));

  return {
    signedDistance: distance.signedDistance,
    distanceToEdge,
    edgeStrength,
    normalX: distance.normalX,
    normalY: distance.normalY,
    red,
    blue,
    redByte: toFieldByte(red, neutral),
    edgeByte: Math.round(edgeStrength * 255),
    blueByte: toFieldByte(blue, neutral),
  };
};

export const createRoundedRectDisplacementRaster = (
  config: GlassDisplacementFieldConfig,
): GlassDisplacementRaster => {
  const width = Math.max(1, Math.round(config.width));
  const height = Math.max(1, Math.round(config.height));
  const normalizedConfig = { ...config, width, height };
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let row = 0; row < height; row += 1) {
    const y = height === 1 ? height / 2 : (row / (height - 1)) * height;
    for (let column = 0; column < width; column += 1) {
      const x = width === 1 ? width / 2 : (column / (width - 1)) * width;
      const sample = sampleRoundedRectDisplacement(normalizedConfig, x, y);
      const offset = ((row * width) + column) * 4;
      pixels[offset] = sample.redByte;
      pixels[offset + 1] = sample.edgeByte;
      pixels[offset + 2] = sample.blueByte;
      pixels[offset + 3] = 255;
    }
  }

  return { width, height, pixels };
};

export const createGlassFilterGraphSpec = (
  input: GlassFilterGraphSpecInput,
): GlassFilterGraphSpec => {
  let channels: readonly GlassFilterChannelSpec[] = [];
  if (input.mode === 'rgb') {
    channels = [
      { channel: 'R', scale: input.displacementPx - input.chromaticOffsetPx, result: 'glass-channel-r' },
      { channel: 'G', scale: input.displacementPx, result: 'glass-channel-g' },
      { channel: 'B', scale: input.displacementPx + input.chromaticOffsetPx, result: 'glass-channel-b' },
    ];
  } else if (input.mode === 'single') {
    channels = [
      { channel: 'RGBA', scale: input.displacementPx, result: 'glass-channel-single' },
    ];
  }

  return {
    id: input.id,
    mode: input.mode,
    mapUrl: input.mapUrl,
    width: input.width,
    height: input.height,
    colorInterpolationFilters: 'sRGB',
    neutralByteCorrection: BYTE_NEUTRAL_CORRECTION,
    edgeMaskChannel: 'G',
    cleanCenter: input.mode !== 'none',
    edgeOnly: input.mode !== 'none',
    channels,
  };
};

const createSvgElement = <Tag extends keyof SVGElementTagNameMap>(
  documentRef: Document,
  tag: Tag,
): SVGElementTagNameMap[Tag] => documentRef.createElementNS(SVG_NS, tag);

const channelMatrix = (channel: 'R' | 'G' | 'B'): string => {
  if (channel === 'R') return '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0';
  if (channel === 'G') return '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0';
  return '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0';
};

const appendDisplacedChannel = (
  documentRef: Document,
  filter: SVGFilterElement,
  channel: GlassFilterChannelSpec,
): string => {
  const displacedResult = `${channel.result}-displaced`;
  const displaced = createSvgElement(documentRef, 'feDisplacementMap');
  displaced.setAttribute('in', 'SourceGraphic');
  displaced.setAttribute('in2', 'glass-map');
  displaced.setAttribute('scale', String(channel.scale));
  displaced.setAttribute('xChannelSelector', 'R');
  displaced.setAttribute('yChannelSelector', 'B');
  displaced.setAttribute('result', displacedResult);
  filter.append(displaced);

  if (channel.channel === 'RGBA') return displacedResult;
  const isolated = createSvgElement(documentRef, 'feColorMatrix');
  isolated.setAttribute('in', displacedResult);
  isolated.setAttribute('type', 'matrix');
  isolated.setAttribute('values', channelMatrix(channel.channel));
  isolated.setAttribute('result', channel.result);
  filter.append(isolated);
  return channel.result;
};

const mountGraphElement = (
  documentRef: Document,
  defs: SVGDefsElement,
  spec: GlassFilterGraphSpec,
): SVGFilterElement => {
  const filter = createSvgElement(documentRef, 'filter');
  filter.id = spec.id;
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', '100%');
  filter.setAttribute('height', '100%');
  filter.setAttribute('filterUnits', 'objectBoundingBox');
  filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
  filter.setAttribute('color-interpolation-filters', spec.colorInterpolationFilters);

  if (spec.mode === 'none' || !spec.mapUrl) {
    const passthrough = createSvgElement(documentRef, 'feComposite');
    passthrough.setAttribute('in', 'SourceGraphic');
    passthrough.setAttribute('operator', 'over');
    passthrough.setAttribute('result', 'glass-output');
    filter.append(passthrough);
    defs.append(filter);
    return filter;
  }

  const image = createSvgElement(documentRef, 'feImage');
  image.setAttribute('href', spec.mapUrl);
  image.setAttribute('x', '0');
  image.setAttribute('y', '0');
  // A graph is shared by every element in the same geometry bucket. Stretch
  // the low-frequency field to each consumer's own filter region instead of
  // pinning it to the bucket's upper-bound CSS size.
  image.setAttribute('width', '100%');
  image.setAttribute('height', '100%');
  image.setAttribute('preserveAspectRatio', 'none');
  image.setAttribute('result', 'glass-map-encoded');
  filter.append(image);

  // Canvas stores the neutral byte as 128 (128/255). Correct that tiny bias
  // before feDisplacementMap so the safe centre evaluates to exactly 0.5.
  const neutralize = createSvgElement(documentRef, 'feComponentTransfer');
  neutralize.setAttribute('in', 'glass-map-encoded');
  neutralize.setAttribute('result', 'glass-map');
  const red = createSvgElement(documentRef, 'feFuncR');
  red.setAttribute('type', 'linear');
  red.setAttribute('slope', '1');
  red.setAttribute('intercept', String(spec.neutralByteCorrection));
  const blue = createSvgElement(documentRef, 'feFuncB');
  blue.setAttribute('type', 'linear');
  blue.setAttribute('slope', '1');
  blue.setAttribute('intercept', String(spec.neutralByteCorrection));
  neutralize.append(red, blue);
  filter.append(neutralize);

  const edgeMask = createSvgElement(documentRef, 'feColorMatrix');
  edgeMask.setAttribute('in', 'glass-map');
  edgeMask.setAttribute('type', 'matrix');
  edgeMask.setAttribute(
    'values',
    '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 1 0 0 0',
  );
  edgeMask.setAttribute('result', 'glass-edge-mask');
  filter.append(edgeMask);

  const cleanCentre = createSvgElement(documentRef, 'feComposite');
  cleanCentre.setAttribute('in', 'SourceGraphic');
  cleanCentre.setAttribute('in2', 'glass-edge-mask');
  cleanCentre.setAttribute('operator', 'out');
  cleanCentre.setAttribute('result', 'glass-clean-center');
  filter.append(cleanCentre);

  const channelResults = spec.channels.map((channel) => (
    appendDisplacedChannel(documentRef, filter, channel)
  ));
  let displacedResult = channelResults[0];
  for (let index = 1; index < channelResults.length; index += 1) {
    const blend = createSvgElement(documentRef, 'feBlend');
    blend.setAttribute('in', displacedResult);
    blend.setAttribute('in2', channelResults[index]);
    blend.setAttribute('mode', 'screen');
    displacedResult = `glass-channel-blend-${index}`;
    blend.setAttribute('result', displacedResult);
    filter.append(blend);
  }

  const edgeOnly = createSvgElement(documentRef, 'feComposite');
  edgeOnly.setAttribute('in', displacedResult);
  edgeOnly.setAttribute('in2', 'glass-edge-mask');
  edgeOnly.setAttribute('operator', 'in');
  edgeOnly.setAttribute('result', 'glass-edge-only');
  filter.append(edgeOnly);

  const output = createSvgElement(documentRef, 'feComposite');
  output.setAttribute('in', 'glass-edge-only');
  output.setAttribute('in2', 'glass-clean-center');
  // Both inputs are already complementary premultiplied masks. Arithmetic
  // addition preserves full alpha through the transition; source-over would
  // attenuate the midpoint twice and create a dark seam.
  output.setAttribute('operator', 'arithmetic');
  output.setAttribute('k1', '0');
  output.setAttribute('k2', '1');
  output.setAttribute('k3', '1');
  output.setAttribute('k4', '0');
  output.setAttribute('result', 'glass-output');
  filter.append(output);
  defs.append(filter);
  return filter;
};

export interface BrowserGlassFilterEnvironmentOptions {
  document?: Document;
  url?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  now?: () => number;
}

/** Browser environment used by the runtime. Encoding is asynchronous and
 * deliberately has no synchronous data-URL path. */
export const createBrowserGlassFilterEnvironment = (
  options: BrowserGlassFilterEnvironmentOptions = {},
): GlassFilterPoolEnvironment => {
  const documentRef = options.document ?? globalThis.document;
  const urlRef = options.url ?? globalThis.URL;
  if (!documentRef || !urlRef?.createObjectURL || !urlRef.revokeObjectURL) {
    throw new Error('A browser document and object URL implementation are required');
  }

  let root: SVGSVGElement | null = null;
  let defs: SVGDefsElement | null = null;
  const graphs = new Map<string, SVGFilterElement>();
  const ensureDefs = (): SVGDefsElement => {
    if (defs) return defs;
    root = createSvgElement(documentRef, 'svg');
    root.classList.add('v3-liquid-glass-defs');
    root.setAttribute('width', '0');
    root.setAttribute('height', '0');
    root.setAttribute('aria-hidden', 'true');
    root.style.position = 'absolute';
    root.style.width = '0';
    root.style.height = '0';
    root.style.overflow = 'hidden';
    root.style.pointerEvents = 'none';
    defs = createSvgElement(documentRef, 'defs');
    root.append(defs);
    (documentRef.body ?? documentRef.documentElement).prepend(root);
    return defs;
  };

  return {
    now: options.now ?? (() => globalThis.performance?.now() ?? Date.now()),
    createMapResource: async (raster) => {
      const canvas = documentRef.createElement('canvas');
      canvas.width = raster.width;
      canvas.height = raster.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Unable to create a 2D canvas context');
      const image = context.createImageData(raster.width, raster.height);
      image.data.set(raster.pixels);
      context.putImageData(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error('Unable to encode the displacement field'));
        }, 'image/png');
      });
      return {
        url: urlRef.createObjectURL(blob),
        // Budget for the decoded RGBA surface, not only the compressed PNG.
        byteSize: Math.max(blob.size, raster.pixels.byteLength),
      };
    },
    createFilterGraph: (spec) => {
      const element = mountGraphElement(documentRef, ensureDefs(), spec);
      graphs.set(spec.id, element);
      return { filterId: spec.id, cssFilter: `url(#${spec.id})` };
    },
    removeFilterGraph: (graph) => {
      graphs.get(graph.filterId)?.remove();
      graphs.delete(graph.filterId);
    },
    revokeMapResource: (resource) => { urlRef.revokeObjectURL(resource.url); },
    dispose: () => {
      graphs.clear();
      root?.remove();
      root = null;
      defs = null;
    },
  };
};

interface GlassFilterCacheEntry {
  key: string;
  mode: Exclude<GlassFilterMode, 'none'>;
  geometry: GlassGeometryBucket;
  refCount: number;
  lastUsed: number;
  byteEstimate: number;
  cancelled: boolean;
  resource: GlassFilterResource | null;
  mapResource: GlassMapResource | null;
  graph: GlassFilterGraphMount | null;
  pending: Promise<GlassFilterResource>;
}

const noFilterResource = (request: GlassFilterAcquireRequest): GlassFilterResource => ({
  key: `none:${request.quality}:${request.role}`,
  role: request.role,
  quality: request.quality,
  mode: 'none',
  filterId: null,
  cssFilter: 'none',
  mapUrl: null,
  byteEstimate: 0,
  geometry: null,
});

export class GlassFilterPool {
  private readonly environment: GlassFilterPoolEnvironment;

  private readonly maxBytes: number;

  private readonly idPrefix: string;

  private readonly entries = new Map<string, GlassFilterCacheEntry>();

  private totalBytes = 0;

  private nextId = 0;

  private disposed = false;

  constructor(options: GlassFilterPoolOptions = {}) {
    this.environment = options.environment ?? createBrowserGlassFilterEnvironment();
    this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_POOL_BYTES);
    this.idPrefix = options.idPrefix ?? 'ww-glass-filter';
  }

  async acquire(request: GlassFilterAcquireRequest): Promise<GlassFilterLease> {
    if (this.disposed) throw new Error('GlassFilterPool has been disposed');
    const mode = filterModeForQuality(request.quality);
    if (mode === 'none') return this.createNoopLease(noFilterResource(request));

    const geometry = quantizeGlassGeometry(request);
    const key = `${geometry.key}:${mode}`;
    let entry = this.entries.get(key);
    const now = this.environment.now();
    if (!entry) {
      const newEntry = {
        key,
        mode,
        geometry,
        refCount: 0,
        lastUsed: now,
        byteEstimate: 0,
        cancelled: false,
        resource: null,
        mapResource: null,
        graph: null,
        pending: Promise.resolve(null as unknown as GlassFilterResource),
      } satisfies GlassFilterCacheEntry;
      newEntry.pending = this.materialize(newEntry, request);
      entry = newEntry;
      this.entries.set(key, entry);
    } else {
      entry.lastUsed = now;
    }
    entry.refCount += 1;

    try {
      const resource = await entry.pending;
      if (this.disposed || entry.cancelled) throw new Error('GlassFilterPool has been disposed');
      return this.createEntryLease(entry, resource);
    } catch (error) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount === 0 && this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  release(lease: GlassFilterLease): void {
    lease.release();
  }

  snapshot(): GlassFilterPoolSnapshot {
    const entries = [...this.entries.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => ({
        key: entry.key,
        refCount: entry.refCount,
        byteEstimate: entry.byteEstimate,
        lastUsed: entry.lastUsed,
        mode: entry.mode,
      }));
    return {
      entryCount: entries.length,
      pendingEntries: [...this.entries.values()].filter((entry) => !entry.resource).length,
      referencedEntries: entries.filter((entry) => entry.refCount > 0).length,
      totalBytes: this.totalBytes,
      entries,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.cancelled = true;
      if (entry.resource) this.destroyEntry(entry);
    }
    this.entries.clear();
    this.totalBytes = 0;
    this.environment.dispose?.();
  }

  private async materialize(
    entry: GlassFilterCacheEntry,
    request: GlassFilterAcquireRequest,
  ): Promise<GlassFilterResource> {
    const profile = getGlassProfile(request.role);
    const raster = createRoundedRectDisplacementRaster({
      width: entry.geometry.mapWidth,
      height: entry.geometry.mapHeight,
      radius: entry.geometry.mapRadius,
      refractionBand: entry.geometry.mapRefractionBand,
      edgeCurve: profile.optics.edgeCurve,
    });
    const mapResource = await this.environment.createMapResource(raster);
    if (this.disposed || entry.cancelled) {
      this.safeRevokeMap(mapResource);
      throw new Error('GlassFilterPool was disposed while creating a map');
    }

    const strength = displacementStrengthMultiplier(entry.geometry.strength);
    const filterId = `${this.idPrefix}-${this.nextId += 1}`;
    const spec = createGlassFilterGraphSpec({
      id: filterId,
      mode: entry.mode,
      mapUrl: mapResource.url,
      width: entry.geometry.width,
      height: entry.geometry.height,
      displacementPx: profile.optics.displacementPx * strength,
      chromaticOffsetPx: profile.optics.chromaticOffsetPx * strength,
    });
    let graph: GlassFilterGraphMount;
    try {
      graph = this.environment.createFilterGraph(spec);
    } catch (error) {
      this.safeRevokeMap(mapResource);
      throw error;
    }
    if (this.disposed || entry.cancelled) {
      this.safeRemoveGraph(graph);
      this.safeRevokeMap(mapResource);
      throw new Error('GlassFilterPool was disposed while creating a filter graph');
    }

    const resource: GlassFilterResource = {
      key: entry.key,
      role: request.role,
      quality: request.quality,
      mode: entry.mode,
      filterId: graph.filterId,
      cssFilter: graph.cssFilter,
      mapUrl: mapResource.url,
      byteEstimate: mapResource.byteSize,
      geometry: entry.geometry,
    };
    entry.mapResource = mapResource;
    entry.graph = graph;
    entry.resource = resource;
    entry.byteEstimate = mapResource.byteSize;
    this.totalBytes += mapResource.byteSize;
    this.evictToBudget();
    return resource;
  }

  private createNoopLease(resource: GlassFilterResource): GlassFilterLease {
    let released = false;
    return {
      resource,
      get released() { return released; },
      release: () => { released = true; },
    };
  }

  private createEntryLease(
    entry: GlassFilterCacheEntry,
    resource: GlassFilterResource,
  ): GlassFilterLease {
    let released = false;
    return {
      resource,
      get released() { return released; },
      release: () => {
        if (released) return;
        released = true;
        if (entry.refCount > 0) entry.refCount -= 1;
        entry.lastUsed = this.environment.now();
        this.evictToBudget();
      },
    };
  }

  private evictToBudget(): void {
    if (this.totalBytes <= this.maxBytes) return;
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.refCount === 0 && entry.resource)
      .sort((left, right) => left.lastUsed - right.lastUsed || left.key.localeCompare(right.key));
    for (const entry of candidates) {
      if (this.totalBytes <= this.maxBytes) break;
      this.destroyEntry(entry);
      this.entries.delete(entry.key);
    }
  }

  private destroyEntry(entry: GlassFilterCacheEntry): void {
    if (!entry.resource) return;
    // The graph must stop referencing feImage before its object URL is revoked.
    if (entry.graph) this.safeRemoveGraph(entry.graph);
    if (entry.mapResource) this.safeRevokeMap(entry.mapResource);
    this.totalBytes = Math.max(0, this.totalBytes - entry.byteEstimate);
    entry.graph = null;
    entry.mapResource = null;
    entry.resource = null;
    entry.byteEstimate = 0;
  }

  private safeRemoveGraph(graph: GlassFilterGraphMount): void {
    try {
      this.environment.removeFilterGraph(graph);
    } catch {
      // Cleanup is best-effort; a detached SVG root is already non-rendering.
    }
  }

  private safeRevokeMap(resource: GlassMapResource): void {
    try {
      this.environment.revokeMapResource(resource);
    } catch {
      // Object URL cleanup must not break application teardown.
    }
  }
}
