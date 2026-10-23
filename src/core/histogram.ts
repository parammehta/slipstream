import type { TypedArray } from './format.ts';
import type { Selection } from './filter.ts';

/**
 * Bin a column over the current selection. This is what lets the price slider
 * redraw its own distribution while it is being dragged.
 *
 * Pass `selection` as null to bin every row — the unfiltered backdrop series
 * drawn behind the live one.
 */
export function histogram(
  col: TypedArray,
  selection: Selection | null,
  min: number,
  max: number,
  bins: number,
  out?: Uint32Array,
): Uint32Array {
  const counts = out && out.length === bins ? out.fill(0) : new Uint32Array(bins);
  if (bins <= 0 || max < min) return counts;

  const span = max - min;
  const scale = span === 0 ? 0 : bins / span;
  const last = bins - 1;

  if (selection === null) {
    for (let i = 0; i < col.length; i++) tally(counts, col[i], min, max, scale, last);
    return counts;
  }

  const { rows, count } = selection;
  for (let i = 0; i < count; i++) tally(counts, col[rows[i]], min, max, scale, last);
  return counts;
}

function tally(
  counts: Uint32Array,
  v: number,
  min: number,
  max: number,
  scale: number,
  last: number,
): void {
  if (v < min || v > max) return;
  let idx = ((v - min) * scale) | 0;
  if (idx > last) idx = last; // the maximum value belongs in the final bin
  counts[idx]++;
}
