import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GLASS_QUALITY_BUDGETS,
  GlassQualityController,
  allocateGlassQuality,
  scoreGlassQualityCandidate,
} from '../glassQualityController';
import type {
  GlassQualityAllocation,
  GlassQualityCandidate,
  GlassQualityContext,
  GlassQualityTier,
} from '../glassTypes';

const allCapabilities = {
  refractRgb: true,
  refractSingle: true,
  backdropBlur: true,
};

const context = (overrides: Partial<GlassQualityContext> = {}): GlassQualityContext => ({
  deviceClass: 'desktop',
  viewportArea: 10_000,
  capabilities: allCapabilities,
  ...overrides,
});

const candidate = (
  id: string,
  role: GlassQualityCandidate['role'],
  overrides: Partial<GlassQualityCandidate> = {},
): GlassQualityCandidate => ({
  id,
  role,
  visible: true,
  visibleArea: 300,
  ...overrides,
});

const qualityOf = (result: GlassQualityAllocation, id: string): GlassQualityTier => {
  const assignment = result.assignments.find((item) => item.id === id);
  assert.ok(assignment, `missing quality assignment for ${id}`);
  return assignment.quality;
};

test('priority scoring follows interaction, navigation/modal, panel, control, and repeated-item order', () => {
  const ordinaryItem = candidate('item', 'item');
  const control = candidate('control', 'control');
  const panel = candidate('panel', 'panel');
  const navigation = candidate('navigation', 'navigation');
  const modalPanel = candidate('modal', 'panel', { modal: true });
  const interactingItem = candidate('active', 'item', { interacting: true });

  assert.ok(scoreGlassQualityCandidate(control) > scoreGlassQualityCandidate(ordinaryItem));
  assert.ok(scoreGlassQualityCandidate(panel) > scoreGlassQualityCandidate(control));
  assert.ok(scoreGlassQualityCandidate(navigation) > scoreGlassQualityCandidate(panel));
  assert.ok(scoreGlassQualityCandidate(modalPanel) > scoreGlassQualityCandidate(navigation));
  assert.ok(scoreGlassQualityCandidate(interactingItem) > scoreGlassQualityCandidate(modalPanel));
  assert.ok(
    scoreGlassQualityCandidate(candidate('explicit', 'item', { priority: 900 }))
      > scoreGlassQualityCandidate(navigation),
  );
});

test('desktop allocation reserves one RGB slot for direct interaction and three for static surfaces', () => {
  const result = allocateGlassQuality([
    candidate('ordinary-control', 'control'),
    candidate('field', 'field'),
    candidate('panel', 'panel'),
    candidate('navigation', 'navigation'),
    candidate('active-item', 'item', { interacting: true }),
  ], context());

  assert.equal(qualityOf(result, 'active-item'), 'refract-rgb');
  assert.equal(qualityOf(result, 'navigation'), 'refract-rgb');
  assert.equal(qualityOf(result, 'panel'), 'refract-rgb');
  assert.equal(qualityOf(result, 'field'), 'refract-rgb');
  assert.equal(qualityOf(result, 'ordinary-control'), 'refract-single');
  assert.equal(result.totals.rgbCount, 4);
  assert.equal(result.totals.staticRgbCount, 3);
  assert.equal(result.totals.interactiveRgbCount, 1);
});

test('visible area prevents a large panel from consuming the RGB budget', () => {
  const result = allocateGlassQuality([
    candidate('large-panel', 'panel', { visibleArea: 3_000 }),
    candidate('navigation', 'navigation', { visibleArea: 900 }),
  ], context());

  assert.equal(qualityOf(result, 'navigation'), 'refract-rgb');
  assert.equal(qualityOf(result, 'large-panel'), 'refract-single');
  assert.equal(result.totals.rgbArea, 900);
  assert.equal(result.totals.refractedArea, 3_900);
});

test('RGB allocations also respect the combined refraction-area budget', () => {
  const result = allocateGlassQuality([
    candidate('large-navigation', 'navigation', { visibleArea: 3_000 }),
    candidate('panel', 'panel', { visibleArea: 1_000 }),
    candidate('field', 'field', { visibleArea: 1_000 }),
  ], context());

  assert.equal(qualityOf(result, 'large-navigation'), 'refract-single');
  assert.equal(qualityOf(result, 'panel'), 'refract-rgb');
  assert.equal(qualityOf(result, 'field'), 'blur');
  assert.equal(result.totals.refractedArea, 4_000);
});

test('mobile allocation uses the stricter one-static plus one-interactive RGB budget', () => {
  assert.equal(DEFAULT_GLASS_QUALITY_BUDGETS.mobile.staticRgbCount, 1);
  assert.equal(DEFAULT_GLASS_QUALITY_BUDGETS.mobile.interactiveRgbCount, 1);
  assert.equal(DEFAULT_GLASS_QUALITY_BUDGETS.mobile.rgbAreaRatio, 0.12);

  const result = allocateGlassQuality([
    candidate('control', 'control', { visibleArea: 300 }),
    candidate('panel', 'panel', { visibleArea: 300 }),
    candidate('navigation', 'navigation', { visibleArea: 300 }),
    candidate('active', 'control', { visibleArea: 300, interacting: true }),
  ], context({ deviceClass: 'mobile' }));

  assert.equal(qualityOf(result, 'active'), 'refract-rgb');
  assert.equal(qualityOf(result, 'navigation'), 'refract-rgb');
  assert.equal(qualityOf(result, 'panel'), 'refract-single');
  assert.equal(qualityOf(result, 'control'), 'refract-single');
  assert.equal(result.totals.rgbCount, 2);
});

test('offscreen surfaces are assigned solid and consume no optical budget', () => {
  const result = allocateGlassQuality([
    candidate('offscreen', 'navigation', { visible: false, visibleArea: 5_000 }),
    candidate('onscreen', 'panel', { visibleArea: 1_000 }),
  ], context());

  assert.equal(qualityOf(result, 'offscreen'), 'solid');
  assert.equal(result.assignments.find((item) => item.id === 'offscreen')?.reason, 'offscreen');
  assert.equal(result.totals.rgbArea, 1_000);
  assert.equal(result.totals.solidCount, 1);
});

test('capability and candidate ceilings degrade in RGB → single → blur → solid order', () => {
  const candidates = [
    candidate('ceiling', 'navigation', { maxQuality: 'blur' }),
    candidate('normal', 'panel'),
  ];

  const noRgb = allocateGlassQuality(candidates, context({
    capabilities: { ...allCapabilities, refractRgb: false },
  }));
  assert.equal(qualityOf(noRgb, 'ceiling'), 'blur');
  assert.equal(qualityOf(noRgb, 'normal'), 'refract-single');

  const blurOnly = allocateGlassQuality(candidates, context({
    capabilities: { refractRgb: false, refractSingle: false, backdropBlur: true },
  }));
  assert.equal(qualityOf(blurOnly, 'ceiling'), 'blur');
  assert.equal(qualityOf(blurOnly, 'normal'), 'blur');

  const solidOnly = allocateGlassQuality(candidates, context({
    capabilities: { refractRgb: false, refractSingle: false, backdropBlur: false },
  }));
  assert.equal(qualityOf(solidOnly, 'ceiling'), 'solid');
  assert.equal(qualityOf(solidOnly, 'normal'), 'solid');
});

test('allocation is deterministic and reports assignments in caller order', () => {
  const candidates = [
    candidate('low', 'item'),
    candidate('high', 'navigation'),
    candidate('middle', 'panel'),
  ];
  const first = allocateGlassQuality(candidates, context());
  const second = allocateGlassQuality([...candidates].reverse(), context());

  assert.deepEqual(first.assignments.map((item) => item.id), ['low', 'high', 'middle']);
  for (const item of candidates) {
    assert.equal(qualityOf(first, item.id), qualityOf(second, item.id));
  }
});

test('GlassQualityController is a thin stateful adapter over the pure allocator', () => {
  const controller = new GlassQualityController({
    deviceClass: 'mobile',
    capabilities: allCapabilities,
  });
  const candidates = [
    candidate('active', 'control', { interacting: true, visibleArea: 200 }),
    candidate('navigation', 'navigation', { visibleArea: 200 }),
    candidate('panel', 'panel', { visibleArea: 200 }),
  ];

  const mobile = controller.allocate(candidates, 8_000);
  assert.equal(mobile.budget.deviceClass, 'mobile');
  assert.equal(mobile.totals.rgbCount, 2);

  controller.setDeviceClass('desktop');
  const desktop = controller.allocate(candidates, 8_000);
  assert.equal(desktop.budget.deviceClass, 'desktop');
  assert.equal(desktop.totals.rgbCount, 3);
});
