import { test, expect } from './fixtures/v3App';

test('a UI mutation remains retryable after its ACK is lost and does not create a second room fact', async ({ page, v3 }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('命令终态验收');
        await page.getByRole('button', { name: '创建并进入等待房' }).click();
  await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });

  await v3.setFault('mutation_ack');
  await page.getByRole('button', { name: '确认准备' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('等待准备').first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText('等待准备').first()).toBeVisible({ timeout: 20_000 });
});
