import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materializeWindow, rankOf } from '../src/core/query.ts';
import { applyFilters } from '../src/core/filter.ts';
import { argsortColumn } from '../src/core/sort.ts';
import { encodeSlab } from '../src/core/encode.ts';
import { decodeSlab } from '../src/core/decode.ts';
import { generateOffers } from '../src/core/synth.ts';
import { getBit } from '../src/core/bitset.ts';

const slab = decodeSlab(encodeSlab(generateOffers(3000, 13)));
const order = argsortColumn(slab.columns.priceCents);
const filters = [{ kind: 'range' as const, column: 'durationMin', min: 0, max: 500 }];
const { mask, count } = applyFilters(slab, filters);

/** The full sorted+filtered list, which pages must be slices of. */
const expected: number[] = [];
for (let i = 0; i < order.length; i++) if (getBit(mask, order[i])) expected.push(order[i]);

test('the reference result set is non-trivial', () => {
  assert.ok(count > 100 && count < slab.rowCount, `unhelpful selectivity: ${count}`);
  assert.equal(expected.length, count);
});

test('a window is the matching slice of the sorted result', () => {
  assert.deepEqual(Array.from(materializeWindow(order, mask, 0, 40)), expected.slice(0, 40));
  assert.deepEqual(Array.from(materializeWindow(order, mask, 500, 40)), expected.slice(500, 540));
});

test('paging through covers the result exactly once', () => {
  const seen: number[] = [];
  for (let offset = 0; offset < count; offset += 37) {
    seen.push(...materializeWindow(order, mask, offset, 37));
  }
  assert.deepEqual(seen, expected);
});

test('windows are sorted by the sort key', () => {
  const prices = slab.columns.priceCents;
  const rows = materializeWindow(order, mask, 200, 60);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(prices[rows[i]] >= prices[rows[i - 1]], 'window is out of order');
  }
});

test('a window past the end comes back short, not padded', () => {
  const rows = materializeWindow(order, mask, count - 5, 40);
  assert.equal(rows.length, 5);
});

test('an offset beyond the result is empty', () => {
  assert.equal(materializeWindow(order, mask, count + 10, 20).length, 0);
});

test('rankOf agrees with the materialized position', () => {
  assert.equal(rankOf(order, mask, expected[0]), 0);
  assert.equal(rankOf(order, mask, expected[123]), 123);
});

test('rankOf reports -1 for filtered-out rows', () => {
  let excluded = -1;
  for (let i = 0; i < slab.rowCount; i++) {
    if (!getBit(mask, i)) { excluded = i; break; }
  }
  assert.ok(excluded >= 0, 'expected at least one excluded row');
  assert.equal(rankOf(order, mask, excluded), -1);
});
