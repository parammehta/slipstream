import type { TypedArray } from './format.ts';
import type { Selection } from './filter.ts';

export const MINUTES_PER_DAY = 1440;

/**
 * Sentinel for a bucket no row landed in. Prices are cents in a u32, so this
 * is unreachable in practice — a $42,949,672 fare would be required to collide.
 */
export const NO_VALUE = 0xffffffff;

/**
 * Minimum of `values` per bucket, where a row's bucket is
 * `bucketBy[row] / divisor | 0`.
 *
 * This is what the departure-date grid runs on: cheapest fare per day across
 * the current selection, in one pass over the rows that are already in play.
 * Buckets outside `[0, bucketCount)` are ignored rather than clamped, so a
 * stray row cannot distort the first or last cell.
 */
export function minPerBucket(
  values: TypedArray,
  bucketBy: TypedArray,
  divisor: number,
  bucketCount: number,
  selection: Selection | null,
  out?: Uint32Array,
): Uint32Array {
  const mins = out && out.length === bucketCount ? out : new Uint32Array(bucketCount);
  mins.fill(NO_VALUE);
  if (bucketCount <= 0 || divisor <= 0) return mins;

  if (selection === null) {
    for (let i = 0; i < values.length; i++) consider(mins, values, bucketBy, divisor, bucketCount, i);
    return mins;
  }

  const { rows, count } = selection;
  for (let i = 0; i < count; i++) {
    consider(mins, values, bucketBy, divisor, bucketCount, rows[i]);
  }
  return mins;
}

function consider(
  mins: Uint32Array,
  values: TypedArray,
  bucketBy: TypedArray,
  divisor: number,
  bucketCount: number,
  row: number,
): void {
  const b = (bucketBy[row] / divisor) | 0;
  if (b < 0 || b >= bucketCount) return;
  const v = values[row];
  if (v < mins[b]) mins[b] = v;
}

/** Lowest non-empty bucket value and the highest, for building a colour ramp. */
export function valueExtent(mins: Uint32Array): { min: number; max: number; filled: number } {
  let min = NO_VALUE;
  let max = 0;
  let filled = 0;
  for (let i = 0; i < mins.length; i++) {
    const v = mins[i];
    if (v === NO_VALUE) continue;
    filled++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return filled === 0 ? { min: 0, max: 0, filled: 0 } : { min, max, filled };
}
