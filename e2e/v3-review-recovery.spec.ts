import { test, expect } from './fixtures/v3App';

test('ended result and server review projection recover after a real process restart', async ({ page, v3 }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '快速电脑局' }).click();
  await page.getByRole('button', { name: '继续选择角色' }).click();
  await page.getByRole('button', { name: '继续选择规则' }).click();
  await page.getByRole('button', { name: '查看确认' }).click();
  await page.getByRole('button', { name: '创建并开始电脑局' }).click();
  await expect(page.getByText(/全知监控|结果与复盘/).first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.locator('body').textContent(), { timeout: 90_000 }).toContain('对局已结束');
  await expect(page.getByText('AI 复盘与心得')).toBeVisible({ timeout: 20_000 });

  await v3.restart();
  await page.reload();
  await expect(page.getByText('结果与复盘')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('死亡记录')).toBeVisible();
  await expect(page.getByText('AI 复盘与心得')).toBeVisible();
});
