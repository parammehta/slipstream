import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argsortU32, argsortColumn, reversePermutation } from '../src/core/sort.ts';
import { generateOffers } from '../src/core/synth.ts';

test('argsort orders ascending', () => {
  const keys = Uint32Array.from([5, 1, 4, 1, 9, 0]);
  const order = argsortU32(keys);
  const sorted = Array.from(order, (i) => keys[i]);
  assert.deepEqual(sorted, [0, 1, 1, 4, 5, 9]);
});

test('argsort is stable for equal keys', () => {
  const keys = Uint32Array.from([2, 1, 2, 1, 2]);
  const order = Array.from(argsortU32(keys));
  assert.deepEqual(order, [1, 3, 0, 2, 4]);
});

test('argsort handles empty and single-element inputs', () => {
  assert.equal(argsortU32(new Uint32Array(0)).length, 0);
  assert.deepEqual(Array.from(argsortU32(Uint32Array.from([7]))), [0]);
});

test('argsort spans the full 32-bit range', () => {
  const keys = Uint32Array.from([0xffffffff, 0, 0x80000000, 0x7fffffff, 1]);
  const sorted = Array.from(argsortU32(keys), (i) => keys[i]);
  assert.deepEqual(sorted, [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]);
});

test('argsortColumn agrees with a comparator sort on real columns', () => {
  const input = generateOffers(20_000, 5);
  for (const name of ['priceCents', 'durationMin', 'depMin']) {
    const col = input.columns[name];
    const mine = Array.from(argsortColumn(col), (i) => col[i]);
    const reference = Array.from(col).sort((a, b) => a - b);
    assert.deepEqual(mine, reference, `${name} ordering differs`);
  }
});

test('signed columns sort by value, not by bit pattern', () => {
  const col = Int32Array.from([5, -3, 0, -100, 42]);
  const sorted = Array.from(argsortColumn(col), (i) => col[i]);
  assert.deepEqual(sorted, [-100, -3, 0, 5, 42]);
});

test('reversePermutation yields descending order', () => {
  const col = Uint32Array.from([3, 1, 2]);
  const desc = reversePermutation(argsortColumn(col));
  assert.deepEqual(Array.from(desc, (i) => col[i]), [3, 2, 1]);
});
