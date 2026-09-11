import { test, expect } from './fixtures/v3App';

test('waiting-room AI configuration is entered after creation and remains host-scoped', async ({ page, v3 }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('AI 配置验收房');
  await page.getByRole('button', { name: '混合房' }).click();
  await page.getByRole('button', { name: '创建并进入等待房', exact: true }).click();
  await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: '房间设置', exact: true }).click();
  await page.getByRole('button', { name: 'AI 参数与服务', exact: true }).click();
  await page.getByLabel('模型名称').fill('deterministic-e2e');
  await page.getByLabel(/API 密钥 \/ Token/).fill(v3.canary);
  await page.getByRole('button', { name: '保存电脑玩家设置', exact: true }).click();
  await expect(page.getByText('deterministic-e2e')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(v3.canary);
});
