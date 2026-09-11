import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GlassFilterPool,
  NEUTRAL_DISPLACEMENT_CHANNEL,
  createGlassFilterGraphSpec,
  createRoundedRectDisplacementRaster,
  sampleRoundedRectDisplacement,
} from '../glassFilterPool';
import { GLASS_PROFILE_ROLES, GLASS_PROFILES } from '../glassProfiles';
import type {
  GlassDisplacementRaster,
  GlassFilterGraphMount,
  GlassFilterGraphSpec,
  GlassFilterPoolEnvironment,
  GlassMapResource,
} from '../glassTypes';

const field = {
  width: 100,
  height: 40,
  radius: 12,
  refractionBand: 10,
  edgeCurve: 1.15,
};

test('profiles define a broad refractive band and an extremely narrow faint chromatic rim', () => {
  assert.deepEqual(GLASS_PROFILE_ROLES, [
    'navigation',
    'panel',
    'control',
    'field',
    'segmented',
    'item',
  ]);

  for (const role of GLASS_PROFILE_ROLES) {
    const profile = GLASS_PROFILES[role];
    assert.equal(profile.role, role);
    assert.ok(profile.optics.refractionBandPx >= profile.chromaticRim.widthPx * 4);
    assert.ok(profile.chromaticRim.widthPx >= 1);
    assert.ok(profile.chromaticRim.widthPx <= 2.25);
    assert.ok(profile.chromaticRim.opacity >= 0.1);
    assert.ok(profile.chromaticRim.opacity <= 0.18);
    assert.ok(profile.chromaticRim.activeOpacity <= 0.26);
    assert.ok(profile.chromaticRim.blurPx >= 0.35);
    assert.ok(profile.chromaticRim.blurPx <= 0.8);
    assert.equal(profile.chromaticRim.angleDeg, 135);
  }

  assert.ok(
    Math.abs(GLASS_PROFILES.control.optics.displacementPx)
      > Math.abs(GLASS_PROFILES.panel.optics.displacementPx),
  );
});

test('rounded-rectangle displacement field has an exactly neutral clean centre', () => {
  const centre = sampleRoundedRectDisplacement(field, 50, 20);
  assert.equal(centre.edgeStrength, 0);
  assert.equal(centre.red, 0.5);
  assert.equal(centre.blue, 0.5);
  assert.equal(centre.redByte, NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.equal(centre.blueByte, NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.equal(centre.edgeByte, 0);

  const safeCentre = sampleRoundedRectDisplacement(field, 35, 20);
  assert.equal(safeCentre.red, 0.5);
  assert.equal(safeCentre.blue, 0.5);
  assert.equal(safeCentre.redByte, NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.equal(safeCentre.blueByte, NEUTRAL_DISPLACEMENT_CHANNEL);

  const shallowCentre = sampleRoundedRectDisplacement(
    { ...field, refractionBand: 200 },
    50,
    20,
  );
  assert.equal(shallowCentre.edgeStrength, 0, 'over-wide bands are clamped before they meet');
  assert.equal(shallowCentre.red, 0.5);
  assert.equal(shallowCentre.blue, 0.5);
});

test('edge strength increases monotonically and follows the rounded boundary normal', () => {
  const inwardToEdge = [15, 10, 7.5, 5, 2.5, 0]
    .map((x) => sampleRoundedRectDisplacement(field, x, 20));

  for (let index = 1; index < inwardToEdge.length; index += 1) {
    assert.ok(
      inwardToEdge[index].edgeStrength >= inwardToEdge[index - 1].edgeStrength,
      `edge strength regressed at sample ${index}`,
    );
  }

  const left = sampleRoundedRectDisplacement(field, 0, 20);
  const right = sampleRoundedRectDisplacement(field, 100, 20);
  const top = sampleRoundedRectDisplacement(field, 50, 0);
  const bottom = sampleRoundedRectDisplacement(field, 50, 40);
  assert.ok(left.normalX < -0.99 && left.redByte < NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.ok(right.normalX > 0.99 && right.redByte > NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.ok(top.normalY < -0.99 && top.blueByte < NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.ok(bottom.normalY > 0.99 && bottom.blueByte > NEUTRAL_DISPLACEMENT_CHANNEL);

  const corner = sampleRoundedRectDisplacement(field, 0, 0);
  assert.ok(corner.normalX < -0.6);
  assert.ok(corner.normalY < -0.6);
  assert.equal(corner.edgeStrength, 1);
});

test('raster generation preserves the neutral platform and stores the edge mask separately', () => {
  const raster = createRoundedRectDisplacementRaster({
    width: 101,
    height: 41,
    radius: 12,
    refractionBand: 9,
    edgeCurve: 1.2,
  });
  assert.equal(raster.pixels.length, 101 * 41 * 4);

  const centreOffset = ((20 * 101) + 50) * 4;
  assert.equal(raster.pixels[centreOffset], NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.equal(raster.pixels[centreOffset + 1], 0);
  assert.equal(raster.pixels[centreOffset + 2], NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.equal(raster.pixels[centreOffset + 3], 255);

  const leftOffset = (20 * 101) * 4;
  assert.ok(raster.pixels[leftOffset] < NEUTRAL_DISPLACEMENT_CHANNEL);
  assert.equal(raster.pixels[leftOffset + 1], 255);
});

test('filter graph specs expose clean-centre edge-only RGB, single-channel, and no-displacement modes', () => {
  const base = {
    id: 'glass-test',
    mapUrl: 'blob:map',
    width: 160,
    height: 48,
    displacementPx: -24,
    chromaticOffsetPx: 1.1,
  } as const;

  const rgb = createGlassFilterGraphSpec({ ...base, mode: 'rgb' });
  assert.equal(rgb.colorInterpolationFilters, 'sRGB');
  assert.equal(rgb.cleanCenter, true);
  assert.equal(rgb.edgeOnly, true);
  assert.equal(rgb.neutralByteCorrection, -1 / 510);
  assert.deepEqual(rgb.channels.map((channel) => channel.channel), ['R', 'G', 'B']);
  assert.ok(rgb.channels[0].scale < rgb.channels[1].scale);
  assert.ok(rgb.channels[1].scale < rgb.channels[2].scale);

  const single = createGlassFilterGraphSpec({ ...base, mode: 'single' });
  assert.equal(single.cleanCenter, true);
  assert.equal(single.edgeOnly, true);
  assert.deepEqual(single.channels.map((channel) => channel.channel), ['RGBA']);

  const none = createGlassFilterGraphSpec({ ...base, mode: 'none', mapUrl: null });
  assert.equal(none.cleanCenter, false);
  assert.equal(none.edgeOnly, false);
  assert.deepEqual(none.channels, []);
});

type FakeEnvironment = GlassFilterPoolEnvironment & {
  events: string[];
  graphSpecs: GlassFilterGraphSpec[];
  rasterCount: () => number;
};

const createFakeEnvironment = (byteSize = 64): FakeEnvironment => {
  let time = 0;
  let maps = 0;
  const events: string[] = [];
  const graphSpecs: GlassFilterGraphSpec[] = [];
  return {
    events,
    graphSpecs,
    now: () => { time += 1; return time; },
    rasterCount: () => maps,
    createMapResource: async (_raster: GlassDisplacementRaster): Promise<GlassMapResource> => {
      maps += 1;
      const resource = { url: `blob:map-${maps}`, byteSize };
      events.push(`map:${resource.url}`);
      return resource;
    },
    createFilterGraph: (spec): GlassFilterGraphMount => {
      graphSpecs.push(spec);
      events.push(`graph:${spec.id}`);
      return { filterId: spec.id, cssFilter: `url(#${spec.id})` };
    },
    removeFilterGraph: (graph) => { events.push(`remove:${graph.filterId}`); },
    revokeMapResource: (resource) => { events.push(`revoke:${resource.url}`); },
    dispose: () => { events.push('environment:dispose'); },
  };
};

const controlRequest = {
  role: 'control',
  width: 121,
  height: 43,
  radius: 13,
  dpr: 1,
  quality: 'refract-rgb',
} as const;

test('FilterPool shares a geometry bucket and graph across concurrent consumers', async () => {
  const environment = createFakeEnvironment();
  const pool = new GlassFilterPool({ environment, maxBytes: 1024 });
  const [first, second] = await Promise.all([
    pool.acquire(controlRequest),
    pool.acquire({ ...controlRequest, width: 124, height: 44 }),
  ]);

  assert.equal(first.resource, second.resource);
  assert.equal(environment.rasterCount(), 1);
  assert.equal(environment.graphSpecs.length, 1);
  assert.equal(environment.graphSpecs[0].cleanCenter, true);
  assert.equal(environment.graphSpecs[0].edgeOnly, true);
  assert.equal(environment.graphSpecs[0].colorInterpolationFilters, 'sRGB');
  assert.deepEqual(pool.snapshot(), {
    entryCount: 1,
    pendingEntries: 0,
    referencedEntries: 1,
    totalBytes: 64,
    entries: [{
      key: first.resource.key,
      refCount: 2,
      byteEstimate: 64,
      lastUsed: 2,
      mode: 'rgb',
    }],
  });

  pool.release(first);
  first.release();
  assert.equal(pool.snapshot().entries[0].refCount, 1);
  second.release();
  assert.equal(pool.snapshot().entries[0].refCount, 0);
  pool.dispose();
});

test('FilterPool evicts only unreferenced LRU entries and removes graph before revoking its URL', async () => {
  const environment = createFakeEnvironment(80);
  const pool = new GlassFilterPool({ environment, maxBytes: 100 });

  const first = await pool.acquire(controlRequest);
  first.release();
  const second = await pool.acquire({ ...controlRequest, width: 201 });

  assert.equal(pool.snapshot().entryCount, 1);
  assert.equal(pool.snapshot().entries[0].key, second.resource.key);
  const removeIndex = environment.events.findIndex((event) => event.startsWith('remove:'));
  const revokeIndex = environment.events.findIndex((event) => event === 'revoke:blob:map-1');
  assert.ok(removeIndex >= 0);
  assert.ok(revokeIndex > removeIndex);

  second.release();
  assert.equal(pool.snapshot().entryCount, 1, 'the remaining under-budget LRU entry stays cached');
  pool.dispose();
});

test('FilterPool retains active over-budget resources and disposes every URL exactly once', async () => {
  const environment = createFakeEnvironment(80);
  const pool = new GlassFilterPool({ environment, maxBytes: 50 });
  const lease = await pool.acquire(controlRequest);
  assert.equal(pool.snapshot().entryCount, 1);
  assert.equal(pool.snapshot().totalBytes, 80);

  lease.release();
  assert.equal(pool.snapshot().entryCount, 0, 'active resource is evicted once it becomes releasable');
  pool.dispose();
  lease.release();
  pool.dispose();
  assert.equal(environment.events.filter((event) => event.startsWith('remove:')).length, 1);
  assert.equal(environment.events.filter((event) => event.startsWith('revoke:')).length, 1);
  assert.equal(environment.events.filter((event) => event === 'environment:dispose').length, 1);
  await assert.rejects(pool.acquire(controlRequest), /disposed/i);
});

test('blur and solid leases take the no-displacement path without allocating map or SVG resources', async () => {
  const environment = createFakeEnvironment();
  const pool = new GlassFilterPool({ environment });
  const blur = await pool.acquire({ ...controlRequest, quality: 'blur' });
  const solid = await pool.acquire({ ...controlRequest, quality: 'solid' });

  assert.equal(blur.resource.mode, 'none');
  assert.equal(solid.resource.mode, 'none');
  assert.equal(blur.resource.filterId, null);
  assert.equal(solid.resource.cssFilter, 'none');
  assert.equal(environment.rasterCount(), 0);
  assert.equal(environment.graphSpecs.length, 0);
  blur.release();
  solid.release();
  pool.dispose();
});

test('disposing during asynchronous map encoding revokes the eventual URL without mounting a graph', async () => {
  let finishMap: ((resource: GlassMapResource) => void) | undefined;
  const environment = createFakeEnvironment();
  environment.createMapResource = async () => new Promise<GlassMapResource>((resolve) => {
    finishMap = resolve;
  });
  const pool = new GlassFilterPool({ environment });
  const pending = pool.acquire(controlRequest);

  pool.dispose();
  assert.ok(finishMap);
  finishMap({ url: 'blob:late-map', byteSize: 64 });
  await assert.rejects(pending, /disposed/i);
  assert.equal(environment.graphSpecs.length, 0);
  assert.equal(environment.events.filter((event) => event === 'revoke:blob:late-map').length, 1);
  assert.equal(pool.snapshot().entryCount, 0);
});

test('a graph creation failure revokes its encoded map and leaves no poisoned cache entry', async () => {
  const environment = createFakeEnvironment();
  environment.createFilterGraph = () => { throw new Error('graph failed'); };
  const pool = new GlassFilterPool({ environment });

  await assert.rejects(pool.acquire(controlRequest), /graph failed/);
  assert.equal(pool.snapshot().entryCount, 0);
  assert.equal(environment.events.filter((event) => event === 'revoke:blob:map-1').length, 1);
  pool.dispose();
});
