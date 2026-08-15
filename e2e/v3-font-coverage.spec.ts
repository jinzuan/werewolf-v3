import { test, expect } from './fixtures/v3App';

const PROBE = '狼人杀中文夜晚白天规则投票发言身份确认，。！？0123456789';

test('bundled CJK webfonts cover the product probe without a network fallback', async ({ page, v3 }, testInfo) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, v3.serverURL);

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${v3.appURL}/rooms/new/players`);
    await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });

    const result = await page.evaluate(async (probe) => {
      const families = [
        { name: 'WW Noto Sans SC', weights: [400, 600, 700] },
        { name: 'WW Noto Serif SC', weights: [600, 700] },
      ];
      await document.fonts.ready;
      const checks = [];
      for (const family of families) {
        for (const weight of family.weights) {
          const shorthand = `${weight} 24px "${family.name}"`;
          await document.fonts.load(shorthand, probe);
          checks.push({
            family: family.name,
            weight,
            loaded: document.fonts.check(shorthand, probe),
          });
        }
      }
      return {
        bodyFont: getComputedStyle(document.body).fontFamily,
        checks,
      };
    }, PROBE);

    expect(result.bodyFont).toContain('WW Noto Sans SC');
    expect(result.checks.filter((item) => !item.loaded)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`font-coverage-${width}.png`), fullPage: true });
  }
});
