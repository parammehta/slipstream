import { createBitset } from './bitset.ts';
import type { Slab, TypedArray } from './format.ts';

export type Filter =
  /** Inclusive on both ends. */
  | { kind: 'range'; column: string; min: number; max: number }
  /** Membership over dictionary ids (carriers, airports, stop counts). */
  | { kind: 'oneOf'; column: string; values: number[] };

/**
 * A selection vector: `rows.subarray(0, count)` holds the surviving row ids in
 * ascending order.
 *
 * Filters shrink this list rather than re-scanning every row, so only the
 * first predicate costs a full pass and each subsequent one costs whatever
 * survived the last. That is the difference between 16ms and 8ms at 1M rows.
 */
export interface Selection {
  rows: Uint32Array;
  count: number;
  /** Membership bitset, for walking a precomputed sort order. */
  mask: Uint32Array;
  /** Rows examined across all passes — what the predicate order bought you. */
  scanned: number;
}

/** Reusable buffers so dragging a slider allocates nothing. */
export interface FilterScratch {
  a: Uint32Array;
  b: Uint32Array;
  mask: Uint32Array;
}

export function createScratch(rowCount: number): FilterScratch {
  return {
    a: new Uint32Array(rowCount),
    b: new Uint32Array(rowCount),
    mask: createBitset(rowCount),
  };
}

export function applyFilters(slab: Slab, filters: Filter[], scratch?: FilterScratch): Selection {
  const n = slab.rowCount;
  const s = scratch && scratch.a.length === n ? scratch : createScratch(n);

  let src = s.a;
  let dst = s.b;
  let count = 0;
  let scanned = 0;

  if (filters.length === 0) {
    for (let i = 0; i < n; i++) src[i] = i;
    count = n;
    scanned = n;
  } else {
    count = firstPass(slab, filters[0], src, n);
    scanned = n;
    for (let f = 1; f < filters.length && count > 0; f++) {
      scanned += count;
      count = narrow(slab, filters[f], src, count, dst);
      const tmp = src;
      src = dst;
      dst = tmp;
    }
  }

  const mask = s.mask;
  mask.fill(0);
  for (let i = 0; i < count; i++) {
    const row = src[i];
    mask[row >>> 5] |= (1 << (row & 31)) >>> 0;
  }

  return { rows: src, count, mask, scanned };
}

/** Scan every row once, writing survivors into `out`. */
function firstPass(slab: Slab, f: Filter, out: Uint32Array, n: number): number {
  const col = column(slab, f);
  let k = 0;
  if (f.kind === 'range') {
    const { min, max } = f;
    for (let i = 0; i < n; i++) {
      const v = col[i];
      out[k] = i;
      // Branchless: always write, advance only on a match.
      k += v >= min && v <= max ? 1 : 0;
    }
  } else {
    const { lut, hi } = lookup(f.values);
    for (let i = 0; i < n; i++) {
      const v = col[i];
      out[k] = i;
      k += v <= hi && lut[v] === 1 ? 1 : 0;
    }
  }
  return k;
}

/** Re-check only the rows that are still in play. */
function narrow(slab: Slab, f: Filter, src: Uint32Array, count: number, out: Uint32Array): number {
  const col = column(slab, f);
  let k = 0;
  if (f.kind === 'range') {
    const { min, max } = f;
    for (let i = 0; i < count; i++) {
      const row = src[i];
      const v = col[row];
      out[k] = row;
      k += v >= min && v <= max ? 1 : 0;
    }
  } else {
    const { lut, hi } = lookup(f.values);
    for (let i = 0; i < count; i++) {
      const row = src[i];
      const v = col[row];
      out[k] = row;
      k += v <= hi && lut[v] === 1 ? 1 : 0;
    }
  }
  return k;
}

function column(slab: Slab, f: Filter): TypedArray {
  const col = slab.columns[f.column];
  if (!col) throw new Error(`applyFilters: unknown column "${f.column}"`);
  return col;
}

/** Dense lookup table: membership in one array read, however many ids. */
function lookup(values: number[]): { lut: Uint8Array; hi: number } {
  let hi = 0;
  for (const v of values) if (v > hi) hi = v;
  const lut = new Uint8Array(hi + 1);
  for (const v of values) lut[v] = 1;
  return { lut, hi };
}
