import { test, expect } from './fixtures/v3App';

test('two browser contexts use product join, readiness, identity isolation, and game start', async ({ page, browser, v3 }) => {
  await page.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('双端混合验收');
  await page.getByRole('button', { name: '混合房' }).click();
  await page.getByLabel('电脑席数量').fill('11');
  await page.getByRole('button', { name: '继续选择角色' }).click();
  await page.getByRole('button', { name: '继续选择规则' }).click();
  await page.getByRole('button', { name: '查看确认' }).click();
  await page.getByRole('button', { name: '创建并进入等待房' }).click();
  await expect(page.locator('[data-room-status="waiting"]')).toBeVisible({ timeout: 30_000 });

  const roomCode = (await page.locator('.v3-room-code strong').textContent())?.trim();
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('werewolf-v3-session') ?? 'null') as {
    credentials?: { joinToken?: string };
  } | null);
  if (!roomCode || !session?.credentials?.joinToken) throw new Error('product-created room did not expose its scoped invite to the host UI');

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  try {
    await secondPage.addInitScript((url) => localStorage.setItem('wolf-server-url', url), v3.serverURL);
    await secondPage.goto(`${v3.appURL}/rooms/join?code=${encodeURIComponent(roomCode)}`);
    await secondPage.getByLabel('显示名称').fill('第二位玩家');
    await secondPage.getByLabel('邀请口令').fill(session.credentials.joinToken);
    await secondPage.getByRole('button', { name: '加入房间', exact: true }).click();
    await expect(secondPage.locator('[data-room-status="waiting"]')).toBeVisible({ timeout: 30_000 });
    await expect(secondPage.getByText('第二位玩家')).toBeVisible();

    await page.getByRole('button', { name: '开始准备' }).click();
    await expect(page.getByText('等待准备')).toBeVisible({ timeout: 20_000 });
    await expect(secondPage.getByText('等待准备')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: '准备开局' }).click();
    await secondPage.getByRole('button', { name: '准备开局' }).click();
    await expect(page.getByRole('button', { name: '开始对局' })).toBeEnabled({ timeout: 30_000 });
    await page.getByRole('button', { name: '开始对局' }).click();
    await expect(page.getByText('行动面板')).toBeVisible({ timeout: 45_000 });
    await expect(secondPage.getByText('行动面板')).toBeVisible({ timeout: 45_000 });
    await expect(secondPage.getByText('第二位玩家')).toBeVisible();
  } finally {
    await secondContext.close();
  }
});
