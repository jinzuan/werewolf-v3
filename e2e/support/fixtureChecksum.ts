import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Formal, reviewed assets whose bytes must not be mutated by a test suite. */
export const FORMAL_FIXTURE_PATHS = [
  'v3plan/RULESET.md',
  'src/styles/v3.css',
  'public/fonts',
  'server/data/experience_library',
] as const;

const filesUnder = async (root: string, relativeRoot: string, output: string[]): Promise<void> => {
  const details = await stat(root);
  if (details.isFile()) {
    output.push(relativeRoot);
    return;
  }
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    await filesUnder(path.join(root, entry.name), path.join(relativeRoot, entry.name), output);
  }
};

export const computeFixtureChecksum = async (
  workspace: string,
  fixturePaths: readonly string[] = FORMAL_FIXTURE_PATHS,
): Promise<string> => {
  const files: string[] = [];
  for (const relativePath of fixturePaths) {
    const absolute = path.join(workspace, relativePath);
    try {
      await filesUnder(absolute, relativePath, files);
    } catch {
      throw new Error(`formal fixture is missing: ${relativePath}`);
    }
  }
  const hash = createHash('sha256');
  for (const relativePath of files.sort()) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(path.join(workspace, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
};

export const assertFixtureChecksum = (before: string, after: string): void => {
  if (before !== after) throw new Error('formal fixture checksum changed during the suite');
};
