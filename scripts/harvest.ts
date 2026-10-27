/**
 * Builds src/core/markets.ts from a fare source.
 *
 *   node scripts/harvest.ts --csv <path to DB1BMarket CSV> --period "2025 Q1"
 *
 * The output is committed, so builds and tests never touch the network. Run
 * this when a new quarter is published, or when adding a second provider.
 *
 * Downloading the DB1B file is left to you — it is ~90MB compressed and
 * several GB extracted, which does not belong in an automated build:
 *
 *   curl -L -o db1b.zip \
 *     https://transtats.bts.gov/PREZIP/Origin_and_Destination_Survey_DB1BMarket_2025_1.zip
 *   unzip db1b.zip
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDb1bProvider } from '../src/harvest/db1b.ts';
import { emitMarketModule } from '../src/harvest/emit.ts';
import { HarvestError, type HarvestProvider } from '../src/harvest/provider.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const csvPath = arg('csv');
const period = arg('period', '2025 Q1')!;
const limit = Number(arg('limit', '1200'));
const minPassengers = Number(arg('min-passengers', '50'));
const out = arg('out', join(ROOT, 'src/core/markets.ts'))!;

if (!csvPath) {
  console.error('usage: node scripts/harvest.ts --csv <DB1BMarket CSV> [--period "2025 Q1"] [--limit 1200]');
  process.exit(2);
}
if (!existsSync(csvPath)) {
  console.error(`no such file: ${csvPath}`);
  process.exit(2);
}

export interface AirportMeta {
  city: string;
  lat: number;
  lon: number;
}

/**
 * DB1B carries neither city names nor coordinates. OpenFlights has both and
 * needs no key. Coordinates are what let the page suggest a nearby airport.
 */
async function fetchAirportMeta(log: (m: string) => void): Promise<Map<string, AirportMeta>> {
  const meta = new Map<string, AirportMeta>();
  try {
    log('fetching airport names and coordinates from OpenFlights');
    const res = await fetch(
      'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat',
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const line of (await res.text()).split('\n')) {
      // id, name, city, country, iata, icao, lat, lon, ...  — quoted CSV
      const m = line.match(
        /^[^,]*,"([^"]*)","([^"]*)","[^"]*","([A-Z]{3})","[^"]*",(-?[\d.]+),(-?[\d.]+)/,
      );
      if (!m) continue;
      const lat = Number(m[4]);
      const lon = Number(m[5]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      meta.set(m[3], { city: m[2] || m[1], lat, lon });
    }
    log(`  ${meta.size.toLocaleString()} airports located`);
  } catch (err) {
    // Not fatal: the UI falls back to the IATA code and skips the suggestion.
    log(`  airport lookup unavailable (${(err as Error).message}); codes will be used`);
  }
  return meta;
}

const provider: HarvestProvider = createDb1bProvider({ csvPath, period, limit, minPassengers });

const log = (m: string) => console.log(m);
log(`harvesting with ${provider.name}`);

try {
  const started = Date.now();
  const cacheDir = join(ROOT, '.data');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

  const [run, airportMeta] = await Promise.all([
    provider.run({ cacheDir, log }),
    fetchAirportMeta(log),
  ]);

  const source = emitMarketModule({
    markets: run.markets,
    airports: airportMeta,
    period: run.period,
    attribution: run.attribution,
    source: run.source,
  });
  writeFileSync(out, source);

  const airports = new Set(run.markets.flatMap((m) => [m.origin, m.dest]));
  const carriers = new Set(run.markets.flatMap((m) => m.carriers.map((c) => c.code)));
  log(
    `\nwrote ${out}\n` +
    `  ${run.markets.length.toLocaleString()} markets, ${airports.size} airports, ` +
    `${carriers.size} carriers, ${(source.length / 1024).toFixed(0)}KB\n` +
    `  ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
} catch (err) {
  if (err instanceof HarvestError) {
    console.error(`\nharvest failed: ${err.message}`);
    if (err.hint) console.error(err.hint);
    process.exit(1);
  }
  throw err;
}
