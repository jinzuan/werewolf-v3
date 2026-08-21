import { test, expect } from './fixtures/v3App';

const createThroughWizard = async (page: import('playwright').Page, appURL: string): Promise<void> => {
  await page.goto(`${appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('浏览器幂等验收房');
        await page.getByRole('button', { name: '创建并进入等待房' }).click();
};

test('a committed create whose ACK is lost retries from the product UI to one waiting room', async ({ page, v3 }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await v3.setFault('create_ack');
  await createThroughWizard(page, v3.appURL);

  await expect(page.getByRole('alert')).toContainText('连接', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '创建并进入等待房' })).toBeVisible();
  await page.getByRole('button', { name: '创建并进入等待房' }).click();

  await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });
  const roomCode = page.locator('.v3-room-header__code strong');
  await expect(roomCode).toHaveCount(1);
  const committedCode = await roomCode.textContent();
  await page.reload();
  await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 20_000 });
  await expect(roomCode).toHaveText(committedCode ?? '');
});
