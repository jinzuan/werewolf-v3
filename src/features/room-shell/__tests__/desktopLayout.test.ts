import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');

test('月影桌游台在桌面使用三栏，在平板和手机切到主流优先布局', () => {
  const shell = source('src/components/shell/MatchShell.tsx');
  const game = source('src/pages/v3/GamePage.tsx');
  const styles = source('src/styles/v3.css');
  const waitingStyles = source('src/features/waiting-room/waiting-room.css');

  assert.match(shell, /desktop\?: boolean/);
  assert.match(shell, /v3-desktop-match-layout/);
  assert.match(game, /<MatchShell[\s\S]*desktop/);
  assert.match(game, /v3-stage-summary/);
  assert.match(styles, /@media \(min-width: 1280px\)/);
  assert.match(styles, /--v3-workspace-columns:[\s\S]*minmax\(clamp\(250px, 20vw, 330px\), \.82fr\)/);
  assert.match(styles, /minmax\(clamp\(560px, 46vw, 920px\), 1\.8fr\)/);
  assert.match(styles, /grid-template-columns: var\(--v3-workspace-columns\)/);
  assert.match(styles, /min-aspect-ratio: 16\/9/);
  assert.match(styles, /v3-app-shell__body:has\(\.v3-page--match\)[^}]*overflow: hidden/);
  assert.match(styles, /\.v3-game-workspace[^}]*min-height: 0[^}]*overflow: hidden/);
  assert.match(styles, /\.v3-chat-list[^}]*overflow-y: auto[^}]*scrollbar-gutter: stable/);
  assert.match(styles, /\.v3-player-grid[^}]*overflow-y: auto[^}]*scrollbar-gutter: stable/);
  assert.match(styles, /--v3-mobile-nav-height: calc\(64px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(styles, /\.v3-mobile-match-nav[\s\S]*position: fixed[\s\S]*data-mobile-section='players'/);
  assert.match(game, /<MobileMatchNav[\s\S]*active=\{mobileSection\}/);
  assert.match(game, /\{identityPanel\}[\s\S]*<details className="v3-card v3-player-panel"/);
  assert.match(waitingStyles, /grid-template-areas: 'players side'/);
  assert.match(waitingStyles, /min-aspect-ratio: 16\/9/);
  assert.match(waitingStyles, /--waiting-workspace-height: clamp\(360px, calc\(100dvh - 210px\), 560px\)/);
  assert.match(waitingStyles, /@media \(max-width: 767px\)/);
});

test('公共头部、加入表单和大厅空状态保持稳定布局契约', () => {
  const topbar = source('src/components/shell/TopStatusBar.tsx');
  const roomHeader = source('src/features/room-shell/RoomHeader.tsx');
  const join = source('src/features/room-join/JoinRoomPage.tsx');
  const lobby = source('src/pages/v3/LobbyPage.tsx');
  const styles = source('src/styles/v3.css');

  assert.match(topbar, /v3-topbar__identity[\s\S]*v3-topbar__actions/);
  assert.match(roomHeader, /v3-room-header__primary[\s\S]*v3-room-header__actions/);
  assert.match(styles, /\.v3-topbar__actions[^}]*justify-self: end[^}]*margin-inline-start: auto/);
  assert.match(styles, /\.v3-room-header__actions[^}]*justify-content: flex-end[^}]*margin-inline-start: auto/);
  assert.match(styles, /\.v3-join-form[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.v3-join-form > \.v3-field[^}]*grid-template-rows: auto var\(--ww-height-control\) minmax\(20px, auto\)/);
  assert.match(join, /房间码格式正确[\s\S]*最多 16 个字符/);
  assert.match(lobby, /v3-room-list--empty/);
  assert.match(styles, /\.v3-room-list--empty > \.v3-empty-state[^}]*height: 100%/);
  const emptyCard = lobby.match(/<Card className="v3-empty-state">([\s\S]*?)<\/Card>/)?.[1] ?? '';
  assert.doesNotMatch(emptyCard, /<Button|创建第一个房间|输入房间码/);
  assert.match(lobby, /刷新列表/);
});

test('发言、事件引用和身份行复用稳定席位色且保留文字身份', () => {
  const game = source('src/pages/v3/GamePage.tsx');
  const spectate = source('src/pages/v3/SpectatePage.tsx');
  const bubble = source('src/ui/ChatBubble.tsx');
  const styles = source('src/styles/v3.css');

  assert.match(game, /actorColorClass = actor \? ` v3-seat-color-\$\{seatColorIndex\(actor\.order\)\}` : ''/);
  assert.match(game, /speakerTone=\{speaker \? seatColorIndex\(speaker\.order\) : undefined\}/);
  assert.match(spectate, /seatColorClass\(player\.order\)/);
  assert.match(bubble, /seatNumber[^]*isAI[^]*playerStatus/);
  assert.match(bubble, /\{author\}[\s\S]*v3-chat-seat[\s\S]*v3-ai-label/);
  assert.match(styles, /\.v3-chat-avatar[^}]*var\(--v3-seat-color/);
  assert.match(styles, /\.v3-chat-bubble[^}]*border-inline-start: 3px solid var\(--v3-seat-color/);
});
