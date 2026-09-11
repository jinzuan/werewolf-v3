import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdown = readFileSync(path.join(root, 'v3plan', 'RULESET.md'), 'utf8');
const source = readFileSync(path.join(root, 'src/core/rules.ts'), 'utf8');
const yaml = markdown.match(/```yaml\s*([\s\S]*?)```/u)?.[1] ?? '';
if (!yaml) throw new Error('RULESET.md has no YAML specification block');

const markdownKeys = [...yaml.matchAll(/^\s+key:\s+([^\s#]+)\s*$/gmu)].map((match) => match[1]);
const sourceKeyBlock = source.match(/export const RULE_KEYS = \[([\s\S]*?)\]\s+as const;/u)?.[1] ?? '';
const sourceKeys = [...sourceKeyBlock.matchAll(/^\s+'([^']+)',\s*$/gmu)].map((match) => match[1]);
const unique = (values) => [...new Set(values)];
const failures = [];
if (markdownKeys.length !== 92) failures.push(`RULESET.md contains ${markdownKeys.length} leaf keys; expected 92`);
if (unique(markdownKeys).length !== markdownKeys.length) failures.push('RULESET.md contains duplicate leaf keys');
if (unique(sourceKeys).length !== sourceKeys.length) failures.push('src/core/rules.ts contains duplicate rule keys');
if (sourceKeys.length !== 92) failures.push(`src/core/rules.ts exports ${sourceKeys.length} rule keys; expected 92`);
if (JSON.stringify(unique(markdownKeys).sort()) !== JSON.stringify(unique(sourceKeys).sort())) {
  failures.push('Markdown and core rule key sets differ');
}
for (const key of markdownKeys) {
  const block = yaml.match(new RegExp(`key:\\s+${key.replaceAll('.', '\\.') }[\\s\\S]*?(?=\\n {4}[A-Za-z0-9_]+:|$)`, 'u'))?.[0] ?? '';
  if (!/\n\s+value:\s+/u.test(block) || !/\n\s+source:\s+/u.test(block) || !/\n\s+description:\s+/u.test(block)) {
    failures.push(`${key} is missing value/source/description`);
  }
}
if (failures.length > 0) {
  console.error('RuleSet check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('RuleSet check OK: 92 unique Markdown/core leaf keys.');
}
