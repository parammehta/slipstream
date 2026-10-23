import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topKCombinations, MAX_LEGS, MAX_RESULTS, type LegCandidates } from '../src/core/combine.ts';

const leg = (prices: number[], rows?: number[]): LegCandidates => ({
  prices: Uint32Array.from(prices),
  rows: Uint32Array.from(rows ?? prices.map((_, i) => i)),
  length: prices.length,
});

/** Exhaustive reference: build every combination and sort. */
function bruteForce(legs: LegCandidates[], k: number): number[] {
  const totals: number[] = [];
  const walk = (l: number, sum: number) => {
    if (l === legs.length) { totals.push(sum); return; }
    for (let i = 0; i < legs[l].length; i++) walk(l + 1, sum + legs[l].prices[i]);
  };
  walk(0, 0);
  return totals.sort((a, b) => a - b).slice(0, k);
}

test('a single leg degenerates to the cheapest offers', () => {
  const r = topKCombinations([leg([300, 100, 200])], 2);
  // The leg is already sorted by the caller, so order is taken as given.
  assert.deepEqual(Array.from(r.totals), [300, 100]);
  assert.equal(r.legCount, 1);
});

test('two legs yield the cheapest sums in order', () => {
  const r = topKCombinations([leg([100, 200, 500]), leg([10, 40, 90])], 5);
  assert.deepEqual(Array.from(r.totals), [110, 140, 190, 210, 240]);
});

test('the chosen rows match the chosen totals', () => {
  const a = leg([100, 200], [7, 8]);
  const b = leg([10, 40], [20, 21]);
  const r = topKCombinations([a, b], 3);
  assert.deepEqual(Array.from(r.rows.subarray(0, 2)), [7, 20]);   // 110
  assert.deepEqual(Array.from(r.rows.subarray(2, 4)), [7, 21]);   // 140
  assert.deepEqual(Array.from(r.rows.subarray(4, 6)), [8, 20]);   // 210
});

test('matches brute force on three legs', () => {
  const legs = [
    leg([50, 80, 130, 210]),
    leg([30, 60, 61, 400]),
    leg([5, 9, 400, 900]),
  ];
  const r = topKCombinations(legs, 20);
  assert.deepEqual(Array.from(r.totals), bruteForce(legs, 20));
});

test('matches brute force on four legs', () => {
  const legs = [leg([1, 4, 9]), leg([2, 3, 20]), leg([5, 6, 7]), leg([10, 11, 50])];
  const r = topKCombinations(legs, 30);
  assert.deepEqual(Array.from(r.totals), bruteForce(legs, 30));
});

test('duplicate fares do not collapse combinations', () => {
  const legs = [leg([100, 100]), leg([50, 50])];
  const r = topKCombinations(legs, 4);
  assert.equal(r.count, 4, 'expected all four pairings');
  assert.deepEqual(Array.from(r.totals), [150, 150, 150, 150]);
});

test('asking for more than exists returns everything, once', () => {
  const r = topKCombinations([leg([1, 2]), leg([10, 20])], 50);
  assert.equal(r.count, 4);
  assert.deepEqual(Array.from(r.totals), [11, 21, 22, 12].sort((a, b) => a - b));
});

test('totals come back ascending', () => {
  const legs = [leg([13, 29, 31, 97]), leg([7, 11, 59]), leg([3, 41, 43])];
  const r = topKCombinations(legs, 25);
  for (let i = 1; i < r.count; i++) {
    assert.ok(r.totals[i] >= r.totals[i - 1], `not ascending at ${i}`);
  }
});

test('an unflyable leg makes the whole trip empty', () => {
  const r = topKCombinations([leg([100]), leg([])], 10);
  assert.equal(r.count, 0);
  assert.equal(r.legCount, 2);
});

test('no legs, or no results wanted, yields nothing', () => {
  assert.equal(topKCombinations([], 10).count, 0);
  assert.equal(topKCombinations([leg([1])], 0).count, 0);
});

test('limits are enforced rather than silently corrupting the packing', () => {
  const many = Array.from({ length: MAX_LEGS + 1 }, () => leg([1, 2]));
  assert.throws(() => topKCombinations(many, 5), /at most 4 legs/);
  assert.throws(() => topKCombinations([leg([1])], MAX_RESULTS + 1), /at most 255 results/);
});

test('each combination is distinct', () => {
  const legs = [leg([1, 2, 3, 4]), leg([10, 20, 30, 40]), leg([100, 200, 300, 400])];
  const r = topKCombinations(legs, 40);
  const keys = new Set<string>();
  for (let i = 0; i < r.count; i++) {
    keys.add(Array.from(r.rows.subarray(i * 3, i * 3 + 3)).join(','));
  }
  assert.equal(keys.size, r.count, 'a combination was emitted twice');
});

test('legs of very different sizes still enumerate correctly', () => {
  const legs = [leg([5]), leg(Array.from({ length: 60 }, (_, i) => i + 1))];
  const r = topKCombinations(legs, 10);
  assert.deepEqual(Array.from(r.totals), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});
