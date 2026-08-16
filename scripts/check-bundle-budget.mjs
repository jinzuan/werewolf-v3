import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'dist', 'assets');
const files = [];
for (const name of await readdir(assetDir)) {
  const file = path.join(assetDir, name);
  const details = await stat(file);
  if (details.isFile() && /\.(?:js|css)$/u.test(name)) files.push({ name, bytes: details.size });
}
const total = files.reduce((sum, file) => sum + file.bytes, 0);
const largest = files.reduce((max, file) => Math.max(max, file.bytes), 0);
const maxTotal = 4 * 1024 * 1024;
const maxChunk = 500 * 1024;
if (files.length === 0 || total > maxTotal || largest > maxChunk) {
  console.error(`Bundle budget failed: ${files.length} assets, ${total} bytes total, largest ${largest} bytes.`);
  process.exitCode = 1;
} else {
  console.log(`Bundle budget OK: ${files.length} assets, ${total} bytes total, largest ${largest} bytes.`);
}
