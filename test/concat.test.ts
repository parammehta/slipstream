import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatSlabs } from '../src/core/concat.ts';
import { encodeSlab } from '../src/core/encode.ts';
import { decodeSlab } from '../src/core/decode.ts';
import { generateOffers } from '../src/core/synth.ts';
import { applyFilters } from '../src/core/filter.ts';
import { argsortColumn } from '../src/core/sort.ts';
import type { Slab } from '../src/core/format.ts';

const shard = (rows: number, seed: number): Slab =>
  decodeSlab(encodeSlab(generateOffers(rows, seed)));

test('a single shard is returned untouched', () => {
  const only = shard(50, 1);
  assert.equal(concatSlabs([only]), only);
});

test('row counts add up and order is preserved', () => {
  const a = shard(40, 1);
  const b = shard(25, 2);
  const joined = concatSlabs([a, b]);

  assert.equal(joined.rowCount, 65);
  for (let i = 0; i < a.rowCount; i++) {
    assert.equal(joined.columns.priceCents[i], a.columns.priceCents[i], `row ${i} of the first shard`);
  }
  for (let i = 0; i < b.rowCount; i++) {
    assert.equal(
      joined.columns.priceCents[a.rowCount + i],
      b.columns.priceCents[i],
      `row ${i} of the second shard`,
    );
  }
});

test('every column is joined, not just the first', () => {
  const a = shard(30, 3);
  const b = shard(30, 4);
  const joined = concatSlabs([a, b]);
  for (const name of Object.keys(a.columns)) {
    assert.equal(joined.columns[name].length, 60, `${name} was not joined`);
    assert.equal(joined.columns[name][59], b.columns[name][29], `${name} lost its tail`);
  }
});

test('the joined slab queries like any other', () => {
  const joined = concatSlabs([shard(500, 5), shard(500, 6), shard(500, 7)]);
  const order = argsortColumn(joined.columns.priceCents);
  const { count } = applyFilters(joined, [{ kind: 'oneOf', column: 'stops', values: [0] }]);

  assert.equal(order.length, 1500);
  assert.ok(count > 0 && count < 1500, `unhelpful selectivity: ${count}`);
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      joined.columns.priceCents[order[i]] >= joined.columns.priceCents[order[i - 1]],
      'the joined slab did not sort',
    );
  }
});

test('dictionaries and the base day carry over', () => {
  const a = shard(10, 8);
  const joined = concatSlabs([a, shard(10, 9)]);
  assert.deepEqual(joined.dicts, a.dicts);
  assert.equal(joined.baseDayEpoch, a.baseDayEpoch);
});

test('byteLength reflects the joined rows', () => {
  const joined = concatSlabs([shard(100, 10), shard(100, 11)]);
  assert.equal(joined.byteLength, 200 * 20, 'expected 20 bytes per row');
});

test('joining nothing fails loudly', () => {
  assert.throws(() => concatSlabs([]), /nothing to join/);
});

test('shards from different builds are refused', () => {
  const a = shard(10, 1);
  const b = shard(10, 2);
  const tampered: Slab = { ...b, baseDayEpoch: b.baseDayEpoch + 1 };
  assert.throws(() => concatSlabs([a, tampered]), /base day/);

  const shortDict: Slab = { ...b, dicts: { ...b.dicts, airports: b.dicts.airports.slice(0, 3) } };
  assert.throws(() => concatSlabs([a, shortDict]), /different dictionaries/);
});
