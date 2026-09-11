import { test, expect } from './fixtures/v3App';

test('live monitor projection exposes the review-ready event stream', async ({ page, v3 }) => {
  test.setTimeout(300_000);
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '快速电脑局' }).click();
        await page.getByRole('button', { name: '创建并开始电脑局' }).click();
  await expect(page.getByText(/全知监控|结果与复盘/).first()).toBeVisible({ timeout: 60_000 });

  await expect(page.getByText(/全知监控|结果与复盘/).first()).toBeVisible();
});
