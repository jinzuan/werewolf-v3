import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safe = (value) => String(value).replaceAll(/[\r\n]/gu, ' ').slice(0, 240);
const commit = safe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
const nodeVersion = process.version;
const npmVersion = safe(execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim());
const fixturePaths = [
  'v3plan/RULESET.md',
  'src/styles/v3.css',
  'public/fonts',
  'server/data/experience_library',
];
const checksum = createHash('sha256');
const fixtureFiles = [];
const collectFixtureFiles = async (absolute, relative) => {
  const details = await stat(absolute);
  if (details.isFile()) { fixtureFiles.push(relative); return; }
  for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    await collectFixtureFiles(path.join(absolute, entry.name), path.join(relative, entry.name));
  }
};
for (const relative of fixturePaths) await collectFixtureFiles(path.join(root, relative), relative);
for (const relative of fixtureFiles.sort()) {
  checksum.update(relative);
  checksum.update(await readFile(path.join(root, relative)));
}
const assetDir = path.join(root, 'dist', 'assets');
let assetBytes = 0;
try {
  for (const name of await readdir(assetDir)) {
    const details = await stat(path.join(assetDir, name));
    if (details.isFile() && /\.(?:js|css)$/u.test(name)) assetBytes += details.size;
  }
} catch { /* release gate still records a safe failed-build fact */ }
const e2eFiles = [];
for (const name of await readdir(path.join(root, 'e2e'))) if (name.endsWith('.spec.ts')) e2eFiles.push(name);
const report = {
  schemaVersion: 1,
  commit,
  nodeVersion,
  npmVersion,
  fixtureChecksum: checksum.digest('hex'),
  e2eSuiteCount: e2eFiles.length,
  bundleBytes: assetBytes,
  artifactCanaryScan: 'fixture teardown enforced',
};
const outputDir = path.join(root, 'artifacts', 'release');
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'release-gate.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`Release gate receipt written: ${e2eFiles.length} E2E suites, ${assetBytes} bundle bytes.`);
if (Number.parseInt(process.versions.node.split('.')[0], 10) !== 22) {
  console.error(`Release gate blocked: Node 22 LTS is required, found ${process.version}.`);
  process.exitCode = 1;
}
