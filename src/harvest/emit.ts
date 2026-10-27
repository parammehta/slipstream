import type { Market } from './market.ts';
import { QUANTILE_COUNT } from './distribution.ts';

/**
 * Packs harvested markets into a generated TypeScript module.
 *
 * The demo is a single self-contained file, so the dataset has to travel as
 * source. A fixed-width record per market plus a flattened carrier section
 * keeps ~1,000 markets near 50KB of base64 — small enough to inline, while
 * still carrying the full fare curve for each one.
 *
 * Fares are stored in whole dollars: cents would need a u32 per cut point and
 * double the fare section, and the UI rounds to the dollar anyway.
 */

/** origin u16, dest u16, distance u16, passengers u32, connecting u8, carrierCount u8, 9 × fare u16. */
const FIXED_BYTES = 2 + 2 + 2 + 4 + 1 + 1 + QUANTILE_COUNT * 2;

export interface AirportMeta {
  city: string;
  lat: number;
  lon: number;
}

export interface EmitInput {
  markets: Market[];
  /**
   * IATA -> name and position. Missing entries fall back to the code and
   * carry no coordinates, which only costs them the nearby-airport guess.
   */
  airports: Map<string, AirportMeta>;
  period: string;
  attribution: string;
  source: string;
}

export function emitMarketModule(input: EmitInput): string {
  const { markets } = input;

  const airportIndex = new Map<string, number>();
  const airports: Array<{ iata: string; city: string; lat?: number; lon?: number }> = [];
  const carrierIndex = new Map<string, number>();
  const carriers: string[] = [];

  const airportId = (iata: string) => {
    let id = airportIndex.get(iata);
    if (id === undefined) {
      id = airports.length;
      airportIndex.set(iata, id);
      const meta = input.airports.get(iata);
      airports.push(
        meta
          ? { iata, city: meta.city, lat: +meta.lat.toFixed(4), lon: +meta.lon.toFixed(4) }
          : { iata, city: iata },
      );
    }
    return id;
  };
  const carrierId = (code: string) => {
    let id = carrierIndex.get(code);
    if (id === undefined) {
      id = carriers.length;
      carrierIndex.set(code, id);
      carriers.push(code);
    }
    return id;
  };

  // Carriers are capped at 255 because the slab stores carrierId as a u8.
  const carrierPairs: number[] = [];
  const fixed = new Uint8Array(markets.length * FIXED_BYTES);
  const view = new DataView(fixed.buffer);

  markets.forEach((m, i) => {
    const base = i * FIXED_BYTES;
    view.setUint16(base, airportId(m.origin), true);
    view.setUint16(base + 2, airportId(m.dest), true);
    view.setUint16(base + 4, Math.min(65535, Math.round(m.distanceMiles)), true);
    view.setUint32(base + 6, Math.min(0xffffffff, Math.round(m.passengers)), true);
    view.setUint8(base + 10, Math.round(Math.min(1, Math.max(0, m.connectingShare)) * 255));

    const kept = m.carriers.filter((c) => c.share > 0.01).slice(0, 8);
    const list = kept.length ? kept : m.carriers.slice(0, 1);
    view.setUint8(base + 11, list.length);
    for (const c of list) {
      carrierPairs.push(carrierId(c.code), Math.max(1, Math.round(c.share * 255)));
    }

    for (let q = 0; q < QUANTILE_COUNT; q++) {
      const dollars = Math.round((m.fareQuantiles[q] ?? 0) / 100);
      view.setUint16(base + 12 + q * 2, Math.min(65535, Math.max(0, dollars)), true);
    }
  });

  if (carriers.length > 255) {
    throw new Error(`emitMarketModule: ${carriers.length} carriers exceeds the u8 slab column`);
  }

  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  return `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by scripts/harvest.ts from ${input.source}.
 * Period: ${input.period}. ${markets.length} markets, ${airports.length} airports, ${carriers.length} carriers.
 *
 * ${input.attribution}
 *
 * Fares are real: each market carries the observed fare curve (p10..p90, in
 * whole US dollars) rather than a formula. Schedules are not — the source
 * reports what was paid and how far people flew, not when they departed.
 */
import type { MarketDataset, MarketRow } from './market-data.ts';

export const PERIOD = ${JSON.stringify(input.period)};
export const ATTRIBUTION = ${JSON.stringify(input.attribution)};

const AIRPORTS = ${JSON.stringify(airports)};
const CARRIERS = ${JSON.stringify(carriers)};
const MARKET_FIXED = '${b64(fixed)}';
const MARKET_CARRIER_PAIRS = '${b64(Uint8Array.from(carrierPairs))}';
const MARKET_FIXED_BYTES = ${FIXED_BYTES};
const MARKET_QUANTILE_COUNT = ${QUANTILE_COUNT};

// Names are prefixed because the demo build flattens every module into one
// scope, where a bare QUANTILE_COUNT would collide with the harvester's.
function marketBytes(b64: string): Uint8Array {
  const binary = typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

let cached: MarketDataset | null = null;

/** Decoded once and shared; the dataset is read-only. */
export function marketDataset(): MarketDataset {
  if (cached) return cached;

  const fixed = marketBytes(MARKET_FIXED);
  const pairs = marketBytes(MARKET_CARRIER_PAIRS);
  const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
  const count = Math.floor(fixed.length / MARKET_FIXED_BYTES);

  const markets: MarketRow[] = [];
  let pairCursor = 0;
  for (let i = 0; i < count; i++) {
    const base = i * MARKET_FIXED_BYTES;
    const carrierCount = view.getUint8(base + 11);

    const carriers = [];
    for (let c = 0; c < carrierCount; c++) {
      carriers.push({ id: pairs[pairCursor++], share: pairs[pairCursor++] / 255 });
    }

    const fareQuantiles = [];
    for (let q = 0; q < MARKET_QUANTILE_COUNT; q++) {
      fareQuantiles.push(view.getUint16(base + 12 + q * 2, true) * 100);
    }

    markets.push({
      origin: view.getUint16(base, true),
      dest: view.getUint16(base + 2, true),
      distanceMiles: view.getUint16(base + 4, true),
      passengers: view.getUint32(base + 6, true),
      connectingShare: view.getUint8(base + 10) / 255,
      fareQuantiles,
      carriers,
    });
  }

  cached = { airports: AIRPORTS, carriers: CARRIERS, period: PERIOD, attribution: ATTRIBUTION, markets };
  return cached;
}
`;
}
