import { test, expect } from './fixtures/v3App';

const openQuickComputerGame = async (page: import('playwright').Page, appURL: string, serverURL: string): Promise<void> => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), serverURL);
  await page.goto(`${appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('完整权威流程验收');
  await page.getByRole('button', { name: '快速电脑局' }).click();
        await page.getByRole('button', { name: '创建并开始电脑局' }).click();
};

test('the browser product entry observes live computer-game monitor progress', async ({ page, v3 }) => {
  test.setTimeout(300_000);
  await openQuickComputerGame(page, v3.appURL, v3.serverURL);
  await expect(page.getByText(/全知监控|结果与复盘/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/身份摘要|死亡记录/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/事件时间线|对局时间线/).first()).toBeVisible({ timeout: 20_000 });

  await expect(page.getByText(/事件时间线|对局时间线/).first()).toBeVisible();
  await expect(page.getByText('对局进行中').first()).toBeVisible();
});
