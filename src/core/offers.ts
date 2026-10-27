import { OFFER_SCHEMA, allocColumn, type TypedArray } from './format.ts';
import type { SlabInput } from './encode.ts';
import { cumulativeWeights, pickWeighted, type MarketDataset } from './market-data.ts';
import { sampleFromQuantiles } from '../harvest/distribution.ts';
import { todayEpochDay } from './tz.ts';

/** mulberry32 — small, fast, and seedable so benchmarks are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KM_PER_MILE = 1.60934;
const CRUISE_KMH = 800;
const GROUND_MINUTES = 40;
const DAYS = 60;

/**
 * Generate offers from a harvested dataset.
 *
 * Fares are drawn from each market's observed fare curve rather than a
 * formula, so the spread between a cheap seat and an expensive one on the
 * same route is the real spread. Schedules are modelled: the source reports
 * what people paid and how far they flew, not when they left.
 */
export function generateOffersFromMarkets(
  dataset: MarketDataset,
  rowCount: number,
  seed = 1,
  baseDayEpoch = todayEpochDay(),
): SlabInput {
  const rand = mulberry32(seed);
  const { markets } = dataset;
  if (markets.length === 0) throw new Error('generateOffersFromMarkets: dataset has no markets');

  const columns: Record<string, TypedArray> = Object.create(null);
  for (const { name, type } of OFFER_SCHEMA) columns[name] = allocColumn(type, rowCount);

  const depMin = columns.depMin as Int32Array;
  const arrMin = columns.arrMin as Int32Array;
  const durationMin = columns.durationMin as Uint16Array;
  const priceCents = columns.priceCents as Uint32Array;
  const stops = columns.stops as Uint8Array;
  const carrierId = columns.carrierId as Uint8Array;
  const originId = columns.originId as Uint16Array;
  const destId = columns.destId as Uint16Array;

  const marketWeights = cumulativeWeights(markets);
  // Per-market carrier pickers, built once.
  const carrierCumulative = markets.map((m) => {
    const out = new Float64Array(m.carriers.length);
    let total = 0;
    for (let i = 0; i < m.carriers.length; i++) {
      total += Math.max(0, m.carriers[i].share);
      out[i] = total;
    }
    return out;
  });

  for (let i = 0; i < rowCount; i++) {
    const mi = pickWeighted(marketWeights, rand());
    const market = markets[mi];
    const km = market.distanceMiles * KM_PER_MILE;

    // How often this city pair is actually sold with a connection, observed.
    const connecting = rand() < market.connectingShare;
    const stopCount = !connecting ? 0 : km > 3000 && rand() > 0.75 ? 2 : 1;

    // Aircraft type, routing and winds move block times around a schedule,
    // so without jitter every nonstop on a route reads the same minute and a
    // screen of results looks copy-pasted.
    const jitter = 0.94 + rand() * 0.12;
    const nonstopMinutes = (GROUND_MINUTES + (km / CRUISE_KMH) * 60) * jitter;
    const layover = 55 + rand() * (55 + km / 80);
    const duration = Math.min(
      65535,
      Math.max(25, Math.round(nonstopMinutes + stopCount * layover + stopCount * nonstopMinutes * 0.18)),
    );

    const day = (rand() * DAYS) | 0;
    const depart = day * 1440 + ((rand() * 1440) | 0);

    // Connections sit lower on the same market's fare curve.
    const u = connecting ? rand() * 0.75 : 0.15 + rand() * 0.85;
    const fare = Math.round(sampleFromQuantiles(market.fareQuantiles, u));

    const carriers = market.carriers;
    const ci = carriers.length
      ? carriers[pickWeighted(carrierCumulative[mi], rand())].id
      : 0;

    originId[i] = market.origin;
    destId[i] = market.dest;
    carrierId[i] = ci;
    stops[i] = stopCount;
    durationMin[i] = duration;
    depMin[i] = depart;
    arrMin[i] = depart + duration;
    priceCents[i] = fare;
  }

  return {
    rowCount,
    baseDayEpoch,
    columns,
    dicts: {
      airports: dataset.airports.map((a) => a.iata),
      carriers: dataset.carriers.slice(),
      cities: dataset.airports.map((a) => a.city),
    },
    schema: OFFER_SCHEMA,
  };
}
