import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const workspace = process.cwd();
const read = (file: string) => readFile(path.join(workspace, file), 'utf8');
const glassCssFiles = [
  'src/styles/liquid-glass.css',
  'src/styles/glass/tokens.css',
  'src/styles/glass/background.css',
  'src/styles/glass/surfaces.css',
  'src/styles/glass/states.css',
  'src/styles/glass/fallbacks.css',
  'src/styles/glass/utilities.css',
];

const readGlassCss = async () => (await Promise.all(glassCssFiles.map(read))).join('\n');

const importedGlassModules = (source: string) => [...source.matchAll(
  /^@import '\.\/glass\/([a-z-]+)\.css';$/gm,
)].map((match) => match[1]);

const cssRuleBody = (source: string, selector: string): string => {
  const selectorIndex = source.indexOf(selector);
  assert.notEqual(selectorIndex, -1, `Missing CSS selector: ${selector}`);
  const openingBrace = source.indexOf('{', selectorIndex);
  assert.notEqual(openingBrace, -1, `Missing opening brace for: ${selector}`);
  const closingBrace = source.indexOf('}', openingBrace);
  assert.notEqual(closingBrace, -1, `Missing closing brace for: ${selector}`);
  return source.slice(openingBrace + 1, closingBrace);
};

test('one entry point imports one authoritative modular glass system', async () => {
  const entry = await read('src/styles/liquid-glass.css');
  assert.deepEqual(importedGlassModules(entry), [
    'tokens',
    'background',
    'surfaces',
    'states',
    'fallbacks',
    'utilities',
  ]);
  assert.doesNotMatch(entry, /ww-liquid-rim|ww-adaptive-refraction|OSS prototype restoration/);
  assert.doesNotMatch(entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^@import[^\n]+$/gm, ''), /[{}]/);
});

test('route rendering wins the first frame before the optional glass runtime starts', async () => {
  const main = await read('src/main.tsx');
  const renderAt = main.indexOf('root.render(');
  const scheduleAt = main.indexOf("if (document.documentElement.dataset.visualMode !== 'original') scheduleVisualEffectsWhenNeeded()");
  assert.ok(renderAt >= 0);
  assert.ok(scheduleAt > renderAt);
  assert.match(main, /requestIdleCallback/);
  assert.match(main, /timeout:\s*450/);
  assert.match(main, /cancelScheduledVisualEffects\(\)/);
});

test('transparent glass has a zero-blur clean centre and no black or grey fill', async () => {
  const tokens = await read('src/styles/glass/tokens.css');
  const transparent = cssRuleBody(tokens, ":root[data-visual-mode='transparent']");
  assert.match(transparent, /--ww-glass-panel-blur:\s*0px/);
  assert.match(transparent, /--ww-glass-control-blur:\s*0px/);
  assert.match(transparent, /--ww-glass-item-blur:\s*0px/);
  assert.match(transparent, /--ww-glass-panel-fill:\s*color-mix\([^;]*,\s*transparent\);/);
  assert.match(transparent, /--ww-glass-control-fill:\s*color-mix\([^;]*,\s*transparent\);/);
  assert.match(transparent, /--ww-glass-item-fill:\s*color-mix\([^;]*,\s*transparent\);/);
  assert.match(transparent, /--ww-glass-panel-border:\s*transparent;/);
  assert.match(transparent, /--ww-glass-control-border:\s*transparent;/);
  assert.match(tokens, /data-glass-tint-scope='none'[\s\S]*--ww-glass-tint-active:\s*transparent/);
  assert.doesNotMatch(transparent, /--ww-glass-(?:panel|control|item)-fill:[^;]*rgba\(/);
});

test('chromatic rim is colourful, diagonal, extremely narrow and faint', async () => {
  const [surfaces, profiles] = await Promise.all([
    read('src/styles/glass/surfaces.css'),
    read('src/visual/glass/glassProfiles.ts'),
  ]);
  assert.match(surfaces, /padding:\s*var\(--ww-glass-rim-width, 1\.25px\)/);
  assert.match(surfaces, /135deg/);
  assert.match(surfaces, /var\(--ww-glass-rim-cyan\)/);
  assert.match(surfaces, /var\(--ww-glass-rim-violet\)/);
  assert.match(surfaces, /var\(--ww-glass-rim-warm\)/);
  assert.match(surfaces, /filter:\s*blur\(var\(--ww-glass-instance-rim-softness, var\(--ww-glass-rim-softness\)\)\)/);
  assert.match(surfaces, /border:\s*1px solid transparent/);
  assert.doesNotMatch(surfaces, /border:\s*1px solid var\(--ww-glass-instance-border\)/);
  assert.match(surfaces, /mask-composite:\s*exclude/);
  assert.match(surfaces, /background-clip:\s*padding-box,\s*border-box/);
  assert.match(profiles, /widthPx:\s*1\.25/);
  assert.match(profiles, /opacity:\s*0\.1[0-4]/);
  assert.match(profiles, /angleDeg:\s*135/);
});

test('semantic content stays above one empty lens and native fields remain crisp', async () => {
  const [surfaces, registry] = await Promise.all([
    read('src/styles/glass/surfaces.css'),
    read('src/visual/glass/glassSurfaceRegistry.ts'),
  ]);
  assert.match(registry, /lens\.className = 'ww-glass-lens'/);
  assert.match(registry, /lens\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(registry, /host\.prepend\(lens\)/);
  assert.match(registry, /!host\.matches\(NATIVE_SELECTOR\)/);
  assert.match(surfaces, /> :not\(\.ww-glass-lens\)[^{]*\{[^}]*z-index:\s*1/s);
  assert.match(surfaces, /\.ww-glass-native[\s\S]*backdrop-filter/);
  assert.doesNotMatch(surfaces, /\.ww-glass-native[^{]*\{[^}]*filter:\s*url/s);
});

test('navigation is late-painted and fades its optical sampling inward', async () => {
  const [background, surfaces] = await Promise.all([
    read('src/styles/glass/background.css'),
    read('src/styles/glass/surfaces.css'),
  ]);
  assert.match(background, /v3-app-shell__body[^{]*\{[^}]*z-index:\s*10/s);
  assert.match(background, /v3-topbar[^}]*z-index:\s*30/s);
  assert.match(background, /data-visual-tone='dark'[^}]*brightness\(\.9\)/);
  assert.match(surfaces, /data-glass-role='navigation'[\s\S]*mask-image:\s*linear-gradient\(to bottom/s);
  assert.match(surfaces, /v3-mobile-match-nav[\s\S]*mask-image:\s*linear-gradient\(to top/s);
  assert.match(background, /v3-app-shell__body[\s\S]*--glass-motion-active-z:\s*2[0-9]/);
});

test('segmented options never own optics while base and slider are declarative owners', async () => {
  const [component, states] = await Promise.all([
    read('src/ui/DragSegmented.tsx'),
    read('src/styles/glass/states.css'),
  ]);
  assert.match(component, /data-glass-role="segmented"/);
  assert.match(component, /className="drag-segmented__slider"[\s\S]*data-glass-owner="self"/);
  assert.match(component, /data-glass-owner="none"/);
  assert.match(component, /data-glass-motion="none"/);
  assert.match(states, /drag-segmented__option[\s\S]*backdrop-filter:\s*none/);
  assert.doesNotMatch(
    states,
    /\.drag-segmented__slider,\s*\.drag-segmented__ghost\s*\{[^}]*(?:border|background|box-shadow):/s,
  );
});

test('material tiers keep transparent, low-transparency, frosted and fallback costs distinct', async () => {
  const [tokens, fallbacks] = await Promise.all([
    read('src/styles/glass/tokens.css'),
    read('src/styles/glass/fallbacks.css'),
  ]);
  const lowTransparency = cssRuleBody(tokens, ":root[data-visual-mode='low-transparency']");
  const frosted = cssRuleBody(tokens, ":root[data-visual-mode='frosted']");
  assert.match(lowTransparency, /--ww-glass-panel-blur:\s*1\.25px/);
  assert.match(lowTransparency, /--ww-glass-control-blur:\s*\.35px/);
  assert.match(frosted, /--ww-glass-panel-blur:\s*14px/);
  assert.match(frosted, /--ww-glass-control-blur:\s*8px/);
  assert.match(fallbacks, /data-visual-mode='original'[^{]*\{[^}]*display:\s*none/s);
  assert.match(fallbacks, /@supports not[\s\S]*--ww-glass-panel-fill:\s*rgba\([^;]*\.9[2-9]\)/);
});

test('three motion levels and full pressure deformation are connected without permanent animation', async () => {
  const [preferences, settings, motion, states] = await Promise.all([
    read('src/runtime/visualPreferences.ts'),
    read('src/pages/v3/SettingsPage.tsx'),
    read('src/visual/glass/glassMotionEngine.ts'),
    read('src/styles/glass/states.css'),
  ]);
  assert.match(preferences, /MOTION_MODES = \['none', 'standard', 'full'\]/);
  assert.match(preferences, /motionMode:\s*'standard'/);
  assert.match(settings, /无动效/);
  assert.match(settings, /标准动效/);
  assert.match(settings, /完整动效/);
  assert.match(motion, /--glass-pressure-x/);
  assert.match(motion, /--glass-tilt-x/);
  assert.match(motion, /if \(positionSettled && pressureSettled\)/);
  assert.match(states, /data-motion='full'[\s\S]*--glass-pressure-x/);
  assert.match(states, /--glass-pressure-y/);
  assert.match(states, /--glass-pressure/);
  assert.doesNotMatch(states, /--(?:ww-glass-pressure|contact-x|contact-y)/);
});

test('offscreen and removed surfaces release leases and old optical engines are disconnected', async () => {
  const [runtime, registry, effects] = await Promise.all([
    read('src/visual/glass/glassRuntime.ts'),
    read('src/visual/glass/glassSurfaceRegistry.ts'),
    read('src/runtime/visualEffectsRuntime.ts'),
  ]);
  assert.match(runtime, /if \(!desired\)[\s\S]*releaseLease\(surface\)/);
  assert.match(runtime, /surface\.record\.host\.dataset\.glassQuality = 'solid'/);
  assert.match(runtime, /surface\.lease\?\.release\(\)/);
  assert.match(runtime, /filterPool\.dispose\(\)/);
  assert.match(registry, /item\.removedNodes\.forEach\(removeTree\)/);
  assert.match(registry, /intersectionObserver\.disconnect\(\)/);
  assert.match(effects, /createGlassRuntime/);
  assert.doesNotMatch(effects, /startOpticalEdgeRuntime|startButtonPullInteraction|ensureOpticalDefinitions/);
});

test('glass CSS is an authority rather than another important override pile', async () => {
  const css = await readGlassCss();
  const importantCount = (css.match(/!important/g) ?? []).length;
  assert.equal(importantCount, 0);
  assert.doesNotMatch(css, /ww-liquid-surface|ww-liquid-rim|ww-adaptive-refraction/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-reduced-transparency/);
  assert.match(css, /@supports not \(\(backdrop-filter:/);
});
