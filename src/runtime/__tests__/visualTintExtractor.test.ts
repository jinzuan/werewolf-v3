import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_VISUAL_TINT_SAMPLE_EDGE,
  clearVisualTintCache,
  extractVisualTint,
  extractVisualTintFromPixels,
  type VisualTintDecodeEnvironment,
  type VisualTintPixelData,
} from '../visualTintExtractor';

function pixels(colors: Array<readonly [number, number, number, number?]>): VisualTintPixelData {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach(([red, green, blue, alpha = 255], index) => {
    const offset = index * 4;
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = alpha;
  });
  return { width: colors.length, height: 1, data };
}

function repeat(
  color: readonly [number, number, number, number?],
  count: number,
): Array<readonly [number, number, number, number?]> {
  return Array.from({ length: count }, () => color);
}

test('selects the deepest color from dominant quantized clusters', () => {
  const sample = pixels([
    ...repeat([52, 90, 138], 60),
    ...repeat([90, 38, 60], 35),
    ...repeat([2, 2, 2], 3),
    ...repeat([250, 250, 250], 3),
    ...repeat([80, 80, 80], 3),
    ...repeat([255, 0, 0, 0], 3),
  ]);

  assert.equal(extractVisualTintFromPixels(sample), '#5A263C');
});

test('does not let a rare dark accent override the main color family', () => {
  const sample = pixels([
    ...repeat([42, 102, 142], 80),
    ...repeat([85, 125, 72], 50),
    ...repeat([84, 20, 38], 10),
  ]);

  assert.equal(extractVisualTintFromPixels(sample), '#2A668E');
});

test('prefers a colorful dominant family over a grey-green average', () => {
  const sample = pixels([
    ...repeat([70, 78, 74], 90),
    ...repeat([38, 82, 118], 58),
    ...repeat([78, 42, 92], 34),
  ]);

  assert.equal(extractVisualTintFromPixels(sample), '#4E2A5C');
});

test('returns null when only transparent, near-black, near-white, or low-saturation pixels remain', () => {
  const sample = pixels([
    ...repeat([12, 12, 12], 10),
    ...repeat([248, 248, 248], 10),
    ...repeat([110, 114, 112], 10),
    ...repeat([30, 80, 120, 20], 10),
  ]);

  assert.equal(extractVisualTintFromPixels(sample), null);
});

test('validates malformed injected pixel buffers', () => {
  assert.throws(
    () => extractVisualTintFromPixels({ width: 2, height: 2, data: new Uint8Array(4) }),
    /pixel buffer/i,
  );
  assert.throws(
    () => extractVisualTintFromPixels({ width: 0, height: 2, data: new Uint8Array(8) }),
    /dimensions/i,
  );
});

test('accepts injected pixels directly and reduces oversized data before analysis', async () => {
  const width = 96;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 44;
    data[offset + 1] = 92;
    data[offset + 2] = 132;
    data[offset + 3] = 255;
  }

  assert.equal(await extractVisualTint({ width, height, data }), '#2C5C84');
});

test('decodes a Blob into an at-most 48 by 48 canvas through an injected environment', async () => {
  let bitmapOptions: ImageBitmapOptions | undefined;
  let canvasSize: readonly [number, number] | undefined;
  let closed = false;
  const sample = pixels(repeat([58, 88, 128], 48 * 48));

  const environment: VisualTintDecodeEnvironment = {
    createImageBitmap: async (_blob, options) => {
      bitmapOptions = options;
      return { width: 48, height: 48, close: () => { closed = true; } };
    },
    createCanvas: (width, height) => {
      canvasSize = [width, height];
      return {
        getContext: () => ({
          drawImage: () => undefined,
          getImageData: () => sample,
        }),
      };
    },
  };

  assert.equal(await extractVisualTint(new Blob(['image'], { type: 'image/png' }), { environment }), '#3A5880');
  assert.deepEqual(canvasSize, [MAX_VISUAL_TINT_SAMPLE_EDGE, MAX_VISUAL_TINT_SAMPLE_EDGE]);
  assert.equal(bitmapOptions?.resizeWidth, MAX_VISUAL_TINT_SAMPLE_EDGE);
  assert.equal(bitmapOptions?.resizeHeight, MAX_VISUAL_TINT_SAMPLE_EDGE);
  assert.equal(closed, true);
});

test('fetches same-origin URLs and rejects cross-origin URLs before network access', async () => {
  let fetchCount = 0;
  const sample = pixels(repeat([50, 94, 122], 48 * 48));
  const environment: VisualTintDecodeEnvironment = {
    baseUrl: 'https://game.example/settings',
    fetch: async (url) => {
      fetchCount += 1;
      assert.equal(url, 'https://game.example/assets/day.webp');
      return {
        ok: true,
        blob: async () => new Blob(['image'], { type: 'image/webp' }),
      };
    },
    createImageBitmap: async () => ({ width: 48, height: 48 }),
    createCanvas: () => ({
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: () => sample,
      }),
    }),
  };

  assert.equal(await extractVisualTint('/assets/day.webp', { environment }), '#325E7A');
  assert.equal(fetchCount, 1);
  await assert.rejects(
    extractVisualTint('https://tracker.example/day.webp', { environment }),
    /same-origin/i,
  );
  assert.equal(fetchCount, 1);
});

test('deduplicates work only when the caller supplies a cache key', async () => {
  clearVisualTintCache();
  let decodeCount = 0;
  const decode = async (): Promise<VisualTintPixelData> => {
    decodeCount += 1;
    return pixels(repeat([64, 92, 132], 20));
  };
  const blob = new Blob(['image'], { type: 'image/png' });

  const [first, second] = await Promise.all([
    extractVisualTint(blob, { cacheKey: 'day:revision-1', decode }),
    extractVisualTint(blob, { cacheKey: 'day:revision-1', decode }),
  ]);
  assert.equal(first, '#405C84');
  assert.equal(second, first);
  assert.equal(decodeCount, 1);

  await extractVisualTint(blob, { decode });
  await extractVisualTint(blob, { decode });
  assert.equal(decodeCount, 3);

  clearVisualTintCache('day:revision-1');
  await extractVisualTint(blob, { cacheKey: 'day:revision-1', decode });
  assert.equal(decodeCount, 4);
});

test('does not retain failed cached decodes', async () => {
  clearVisualTintCache();
  let attempts = 0;
  const decode = async (): Promise<VisualTintPixelData> => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary decode failure');
    return pixels(repeat([72, 100, 140], 20));
  };
  const source = new Blob(['image'], { type: 'image/png' });

  await assert.rejects(extractVisualTint(source, { cacheKey: 'retry', decode }), /temporary/);
  assert.equal(await extractVisualTint(source, { cacheKey: 'retry', decode }), '#48648C');
  assert.equal(attempts, 2);
});

test('bounds caller-keyed tint cache growth', async () => {
  clearVisualTintCache();
  let decodeCount = 0;
  const decode = async (): Promise<VisualTintPixelData> => {
    decodeCount += 1;
    return pixels(repeat([54, 96, 132], 20));
  };
  const source = new Blob(['image'], { type: 'image/png' });

  for (let index = 0; index < 25; index += 1) {
    await extractVisualTint(source, { cacheKey: `revision:${index}`, decode });
  }
  await extractVisualTint(source, { cacheKey: 'revision:0', decode });
  assert.equal(decodeCount, 26);
});
