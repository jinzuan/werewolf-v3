import { test, expect } from './fixtures/v3App';

test('a single human can prepare and start a mixed room into the player match view', async ({ page, v3 }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/settings`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByLabel('房间名称').fill('单真人开局回归验收');
  await page.getByRole('button', { name: /混合房/ }).click();
  await page.getByRole('button', { name: '创建并进入等待房', exact: true }).click();
  await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: '确认准备', exact: true }).click();
  const start = page.getByRole('button', { name: '开始游戏', exact: true });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();

  // The room snapshot is the route authority; this assertion proves the
  // waiting-room command, server start transaction, push, and route guard all
  // crossed the boundary rather than merely receiving a successful ACK.
  await expect(page).toHaveURL(/\/rooms\/[A-Z2-9]{6}\/play$/, { timeout: 30_000 });
  await expect(page.getByRole('banner').getByText('身份确认', { exact: true })).toBeVisible({ timeout: 20_000 });
});
