import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { weightedQuantiles, QUANTILE_COUNT } from './distribution.ts';
import type { Market } from './market.ts';
import { HarvestError, type HarvestContext, type HarvestProvider, type ProviderRun } from './provider.ts';

/**
 * US DOT Airline Origin and Destination Survey (DB1B), Market table.
 *
 * A 10% sample of tickets sold by US reporting carriers: real fares people
 * actually paid, published quarterly, in the public domain. No account, no
 * key, no rate limit — which is why it is the first provider.
 *
 * What it does not contain is schedules. DB1B records what was paid and how
 * far the passenger flew, never when they departed, so departure times are
 * modelled downstream and the README says so.
 *
 * The uncompressed file runs to several gigabytes, so this streams and
 * aggregates in two passes: one to find the busiest markets, one to build
 * their fare curves. Holding every fare in memory would need gigabytes;
 * a histogram per market needs a few megabytes.
 */

/** Fare histogram resolution, in dollars. */
const BIN_DOLLARS = 5;
const MAX_FARE_DOLLARS = 4000;
const MIN_FARE_DOLLARS = 20;
const BIN_COUNT = MAX_FARE_DOLLARS / BIN_DOLLARS;

export interface Db1bOptions {
  /** Path to the extracted DB1BMarket CSV. */
  csvPath: string;
  period: string;
  /** Keep this many markets, busiest first. */
  limit?: number;
  minPassengers?: number;
}

/** DB1B ships quoted CSV; fields are simple but quoting is inconsistent. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Column lookup by name, so a change in column order cannot silently corrupt the parse. */
function indexColumns(header: string[], wanted: string[]): Record<string, number> {
  const normalised = header.map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const out: Record<string, number> = {};
  for (const name of wanted) {
    const i = normalised.indexOf(name.toLowerCase());
    if (i < 0) {
      throw new HarvestError(
        `DB1B: column "${name}" not found`,
        `The file has: ${header.slice(0, 20).join(', ')}…`,
      );
    }
    out[name] = i;
  }
  return out;
}

const COLUMNS = [
  'Origin', 'Dest', 'OpCarrier', 'TkCarrier',
  'Passengers', 'MktFare', 'MktDistance', 'MktCoupons', 'BulkFare',
];

interface Row {
  origin: string; dest: string; carrier: string;
  passengers: number; fareDollars: number; distance: number; coupons: number;
}

/** Parse a line into a row, or null when it should be skipped. */
function parseRow(fields: string[], col: Record<string, number>): Row | null {
  // Bulk fares are tour-operator inventory, not what a passenger paid. The
  // column is written as a decimal ("0.00"/"1.00"), so compare numerically.
  if (Number(fields[col.BulkFare]) > 0) return null;

  const origin = fields[col.Origin]?.trim().toUpperCase();
  const dest = fields[col.Dest]?.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(dest) || origin === dest) return null;

  const carrier = (fields[col.OpCarrier] || fields[col.TkCarrier] || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(carrier)) return null;

  const passengers = Number(fields[col.Passengers]);
  const fareDollars = Number(fields[col.MktFare]);
  const distance = Number(fields[col.MktDistance]);
  const coupons = Number(fields[col.MktCoupons]);
  if (!(passengers > 0) || !Number.isFinite(fareDollars) || !Number.isFinite(distance)) return null;
  // $0 and near-$0 fares are award tickets, employee travel and keypunch
  // errors; they are not prices anyone paid and they drag the curve down.
  if (fareDollars < MIN_FARE_DOLLARS || fareDollars > MAX_FARE_DOLLARS) return null;

  return { origin, dest, carrier, passengers, fareDollars, distance, coupons };
}

async function* readRows(csvPath: string, log: (m: string) => void) {
  const stream = createReadStream(csvPath, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let col: Record<string, number> | null = null;
  let seen = 0;
  for await (const line of lines) {
    if (!line) continue;
    const fields = splitCsv(line);
    if (!col) { col = indexColumns(fields, COLUMNS); continue; }
    const row = parseRow(fields, col);
    if (++seen % 5_000_000 === 0) log(`  …${(seen / 1e6).toFixed(0)}M rows read`);
    if (row) yield row;
  }
}

export function createDb1bProvider(options: Db1bOptions): HarvestProvider {
  const limit = options.limit ?? 1200;
  const minPassengers = options.minPassengers ?? 50;

  return {
    id: 'db1b',
    name: 'US DOT DB1B Market (Airline Origin and Destination Survey)',
    requiresCredentials: false,

    async run(ctx: HarvestContext): Promise<ProviderRun> {
      ctx.log('pass 1/2 — ranking markets by traffic');
      const traffic = new Map<string, number>();
      for await (const r of readRows(options.csvPath, ctx.log)) {
        const key = r.origin + r.dest;
        traffic.set(key, (traffic.get(key) ?? 0) + r.passengers);
      }
      ctx.log(`  ${traffic.size.toLocaleString()} directional markets seen`);

      const keep = new Map<string, number>();
      [...traffic.entries()]
        .filter(([, p]) => p >= minPassengers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .forEach(([key], i) => keep.set(key, i));
      ctx.log(`  keeping the busiest ${keep.size.toLocaleString()}`);

      if (keep.size === 0) {
        throw new HarvestError('DB1B: no markets met the passenger threshold', 'Lower --min-passengers.');
      }

      ctx.log('pass 2/2 — building fare curves');
      // One histogram per kept market: a few MB, against gigabytes for raw fares.
      const histograms = Array.from({ length: keep.size }, () => new Uint32Array(BIN_COUNT));
      const carriers = Array.from({ length: keep.size }, () => new Map<string, number>());
      const distances = Array.from({ length: keep.size }, () => new Map<number, number>());
      const passengers = new Float64Array(keep.size);
      const connecting = new Float64Array(keep.size);
      const names: Array<[string, string]> = new Array(keep.size);

      for await (const r of readRows(options.csvPath, ctx.log)) {
        const slot = keep.get(r.origin + r.dest);
        if (slot === undefined) continue;

        names[slot] = [r.origin, r.dest];
        passengers[slot] += r.passengers;
        if (r.coupons > 1) connecting[slot] += r.passengers;
        carriers[slot].set(r.carrier, (carriers[slot].get(r.carrier) ?? 0) + r.passengers);
        if (r.distance > 0) {
          distances[slot].set(r.distance, (distances[slot].get(r.distance) ?? 0) + r.passengers);
        }

        const bin = Math.floor(r.fareDollars / BIN_DOLLARS);
        if (bin >= 0 && bin < BIN_COUNT) histograms[slot][bin] += r.passengers;
      }

      const markets: Market[] = [];
      for (let slot = 0; slot < keep.size; slot++) {
        if (!names[slot] || passengers[slot] <= 0) continue;
        const counts = histograms[slot];

        const values: number[] = [];
        const weights: number[] = [];
        for (let b = 0; b < BIN_COUNT; b++) {
          if (counts[b] === 0) continue;
          values.push((b + 0.5) * BIN_DOLLARS * 100); // bin midpoint, in cents
          weights.push(counts[b]);
        }
        if (values.length === 0) continue;

        let topDistance = 0;
        let topWeight = -1;
        for (const [d, w] of distances[slot]) if (w > topWeight) { topDistance = d; topWeight = w; }

        const total = passengers[slot];
        markets.push({
          origin: names[slot][0],
          dest: names[slot][1],
          distanceMiles: topDistance,
          carriers: [...carriers[slot].entries()]
            .map(([code, w]) => ({ code, share: w / total }))
            .sort((a, b) => b.share - a.share),
          fareQuantiles: weightedQuantiles(values, weights, QUANTILE_COUNT),
          passengers: Math.round(total),
          connectingShare: connecting[slot] / total,
        });
      }

      markets.sort((a, b) => b.passengers - a.passengers);
      ctx.log(`  built ${markets.length.toLocaleString()} markets`);

      return {
        period: options.period,
        attribution:
          'Fare data: US Department of Transportation, Bureau of Transportation Statistics, ' +
          'Airline Origin and Destination Survey (DB1B). Public domain.',
        source: 'US DOT DB1B Market, ' + options.period,
        markets,
        cities: new Map(),
      };
    },
  };
}
