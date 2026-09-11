import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['test', 'server/__tests__', 'src', 'e2e'];
const extensions = new Set(['.js', '.mjs', '.ts', '.tsx']);
const hits = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'artifacts') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (extensions.has(path.extname(entry.name))) {
      const text = await readFile(file, 'utf8');
      const pattern = /\b(?:test|it|describe|suite|specify)\s*\.\s*(?:only|skip)\s*\(/gu;
      let match;
      while ((match = pattern.exec(text))) {
        const line = text.slice(0, match.index).split('\n').length;
        hits.push(`${path.relative(root, file)}:${line}`);
      }
    }
  }
};
for (const relative of roots) {
  try { await stat(path.join(root, relative)); await walk(path.join(root, relative)); } catch { /* optional source root */ }
}
if (hits.length > 0) {
  console.error(`Focused/skipped test declarations found: ${hits.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('Focused-test gate OK: 0 only and 0 skip declarations.');
}
