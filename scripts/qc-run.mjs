/**
 * qc-run.mjs — QC 试跑封装。
 * test-drive.ts 使用正式 V3 composition root 的 headless application，
 * 用 tsx 直跑，确保 QC 与生产/主测试共享同一服务装配路径。
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

execFileSync(process.execPath, [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'test-drive.ts', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
