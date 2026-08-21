import { test, expect } from './fixtures/v3App';

test('two browser contexts use product join, readiness, and identity isolation', async ({ page, browser, v3 }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('双端混合验收');
  await page.getByRole('button', { name: '混合房' }).click();
        await page.getByRole('button', { name: '创建并进入等待房' }).click();
  await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });

  const roomCode = (await page.locator('.v3-room-header__code strong').textContent())?.trim();
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('werewolf-v3-session') ?? 'null') as {
    credentials?: { joinToken?: string };
  } | null);
  if (!roomCode || !session?.credentials?.joinToken) throw new Error('product-created room did not expose its scoped invite to the host UI');

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  try {
    await secondPage.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
    await secondPage.goto(`${v3.appURL}/rooms/join?code=${encodeURIComponent(roomCode)}`);
    await secondPage.getByLabel('昵称').fill('第二位玩家');
    await secondPage.getByText('有邀请口令', { exact: true }).click();
    await secondPage.getByLabel('邀请口令').fill(session.credentials.joinToken);
    await secondPage.getByRole('button', { name: '加入房间', exact: true }).click();
    await expect(secondPage.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });
    await expect(secondPage.getByText('第二位玩家').first()).toBeVisible();
    // Reconcile the host projection before readiness; this test focuses on
    // the two-seat flow, while waiting-room push refresh has its own suite.
    await page.reload();
    await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('第二位玩家').first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: '确认准备' }).click();
    await expect(page.getByText('等待准备').first()).toBeVisible({ timeout: 20_000 });
    await expect(secondPage.getByText('等待准备').first()).toBeVisible({ timeout: 20_000 });
    await secondPage.getByRole('button', { name: '确认准备' }).click();
    await page.reload();
    await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('等待准备').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('第二位玩家').first()).toBeVisible();
  } finally {
    await secondContext.close().catch(() => undefined);
  }
});
