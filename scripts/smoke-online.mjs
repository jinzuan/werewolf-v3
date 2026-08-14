/**
 * smoke-online.mjs — v2.4.7 联机冒烟测试：
 * 起 server，模拟双浏览器同房（创建/加入/鉴权/房主校验/身份掩码/状态广播/观战）。
 * 用法：node scripts/smoke-online.mjs
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const PORT = 3101;
const HOST = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let booted = false;
  const logs = [];
  server.stdout.on('data', (d) => logs.push(d.toString()));
  server.stderr.on('data', (d) => logs.push(d.toString()));
  for (let i = 0; i < 60; i++) {
    if (logs.some((l) => l.includes('联机服务已启动'))) {
      booted = true;
      break;
    }
    await sleep(200);
  }
  if (!booted) {
    console.error('[smoke] 服务启动失败\n', logs.join(''));
    server.kill();
    process.exit(1);
  }
  console.log('[smoke] 服务已启动');

  let passed = 0;
  const check = (name, cond) => {
    if (cond) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      console.error(`  ✗ ${name}`);
      process.exitCode = 1;
    }
  };

  try {
    const makeClient = () => {
      const s = io(HOST, { reconnection: false });
      const queue = [];
      const waiters = [];
      const hostErrors = [];
      s.on('snapshot', (snap) => {
        if (waiters.length) waiters.shift()(snap);
        else queue.push(snap);
      });
      s.on('host-error', (e) => hostErrors.push(e));
      const next = () =>
        new Promise((r) => {
          if (queue.length) r(queue.shift());
          else waiters.push(r);
        });
      const waitForPhase = async (phase, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const snap = await Promise.race([next(), sleep(timeoutMs).then(() => null)]);
          if (!snap) return null;
          if (snap?.gameState?.phase === phase) return snap;
        }
        return null;
      };
      return { s, next, waitForPhase, hostErrors };
    };

    // 客户端A：创建房间（真人房主 + AI 补齐）
    const a = makeClient();
    await new Promise((r) => a.s.on('connect', r));
    const createRes = await new Promise((r) => a.s.emit('create-room', { roomName: '冒烟房', maxPlayers: 6, aiCount: 5, name: '房主甲' }, r));
    check('创建房间返回 ok', createRes.ok === true);
    check('房间码为5位', /^[A-Z2-9]{5}$/.test(createRes.roomCode || ''));
    check('创建返回进入令牌', typeof createRes.token === 'string' && createRes.token.length >= 16);
    check('房主快照含玩家', (createRes.snapshot?.players?.length || 0) === 6);
    check('房主 isHost', createRes.snapshot?.isHost === true);
    const roomCode = createRes.roomCode;
    const hostPlayerId = createRes.playerId;
    const roomToken = createRes.token;

    // 快照推送（broadcast）
    const snap1 = await a.next();
    check('房主收到快照广播', !!snap1 && snap1.roomCode === roomCode);

    // 客户端B：无令牌加入 → 拒绝
    const b = makeClient();
    await new Promise((r) => b.s.on('connect', r));
    const joinNoToken = await new Promise((r) => b.s.emit('join-room', { roomCode, name: '玩家乙' }, r));
    check('无令牌加入被拒', joinNoToken.ok === false);

    // 客户端B：错误令牌加入 → 拒绝
    const joinBadToken = await new Promise((r) => b.s.emit('join-room', { roomCode, name: '玩家乙', token: 'WRONG-TOKEN' }, r));
    check('错误令牌加入被拒', joinBadToken.ok === false);

    // 客户端B：正确令牌加入 → 成功
    const joinRes = await new Promise((r) => b.s.emit('join-room', { roomCode, name: '玩家乙', token: roomToken }, r));
    check('正确令牌加入返回 ok', joinRes.ok === true);
    check('加入者非房主', joinRes.snapshot?.isHost === false);

    // 非房主执行房主操作（开局）→ 拒绝且不影响对局
    b.s.emit('action', { roomCode, playerId: joinRes.playerId, action: { t: 'start-game' } });
    await sleep(300);
    check('非房主开局被拒（host-error）', b.hostErrors.some((e) => /房主/.test(e?.message || '')));
    const snapAfterFake = await Promise.race([a.next(), sleep(500).then(() => null)]);
    const phaseStillWaiting = !snapAfterFake || snapAfterFake?.gameState === null;
    check('非房主开局未生效', phaseStillWaiting);

    // 非房主踢人/销毁也被拒
    b.s.emit('action', { roomCode, playerId: joinRes.playerId, action: { t: 'kick-player', playerId: hostPlayerId } });
    b.s.emit('action', { roomCode, playerId: joinRes.playerId, action: { t: 'destroy-room' } });
    await sleep(200);
    check('非房主踢人/销毁被拒', b.hostErrors.filter((e) => /房主/.test(e?.message || '')).length >= 3);

    // 准备 + 开始（房主）
    a.s.emit('action', { roomCode, playerId: hostPlayerId, action: { t: 'ready' } });
    b.s.emit('action', { roomCode, playerId: joinRes.playerId, action: { t: 'ready' } });
    await sleep(150);
    a.s.emit('action', { roomCode, playerId: hostPlayerId, action: { t: 'start-game' } });
    const snapStarted = await a.waitForPhase('roleSelect');
    check('房主开局 phase=roleSelect', snapStarted?.gameState?.phase === 'roleSelect');

    // 确认角色 → 进入夜晚（房主）
    a.s.emit('action', { roomCode, playerId: hostPlayerId, action: { t: 'confirm-roles' } });
    const snapNight = await a.waitForPhase('night');
    check('房主确认后 phase=night', snapNight?.gameState?.phase === 'night');

    // 身份掩码（P0-1）
    check('房主快照含 joinToken', typeof snap1.joinToken === 'string');
    check(
      '房主视角其他玩家身份已掩码（非狼时）',
      snapNight?.players.every(
        (p) => p.id === hostPlayerId || p.role === null || snapNight.myRole === 'wolf'
      ) === true
    );
    check(
      '房主视角 nightActions 不含他人神职行动',
      (snapNight?.gameState?.nightActions || []).every(
        (act) => act.playerId === hostPlayerId || act.playerId === 'wolf' || act.action === 'kill'
      ) === true
    );
    check(
      '房主视角 actionDone 仅本人',
      Object.keys(snapNight?.gameState?.actionDone || {}).every((k) => k === hostPlayerId)
    );

    // 观战加入（对局已开始 → 自动观战，需令牌）
    const c = makeClient();
    await new Promise((r) => c.s.on('connect', r));
    const specNoToken = await new Promise((r) => c.s.emit('join-room', { roomCode, name: '观众丙', spectator: true }, r));
    check('无令牌观战被拒', specNoToken.ok === false);
    const specRes = await new Promise((r) => c.s.emit('join-room', { roomCode, name: '观众丙', spectator: true, token: roomToken }, r));
    check('带令牌观战加入 ok', specRes.ok === true && specRes.snapshot?.isSpectator === true);
    check('观战可见全部身份', specRes.snapshot?.players.every((p) => p.role !== null) === true);
    check('观战快照不含 joinToken', specRes.snapshot?.joinToken === undefined);

    // 发言（action 校验不崩）
    a.s.emit('action', { roomCode, playerId: hostPlayerId, action: { t: 'skip-speech' } });

    // 重连：带令牌恢复身份
    const d = makeClient();
    await new Promise((r) => d.s.on('connect', r));
    const reconnRes = await new Promise((r) => d.s.emit('reconnect-room', { roomCode, playerId: hostPlayerId, token: roomToken }, r));
    check('带令牌重连成功', reconnRes.ok === true && reconnRes.playerId === hostPlayerId);
    const badReconn = await new Promise((r) => d.s.emit('reconnect-room', { roomCode, playerId: hostPlayerId, token: 'WRONG' }, r));
    check('错误令牌重连被拒', badReconn.ok === false);

    // 存档列表
    const arch = await new Promise((r) => a.s.emit('get-archives', {}, r));
    check('存档列表可读', arch.ok === true && Array.isArray(arch.archives));

    console.log(`\n[smoke] 通过 ${passed} 项检查`);
  } catch (e) {
    console.error('[smoke] 异常:', e);
    process.exitCode = 1;
  } finally {
    server.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  }
}

main();
