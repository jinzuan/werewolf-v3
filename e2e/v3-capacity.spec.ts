import { test, expect } from './fixtures/v3App';

test('lobby renders a bounded room page and does not preload monitor routes', async ({ page, v3 }) => {
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, v3.serverURL);

  const requested = new Set<string>();
  page.on('request', (request) => requested.add(request.url()));
  await page.goto(`${v3.appURL}/lobby`);
  await expect(page.getByRole('heading', { name: '房间列表' })).toBeVisible();

  const roomRows = page.locator('.v3-room-row');
  await expect(roomRows).toHaveCount(0);
  expect([...requested].some((url) => /MonitorPage|SpectatePage|RoomResultPage/.test(url))).toBe(false);
});
