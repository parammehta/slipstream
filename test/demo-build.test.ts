import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderDemo } from '../scripts/build-demo.ts';

const committed = readFileSync(new URL('../demo/index.html', import.meta.url), 'utf8');

/** Symbols the UI script pulls out of the inlined engine. */
const REQUIRED = [
  'AIRPORTS', 'CARRIERS', 'generateOffers', 'encodeSlab', 'decodeSlab',
  'createScratch', 'applyFilters', 'argsortColumn', 'histogram', 'materializeWindow',
];

test('demo/index.html is in sync with src/core', () => {
  assert.equal(
    committed,
    renderDemo(),
    'demo/index.html is stale — run: npm run build:demo',
  );
});

test('the generated engine declares everything the UI uses', () => {
  for (const sym of REQUIRED) {
    const declared = new RegExp(`^(?:function|const|let)\\s+${sym}\\b`, 'm');
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
  for (const file of modules) {
    assert.ok(committed.includes(`/* ---- src/core/${file} ---- */`), `${file} missing from the demo`);
  }
});

test('the generated block warns against editing it', () => {
  assert.match(committed, /GENERATED FILE — do not edit this block/);
});
