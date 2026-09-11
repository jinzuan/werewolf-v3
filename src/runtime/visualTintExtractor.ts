/** Maximum decoded edge length. A 48x48 sample is enough for tint selection
 * while keeping canvas reads and clustering bounded to 2,304 pixels. */
export const MAX_VISUAL_TINT_SAMPLE_EDGE = 48;

export interface VisualTintPixelData {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface VisualTintBitmap {
  width: number;
  height: number;
  close?: () => void;
}

export interface VisualTintCanvasContext {
  drawImage: (image: VisualTintBitmap, dx: number, dy: number, width: number, height: number) => void;
  getImageData: (sx: number, sy: number, width: number, height: number) => VisualTintPixelData;
}

export interface VisualTintCanvas {
  getContext: (
    contextId: '2d',
    options?: { willReadFrequently?: boolean },
  ) => VisualTintCanvasContext | null;
}

export interface VisualTintFetchResponse {
  ok: boolean;
  status?: number;
  blob: () => Promise<Blob>;
}

/** Browser facilities are injectable so the color algorithm remains directly
 * testable in Node and callers can provide platform-specific decoders. */
export interface VisualTintDecodeEnvironment {
  baseUrl?: string;
  signal?: AbortSignal;
  fetch?: (url: string, init?: RequestInit) => Promise<VisualTintFetchResponse>;
  createImageBitmap?: (blob: Blob, options?: ImageBitmapOptions) => Promise<VisualTintBitmap>;
  createCanvas?: (width: number, height: number) => VisualTintCanvas;
}

export type VisualTintSource = Blob | string | VisualTintPixelData;
export type VisualTintDecoder = (
  source: Blob | string,
  environment: VisualTintDecodeEnvironment,
) => Promise<VisualTintPixelData>;

export interface ExtractVisualTintOptions {
  /** Cache identity is deliberately caller-owned. Omit it to disable caching. */
  cacheKey?: string;
  environment?: VisualTintDecodeEnvironment;
  decode?: VisualTintDecoder;
}

interface ColorCluster {
  weight: number;
  red: number;
  green: number;
  blue: number;
}

const tintCache = new Map<string, Promise<string | null>>();
const MAX_VISUAL_TINT_CACHE_ENTRIES = 24;

function isPixelData(source: VisualTintSource): source is VisualTintPixelData {
  return typeof source === 'object'
    && source !== null
    && !(source instanceof Blob)
    && 'width' in source
    && 'height' in source
    && 'data' in source;
}

function assertPixelData(pixels: VisualTintPixelData): void {
  if (!Number.isInteger(pixels.width) || !Number.isInteger(pixels.height)
    || pixels.width <= 0 || pixels.height <= 0) {
    throw new TypeError('Visual tint pixel dimensions must be positive integers.');
  }
  if (pixels.data.length < pixels.width * pixels.height * 4) {
    throw new TypeError('Visual tint pixel buffer is smaller than its declared dimensions.');
  }
}

/** Nearest-neighbour sampling is intentional: averaging before quantization can
 * create colors that were not present in the image and weakens small dark areas. */
function downsamplePixels(pixels: VisualTintPixelData): VisualTintPixelData {
  assertPixelData(pixels);
  const scale = Math.min(
    1,
    MAX_VISUAL_TINT_SAMPLE_EDGE / Math.max(pixels.width, pixels.height),
  );
  const width = Math.max(1, Math.round(pixels.width * scale));
  const height = Math.max(1, Math.round(pixels.height * scale));
  if (width === pixels.width && height === pixels.height) return pixels;

  const sampled = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(pixels.height - 1, Math.floor((y + 0.5) * pixels.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(pixels.width - 1, Math.floor((x + 0.5) * pixels.width / width));
      const sourceOffset = (sourceY * pixels.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      sampled[targetOffset] = Number(pixels.data[sourceOffset]);
      sampled[targetOffset + 1] = Number(pixels.data[sourceOffset + 1]);
      sampled[targetOffset + 2] = Number(pixels.data[sourceOffset + 2]);
      sampled[targetOffset + 3] = Number(pixels.data[sourceOffset + 3]);
    }
  }
  return { width, height, data: sampled };
}

function colorMetrics(red: number, green: number, blue: number): {
  lightness: number;
  saturation: number;
  luminance: number;
} {
  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  const maximum = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
  const minimum = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
  const lightness = (maximum + minimum) / 2;
  const spread = maximum - minimum;
  const saturation = spread === 0
    ? 0
    : spread / (1 - Math.abs(2 * lightness - 1));

  // Perceptual luminance is used only to rank viable dominant colors.
  const linearize = (channel: number): number => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * linearize(normalizedRed)
    + 0.7152 * linearize(normalizedGreen)
    + 0.0722 * linearize(normalizedBlue);
  return { lightness, saturation, luminance };
}

function toHex(red: number, green: number, blue: number): string {
  const channel = (value: number): string => Math.round(value)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** Extracts a stable deep tint from RGBA pixels without allocating per pixel.
 * Transparent, near-black/white, and near-grey noise is discarded first. */
export function extractVisualTintFromPixels(input: VisualTintPixelData): string | null {
  const pixels = downsamplePixels(input);
  const clusters = new Map<number, ColorCluster>();

  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    const red = Number(pixels.data[offset]);
    const green = Number(pixels.data[offset + 1]);
    const blue = Number(pixels.data[offset + 2]);
    const alpha = Number(pixels.data[offset + 3]);
    if (alpha < 64) continue;

    const { lightness, saturation } = colorMetrics(red, green, blue);
    if (lightness <= 0.09 || lightness >= 0.94 || saturation < 0.16) continue;

    // Four bits per channel groups photographic gradients without losing the
    // broad hue families needed for interface tinting.
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    const weight = alpha / 255;
    const cluster = clusters.get(key) ?? { weight: 0, red: 0, green: 0, blue: 0 };
    cluster.weight += weight;
    cluster.red += red * weight;
    cluster.green += green * weight;
    cluster.blue += blue * weight;
    clusters.set(key, cluster);
  }

  const ranked = [...clusters.values()].sort((left, right) => right.weight - left.weight);
  if (ranked.length === 0) return null;

  // A dark accent must represent at least a quarter of the largest cluster;
  // otherwise tiny objects or compression artifacts could tint the whole UI.
  const dominantThreshold = ranked[0].weight * 0.25;
  const dominant = ranked.slice(0, 8).filter((cluster) => cluster.weight >= dominantThreshold);
  const measured = dominant.map((cluster) => {
    const red = cluster.red / cluster.weight;
    const green = cluster.green / cluster.weight;
    const blue = cluster.blue / cluster.weight;
    return { cluster, ...colorMetrics(red, green, blue) };
  });
  // Prefer a visibly chromatic dominant family. The luminance term still
  // keeps the result deep, while saturation prevents grey-green averages.
  const colorful = measured.filter((entry) => entry.saturation >= .2);
  const pool = colorful.length > 0 ? colorful : measured;
  const selected = pool.sort((left, right) => {
    const leftScore = left.luminance - left.saturation * .16;
    const rightScore = right.luminance - right.saturation * .16;
    return leftScore - rightScore || right.cluster.weight - left.cluster.weight;
  })[0].cluster;

  return toHex(
    selected.red / selected.weight,
    selected.green / selected.weight,
    selected.blue / selected.weight,
  );
}

function createDefaultCanvas(width: number, height: number): VisualTintCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height) as unknown as VisualTintCanvas;
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as VisualTintCanvas;
  }
  throw new Error('No canvas implementation is available for visual tint extraction.');
}

function defaultEnvironment(overrides: VisualTintDecodeEnvironment = {}): VisualTintDecodeEnvironment {
  const browserLocation = typeof location !== 'undefined' ? location.href : undefined;
  return {
    baseUrl: overrides.baseUrl ?? browserLocation,
    fetch: overrides.fetch ?? (typeof fetch === 'function'
      ? (url, init) => fetch(url, init) as Promise<VisualTintFetchResponse>
      : undefined),
    createImageBitmap: overrides.createImageBitmap ?? (typeof createImageBitmap === 'function'
      ? (blob, options) => createImageBitmap(blob, options)
      : undefined),
    createCanvas: overrides.createCanvas ?? createDefaultCanvas,
    signal: overrides.signal,
  };
}

function resolveSameOriginUrl(source: string, baseUrl?: string): string {
  if (!baseUrl) {
    throw new Error('A base URL is required to validate a visual tint URL as same-origin.');
  }
  const base = new URL(baseUrl);
  const resolved = new URL(source, base);
  if (resolved.origin !== base.origin) {
    throw new Error('Visual tint extraction only accepts same-origin URLs.');
  }
  return resolved.href;
}

async function defaultDecode(
  source: Blob | string,
  environment: VisualTintDecodeEnvironment,
): Promise<VisualTintPixelData> {
  let blob: Blob;
  if (typeof source === 'string') {
    if (!environment.fetch) throw new Error('Fetch is unavailable for visual tint URL decoding.');
    const response = await environment.fetch(source, {
      credentials: 'same-origin',
      signal: environment.signal,
    });
    if (!response.ok) {
      throw new Error(`Visual tint background request failed (${response.status ?? 'unknown'}).`);
    }
    blob = await response.blob();
  } else {
    blob = source;
  }

  if (environment.signal?.aborted) throw new DOMException('Tint extraction aborted.', 'AbortError');

  if (!environment.createImageBitmap) {
    throw new Error('createImageBitmap is unavailable for visual tint extraction.');
  }
  if (!environment.createCanvas) {
    throw new Error('Canvas creation is unavailable for visual tint extraction.');
  }

  // Requesting the final tiny bitmap lets capable browsers avoid materializing
  // a full-resolution RGBA surface, which is the largest potential cost here.
  const bitmap = await environment.createImageBitmap(blob, {
    resizeWidth: MAX_VISUAL_TINT_SAMPLE_EDGE,
    resizeHeight: MAX_VISUAL_TINT_SAMPLE_EDGE,
    resizeQuality: 'low',
  });
  try {
    const canvas = environment.createCanvas(
      MAX_VISUAL_TINT_SAMPLE_EDGE,
      MAX_VISUAL_TINT_SAMPLE_EDGE,
    );
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('A 2D canvas context is unavailable for visual tint extraction.');
    context.drawImage(
      bitmap,
      0,
      0,
      MAX_VISUAL_TINT_SAMPLE_EDGE,
      MAX_VISUAL_TINT_SAMPLE_EDGE,
    );
    return context.getImageData(
      0,
      0,
      MAX_VISUAL_TINT_SAMPLE_EDGE,
      MAX_VISUAL_TINT_SAMPLE_EDGE,
    );
  } finally {
    bitmap.close?.();
  }
}

async function extractUncached(
  source: VisualTintSource,
  options: ExtractVisualTintOptions,
): Promise<string | null> {
  if (isPixelData(source)) return extractVisualTintFromPixels(source);

  const environment = defaultEnvironment(options.environment);
  const normalizedSource = typeof source === 'string'
    ? resolveSameOriginUrl(source, environment.baseUrl)
    : source;
  const decoded = await (options.decode ?? defaultDecode)(normalizedSource, environment);
  return extractVisualTintFromPixels(decoded);
}

/** Reads a local Blob, a same-origin URL, or injected pixels. No cache exists
 * unless cacheKey is supplied; callers should include the background revision. */
export function extractVisualTint(
  source: VisualTintSource,
  options: ExtractVisualTintOptions = {},
): Promise<string | null> {
  const cacheKey = options.cacheKey?.trim();
  if (!cacheKey) return extractUncached(source, options);

  const cached = tintCache.get(cacheKey);
  if (cached) return cached;

  const extraction = extractUncached(source, options).catch((error: unknown) => {
    // Failed decodes may be transient (for example a Blob URL was replaced),
    // so never pin failures in the process-local cache. Do not delete a newer
    // extraction if the caller invalidated and reused this key meanwhile.
    if (tintCache.get(cacheKey) === extraction) tintCache.delete(cacheKey);
    throw error;
  });
  tintCache.set(cacheKey, extraction);
  while (tintCache.size > MAX_VISUAL_TINT_CACHE_ENTRIES) {
    const oldestKey = tintCache.keys().next().value as string | undefined;
    if (!oldestKey || oldestKey === cacheKey) break;
    tintCache.delete(oldestKey);
  }
  return extraction;
}

/** Allows explicit invalidation when a local background revision is replaced. */
export function clearVisualTintCache(cacheKey?: string): void {
  if (cacheKey === undefined) {
    tintCache.clear();
    return;
  }
  tintCache.delete(cacheKey);
}
