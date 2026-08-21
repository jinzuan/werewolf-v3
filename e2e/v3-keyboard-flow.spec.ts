import { test, expect } from './fixtures/v3App';
import { io as createClient } from 'socket.io-client';
import type { RoomAccess, RoomCreationCatalog } from '../shared/protocol';

type CatalogAck = { ok: true; catalog: RoomCreationCatalog };
type CreateAck = { ok: true } & RoomAccess;

const createQuickComputerRoom = async (serverURL: string): Promise<RoomAccess> => {
  const socket = createClient(serverURL, {
    transports: ['polling'],
    reconnection: false,
    timeout: 5_000,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const catalog = await new Promise<CatalogAck>((resolve) => {
      socket.emit('v3:command', {
        meta: { commandId: 'e2e-catalog', actorId: 'e2e-quick-reader', sentAt: Date.now() },
        command: { type: 'catalog.get', payload: {} },
      }, resolve);
    });
    const preset = catalog.catalog.rolePresets.find((item) => item.enabled);
    if (!preset) throw new Error('No enabled E2E room preset');
    const options = {
      ...preset,
      catalogVersion: catalog.catalog.catalogVersion,
      roomName: '快速电脑局验收',
      creator: { name: '浏览器观察者', avatarId: 'avatar-player' },
      mode: 'quick_computer' as const,
      visibility: 'invite_only' as const,
      maxPlayers: preset.playerCount,
      minHumanPlayers: 0,
      computerSeats: 0,
      aiFillPolicy: 'fill_to_max' as const,
      roleSetup: preset.roleSetup,
      rolePresetId: preset.id,
      rulesetId: preset.rulesetId,
      rulesetVersion: preset.rulesetVersion,
      readyPolicy: 'all_connected_humans' as const,
      allowPublicSpectators: false,
      reviewEnabled: true,
    };
    const response = await new Promise<CreateAck>((resolve) => {
      socket.emit('v3:command', {
        meta: { commandId: 'e2e-quick-create', actorId: 'e2e-quick-host', sentAt: Date.now() },
        actorName: '浏览器观察者',
        command: { type: 'room.create', payload: { createRequestId: 'e2e-quick-create', options } },
      }, resolve);
    });
    return response;
  } finally {
    socket.disconnect();
  }
};

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

test('keyboard can enter room settings, inspect rules, and create a friend room', async ({ page, v3 }) => {
  await useServer(page, v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });

  const roomName = page.getByLabel('房间名称');
  await roomName.focus();
  await roomName.fill('键盘验收房');

  const rulesButton = page.getByRole('button', { name: '查看完整规则', exact: true }).first();
  await rulesButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '完整规则' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '完整规则' })).toHaveCount(0);
  await expect(rulesButton).toBeFocused();

  const createRoom = page.getByRole('button', { name: '创建并进入等待房', exact: true });
  await expect(createRoom).toBeEnabled();
  await createRoom.focus();
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-room-status="ready_check"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.v3-room-header__identity strong')).toHaveText('键盘验收房');
});

test('quick computer creation resumes into the omniscient monitor through a direct room access', async ({ page, v3 }) => {
  const access = await createQuickComputerRoom(v3.serverURL);
  await page.addInitScript(({ serverURL, session }) => {
    localStorage.setItem('wolf-server-url', serverURL);
    localStorage.setItem('werewolf-v3-session', JSON.stringify(session));
  }, {
    serverURL: v3.serverURL,
    session: {
      version: 2,
      actorId: access.room.viewer.actorId,
      actorName: '浏览器观察者',
      roomCode: access.room.code,
      roomId: access.room.id,
      credentials: access.credentials,
      mode: 'spectator',
      gameId: access.room.gameId,
      lastSeenSeq: 0,
    },
  });
  await page.goto(`${v3.appURL}/rooms/${access.room.code}`);
  await expect(page).toHaveURL(/\/rooms\/[^/]+\/monitor/, { timeout: 60_000 });
  await expect(page.getByText('全知监控')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('完整对局记录')).toBeVisible();
});

test('quick computer creation reaches the omniscient monitor through the product wizard', async ({ page, v3 }) => {
  await useServer(page, v3.serverURL);
  await page.goto(`${v3.appURL}/rooms/new/players`);
  await expect(page.getByRole('heading', { name: '房间设置', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('房间名称').fill('电脑局验收');
  await page.getByRole('button', { name: '快速电脑局' }).click();
        await page.getByRole('button', { name: '创建并开始电脑局' }).click();

  await expect(page.getByText(/全知监控|结果与复盘/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('全知监控')).toBeVisible();
});
