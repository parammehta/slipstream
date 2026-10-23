import { OFFER_SCHEMA, allocColumn, type TypedArray } from './format.ts';
import type { SlabInput } from './encode.ts';
import { AIRPORTS, CARRIERS, routeTable, distanceKm } from './routes.ts';

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

/** Cruise speed in km/h, plus fixed minutes for taxi, climb and descent. */
const CRUISE_KMH = 800;
const GROUND_MINUTES = 40;
/** Economy fare model: a floor plus a per-kilometre rate, in cents. */
const BASE_CENTS = 5000;
const CENTS_PER_KM = 5.5;

/**
 * Generate a plausible offer set over *real* routes.
 *
 * Origin and destination are drawn from routes that genuinely exist in the
 * OpenFlights data, the carrier is one that actually serves that route, and
 * duration follows from great-circle distance — so SFO–LHR is a long flight
 * because London is far away, not because of where it sits in an array.
 */
export function generateOffers(rowCount: number, seed = 1): SlabInput {
  const rand = mulberry32(seed);
  const routes = routeTable();

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

  // Distance per route is the same for every offer on it, so pay for it once.
  const routeKm = new Float32Array(routes.length);
  for (let r = 0; r < routes.length; r++) {
    routeKm[r] = distanceKm(AIRPORTS[routes.origin[r]], AIRPORTS[routes.dest[r]]);
  }

  // Carriers serving each route, expanded from the bitmask for fast sampling.
  const carriersFor: number[][] = new Array(routes.length);
  for (let r = 0; r < routes.length; r++) {
    const mask = routes.carrierMask[r];
    const list: number[] = [];
    for (let c = 0; c < CARRIERS.length; c++) if (mask & (1 << c)) list.push(c);
    carriersFor[r] = list;
  }

  for (let i = 0; i < rowCount; i++) {
    const r = (rand() * routes.length) | 0;
    const km = routeKm[r];

    // Long flights are likelier to be sold with a connection.
    const stopBias = km > 6000 ? 0.3 : km > 2000 ? 0.45 : 0.62;
    const stopCount = rand() < stopBias ? 0 : rand() < 0.82 ? 1 : 2;

    const nonstopMinutes = GROUND_MINUTES + (km / CRUISE_KMH) * 60;
    // Each connection adds a layover plus the detour it implies.
    const connection = stopCount * (70 + rand() * 150) + stopCount * nonstopMinutes * 0.18;
    const duration = Math.min(65535, Math.round(nonstopMinutes + connection));

    const day = (rand() * DAYS) | 0;
    const depart = day * 1440 + ((rand() * 1440) | 0);

    // Connections sell cheaper; the tail is lognormal.
    const base = (BASE_CENTS + km * CENTS_PER_KM) * (1 - 0.13 * stopCount);
    const price = Math.round(base * Math.exp(rand() * 0.95));

    const serving = carriersFor[r];
    originId[i] = routes.origin[r];
    destId[i] = routes.dest[r];
    carrierId[i] = serving[(rand() * serving.length) | 0];
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
    dicts: {
      airports: AIRPORTS.map((a) => a.iata),
      carriers: CARRIERS.slice(),
      cities: AIRPORTS.map((a) => a.city),
    },
    schema: OFFER_SCHEMA,
  };
}

export { AIRPORTS, CARRIERS };
