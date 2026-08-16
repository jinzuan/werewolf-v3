import { test, expect } from './fixtures/v3App';

test('waiting-room AI configuration is entered through the wizard and remains host-scoped', async ({ page, v3 }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('AI 配置验收房');
  await page.getByRole('button', { name: '混合房' }).click();
  await page.getByLabel('模型名称').fill('deterministic-e2e');
  await page.getByLabel('访问密钥').fill(v3.canary);
  await page.getByRole('button', { name: '继续选择角色' }).click();
  await page.getByRole('button', { name: '继续选择规则' }).click();
  await page.getByRole('button', { name: '查看确认' }).click();
  await expect(page.getByText('deterministic-e2e')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(v3.canary);
  await page.getByRole('button', { name: '创建并进入等待房' }).click();
  await expect(page.locator('[data-room-status="waiting"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('body')).not.toContainText(v3.canary);
});
