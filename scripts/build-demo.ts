/**
 * Generates demo/index.html from demo/index.template.html plus src/core.
 *
 *   node scripts/build-demo.ts [--check]
 *
 * The demo has to stay a single self-contained file: ES module imports are
 * blocked for file:// origins, so a page split across modules would only work
 * over HTTP. Rather than keep a hand-maintained copy of the engine inside the
 * HTML, this inlines the real `src/core` modules at build time — one source of
 * truth, still one file.
 *
 * Type stripping uses Node's built-in `stripTypeScriptTypes`, so the build
 * needs no dependencies. `--check` verifies the committed file is current
 * instead of writing it; the test suite uses that to catch drift.
 */
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'demo/index.template.html');
const OUTPUT = join(ROOT, 'demo/index.html');
const MARKER = '<!--@ENGINE@-->';

/**
 * Dependency order, since the output is one flat classic script rather than a
 * module graph. `index.ts` is skipped — it only re-exports.
 */
const MODULES = [
  'format.ts',
  'encode.ts',
  'decode.ts',
  'bitset.ts',
  'filter.ts',
  'sort.ts',
  'histogram.ts',
  'query.ts',
  'synth.ts',
];

/**
 * Drop import statements: once flattened, every module shares one scope.
 * Statement-aware rather than line-based, because a multi-line
 * `import {\n  A,\n  B,\n} from './x.ts';` would otherwise leave its tail behind.
 */
function stripImports(lines: string[]): string[] {
  const out: string[] = [];
  let continuing = false;
  for (const line of lines) {
    if (continuing) {
      if (/from\s*['"][^'"]+['"]\s*;?\s*$/.test(line)) continuing = false;
      continue;
    }
    if (/^\s*import\s/.test(line)) {
      // A single-line import closes on the same line; anything else continues.
      if (!/from\s*['"][^'"]+['"]\s*;?\s*$/.test(line)) continuing = true;
      continue;
    }
    out.push(line);
  }
  if (continuing) throw new Error('build-demo: unterminated import statement');
  return out;
}

/** Strip types, then flatten module syntax into plain top-level declarations. */
function flatten(source: string): string {
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  const lines = stripImports(stripped.split('\n'));
  return lines
    // `export { A, B };` re-export statements have no meaning once flattened.
    .filter((line) => !/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line))
    .map((line) => line.replace(/^export\s+/, ''))
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildEngine(): string {
  const parts = MODULES.map((file) => {
    const source = readFileSync(join(ROOT, 'src/core', file), 'utf8');
    return `/* ---- src/core/${file} ---- */\n${flatten(source)}`;
  });

  return [
    '<script>',
    '"use strict";',
    '/* ------------------------------------------------------------------',
    '   GENERATED FILE — do not edit this block.',
    '',
    '   Produced by scripts/build-demo.ts from src/core/*.ts. Edit the engine',
    '   there and run `npm run build:demo`; `npm test` fails if this file is',
    '   stale.',
    '   ------------------------------------------------------------------ */',
    '',
    parts.join('\n\n'),
    '</script>',
  ].join('\n');
}

export function renderDemo(): string {
  const template = readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(MARKER)) {
    throw new Error(`build-demo: ${MARKER} missing from the template`);
  }
  return template.replace(MARKER, buildEngine());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rendered = renderDemo();
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT, 'utf8');
    if (current !== rendered) {
      console.error('demo/index.html is stale — run: npm run build:demo');
      process.exit(1);
    }
    console.log('demo/index.html is up to date');
  } else {
    writeFileSync(OUTPUT, rendered);
    console.log(`wrote demo/index.html (${rendered.length.toLocaleString()} bytes)`);
  }
}
