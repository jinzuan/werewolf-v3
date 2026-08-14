/**
 * smoke-full-game.mjs — 全流程模拟局：斗蛐蛐（纯 AI 12 人）自动打完一局 + 复盘生成 + 存档。
 * 用空 apiKey 的 siliconflow 配置触发"内置回复"，不依赖真实中转，跑通引擎全流程。
 * 用法：node scripts/smoke-full-game.mjs
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import path from 'node:path';

const PORT = 3102;
const HOST = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const configPath = path.resolve('scripts/ai-test-empty.json');
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), WEREWOLF_AI_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (d) => { logs.push(d.toString()); process.stdout.write(d); });
  server.stderr.on('data', (d) => { logs.push(d.toString()); process.stdout.write(d); });

  let booted = false;
  for (let i = 0; i < 60; i++) {
    if (logs.some((l) => l.includes('联机服务已启动'))) { booted = true; break; }
    await sleep(200);
  }
  if (!booted) { console.error('启动失败\n', logs.join('')); server.kill(); process.exit(1); }
  console.log('[full] 服务已启动（内置回复模式，无网络）');

  let passed = 0;
  const check = (name, cond) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { console.error(`  ✗ ${name}`); process.exitCode = 1; }
  };

  try {
    const s = io(HOST, { reconnection: false });
    await new Promise((r) => s.on('connect', r));
    let last = null;
    s.on('snapshot', (snap) => { last = snap; });

    const createRes = await new Promise((r) => s.emit('create-room', { roomName: '斗蛐蛐', maxPlayers: 12, aiCount: 12, name: '系统', auto: true, reviewEnabled: true }, r));
    check('斗蛐蛐创建 ok', createRes.ok === true);
    check('斗蛐蛐返回令牌', typeof createRes.token === 'string' && createRes.token.length >= 16);
    check('斗蛐蛐创建者 isCreator', createRes.snapshot?.isCreator === true);
    check('斗蛐蛐创建者快照含 joinToken', typeof createRes.snapshot?.joinToken === 'string');

    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      await sleep(1200);
      const snap = last || createRes.snapshot;
      if (!snap || !snap.gameState) continue;
      if (snap.review && snap.review.stage === 'done' && snap.gameState.phase === 'ended') break;
    }

    const snap = last || createRes.snapshot;
    console.log(`[full] 最终快照: phase=${snap?.gameState?.phase} winner=${snap?.gameState?.winner} review=${snap?.review?.stage} 天=${snap?.gameState?.day} 消息=${snap?.messages?.length}`);

    check('对局结束 phase=ended', snap?.gameState?.phase === 'ended');
    check('有胜方', snap?.gameState?.winner === 'wolf' || snap?.gameState?.winner === 'good');
    check('复盘完成', snap?.review?.stage === 'done');
    check('复盘有消息', (snap?.review?.messages?.length || 0) > 0);
    check('有死亡记录', (snap?.gameState?.day || 1) >= 1);

    const arch = await new Promise((r) => s.emit('get-archives', {}, r));
    check('存档已生成', Array.isArray(arch.archives) && arch.archives.length >= 1);
    if (arch.archives?.[0]) {
      check('存档含复盘消息', arch.archives[0].reviewMessages.length > 0);
      console.log(`  存档: ${arch.archives[0].roomCode} 第${arch.archives[0].day}天 ${arch.archives[0].winner} 复盘${arch.archives[0].reviewMessages.length}条 心得${arch.archives[0].insights.length}条`);
    }

    // P1-6：auto 房间复盘默认关闭（显式 reviewEnabled 才开启）
    const s2 = io(HOST, { reconnection: false });
    await new Promise((r) => s2.on('connect', r));
    const auto2 = await new Promise((r) => s2.emit('create-room', { roomName: 'x', maxPlayers: 12, aiCount: 12, name: 'x', auto: true }, r));
    check('auto 复盘默认关闭', auto2.ok === true && auto2.snapshot?.review?.enabled === false);
    s2.disconnect();

    console.log(`\n[full] 通过 ${passed} 项检查`);
  } catch (e) {
    console.error('[full] 异常:', e);
    process.exitCode = 1;
  } finally {
    server.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  }
}

main();
