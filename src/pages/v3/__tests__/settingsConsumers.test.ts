import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(
  new URL('../SettingsPage.tsx', import.meta.url),
  'utf8',
);

test('V3 settings keeps only motion and diagnostic endpoint consumers', () => {
  assert.doesNotMatch(pageSource, /主音量|字幕与系统提示|桌面通知/);
  assert.doesNotMatch(pageSource, /werewolf-v3-(captions|notifications)/);
  assert.match(pageSource, /endpointDiagnosticsEnabled/);
  assert.match(pageSource, /werewolf-v3-motion-mode/);
});
