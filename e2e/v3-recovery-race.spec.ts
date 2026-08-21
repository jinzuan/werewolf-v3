import { test, expect } from './fixtures/v3App';
import type { Page } from 'playwright';

const preparePage = async (page: Page, serverUrl: string, staleSession = false): Promise<void> => {
  await page.addInitScript(({ url, stale }) => {
    localStorage.setItem('wolf-server-url', url);
    if (stale) {
      localStorage.setItem('werewolf-v3-session', JSON.stringify({
        version: 2,
        actorId: 'stale-actor',
        actorName: '旧会话',
        roomCode: 'MISSING',
        roomId: 'missing-room',
        credentials: { resumeToken: 'stale-token' },
        mode: 'player',
        lastSeenSeq: 0,
      }));
    }
  }, { url: serverUrl, stale: staleSession });
};

test('stale room recovery does not cancel the public catalog request', async ({ page, v3 }) => {
  await preparePage(page, v3.serverURL, true);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('正在载入房间目录')).toHaveCount(0);
});

test('offline/reconnect reaches an explicit retryable page instead of an infinite spinner', async ({ page, v3 }) => {
  await preparePage(page, v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible();
});
