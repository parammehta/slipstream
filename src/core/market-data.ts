/**
 * The in-memory shape of a harvested fare dataset.
 *
 * Kept separate from the generated data module so tests can build small
 * datasets by hand, and so a second provider can emit the same structure
 * without the generator and the consumer having to agree on a binary layout.
 */

export interface MarketAirport {
  iata: string;
  city: string;
}

export interface MarketCarrierShare {
  /** Index into `MarketDataset.carriers`. */
  id: number;
  /** Fraction of this market's passengers, 0..1. */
  share: number;
}

export interface MarketRow {
  /** Indices into `MarketDataset.airports`. */
  origin: number;
  dest: number;
  distanceMiles: number;
  /** Fare curve in US cents, p10..p90. */
  fareQuantiles: number[];
  /** Passengers observed, used to weight how often the market is sampled. */
  passengers: number;
  /** Share of passengers who flew a connecting itinerary, 0..1. */
  connectingShare: number;
  carriers: MarketCarrierShare[];
}

export interface MarketDataset {
  airports: MarketAirport[];
  carriers: string[];
  /** Vintage of the underlying data, e.g. "2025 Q1". */
  period: string;
  attribution: string;
  markets: MarketRow[];
}

/**
 * Cumulative weights for sampling a market in proportion to how much traffic
 * it actually carries, so SFO–LAX shows up far more than a thin regional pair.
 */
export function cumulativeWeights(markets: MarketRow[]): Float64Array {
  const out = new Float64Array(markets.length);
  let total = 0;
  for (let i = 0; i < markets.length; i++) {
    total += Math.max(0, markets[i].passengers);
    out[i] = total;
  }
  return out;
}

/** Binary search for the first cumulative weight strictly greater than `u * total`. */
export function pickWeighted(cumulative: Float64Array, u: number): number {
  const n = cumulative.length;
  if (n === 0) return -1;
  const total = cumulative[n - 1];
  if (!(total > 0)) return Math.min(n - 1, Math.floor(u * n));

  const target = u * total;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
