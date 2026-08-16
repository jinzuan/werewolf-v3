import { test, expect } from './fixtures/v3App';

test('join is a deep-linkable keyboard-safe route with browser back support', async ({ page, v3 }) => {
  await page.addInitScript((url) => {
    localStorage.setItem('wolf-server-url', url);
  }, v3.serverURL);

  await page.goto(`${v3.appURL}/lobby`);
  const joinButton = page.getByRole('button', { name: '加入房间', exact: true }).first();
  await joinButton.click();
  await expect(page.getByRole('heading', { name: '用房间码找到同伴' })).toBeVisible({ timeout: 20_000 });

  await page.goBack();
  await expect(page.getByRole('heading', { name: '邀请朋友，点亮一局狼人杀' })).toBeVisible();

  await page.goto(`${v3.appURL}/rooms/join?code=ab12cd&intent=play`);
  await expect(page.getByRole('heading', { name: '用房间码找到同伴' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '房间码' })).toHaveValue('AB12CD');
  await expect(page.getByRole('button', { name: '加入房间', exact: true })).toBeVisible();
});
