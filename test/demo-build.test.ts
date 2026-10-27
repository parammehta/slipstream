import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderDemo, BUNDLE, PAGE_BUNDLE, EXCLUDED_FROM_BUNDLE } from '../scripts/build-demo.ts';

const committed = readFileSync(new URL('../demo/search/index.html', import.meta.url), 'utf8');

/**
 * Symbols the bundle must declare. The page no longer reaches into the engine
 * directly — it talks to `handleMessage` over postMessage and reads airports
 * and carriers out of the ready payload — so this is the engine's own surface.
 */
const REQUIRED = [
  'handleMessage', 'encodeSlab', 'decodeSlab', 'createScratch', 'applyFilters',
  'argsortColumn', 'histogram', 'materializeWindow', 'minPerBucket',
  'generateOffersFromMarkets', 'marketDataset',
];

test('demo/search/index.html is in sync with src/core', () => {
  assert.equal(
    committed,
    renderDemo(),
    'demo/search/index.html is stale — run: npm run build:demo',
  );
});

test('the generated engine declares its full surface', () => {
  for (const sym of REQUIRED) {
    const declared = new RegExp(`^(?:async\\s+)?(?:function|const|let)\\s+${sym}\\b`, 'm');
    assert.ok(declared.test(committed), `engine never declares ${sym}`);
  }
});

test('no module syntax survives into the flat script', () => {
  const engine = committed.slice(
    committed.indexOf('/* ---- src/core/format.ts ---- */'),
    committed.indexOf('UI — virtualized timetable'),
  );
  assert.ok(engine.length > 1000, 'engine block not found');
  assert.doesNotMatch(engine, /^\s*import\s/m, 'leftover import statement');
  assert.doesNotMatch(engine, /^\s*export\s/m, 'leftover export statement');
  assert.doesNotMatch(engine, /from\s*['"]\.\//, 'leftover module specifier');
});

test('every core module is inlined', () => {
  // Read the directory rather than hardcoding names: a new module that the
  // build script forgets to list would otherwise ship missing from the demo.
  const modules = readdirSync(new URL('../src/core', import.meta.url))
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts');

  assert.ok(modules.length >= 9, `only found ${modules.length} core modules`);

  const bundled = new Set(
    [...BUNDLE, ...PAGE_BUNDLE].filter((b) => b.dir === 'src/core').map((b) => b.file),
  );
  const excluded = new Set(EXCLUDED_FROM_BUNDLE);
  for (const file of modules) {
    assert.ok(
      bundled.has(file) || excluded.has(file),
      `src/core/${file} is neither bundled nor explicitly excluded`,
    );
    if (bundled.has(file)) {
      assert.ok(committed.includes(`/* ---- src/core/${file} ---- */`), `${file} missing from the demo`);
    }
  }
  // The worker and the harvest helpers it leans on must travel too.
  assert.ok(committed.includes('/* ---- src/worker/engine-worker.ts ---- */'), 'worker missing');
  assert.ok(committed.includes('/* ---- src/harvest/distribution.ts ---- */'), 'distribution missing');
});

test('the generated block warns against editing it', () => {
  assert.match(committed, /GENERATED FILE — do not edit this block/);
});
