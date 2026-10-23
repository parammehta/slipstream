import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightedQuantiles, sampleFromQuantiles, QUANTILE_COUNT } from '../src/harvest/distribution.ts';

test('quantiles of a uniform ramp land near the expected deciles', () => {
  const values = Array.from({ length: 1000 }, (_, i) => i);
  const q = weightedQuantiles(values, new Array(1000).fill(1));
  assert.equal(q.length, QUANTILE_COUNT);
  for (let i = 0; i < QUANTILE_COUNT; i++) {
    const expected = ((i + 1) / 10) * 1000;
    assert.ok(Math.abs(q[i] - expected) < 25, `q${i + 1} was ${q[i]}, expected near ${expected}`);
  }
});

test('quantiles come back ascending', () => {
  const values = [500, 100, 900, 300, 700, 200, 800, 400, 600, 1000];
  const q = weightedQuantiles(values, new Array(values.length).fill(1));
  for (let i = 1; i < q.length; i++) assert.ok(q[i] >= q[i - 1], 'quantiles out of order');
});

test('weight pulls the distribution toward the heavy observations', () => {
  const values = [100, 1000];
  const cheapHeavy = weightedQuantiles(values, [99, 1]);
  const dearHeavy = weightedQuantiles(values, [1, 99]);
  assert.ok(cheapHeavy[4] < dearHeavy[4], 'median ignored the weights');
  assert.equal(cheapHeavy[0], 100);
  assert.equal(dearHeavy[8], 1000);
});

test('zero weights fall back to treating observations equally', () => {
  const q = weightedQuantiles([10, 20, 30], [0, 0, 0]);
  assert.ok(q[0] >= 10 && q[8] <= 30);
  assert.ok(q.every((v) => Number.isFinite(v)));
});

test('an empty market yields zeros rather than NaN', () => {
  const q = weightedQuantiles([], []);
  assert.equal(q.length, QUANTILE_COUNT);
  assert.ok(q.every((v) => v === 0));
});

test('mismatched inputs fail loudly', () => {
  assert.throws(() => weightedQuantiles([1, 2], [1]), /differ in length/);
});

test('sampling reproduces the input distribution', () => {
  const values = Array.from({ length: 2000 }, (_, i) => i);
  const q = weightedQuantiles(values, new Array(2000).fill(1));

  const drawn: number[] = [];
  for (let i = 0; i < 20000; i++) drawn.push(sampleFromQuantiles(q, (i + 0.5) / 20000));
  drawn.sort((a, b) => a - b);

  for (const p of [0.25, 0.5, 0.75]) {
    const got = drawn[Math.floor(drawn.length * p)];
    const want = 2000 * p;
    assert.ok(Math.abs(got - want) < 120, `p${p * 100}: sampled ${got.toFixed(0)}, wanted ~${want}`);
  }
});

test('sampling is monotonic in u', () => {
  const q = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  let prev = -Infinity;
  for (let u = 0; u < 1; u += 0.01) {
    const v = sampleFromQuantiles(q, u);
    assert.ok(v >= prev, `not monotonic at u=${u.toFixed(2)}`);
    prev = v;
  }
});

test('the tails extend past the stored cut points', () => {
  const q = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  assert.ok(sampleFromQuantiles(q, 0.001) < 10, 'bottom tail clamped');
  assert.ok(sampleFromQuantiles(q, 0.999) > 90, 'top tail clamped');
});

test('a steep bottom decile does not extrapolate below the data', () => {
  // p10 $20, p20 $90: the inter-decile slope would run straight past zero.
  const q = [2000, 9000, 11000, 13000, 15000, 18000, 22000, 28000, 40000];
  for (let u = 0; u < 0.2; u += 0.005) {
    const v = sampleFromQuantiles(q, u);
    assert.ok(v >= 1700, `u=${u.toFixed(3)} produced ${v}, below any observed fare`);
  }
});

test('sampling never goes negative at the bottom tail', () => {
  const q = [5, 10, 15, 20, 25, 30, 35, 40, 45];
  assert.ok(sampleFromQuantiles(q, 0) >= 0);
});

test('a single cut point degenerates to a constant', () => {
  assert.equal(sampleFromQuantiles([42], 0.3), 42);
  assert.equal(sampleFromQuantiles([], 0.3), 0);
});
