import type { TypedArray } from './format.ts';

/**
 * Stable LSD radix argsort over 32-bit keys: four counting passes, no
 * comparator calls. ~10x faster than Array#sort with a comparator at 1M rows,
 * which is what makes precomputing a permutation per sort key affordable.
 */
export function argsortU32(keys: Uint32Array): Uint32Array {
  const n = keys.length;
  let src = new Uint32Array(n);
  for (let i = 0; i < n; i++) src[i] = i;
  if (n < 2) return src;

  let dst = new Uint32Array(n);
  const count = new Uint32Array(256);

  for (let shift = 0; shift < 32; shift += 8) {
    count.fill(0);
    for (let i = 0; i < n; i++) count[(keys[src[i]] >>> shift) & 255]++;

    // If every key shares this byte the pass is a no-op; skip it. Prices and
    // durations rarely use the top bytes, so this usually saves two passes.
    let uniform = false;
    for (let b = 0; b < 256; b++) {
      if (count[b] === n) {
        uniform = true;
        break;
      }
    }
    if (uniform) continue;

    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = count[b];
      count[b] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const row = src[i];
      dst[count[(keys[row] >>> shift) & 255]++] = row;
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return src;
}

/**
 * Map a column onto unsigned sort keys. Signed values are biased by 2^31 so
 * their two's-complement order matches unsigned order.
 */
export function toSortKeys(col: TypedArray): Uint32Array {
  const n = col.length;
  const keys = new Uint32Array(n);
  if (col instanceof Int32Array) {
    for (let i = 0; i < n; i++) keys[i] = (col[i] ^ 0x80000000) >>> 0;
  } else {
    for (let i = 0; i < n; i++) keys[i] = col[i];
  }
  return keys;
}

/** Ascending permutation of row ids for a column. */
export function argsortColumn(col: TypedArray): Uint32Array {
  return argsortU32(toSortKeys(col));
}

/** Reverse a permutation in place-free fashion, for descending sorts. */
export function reversePermutation(order: Uint32Array): Uint32Array {
  const n = order.length;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = order[n - 1 - i];
  return out;
}
