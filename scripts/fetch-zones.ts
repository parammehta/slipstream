/**
 * Builds src/core/zones.ts: IATA -> IANA time zone.
 *
 *   node scripts/fetch-zones.ts
 *
 * Arrival times are wrong without this. A flight is stored as a local
 * departure plus an elapsed duration, so the arrival clock only reads
 * correctly once the zone change between the two airports is added back, and
 * that change is a property of the airports rather than of the fare data.
 *
 * Only airports the dataset actually uses are emitted — OpenFlights lists
 * ~6,000 and the page would carry all of them for nothing.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { marketDataset } from '../src/core/markets.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/core/zones.ts');
const SOURCE =
  'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';

const needed = new Set(marketDataset().airports.map((a) => a.iata));
console.log(`${needed.size} airports in the dataset`);

const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`OpenFlights returned HTTP ${res.status}`);

/**
 * id,"name","city","country","IATA","ICAO",lat,lon,alt,tzOffset,"DST","Zone",...
 *
 * The zone name is the twelfth field. Matching it positionally rather than by
 * a loose search keeps a city called "America/Something" from being read as
 * one.
 */
const ROW =
  /^[^,]*,"[^"]*","[^"]*","[^"]*","([A-Z]{3})","[^"]*",[-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+,"[^"]*","([^"]+)"/;

const zones = new Map<string, string>();
for (const line of (await res.text()).split('\n')) {
  const m = ROW.exec(line);
  if (!m) continue;
  const [, iata, zone] = m;
  // "\N" is OpenFlights' null, and a handful of rows carry "Unknown".
  if (!needed.has(iata) || !zone.includes('/')) continue;
  zones.set(iata, zone);
}

const missing = [...needed].filter((code) => !zones.has(code)).sort();
const sorted = [...zones.entries()].sort(([a], [b]) => a.localeCompare(b));

// A zone that this runtime cannot resolve would silently format as UTC and
// put the arrival clock back where it started, so they are checked here where
// the failure is loud rather than in the page where it is invisible.
for (const [iata, zone] of sorted) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`${iata}: ICU does not know the zone "${zone}"`);
  }
}

writeFileSync(
  OUT,
  `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by scripts/fetch-zones.ts from OpenFlights.
 * ${sorted.length} airports.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}
 *
 * Data only: the arithmetic that uses it is in src/core/tz.ts, which is
 * hand-written and tested. An airport missing here is left uncorrected
 * rather than guessed at.
 */

export const AIRPORT_ZONES: Record<string, string> = ${JSON.stringify(
    Object.fromEntries(sorted),
    null,
    2,
  )};
`,
);

console.log(`wrote ${OUT}\n  ${sorted.length} airports`);
if (missing.length) console.log(`  no zone for: ${missing.join(', ')}`);
