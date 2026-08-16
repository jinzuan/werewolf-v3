import { test, expect } from './fixtures/v3App';

const useServer = async (page: import('playwright').Page, serverURL: string): Promise<void> => {
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, serverURL);
};

const tabTo = async (
  page: import('playwright').Page,
  target: import('playwright').Locator,
  limit = 160,
): Promise<void> => {
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`keyboard focus did not reach ${await target.getAttribute('aria-label').catch(() => 'target')}`);
};

test('keyboard can enter the four-step wizard, inspect rules, and create a friend room', async ({ page, v3 }) => {
  await useServer(page, v3.serverURL);
  await page.goto(`${v3.appURL}/lobby`);

  const create = page.getByRole('button', { name: '创建房间' }).first();
  await tabTo(page, create);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });

  const roomName = page.getByLabel('房间名称');
  await tabTo(page, roomName);
  await page.keyboard.type('键盘验收房');
  const continueToRoles = page.getByRole('button', { name: '继续选择角色' });
  await tabTo(page, continueToRoles);
  await page.keyboard.press('Enter');
  const continueToRules = page.getByRole('button', { name: '继续选择规则' });
  await tabTo(page, continueToRules);
  await page.keyboard.press('Enter');

  const rulesButton = page.getByRole('button', { name: '查看完整规则', exact: true });
  await tabTo(page, rulesButton);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '完整规则' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '完整规则' })).toHaveCount(0);
  await expect(rulesButton).toBeFocused();

  const confirm = page.getByRole('button', { name: '查看确认' });
  await tabTo(page, confirm);
  await page.keyboard.press('Enter');
  const createRoom = page.getByRole('button', { name: '创建并进入等待房' });
  await expect(createRoom).toBeEnabled();
  await tabTo(page, createRoom);
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-room-status="waiting"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '键盘验收房' })).toBeVisible();
});

test('quick computer creation reaches the omniscient monitor through the product wizard', async ({ page, v3 }) => {
  await useServer(page, v3.serverURL);
  await page.goto('/rooms/new/players');
  await expect(page.getByRole('heading', { name: '先决定今晚有多少人' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('电脑局验收');
  await page.getByRole('button', { name: '快速电脑局' }).click();
  await page.getByRole('button', { name: '继续选择角色' }).click();
  await page.getByRole('button', { name: '继续选择规则' }).click();
  await page.getByRole('button', { name: '查看确认' }).click();
  await page.getByRole('button', { name: '创建并开始电脑局' }).click();

  await expect(page.getByText(/全知监控|结果与复盘/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/事件时间线|对局时间线|死亡记录/).first()).toBeVisible({ timeout: 20_000 });
});
