import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const workspace = process.cwd();

const cssRuleBody = (source: string, selector: string): string => {
  const selectorIndex = source.indexOf(selector);
  assert.notEqual(selectorIndex, -1, `Missing CSS selector: ${selector}`);
  const openingBrace = source.indexOf('{', selectorIndex);
  const closingBrace = source.indexOf('}', openingBrace);
  assert.notEqual(openingBrace, -1, `Missing opening brace for: ${selector}`);
  assert.notEqual(closingBrace, -1, `Missing closing brace for: ${selector}`);
  return source.slice(openingBrace + 1, closingBrace);
};

test('lobby uses the approved moon-orbit poster composition', async () => {
  const source = await readFile(path.join(workspace, 'src/pages/v3/LobbyPage.tsx'), 'utf8');
  assert.match(source, /pageClassName="v3-page--lobby"/);
  assert.match(source, /v3-lobby-hero__visual/);
  assert.match(source, /v3-lobby-hero__orbit/);
  assert.match(source, /v3-lobby-room-section/);
  assert.match(source, /CircleAlert/);
});

test('error insertion cancels the lobby overlap and glass alerts stay translucent', async () => {
  const [layout, material] = await Promise.all([
    readFile(path.join(workspace, 'src/styles/v3.css'), 'utf8'),
    readFile(path.join(workspace, 'src/styles/glass/surfaces.css'), 'utf8'),
  ]);
  assert.match(layout, /\.v3-lobby-alert \+ \.v3-lobby-room-section \{ margin-top: 0; \}/);
  const errorSurface = cssRuleBody(
    material,
    ":root:not([data-visual-mode='original']) .v3-alert--error",
  );
  assert.match(errorSurface, /--ww-glass-state-color:\s*var\(--ww-state-danger\)/);
  assert.match(errorSurface, /--ww-glass-state-strength:\s*18%/);
  assert.doesNotMatch(errorSurface, /background:\s*(?:#[0-9a-f]{3,8}|rgba?\()/i);
  assert.match(material, /\[data-glass-role='item'\]\.ww-glass-has-lens[^{]*\{[^}]*background:\s*transparent/s);
  assert.match(material, /mask-composite:\s*exclude/);
});
