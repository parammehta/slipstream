import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minPerBucket, valueExtent, NO_VALUE, MINUTES_PER_DAY } from '../src/core/buckets.ts';
import { applyFilters, refineSelection, createScratch, type Filter } from '../src/core/filter.ts';
import { encodeSlab } from '../src/core/encode.ts';
import { decodeSlab } from '../src/core/decode.ts';
import { generateOffers } from '../src/core/synth.ts';

const slab = decodeSlab(encodeSlab(generateOffers(6000, 77)));
const DAYS = 60;

test('finds the minimum in each bucket', () => {
  const values = Uint32Array.from([50, 10, 30, 70, 20]);
  const buckets = Uint32Array.from([0, 0, 1, 1, 2]);
  assert.deepEqual(Array.from(minPerBucket(values, buckets, 1, 3, null)), [10, 30, 20]);
});

test('empty buckets report NO_VALUE', () => {
  const values = Uint32Array.from([5]);
  const buckets = Uint32Array.from([2]);
  const mins = minPerBucket(values, buckets, 1, 4, null);
  assert.deepEqual(Array.from(mins), [NO_VALUE, NO_VALUE, 5, NO_VALUE]);
});

test('buckets outside the range are ignored, not clamped', () => {
  const values = Uint32Array.from([1, 2, 3]);
  const buckets = Uint32Array.from([0, 5, 99]);
  const mins = minPerBucket(values, buckets, 1, 2, null);
  assert.deepEqual(Array.from(mins), [1, NO_VALUE]);
});

test('the divisor maps minutes onto days', () => {
  const values = Uint32Array.from([900, 400, 700]);
  // day 0 (00:10), day 0 (23:00), day 1 (00:00)
  const depMin = Int32Array.from([10, 1380, 1440]);
  const mins = minPerBucket(values, depMin, MINUTES_PER_DAY, 2, null);
  assert.deepEqual(Array.from(mins), [400, 700]);
});

test('matches a reference implementation over real data', () => {
  const prices = slab.columns.priceCents;
  const dep = slab.columns.depMin;
  const mine = minPerBucket(prices, dep, MINUTES_PER_DAY, DAYS, null);

  const reference = new Uint32Array(DAYS).fill(NO_VALUE);
  for (let i = 0; i < slab.rowCount; i++) {
    const d = (dep[i] / MINUTES_PER_DAY) | 0;
    if (d >= 0 && d < DAYS && prices[i] < reference[d]) reference[d] = prices[i];
  }
  assert.deepEqual(Array.from(mine), Array.from(reference));
});

test('respects the current selection', () => {
  const filters: Filter[] = [{ kind: 'oneOf', column: 'stops', values: [0] }];
  const selection = applyFilters(slab, filters);
  const prices = slab.columns.priceCents;
  const dep = slab.columns.depMin;
  const mins = minPerBucket(prices, dep, MINUTES_PER_DAY, DAYS, selection);

  const reference = new Uint32Array(DAYS).fill(NO_VALUE);
  for (let i = 0; i < selection.count; i++) {
    const row = selection.rows[i];
    const d = (dep[row] / MINUTES_PER_DAY) | 0;
    if (prices[row] < reference[d]) reference[d] = prices[row];
  }
  assert.deepEqual(Array.from(mins), Array.from(reference));

  // A nonstop-only grid can never beat the unfiltered grid on any day.
  const all = minPerBucket(prices, dep, MINUTES_PER_DAY, DAYS, null);
  for (let d = 0; d < DAYS; d++) {
    if (mins[d] !== NO_VALUE) assert.ok(mins[d] >= all[d], `day ${d} got cheaper when filtered`);
  }
});

test('reused output buffers are reset', () => {
  const scratch = new Uint32Array(3);
  minPerBucket(Uint32Array.from([1, 2, 3]), Uint32Array.from([0, 1, 2]), 1, 3, null, scratch);
  minPerBucket(Uint32Array.from([9]), Uint32Array.from([1]), 1, 3, null, scratch);
  assert.deepEqual(Array.from(scratch), [NO_VALUE, 9, NO_VALUE]);
});

test('valueExtent reports the filled range', () => {
  const mins = Uint32Array.from([NO_VALUE, 30, 10, NO_VALUE, 90]);
  assert.deepEqual(valueExtent(mins), { min: 10, max: 90, filled: 3 });
});

test('valueExtent handles a grid with nothing in it', () => {
  assert.deepEqual(valueExtent(Uint32Array.from([NO_VALUE, NO_VALUE])), { min: 0, max: 0, filled: 0 });
});

test('refineSelection narrows an existing selection', () => {
  const scratchA = createScratch(slab.rowCount);
  const scratchB = createScratch(slab.rowCount);
  const base: Filter[] = [{ kind: 'oneOf', column: 'stops', values: [0, 1] }];
  const dateFilter: Filter[] = [
    { kind: 'range', column: 'depMin', min: 5 * MINUTES_PER_DAY, max: 6 * MINUTES_PER_DAY - 1 },
  ];

  const baseSel = applyFilters(slab, base, scratchA);
  const refined = refineSelection(slab, dateFilter, baseSel, scratchB);
  const direct = applyFilters(slab, [...base, ...dateFilter]);

  assert.equal(refined.count, direct.count);
  assert.deepEqual(
    Array.from(refined.rows.subarray(0, refined.count)),
    Array.from(direct.rows.subarray(0, direct.count)),
  );
});

test('refineSelection with no filters leaves the selection alone', () => {
  const scratchA = createScratch(slab.rowCount);
  const scratchB = createScratch(slab.rowCount);
  const baseSel = applyFilters(slab, [{ kind: 'oneOf', column: 'stops', values: [2] }], scratchA);
  const refined = refineSelection(slab, [], baseSel, scratchB);
  assert.equal(refined.count, baseSel.count);
});

test('refineSelection keeps the mask in step with the rows', () => {
  const scratchA = createScratch(slab.rowCount);
  const scratchB = createScratch(slab.rowCount);
  const baseSel = applyFilters(slab, [{ kind: 'oneOf', column: 'stops', values: [0, 1] }], scratchA);
  const refined = refineSelection(
    slab,
    [{ kind: 'range', column: 'durationMin', min: 0, max: 400 }],
    baseSel,
    scratchB,
  );
  let bits = 0;
  for (let w = 0; w < refined.mask.length; w++) {
    let v = refined.mask[w];
    while (v) { bits += v & 1; v >>>= 1; }
  }
  assert.equal(bits, refined.count);
});

test('rows before the first bucket are rejected, not folded into bucket 0', () => {
  const values = Uint32Array.from([111, 222]);
  // -60 minutes is the day *before* the base day; 60 minutes is day 0.
  const buckets = Int32Array.from([-60, 60]);
  const mins = minPerBucket(values, buckets, MINUTES_PER_DAY, 3, null);
  assert.equal(mins[0], 222, 'the pre-base row leaked into day 0');
  assert.equal(mins[1], NO_VALUE);
});

test('negative buckets are rejected across a whole day boundary', () => {
  const values = Uint32Array.from([5, 6, 7]);
  const buckets = Int32Array.from([-1441, -1, 0]);
  const mins = minPerBucket(values, buckets, MINUTES_PER_DAY, 2, null);
  assert.equal(mins[0], 7, 'only the row at minute 0 belongs in bucket 0');
});
