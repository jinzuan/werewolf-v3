import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '../../shared/types';

export type ExperienceRole = Role | 'common';

export interface ExperienceManifestEntry {
  path: string;
  role: ExperienceRole;
  bytes: number;
  sha256: string;
}

export interface ExperienceManifest {
  version: number;
  count: number;
  files: ExperienceManifestEntry[];
}

export interface ExperienceAsset extends ExperienceManifestEntry {
  content: string;
}

export interface ExperienceAssignment {
  assetId: string;
  text: string;
}

export interface ExperienceLibrary {
  manifest: ExperienceManifest;
  assets: ExperienceAsset[];
  getReference(role: Role, stageRevision: number): string;
  getAssignment(role: Role, stableKey: string): ExperienceAssignment;
}

export const EXPECTED_EXPERIENCE_FILE_COUNT = 33;

const ROLE_NAMES = new Set<ExperienceRole>([
  'common',
  'wolf',
  'seer',
  'witch',
  'hunter',
  'guardian',
  'villager',
]);

const DEFAULT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'experience_library',
);

const failManifest = (message: string): never => {
  throw new Error(`AI_EXPERIENCE_MANIFEST_INVALID:${message}`);
};

const digest = (content: Buffer): string =>
  createHash('sha256').update(content).digest('hex');

const stableIndex = (value: string, modulo: number): number => {
  if (modulo <= 0) return 0;
  const hash = createHash('sha256').update(value).digest();
  return hash.readUInt32BE(0) % modulo;
};

const parseManifest = (manifestPath: string): ExperienceManifest => {
  if (!existsSync(manifestPath)) {
    return failManifest(`missing:${manifestPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''),
    );
  } catch {
    return failManifest('invalid_json');
  }
  if (!raw || typeof raw !== 'object') return failManifest('invalid_shape');
  const candidate = raw as Partial<ExperienceManifest>;
  if (
    candidate.version !== 1 ||
    candidate.count !== EXPECTED_EXPERIENCE_FILE_COUNT ||
    !Array.isArray(candidate.files)
  ) {
    return failManifest('invalid_header');
  }
  const files = candidate.files.map((entry) => {
    if (!entry || typeof entry !== 'object') return failManifest('invalid_entry');
    const item = entry as Partial<ExperienceManifestEntry>;
    if (
      typeof item.path !== 'string' ||
      typeof item.role !== 'string' ||
      !ROLE_NAMES.has(item.role as ExperienceRole) ||
      typeof item.bytes !== 'number' ||
      !Number.isInteger(item.bytes) ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    ) {
      return failManifest('invalid_entry_fields');
    }
    return {
      path: item.path,
      role: item.role as ExperienceRole,
      bytes: item.bytes,
      sha256: item.sha256,
    };
  });
  if (files.length !== EXPECTED_EXPERIENCE_FILE_COUNT) {
    return failManifest('count_mismatch');
  }
  return {
    version: candidate.version,
    count: candidate.count,
    files,
  };
};

const compareSorted = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export function loadExperienceLibrary(
  directory = DEFAULT_DIRECTORY,
): ExperienceLibrary {
  const manifest = parseManifest(path.join(directory, 'manifest.json'));
  const manifestPaths = [...new Set(manifest.files.map((entry) => entry.path))].sort();
  if (manifestPaths.length !== manifest.files.length) {
    return failManifest('duplicate_paths');
  }

  const diskPaths = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        entry.name !== 'README.md',
    )
    .map((entry) => entry.name)
    .sort();
  if (!compareSorted(manifestPaths, diskPaths)) {
    return failManifest('disk_set_mismatch');
  }

  const assets = manifest.files
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => {
      const filePath = path.join(directory, entry.path);
      const content = readFileSync(filePath);
      const actualBytes = content.length;
      const actualHash = digest(content);
      if (actualBytes !== entry.bytes) {
        return failManifest(`bytes_mismatch:${entry.path}`);
      }
      if (actualHash !== entry.sha256) {
        return failManifest(`sha256_mismatch:${entry.path}`);
      }
      return {
        ...entry,
        content: content.toString('utf8'),
      };
    });

  return {
    manifest: {
      ...manifest,
      files: assets.map(({ content: _content, ...entry }) => entry),
    },
    assets,
    getReference(role, stageRevision) {
      const roleAssets = assets.filter((asset) => asset.role === role);
      const commonAssets = assets.filter((asset) => asset.role === 'common');
      const pick = (items: ExperienceAsset[]): string | null => {
        if (items.length === 0) return null;
        const index = Math.abs(stageRevision) % items.length;
        return items[index].content;
      };
      return [pick(roleAssets), pick(commonAssets)]
        .filter((content): content is string => content !== null)
        .join('\n\n');
    },
    getAssignment(role, stableKey) {
      const roleAssets = assets.filter((asset) => asset.role === role);
      const fallback = assets.find((asset) => asset.role === 'common') ?? assets[0];
      const asset = roleAssets[stableIndex(`${role}:${stableKey}`, roleAssets.length)] ?? fallback;
      return {
        assetId: asset?.path ?? `role:${role}:default`,
        text: asset?.content ?? '',
      };
    },
  };
}

export const experienceLibrary = loadExperienceLibrary();
