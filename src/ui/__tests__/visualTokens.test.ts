import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const workspace = process.cwd();
const cssPath = path.join(workspace, 'src/styles/v3.css');

const contrast = (foreground: string, background: string) => {
  const channel = (value: string, offset: number) => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (value: string) => {
    const red = channel(value, 1);
    const green = channel(value, 3);
    const blue = channel(value, 5);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
};

test('月光森林 token 由 CSS 单一来源提供日夜语义', async () => {
  const css = await readFile(cssPath, 'utf8');
  for (const token of [
    '--ww-bg-scene',
    '--ww-bg-surface',
    '--ww-action-primary',
    '--ww-state-success',
    '--ww-state-warning',
    '--ww-state-danger',
    '--ww-focus-ring',
    '--ww-overlay',
  ]) {
    assert.match(css, new RegExp(`${token}\\s*:`));
  }
  assert.match(css, /:root\[data-scene='night'\]/);
  assert.doesNotMatch(css, /--color-(?:bg|text|gold|purple|danger|success|info|warning)/);
});

test('关键日夜前景组合满足正文对比度门槛', () => {
  const pairs = [
    ['#303A50', '#FFFBED'],
    ['#EDF0F7', '#1B2744'],
    ['#FFFFFF', '#356B52'],
    ['#17213B', '#8FB7E8'],
  ] as const;
  for (const [foreground, background] of pairs) {
    assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  }
});

test('键盘焦点、减少动态和首批资产均有明确交付物', async () => {
  const css = await readFile(cssPath, 'utf8');
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  for (const asset of [
    'sky-day.svg',
    'sky-night.svg',
    'village-scene.svg',
    'moon-phases.svg',
    'roles/role-wolf.svg',
    'roles/role-seer.svg',
    'roles/role-witch.svg',
    'roles/role-hunter.svg',
    'roles/role-guard.svg',
    'roles/role-villager.svg',
    'avatars/avatar-player.svg',
    'avatars/avatar-computer.svg',
    'avatars/avatar-spectator.svg',
  ]) {
    await access(path.join(workspace, 'src/assets/v31', asset));
  }
});
