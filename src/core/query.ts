import { getBit } from './bitset.ts';

/**
 * Walk a precomputed sort order and collect the rows that survive the mask,
 * skipping `offset` and stopping at `limit`.
 *
 * The virtualized list only ever asks for the ~40 rows it is about to paint,
 * so paging never materializes the full result set.
 */
export function materializeWindow(
  order: Uint32Array,
  mask: Uint32Array,
  offset: number,
  limit: number,
): Uint32Array {
  const out = new Uint32Array(limit);
  let seen = 0;
  let written = 0;
  for (let i = 0; i < order.length && written < limit; i++) {
    const row = order[i];
    if (!getBit(mask, row)) continue;
    if (seen++ < offset) continue;
    out[written++] = row;
  }
  return written === limit ? out : out.subarray(0, written);
}

/** Rank of a row within the current filtered+sorted result, or -1 if excluded. */
export function rankOf(order: Uint32Array, mask: Uint32Array, row: number): number {
  if (!getBit(mask, row)) return -1;
  let rank = 0;
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    if (r === row) return rank;
    if (getBit(mask, r)) rank++;
  }
  return -1;
}
