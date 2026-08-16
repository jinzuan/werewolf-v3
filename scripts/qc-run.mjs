/** Run the V3 QC driver through the workspace's TypeScript runtime. */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

execFileSync(process.execPath, [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'test-drive.ts', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
