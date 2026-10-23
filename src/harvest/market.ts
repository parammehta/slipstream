import { weightedQuantiles, QUANTILE_COUNT } from './distribution.ts';
import type { FareObservation } from './provider.ts';

/**
 * An origin–destination market, aggregated from individual fare observations.
 *
 * This is the unit the published dataset stores: one row per city pair rather
 * than per ticket, carrying enough shape (the fare curve, who flies it, how
 * often it is sold with a connection) to generate believable offers without
 * shipping millions of raw records.
 */
export interface Market {
  origin: string;
  dest: string;
  /** Miles, as reported by the source; median across observations. */
  distanceMiles: number;
  /** Carrier IATA codes with their share of passengers on this market. */
  carriers: Array<{ code: string; share: number }>;
  /** Fare curve in US cents, p10..p90. */
  fareQuantiles: number[];
  /** Total passengers observed, used to weight market selection. */
  passengers: number;
  /** Share of passengers who travelled on a connecting itinerary. */
  connectingShare: number;
}

export interface BuildOptions {
  /** Drop markets thinner than this; they are mostly data noise. */
  minPassengers?: number;
  /** Keep only the busiest N markets. */
  limit?: number;
  /** Discard fares at or below this, in cents. */
  minFareCents?: number;
  /** Discard fares at or above this, in cents. */
  maxFareCents?: number;
}

const DEFAULTS = {
  minPassengers: 20,
  limit: 1200,
  // DB1B carries bulk fares and keypunch errors at both ends; $20 and $4,000
  // bracket essentially all genuine one-way domestic economy fares.
  minFareCents: 2000,
  maxFareCents: 400000,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Aggregate observations into markets.
 *
 * Direction is preserved: a one-way fare from A to B is not the same product
 * as B to A, and collapsing them would hide genuinely asymmetric pricing.
 */
export function buildMarkets(
  observations: FareObservation[],
  options: BuildOptions = {},
): Market[] {
  const opts = { ...DEFAULTS, ...options };

  interface Bucket {
    origin: string;
    dest: string;
    fares: number[];
    weights: number[];
    distances: number[];
    carriers: Map<string, number>;
    passengers: number;
    connecting: number;
  }

  const buckets = new Map<string, Bucket>();

  for (const o of observations) {
    if (o.fareCents < opts.minFareCents || o.fareCents > opts.maxFareCents) continue;
    if (!(o.passengers > 0)) continue;

    const key = o.origin + o.dest;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        origin: o.origin, dest: o.dest,
        fares: [], weights: [], distances: [],
        carriers: new Map(), passengers: 0, connecting: 0,
      };
      buckets.set(key, bucket);
    }

    bucket.fares.push(o.fareCents);
    bucket.weights.push(o.passengers);
    if (o.distanceMiles) bucket.distances.push(o.distanceMiles);
    bucket.carriers.set(o.carrier, (bucket.carriers.get(o.carrier) ?? 0) + o.passengers);
    bucket.passengers += o.passengers;
    if (o.stops > 0) bucket.connecting += o.passengers;
  }

  const markets: Market[] = [];
  for (const b of buckets.values()) {
    if (b.passengers < opts.minPassengers) continue;

    const carriers = [...b.carriers.entries()]
      .map(([code, weight]) => ({ code, share: weight / b.passengers }))
      .sort((x, y) => y.share - x.share);

    markets.push({
      origin: b.origin,
      dest: b.dest,
      distanceMiles: median(b.distances),
      carriers,
      fareQuantiles: weightedQuantiles(b.fares, b.weights, QUANTILE_COUNT),
      passengers: b.passengers,
      connectingShare: b.connecting / b.passengers,
    });
  }

  markets.sort((a, b) => b.passengers - a.passengers);
  return opts.limit ? markets.slice(0, opts.limit) : markets;
}
