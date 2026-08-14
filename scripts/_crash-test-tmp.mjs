import { spawn } from 'node:child_process';
import http from 'node:http';
import { io } from 'socket.io-client';

const PORT = 3198;
const HOST = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (logs.some((l) => l.includes('联机服务已启动'))) { booted = true; break; }
  await sleep(200);
}
if (!booted) { console.log('RESULT: START_FAIL'); server.kill(); process.exit(1); }

let exited = false;
server.on('exit', () => { exited = true; });

await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/%ZZ%ZZ%ZZ' }, (res) => { res.resume(); res.on('end', resolve); });
  req.on('error', resolve);
  req.end();
});
await sleep(300);
console.log('RESULT after malformed-URL: server alive =', !exited);

const s = io(HOST, { reconnection: false });
await new Promise((r) => s.on('connect', r));
s.emit('action', { roomCode: null, playerId: undefined, action: { t: 'destroy-room' } });
s.emit('action', { roomCode: 'NO', playerId: 'x', action: {} });
s.emit('join-room', { roomCode: { evil: true } });
s.emit('create-room', { maxPlayers: 'NaN' });
await sleep(500);
console.log('RESULT after malformed-socket: server alive =', !exited);

let gotSnap = false;
s.on('snapshot', () => { gotSnap = true; });
await sleep(500);
console.log('RESULT unverified socket got snapshot =', gotSnap);

server.kill();
await sleep(200);
console.log('RESULT server alive at end =', !exited);
process.exit(0);
