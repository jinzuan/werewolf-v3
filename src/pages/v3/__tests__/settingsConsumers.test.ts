import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(
  new URL('../SettingsPage.tsx', import.meta.url),
  'utf8',
);

test('V3 settings consumes the local visual preference module without restoring removed settings', () => {
  assert.doesNotMatch(pageSource, /主音量|字幕与系统提示|桌面通知/);
  assert.doesNotMatch(pageSource, /werewolf-v3-(captions|notifications)/);
  assert.match(pageSource, /endpointDiagnosticsEnabled/);
  assert.match(pageSource, /loadVisualPreferences/);
  assert.match(pageSource, /saveVisualPreferences/);
  assert.match(pageSource, /visualBackgroundStore/);
  assert.match(pageSource, /VISUAL_MODES/);
  assert.match(pageSource, /BACKGROUND_MODES/);
  assert.match(pageSource, /BACKGROUND_PRESETS/);
  assert.match(pageSource, /COLOR_SCHEMES/);
  assert.match(pageSource, /GLASS_TINT_SCOPES/);
  assert.match(pageSource, /GLASS_TINT_SOURCES/);
  assert.match(pageSource, /MOTION_MODES/);
  assert.match(pageSource, /无动效/);
  assert.match(pageSource, /标准动效/);
  assert.match(pageSource, /完整动效/);
  assert.match(pageSource, /DragSegmented/);
  assert.match(pageSource, /大厅明暗/);
  assert.match(pageSource, /applyVisualPreferences/);
  assert.match(pageSource, /previewTintPreferences/);
  assert.match(pageSource, /visualBackgroundStore\.putMany/);
  assert.match(pageSource, /validationMessage\[result\.code\]/);
  assert.match(pageSource, /image\/png,image\/jpeg,image\/webp,image\/avif/);
  assert.doesNotMatch(pageSource, /localStorage|indexedDB|base64/);
});
