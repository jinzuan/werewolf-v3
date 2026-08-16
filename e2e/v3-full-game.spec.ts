import { test, expect } from './fixtures/v3App';

const openQuickComputerGame = async (page: import('playwright').Page, appURL: string, serverURL: string): Promise<void> => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), serverURL);
  await page.goto(`${appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('完整权威流程验收');
  await page.getByRole('button', { name: '快速电脑局' }).click();
  await page.getByRole('button', { name: '继续选择角色' }).click();
  await page.getByRole('button', { name: '继续选择规则' }).click();
  await page.getByRole('button', { name: '查看确认' }).click();
  await page.getByRole('button', { name: '创建并开始电脑局' }).click();
};

test('the browser product entry observes the complete computer-game lifecycle and review result', async ({ page, v3 }) => {
  await openQuickComputerGame(page, v3.appURL, v3.serverURL);
  await expect(page.getByText(/全知监控|结果与复盘/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/身份摘要|死亡记录/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/事件时间线|对局时间线/).first()).toBeVisible({ timeout: 20_000 });

  await expect.poll(
    () => page.locator('body').textContent(),
    { timeout: 90_000, intervals: [250, 500, 1_000] },
  ).toContain('对局已结束');
  await expect(page.getByText('结果与复盘')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('死亡记录')).toBeVisible();
  await expect(page.getByText('AI 复盘与心得')).toBeVisible();
});
