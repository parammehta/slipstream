/**
 * Fare distributions, compressed to quantiles.
 *
 * A busy market can carry tens of thousands of observed fares. Keeping them
 * all would make the published dataset far larger than the demo it feeds, and
 * keeping only a mean would throw away the thing that makes fares interesting:
 * the spread between what people actually pay on the same route.
 *
 * Quantiles keep the shape at fixed cost — nine numbers per market reproduce
 * the decile curve, and sampling interpolates between them.
 */

/** Number of cut points stored per market: the nine deciles, p10..p90. */
export const QUANTILE_COUNT = 9;

/**
 * Weighted quantiles over (value, weight) pairs.
 *
 * Weighting matters because DB1B is a 10% sample: a record covering 40
 * passengers describes the market far better than one covering a single
 * unusual ticket, and unweighted quantiles would treat them alike.
 */
export function weightedQuantiles(
  values: number[],
  weights: number[],
  count = QUANTILE_COUNT,
): number[] {
  if (values.length === 0) return new Array(count).fill(0);
  if (values.length !== weights.length) {
    throw new Error('weightedQuantiles: values and weights differ in length');
  }

  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) {
    // No usable weights: fall back to treating every observation equally.
    return weightedQuantiles(values, new Array(values.length).fill(1), count);
  }

  const out: number[] = [];
  let cursor = 0;
  let cumulative = 0;
  for (let q = 1; q <= count; q++) {
    const target = (total * q) / (count + 1);
    while (cursor < order.length - 1 && cumulative + Math.max(0, weights[order[cursor]]) < target) {
      cumulative += Math.max(0, weights[order[cursor]]);
      cursor++;
    }
    out.push(values[order[cursor]]);
  }
  return out;
}

/**
 * Draw a value from a quantile curve, interpolating between cut points.
 *
 * `u` is a uniform in [0,1). The tails below p10 and above p90 are extended
 * linearly from the nearest pair, so the cheapest and dearest fares stay
 * reachable instead of clamping to the stored extremes.
 */
export function sampleFromQuantiles(quantiles: number[], u: number): number {
  const n = quantiles.length;
  if (n === 0) return 0;
  if (n === 1) return quantiles[0];

  const t = Math.min(0.999999, Math.max(0, u));
  // Quantile i sits at probability (i + 1) / (n + 1).
  const pos = t * (n + 1) - 1;

  if (pos <= 0) {
    // Extend below p10, but not by the inter-decile slope: on a market whose
    // bottom decile is steep that runs straight past zero and invents fares
    // cheaper than anything observed. Bound it just under the real p10.
    const slope = quantiles[1] - quantiles[0];
    return Math.max(quantiles[0] * 0.85, quantiles[0] + slope * pos);
  }
  if (pos >= n - 1) {
    const slope = quantiles[n - 1] - quantiles[n - 2];
    return quantiles[n - 1] + slope * (pos - (n - 1));
  }

  const lo = Math.floor(pos);
  const frac = pos - lo;
  return quantiles[lo] + (quantiles[lo + 1] - quantiles[lo]) * frac;
}
