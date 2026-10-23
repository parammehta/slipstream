import { OFFER_SCHEMA, allocColumn, type TypedArray } from './format.ts';
import type { SlabInput } from './encode.ts';

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

const AIRPORTS = [
  'SFO', 'JFK', 'LAX', 'ORD', 'DFW', 'SEA', 'BOS', 'ATL', 'DEN', 'MIA',
  'LHR', 'CDG', 'AMS', 'FRA', 'NRT', 'HND', 'SIN', 'DXB', 'BOM', 'DEL',
  'SYD', 'YYZ', 'MEX', 'GRU', 'ICN', 'HKG', 'ZRH', 'MAD', 'BCN', 'FCO',
];

const CARRIERS = ['AA', 'UA', 'DL', 'AS', 'B6', 'WN', 'BA', 'LH', 'AF', 'KL', 'EK', 'SQ', 'QF', 'AC', 'NH'];

/**
 * Generate a plausible offer set: prices are lognormal-ish, duration tracks a
 * synthetic distance, and stops correlate with cheaper fares. Realistic enough
 * that filter selectivity in benchmarks resembles real traffic.
 */
export function generateOffers(rowCount: number, seed = 1): SlabInput {
  const rand = mulberry32(seed);
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

  const DAYS = 60; // a two-month shopping window

  for (let i = 0; i < rowCount; i++) {
    let o = (rand() * AIRPORTS.length) | 0;
    let d = (rand() * AIRPORTS.length) | 0;
    if (d === o) d = (d + 1) % AIRPORTS.length;

    // Stand-in for great-circle distance: index gap wrapped into a range.
    const gap = Math.abs(o - d);
    const baseDuration = 70 + gap * 38 + rand() * 240;

    const stopCount = rand() < 0.42 ? 0 : rand() < 0.8 ? 1 : 2;
    const duration = Math.min(65535, Math.round(baseDuration + stopCount * (90 + rand() * 150)));

    const day = (rand() * DAYS) | 0;
    const depart = day * 1440 + ((rand() * 1440) | 0);

    // Nonstops cost more per minute; long tail on the top end. The stop
    // discount is multiplicative so short two-stop hops stay positive instead
    // of clamping to a floor and producing thousands of identical fares.
    const base = (4000 + baseDuration * 34) * (1 - 0.13 * stopCount);
    const price = Math.round(base * Math.exp(rand() * 1.15));

    originId[i] = o;
    destId[i] = d;
    carrierId[i] = (rand() * CARRIERS.length) | 0;
    stops[i] = stopCount;
    durationMin[i] = duration;
    depMin[i] = depart;
    arrMin[i] = depart + duration;
    priceCents[i] = price;
  }

  return {
    rowCount,
    baseDayEpoch: 20000, // 2024-10-04; arbitrary but fixed for reproducibility
    columns,
    dicts: { airports: AIRPORTS.slice(), carriers: CARRIERS.slice() },
    schema: OFFER_SCHEMA,
  };
}

export { AIRPORTS, CARRIERS };
