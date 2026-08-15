import { test, expect } from './fixtures/v3App';

test('lobby and room wizard keep the primary flow usable at all required widths', async ({ page, v3 }) => {
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, v3.serverURL);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${v3.appURL}/rooms/new/players`);
    await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))).toEqual({ client: width, scroll: width });
    await expect(page.locator('link[rel="icon"][href*="favicon-v31"]')).toHaveCount(2);
  }
});
