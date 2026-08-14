import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { NIGHT_STAGES } from '../index';

const coreDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('core source does not depend on server, frontend, or shared modules', () => {
  const sourceFiles = readdirSync(coreDir)
    .filter((fileName) => fileName.endsWith('.ts'))
    .map((fileName) => join(coreDir, fileName));

  for (const filePath of sourceFiles) {
    const source = readFileSync(filePath, 'utf8');
    assert.doesNotMatch(source, /from\s+['"](?:.*server|.*components|.*pages|.*stores|shared\/)/);
  }
});

test('core publishes exactly the five shared night stages', () => {
  assert.deepEqual(NIGHT_STAGES, [
    'guard_seer',
    'wolf_discussion',
    'wolf_vote',
    'witch',
    'resolve',
  ]);
});

test('core source excludes legacy role, revote stages, and entry victory checkpoints', () => {
  const source = readdirSync(coreDir)
    .filter((fileName) => fileName.endsWith('.ts'))
    .map((fileName) => readFileSync(join(coreDir, fileName), 'utf8'))
    .join('\n');

  assert.doesNotMatch(source, /['"]werewolf['"]/);
  assert.doesNotMatch(source, /wolf_revote(?:_discussion)?/);
  assert.doesNotMatch(source, /night_start/);
});
