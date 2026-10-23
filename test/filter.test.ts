import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSlab } from '../src/core/encode.ts';
import { decodeSlab } from '../src/core/decode.ts';
import { generateOffers } from '../src/core/synth.ts';
import { applyFilters, createScratch, type Filter } from '../src/core/filter.ts';
import { getBit, popcount, createBitset, fillOnes } from '../src/core/bitset.ts';

const slab = decodeSlab(encodeSlab(generateOffers(4321, 9)));

/** Straightforward reference implementation the fast path must agree with. */
function naive(filters: Filter[]): number[] {
  const kept: number[] = [];
  outer: for (let i = 0; i < slab.rowCount; i++) {
    for (const f of filters) {
      const v = slab.columns[f.column][i];
      if (f.kind === 'range') {
        if (v < f.min || v > f.max) continue outer;
      } else if (!f.values.includes(v)) {
        continue outer;
      }
    }
    kept.push(i);
  }
  return kept;
}

function assertMatches(filters: Filter[], label: string) {
  const expected = naive(filters);
  const { mask, count } = applyFilters(slab, filters);
  assert.equal(count, expected.length, `${label}: count mismatch`);
  const actual: number[] = [];
  for (let i = 0; i < slab.rowCount; i++) if (getBit(mask, i)) actual.push(i);
  assert.deepEqual(actual, expected, `${label}: row set mismatch`);
}

test('range filter matches the reference', () => {
  assertMatches([{ kind: 'range', column: 'priceCents', min: 20_000, max: 60_000 }], 'price');
});

test('range filter is inclusive at both bounds', () => {
  const prices = slab.columns.priceCents;
  let min = Infinity;
  for (let i = 0; i < prices.length; i++) if (prices[i] < min) min = prices[i];
  const { count } = applyFilters(slab, [
    { kind: 'range', column: 'priceCents', min, max: min },
  ]);
  let expected = 0;
  for (let i = 0; i < prices.length; i++) if (prices[i] === min) expected++;
  assert.equal(count, expected);
});

test('oneOf filter matches the reference', () => {
  assertMatches([{ kind: 'oneOf', column: 'carrierId', values: [0, 3, 7] }], 'carriers');
});

test('oneOf tolerates ids above every value present', () => {
  assertMatches([{ kind: 'oneOf', column: 'stops', values: [0, 200] }], 'sparse ids');
});

test('filters compose as an intersection', () => {
  assertMatches(
    [
      { kind: 'range', column: 'priceCents', min: 15_000, max: 90_000 },
      { kind: 'range', column: 'durationMin', min: 0, max: 600 },
      { kind: 'oneOf', column: 'stops', values: [0, 1] },
      { kind: 'oneOf', column: 'carrierId', values: [1, 2, 4, 8] },
    ],
    'combined',
  );
});

test('no filters keeps every row', () => {
  assert.equal(applyFilters(slab, []).count, slab.rowCount);
});

test('an impossible range keeps nothing', () => {
  assert.equal(applyFilters(slab, [{ kind: 'range', column: 'priceCents', min: 1, max: 0 }]).count, 0);
});

test('reused scratch does not leak state between queries', () => {
  const scratch = createScratch(slab.rowCount);
  applyFilters(slab, [{ kind: 'range', column: 'priceCents', min: 0, max: 1 }], scratch);
  const second = applyFilters(slab, [], scratch);
  assert.equal(second.mask, scratch.mask, 'should reuse the buffer');
  assert.equal(second.count, slab.rowCount);
  for (let i = 0; i < slab.rowCount; i++) assert.ok(getBit(second.mask, i), `row ${i} missing`);
});

test('the selection vector and the mask agree', () => {
  const filters: Filter[] = [
    { kind: 'range', column: 'priceCents', min: 15_000, max: 90_000 },
    { kind: 'oneOf', column: 'stops', values: [0, 1] },
  ];
  const { rows, count, mask } = applyFilters(slab, filters);
  assert.equal(popcount(mask), count);
  for (let i = 0; i < count; i++) assert.ok(getBit(mask, rows[i]), `row ${rows[i]} not in mask`);
});

test('the selection vector stays ascending', () => {
  const { rows, count } = applyFilters(slab, [
    { kind: 'oneOf', column: 'carrierId', values: [2, 5] },
  ]);
  for (let i = 1; i < count; i++) assert.ok(rows[i] > rows[i - 1], 'selection out of order');
});

test('padding bits past the row count are never counted', () => {
  const bs = createBitset(slab.rowCount);
  fillOnes(bs, slab.rowCount);
  assert.equal(popcount(bs), slab.rowCount);
});

test('unknown columns fail loudly', () => {
  assert.throws(
    () => applyFilters(slab, [{ kind: 'range', column: 'nope', min: 0, max: 1 }]),
    /unknown column/,
  );
});
