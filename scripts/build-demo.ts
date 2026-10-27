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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'demo/index.template.html');
/** The search lives at /search so that / can be the landing page. */
const OUTPUT = join(ROOT, 'demo/search/index.html');
const LANDING_SOURCE = join(ROOT, 'demo/landing.template.html');
const LANDING_OUTPUT = join(ROOT, 'demo/index.html');
const MARKER = '<!--@ENGINE@-->';
const PAGE_MARKER = '<!--@PAGE@-->';

/**
 * Dependency order, since the output is one flat classic script rather than a
 * module graph. `index.ts` is skipped — it only re-exports.
 */
/**
 * Dependency order for the flattened bundle. Spans directories because the
 * offer generator samples fare curves, which live with the harvester.
 */
export const BUNDLE: ReadonlyArray<{ dir: string; file: string }> = [
  { dir: 'src/core', file: 'format.ts' },
  { dir: 'src/core', file: 'encode.ts' },
  { dir: 'src/core', file: 'decode.ts' },
  { dir: 'src/core', file: 'concat.ts' },
  { dir: 'src/core', file: 'bitset.ts' },
  { dir: 'src/core', file: 'filter.ts' },
  { dir: 'src/core', file: 'buckets.ts' },
  { dir: 'src/core', file: 'sort.ts' },
  { dir: 'src/core', file: 'histogram.ts' },
  { dir: 'src/core', file: 'query.ts' },
  { dir: 'src/core', file: 'combine.ts' },
  { dir: 'src/harvest', file: 'distribution.ts' },
  { dir: 'src/core', file: 'market-data.ts' },
  { dir: 'src/core', file: 'markets.ts' },
  { dir: 'src/core', file: 'offers.ts' },
  { dir: 'src/worker', file: 'engine-worker.ts' },
];

/**
 * Core modules deliberately left out of the demo. The demo generates offers
 * from the harvested fare dataset, so the OpenFlights route table and the
 * model that rides on it are only used by the benchmark and the tests —
 * inlining them would add ~46KB the page never executes.
 *
 * Listed explicitly so that forgetting a *new* module still fails the build
 * rather than silently shipping a broken page.
 */
export const EXCLUDED_FROM_BUNDLE: ReadonlyArray<string> = ['index.ts', 'routes.ts', 'synth.ts'];

/**
 * Modules the page itself runs, as opposed to the engine. The engine travels
 * as inert text that only the worker evaluates, so anything the page needs in
 * its own scope — choosing which shard to fetch, before any engine exists —
 * has to ship as an executing script of its own.
 */
export const PAGE_BUNDLE: ReadonlyArray<{ dir: string; file: string }> = [
  { dir: 'src/core', file: 'geo.ts' },
  { dir: 'src/core', file: 'zones.ts' },
  { dir: 'src/core', file: 'tz.ts' },
];

/**
 * Wires the flattened bundle up to whichever host it finds itself in: a real
 * Worker, where `self` is the global scope, or the main-thread fallback,
 * where the page passes in a shim with the same two methods.
 */
const MESSAGE_LOOP = `
self.onmessage = (event) => {
  Promise.resolve(handleMessage(event.data, (m) => self.postMessage(m))).then((out) => {
    self.postMessage(out.reply, out.transfer);
  });
};
`.trim();

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
  const parts = BUNDLE.map(({ dir, file }) => {
    const source = readFileSync(join(ROOT, dir, file), 'utf8');
    return `/* ---- ${dir}/${file} ---- */\n${flatten(source)}`;
  });

  const bundle = ['"use strict";', parts.join('\n\n'), MESSAGE_LOOP].join('\n\n');
  assertNoDuplicateDeclarations(bundle);

  // The bundle is carried as inert text and handed to a Blob worker, so a
  // literal </script> anywhere inside it would close the tag early.
  const escaped = bundle.replace(/<\/script/gi, '<\\/script');

  return [
    '<script type="text/plain" id="engine-source">',
    '/* ------------------------------------------------------------------',
    '   GENERATED FILE — do not edit this block.',
    '',
    '   Produced by scripts/build-demo.ts from src/core/*.ts and',
    '   src/worker/*.ts. Edit the engine there and run `npm run build:demo`;',
    '   `npm test` fails if this file is stale.',
    '',
    '   This is deliberately inert: the page turns it into a Blob and runs it',
    '   in a Worker, falling back to evaluating it on the main thread when a',
    '   Worker cannot be created (file:// origins, mostly).',
    '   ------------------------------------------------------------------ */',
    '',
    escaped,
    '</script>',
  ].join('\n');
}

/**
 * Flattening puts every module in one scope, so two modules declaring the
 * same top-level name produce a page that dies on load with
 * "Identifier X has already been declared". Catch it at build time.
 */
function assertNoDuplicateDeclarations(bundle: string): void {
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  const pattern = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

  for (const match of bundle.matchAll(pattern)) {
    const name = match[1];
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 2) duplicates.push(name);
  }

  if (duplicates.length) {
    throw new Error(
      `build-demo: ${duplicates.length} name(s) declared twice in the flattened ` +
      `bundle: ${duplicates.join(', ')}. Rename one of them — the bundle is a single scope.`,
    );
  }
}

function buildPageScript(): string {
  const parts = PAGE_BUNDLE.map(({ dir, file }) => {
    const source = readFileSync(join(ROOT, dir, file), 'utf8');
    return `/* ---- ${dir}/${file} ---- */\n${flatten(source)}`;
  });
  const body = ['"use strict";', parts.join('\n\n')].join('\n\n');
  assertNoDuplicateDeclarations(body);
  return ['<script>', body, '</script>'].join('\n');
}

export function renderDemo(): string {
  const template = readFileSync(TEMPLATE, 'utf8');
  for (const marker of [MARKER, PAGE_MARKER]) {
    if (!template.includes(marker)) {
      throw new Error(`build-demo: ${marker} missing from the template`);
    }
  }
  return template.replace(MARKER, buildEngine()).replace(PAGE_MARKER, buildPageScript());
}

/** The landing page is static; the build only copies it into the output. */
export function renderLanding(): string {
  return readFileSync(LANDING_SOURCE, 'utf8');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = renderDemo();
  const landing = renderLanding();

  if (process.argv.includes('--check')) {
    const stale: string[] = [];
    if (readFileSync(OUTPUT, 'utf8') !== app) stale.push('demo/search/index.html');
    if (readFileSync(LANDING_OUTPUT, 'utf8') !== landing) stale.push('demo/index.html');
    if (stale.length) {
      console.error(`${stale.join(' and ')} stale — run: npm run build:demo`);
      process.exit(1);
    }
    console.log('demo output is up to date');
  } else {
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, app);
    writeFileSync(LANDING_OUTPUT, landing);
    console.log(
      `wrote demo/search/index.html (${app.length.toLocaleString()} bytes)\n` +
      `wrote demo/index.html (${landing.length.toLocaleString()} bytes)`,
    );
  }
}
