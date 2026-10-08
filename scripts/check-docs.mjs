// Fails when an input or output declared in an action.yml is not mentioned in its README.md
// section: the root action above "## Actions in this repository", each sub-action under its
// own "### `name`" heading. Scoping matters because the actions share input names (api_key,
// api_base), so a README-wide search would let one action's table cover another's gap.
//
// Run with `npm test` (or `node scripts/check-docs.mjs`). No dependencies: action.yml files
// here keep inputs and outputs as two-space-indented keys under top-level `inputs:` and
// `outputs:`, which is all this reads. A name counts as documented when it appears in
// backticks, the way the README tables write them.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actions = [
  { file: 'action.yml', start: null, end: '## Actions in this repository' },
  { file: 'upload-artifact/action.yml', start: '### `upload-artifact`', end: '\n### ' },
  { file: 'emi/action.yml', start: '### `emi`', end: '\n### ' },
];

export function section(text, start, end) {
  let from = 0;
  if (start) {
    from = text.indexOf(start);
    if (from < 0) return null;
    from += start.length;
  }
  const to = text.indexOf(end, from);
  return text.slice(from, to < 0 ? undefined : to);
}

export function declaredNames(yamlText) {
  const names = { inputs: [], outputs: [] };
  let section = null;
  for (const line of yamlText.split('\n')) {
    const top = line.match(/^([A-Za-z_][\w-]*):/);
    if (top) {
      section = top[1] in names ? top[1] : null;
      continue;
    }
    const key = section && line.match(/^  ([A-Za-z_][\w-]*):/);
    if (key) names[section].push(key[1]);
  }
  return names;
}

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const missing = [];
for (const { file, start, end } of actions) {
  const doc = section(readme, start, end);
  if (doc === null) {
    missing.push(`${file}: README.md has no "${start}" section`);
    continue;
  }
  const names = declaredNames(fs.readFileSync(path.join(root, file), 'utf8'));
  if (names.inputs.length === 0) missing.push(`${file}: no inputs parsed (has the layout changed?)`);
  for (const kind of ['inputs', 'outputs']) {
    for (const name of names[kind]) {
      if (!doc.includes(`\`${name}\``)) missing.push(`${file}: ${kind.slice(0, -1)} \`${name}\``);
    }
  }
  console.log(`${file}: ${names.inputs.length} inputs, ${names.outputs.length} outputs`);
}

if (missing.length) {
  console.error('\nREADME.md does not mention (in the section for that action):');
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}
console.log('README.md covers every input and output.');
