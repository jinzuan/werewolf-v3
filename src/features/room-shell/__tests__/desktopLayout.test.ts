import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');

test('桌面房间工作区有独立三栏契约，窄屏规则仍由旧断点负责', () => {
  const shell = source('src/components/shell/MatchShell.tsx');
  const game = source('src/pages/v3/GamePage.tsx');
  const styles = source('src/styles/v3.css');
  const waitingStyles = source('src/features/waiting-room/waiting-room.css');

  assert.match(shell, /desktop\?: boolean/);
  assert.match(shell, /v3-desktop-match-layout/);
  assert.match(game, /<MatchShell[\s\S]*desktop/);
  assert.match(game, /v3-desktop-room-panel/);
  assert.match(styles, /@media \(min-width: 1280px\)/);
  assert.match(styles, /grid-template-columns:[\s\S]*clamp\(224px, 18vw, 330px\)[\s\S]*clamp\(380px, 36vw, 720px\)/);
  assert.match(styles, /min-aspect-ratio: 16\/9/);
  assert.match(styles, /--v3-workspace-height: clamp\(380px, calc\(100dvh - 170px\), 620px\)/);
  assert.match(waitingStyles, /grid-template-areas: 'players side info'/);
  assert.match(waitingStyles, /min-aspect-ratio: 16\/9/);
  assert.match(waitingStyles, /--waiting-workspace-height: clamp\(360px, calc\(100dvh - 210px\), 560px\)/);
  assert.match(waitingStyles, /@media \(max-width: 767px\)/);
});
