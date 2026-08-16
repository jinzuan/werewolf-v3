import { readFile, readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from 'playwright';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage']);

export const newArtifactCanary = (namespace = 'e2e'): string =>
  `WW_CANARY_${namespace}_${randomUUID()}`;

const containsInTree = async (root: string, canary: string, hits: string[]): Promise<void> => {
  let details;
  try {
    details = await stat(root);
  } catch {
    return;
  }
  if (details.isDirectory()) {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      await containsInTree(path.join(root, entry.name), canary, hits);
    }
    return;
  }
  if (!details.isFile() || details.size > 8 * 1024 * 1024) return;
  try {
    const text = await readFile(root, 'utf8');
    if (text.includes(canary)) hits.push(root);
  } catch {
    // Binary screenshots/videos are not text artifacts; their names and
    // containing metadata are still checked by the caller where applicable.
  }
};

export const assertNoArtifactCanary = async (
  roots: readonly string[],
  canary: string,
): Promise<void> => {
  const hits: string[] = [];
  for (const root of roots) await containsInTree(root, canary, hits);
  if (hits.length > 0) throw new Error(`artifact canary leaked to ${hits.length} file(s)`);
};

export const assertPageHasNoArtifactCanary = async (page: Page, canary: string): Promise<void> => {
  const state = await page.evaluate(() => ({
    url: location.href,
    body: document.body.innerHTML,
    localStorage: Object.entries(localStorage),
    sessionStorage: Object.entries(sessionStorage),
  }));
  const serialized = JSON.stringify(state);
  if (serialized.includes(canary)) throw new Error('artifact canary leaked to URL, DOM, or browser storage');
};
