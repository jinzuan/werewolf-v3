import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(SCRIPT_DIR, '..');
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.json', '.md', '.ts', '.tsx']);
const CJK_RANGES = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
];
const REQUIRED_SYMBOLS = new Set([
  ...'，。！？：；、“”‘’（）【】《》〈〉「」『』〔〕…——～·、　',
  ...'0123456789０１２３４５６７８９',
]);

const FONT_GROUPS = [
  { name: 'body 400', prefix: 'noto-sans-sc-400-' },
  { name: 'body 600', prefix: 'noto-sans-sc-600-' },
  { name: 'body 700', prefix: 'noto-sans-sc-700-' },
  { name: 'display 600', prefix: 'noto-serif-sc-600-' },
  { name: 'display 700', prefix: 'noto-serif-sc-700-' },
];
const CSS_FAMILIES = [
  { name: 'WW Noto Sans SC', weights: [400, 600, 700], prefix: 'noto-sans-sc-' },
  { name: 'WW Noto Serif SC', weights: [600, 700], prefix: 'noto-serif-sc-' },
];

const isInRange = (codePoint, [start, end]) => codePoint >= start && codePoint <= end;

const isRequiredCodePoint = (codePoint, character) =>
  CJK_RANGES.some((range) => isInRange(codePoint, range)) || REQUIRED_SYMBOLS.has(character);

const walkTextFiles = (directory, files = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'coverage') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'data' && (directory.endsWith('/server') || directory.endsWith('/src'))) continue;
      walkTextFiles(path, files);
      continue;
    }
    if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
};

const sourceFiles = (workspace) => {
  const files = [join(workspace, 'index.html'), join(workspace, 'v3plan', 'RULESET.md')];
  for (const directory of ['src', 'shared', 'server']) {
    const path = join(workspace, directory);
    if (statSync(path).isDirectory()) files.push(...walkTextFiles(path));
  }
  return files.filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
};

const collectRequiredCodePoints = (workspace) => {
  const codePoints = new Set();
  for (const path of sourceFiles(workspace)) {
    const text = readFileSync(path, 'utf8');
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (isRequiredCodePoint(codePoint, character)) codePoints.add(codePoint);
    }
  }
  return [...codePoints].sort((a, b) => a - b);
};

const parseArgs = (args) => {
  const options = { workspace: WORKSPACE, fontDir: null, fonts: [], skipCss: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--skip-css') {
      options.skipCss = true;
    } else if (arg === '--workspace' || arg === '--font-dir' || arg === '--font') {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--workspace') options.workspace = resolve(value);
      if (arg === '--font-dir') options.fontDir = resolve(value);
      if (arg === '--font') options.fonts.push(resolve(value));
    } else if (arg === '--help') {
      console.log('Usage: node scripts/check-font-coverage.mjs [--workspace DIR] [--font-dir DIR] [--font FILE] [--skip-css]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
};

const parseCharset = (charset) => {
  const codePoints = new Set();
  for (const token of charset.trim().split(/\s+/).filter(Boolean)) {
    const [startText, endText = startText] = token.split('-');
    const start = Number.parseInt(startText, 16);
    const end = Number.parseInt(endText, 16);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
    for (let codePoint = start; codePoint <= end; codePoint += 1) codePoints.add(codePoint);
  }
  return codePoints;
};

const readFontCodePoints = (fontPath) => {
  const result = spawnSync('fc-query', ['--format=%{charset}', fontPath], { encoding: 'utf8' });
  if (result.error) throw new Error(`fc-query is required to inspect ${fontPath}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`fc-query could not read ${fontPath}: ${result.stderr || 'unknown error'}`);
  return parseCharset(result.stdout);
};

const findFonts = (fontDir, explicitFonts) => {
  if (explicitFonts.length > 0) return explicitFonts;
  const files = readdirSync(fontDir).sort();
  return FONT_GROUPS.map(({ prefix }) => files
    .filter((file) => file.startsWith(prefix) && file.endsWith('.woff2'))
    .map((file) => join(fontDir, file))).flat();
};

const missingCharacters = (requiredCodePoints, availableCodePoints) =>
  requiredCodePoints.filter((codePoint) => !availableCodePoints.has(codePoint));

const formatCodePoint = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

const checkFonts = (workspace, fontDir, explicitFonts, requiredCodePoints) => {
  const failures = [];
  const selectedFonts = findFonts(fontDir, explicitFonts);
  if (selectedFonts.length === 0) failures.push(`no WOFF2 files found in ${fontDir}`);

  for (const group of FONT_GROUPS) {
    const paths = explicitFonts.length > 0
      ? selectedFonts
      : selectedFonts.filter((path) => path.includes(`/${group.prefix}`));
    if (paths.length === 0) {
      failures.push(`${group.name}: no font asset found (expected ${group.prefix}*.woff2)`);
      continue;
    }
    const available = new Set();
    for (const path of paths) {
      for (const codePoint of readFontCodePoints(path)) available.add(codePoint);
    }
    const missing = missingCharacters(requiredCodePoints, available);
    if (missing.length > 0) {
      failures.push(`${group.name}: missing ${missing.length} glyphs: ${missing.slice(0, 24).map(formatCodePoint).join(', ')}`);
    }
  }
  return failures;
};

const checkCss = (workspace, fontDir) => {
  const cssPath = join(workspace, 'src', 'styles', 'v3.css');
  const css = readFileSync(cssPath, 'utf8');
  const failures = [];
  const faceBlocks = [...css.matchAll(/@font-face\s*{([\s\S]*?)}/g)].map((match) => match[1]);
  if (css.includes("font-family: 'Noto Sans SC'")) failures.push('v3.css still uses the upstream Noto Sans SC family name');
  if (css.includes("font-family: 'Noto Serif SC'")) failures.push('v3.css still uses the upstream Noto Serif SC family name');
  for (const { name, weights, prefix } of CSS_FAMILIES) {
    if (!css.includes(`font-family: '${name}'`)) failures.push(`v3.css does not declare ${name}`);
    for (const weight of weights) {
      const declaration = faceBlocks.find((block) =>
        block.includes(`font-family: '${name}'`) &&
        block.includes(`font-weight: ${weight};`) &&
        block.includes(`src: url('/fonts/${prefix}${weight}-`));
      if (!declaration) failures.push(`${name} has no correctly mapped local weight ${weight} declaration`);
    }
  }
  for (const asset of css.matchAll(/src: url\('\/fonts\/([^']+\.woff2)'\)/g)) {
    try {
      if (!statSync(join(fontDir, asset[1])).isFile()) failures.push(`CSS references missing font asset ${asset[1]}`);
    } catch {
      failures.push(`CSS references missing font asset ${asset[1]}`);
    }
  }
  return failures;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const fontDir = options.fontDir ?? join(options.workspace, 'public', 'fonts');
  const requiredCodePoints = collectRequiredCodePoints(options.workspace);
  const failures = checkFonts(options.workspace, fontDir, options.fonts, requiredCodePoints);
  if (!options.skipCss) failures.push(...checkCss(options.workspace, fontDir));
  if (failures.length > 0) {
    console.error('Font coverage check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Font coverage OK: ${requiredCodePoints.length} required code points across ${findFonts(fontDir, options.fonts).length} WOFF2 assets.`);
};

main();
