/**
 * qc-run.mjs — QC 试跑封装（NEXT_VERSION_PLAN_v2.md D 项）
 * v3.0 阶段 0b：test-drive.ts 改为 headless 直接驱动真实 engine（server/engine.ts），
 * 用 tsx 直跑（不再 tsc 编译 CJS——test-drive 依赖整个 server 栈）。
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

execFileSync(process.execPath, [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'test-drive.ts', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
