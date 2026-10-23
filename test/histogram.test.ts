import { test } from 'node:test';
import assert from 'node:assert/strict';
import { histogram } from '../src/core/histogram.ts';
import { applyFilters } from '../src/core/filter.ts';
import { encodeSlab } from '../src/core/encode.ts';
import { decodeSlab } from '../src/core/decode.ts';
import { generateOffers } from '../src/core/synth.ts';

test('bins values into the expected buckets', () => {
  const col = Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(Array.from(histogram(col, null, 0, 9, 3)), [3, 3, 4]);
});

test('the maximum value lands in the last bin, not past it', () => {
  const col = Uint32Array.from([10]);
  const bins = histogram(col, null, 0, 10, 4);
  assert.equal(bins[3], 1);
  assert.equal(bins.reduce((a, b) => a + b, 0), 1);
});

test('values outside the range are dropped', () => {
  const col = Uint32Array.from([-0, 5, 100]);
  assert.equal(histogram(col, null, 1, 10, 2).reduce((a, b) => a + b, 0), 1);
});

test('a zero-width range does not divide by zero', () => {
  const col = Uint32Array.from([5, 5, 5]);
  const bins = histogram(col, null, 5, 5, 4);
  assert.equal(bins.reduce((a, b) => a + b, 0), 3);
});

test('masked totals equal the filter count', () => {
  const slab = decodeSlab(encodeSlab(generateOffers(8000, 21)));
  const filters = [{ kind: 'oneOf' as const, column: 'stops', values: [0] }];
  const selection = applyFilters(slab, filters);
  const prices = slab.columns.priceCents;
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] < min) min = prices[i];
    if (prices[i] > max) max = prices[i];
  }
  const bins = histogram(prices, selection, min, max, 40);
  assert.equal(bins.reduce((a, b) => a + b, 0), selection.count);
});

test('reused output buffers are cleared', () => {
  const col = Uint32Array.from([1, 2, 3]);
  const scratch = new Uint32Array(3);
  histogram(col, null, 1, 3, 3, scratch);
  histogram(Uint32Array.from([1]), null, 1, 3, 3, scratch);
  assert.deepEqual(Array.from(scratch), [1, 0, 0]);
});
