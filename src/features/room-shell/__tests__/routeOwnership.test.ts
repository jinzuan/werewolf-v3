import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');

test('room pages delegate mutations to authority actions and keep scene ownership in RoomLayout', () => {
  const waitingRoom = source('src/features/waiting-room/WaitingRoomPage.tsx');
  const appShell = source('src/components/shell/AppShell.tsx');
  const layout = source('src/features/room-shell/RoomLayout.tsx');

  assert.doesNotMatch(waitingRoom, /useV3Store\.getState\(\)/);
  assert.doesNotMatch(waitingRoom, /v3Socket/);
  assert.match(waitingRoom, /updateRoomConfig/);
  assert.match(waitingRoom, /leaveRoomMutation/);
  assert.doesNotMatch(waitingRoom, /更多房主操作|查看问题/);
  assert.doesNotMatch(appShell, /useV3Store/);
  assert.match(appShell, /useRoomShell/);
  assert.match(layout, /sceneForRoom/);
  assert.match(layout, /RoomShellContext\.Provider value=\{\{ inRoom: true, scene \}\}/);
});
