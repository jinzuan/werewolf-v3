import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.env.BUNDLE_DIST_DIR || 'dist');
const manifestCandidates = [
  path.join(distDir, '.vite', 'manifest.json'),
  path.join(distDir, 'manifest.json'),
];
const manifestPath = manifestCandidates.find((candidate) => existsSync(candidate));

const fail = (message) => {
  console.error(`[bundle-budget] ${message}`);
  process.exitCode = 1;
};

if (!manifestPath) {
  fail(`manifest not found under ${distDir}; run the production build first`);
  process.exit();
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = Object.values(manifest);
const byFile = new Map(entries.map((entry) => [entry.file, entry]));

const fileBytes = (relative) => {
  const absolute = path.join(distDir, relative);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`manifest asset is missing: ${relative}`);
  }
  return readFileSync(absolute);
};

const gzipBytes = (relative) => gzipSync(fileBytes(relative), { level: 9 }).byteLength;
const rawBytes = (relative) => fileBytes(relative).byteLength;

const collectManifestFiles = (entry, files = new Set(), seen = new Set()) => {
  if (!entry || seen.has(entry.file)) return files;
  seen.add(entry.file);
  files.add(entry.file);
  for (const css of entry.css || []) files.add(css);
  for (const imported of entry.imports || []) {
    const importedEntry = byFile.get(imported) || manifest[imported];
    collectManifestFiles(importedEntry, files, seen);
  }
  return files;
};

const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
const initialFiles = new Set([
  ...[...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
    .map((match) => match[1].replace(/^\//, '')),
]);
const initialJsGzip = [...initialFiles]
  .filter((file) => file.endsWith('.js'))
  .reduce((total, file) => total + gzipBytes(file), 0);

const lobbyEntry = entries.find((entry) =>
  typeof entry.src === 'string' && /(?:^|\/)LobbyPage\.tsx$/.test(entry.src),
);
if (!lobbyEntry) {
  fail('manifest entry for LobbyPage.tsx not found');
}
const lobbyFiles = lobbyEntry ? collectManifestFiles(lobbyEntry) : new Set();
for (const file of initialFiles) lobbyFiles.add(file);
const lobbyGzip = [...lobbyFiles]
  .filter((file) => file.endsWith('.js') || file.endsWith('.css'))
  .reduce((total, file) => total + gzipBytes(file), 0);

const assetsDir = path.join(distDir, 'assets');
const jsChunks = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((file) => file.endsWith('.js')).map((file) => `assets/${file}`)
  : [];
const largestChunk = jsChunks.reduce(
  (largest, file) => rawBytes(file) > largest.bytes ? { file, bytes: rawBytes(file) } : largest,
  { file: '(none)', bytes: 0 },
);
const allAssetBytes = jsChunks
  .concat(existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((file) => file.endsWith('.css')).map((file) => `assets/${file}`)
    : [])
  .reduce((total, file) => total + rawBytes(file), 0);

const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;
console.log(`[bundle-budget] initial JS gzip: ${kib(initialJsGzip)} / 110 KiB`);
console.log(`[bundle-budget] lobby JS+CSS gzip: ${kib(lobbyGzip)} / 135 KiB`);
console.log(`[bundle-budget] largest JS chunk: ${largestChunk.file} ${kib(largestChunk.bytes)} / 150 KiB raw`);
console.log(`[bundle-budget] all JS+CSS raw: ${kib(allAssetBytes)} / 4096 KiB`);

if (initialJsGzip > 110 * 1024) fail('initial HTML JavaScript gzip budget exceeded');
if (lobbyGzip > 135 * 1024) fail('lobby route JavaScript + CSS gzip budget exceeded');
if (largestChunk.bytes > 150 * 1024) fail('single JavaScript chunk raw budget exceeded');
if (allAssetBytes > 4 * 1024 * 1024) fail('all JavaScript and CSS assets raw budget exceeded');

if (process.exitCode) process.exit();
console.log('[bundle-budget] all budgets pass');
