import { test, expect } from './fixtures/v3App';

test('all public entry pages keep the primary flow usable at all required widths', async ({ page, v3 }, testInfo) => {
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, v3.serverURL);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, route, heading] of [
      ['lobby', '/lobby', '邀请朋友，点亮一局狼人杀'],
      ['join', '/rooms/join', '用房间码找到同伴'],
      ['wizard', '/rooms/new/players', '先决定今晚有多少人'],
      ['settings', '/settings', '设置'],
    ] as const) {
      await page.goto(`${v3.appURL}${route}`);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }))).toEqual({ client: width, scroll: width });
      await page.screenshot({ path: testInfo.outputPath(`responsive-${name}-${width}.png`), fullPage: true });
    }
    await expect(page.locator('link[rel="icon"][href*="favicon-v31"]')).toHaveCount(2);
  }
});
