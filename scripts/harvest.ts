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
import { dirname, join, resolve } from 'node:path';
import { createDb1bProvider } from '../src/harvest/db1b.ts';
import { createTravelpayoutsProvider } from '../src/harvest/travelpayouts.ts';
import { emitMarketModule } from '../src/harvest/emit.ts';
import { HarvestError, type HarvestProvider } from '../src/harvest/provider.ts';
import { marketDataset } from '../src/core/markets.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const providerId = arg('provider', 'db1b')!;
const out = arg('out')!;

/** The dataset the deployed site is built from. */
const PUBLISHED_OUT = join(ROOT, 'src/core/markets.ts');

function usage(message: string): never {
  console.error(message);
  console.error(
    '\nusage:\n' +
    '  node scripts/harvest.ts --provider db1b --csv <DB1BMarket CSV> [--period "2025 Q1"]\n' +
    '  node scripts/harvest.ts --provider travelpayouts [--origins LAX,JFK,...] [--seeds 40]\n',
  );
  process.exit(2);
}

/**
 * Seed origins for the price cache.
 *
 * The cache only holds routes somebody searched recently, so asking it which
 * routes matter is circular. The committed DB1B dataset already knows which
 * origins carry real traffic, so discovery starts there and the cache is only
 * asked what those origins cost today.
 */
function busiestOrigins(count: number): string[] {
  const dataset = marketDataset();
  const weight = new Map<string, number>();
  for (const m of dataset.markets) {
    const code = dataset.airports[m.origin]?.iata;
    if (code) weight.set(code, (weight.get(code) ?? 0) + m.passengers);
  }
  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([code]) => code);
}

function buildProvider(): { provider: HarvestProvider; defaultOut: string } {
  if (providerId === 'db1b') {
    const csvPath = arg('csv');
    const period = arg('period', '2025 Q1')!;
    if (!csvPath) usage('--provider db1b needs --csv <DB1BMarket CSV>');
    if (!existsSync(csvPath)) usage(`no such file: ${csvPath}`);
    return {
      provider: createDb1bProvider({
        csvPath,
        period,
        limit: Number(arg('limit', '1200')),
        minPassengers: Number(arg('min-passengers', '50')),
      }),
      defaultOut: PUBLISHED_OUT,
    };
  }

  if (providerId === 'travelpayouts') {
    // Loaded from .env.local, which is gitignored. The token is never echoed,
    // and it is read here rather than in the provider so the provider stays
    // testable without touching the filesystem.
    try {
      process.loadEnvFile(join(ROOT, '.env.local'));
    } catch {
      // Absent is fine; the variable may already be in the environment.
    }
    const token = process.env.TRAVELPAYOUTS_TOKEN;
    if (!token) {
      usage(
        'TRAVELPAYOUTS_TOKEN is not set.\n' +
        'Put it in .env.local (gitignored): TRAVELPAYOUTS_TOKEN=<your token>',
      );
    }
    const origins = (arg('origins') ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    return {
      provider: createTravelpayoutsProvider({
        token,
        origins: origins.length ? origins : busiestOrigins(Number(arg('seeds', '40'))),
        period: arg('period', new Date().toISOString().slice(0, 10) + ' cache')!,
        limit: Number(arg('limit', '1200')),
        minQuotes: Number(arg('min-quotes', '8')),
        concurrency: Number(arg('concurrency', '6')),
      }),
      // Deliberately not the published path: see the gate below.
      defaultOut: join(ROOT, '.data/markets-travelpayouts.ts'),
    };
  }

  usage(`unknown provider: ${providerId}`);
}

const { provider, defaultOut } = buildProvider();
const outPath = out ?? defaultOut;

/**
 * Publication gate.
 *
 * DB1B is public domain, so its output goes straight to the published module.
 * Travelpayouts fares are licensed, and whether this project may re-serve them
 * as static data depends on terms that have not been confirmed yet. Writing to
 * the published path is therefore refused rather than merely discouraged: a
 * note in a README is not a control, and the failure mode is publishing
 * somebody else\'s data without the right to.
 */
if (providerId === 'travelpayouts' && resolve(outPath) === resolve(PUBLISHED_OUT)) {
  console.error(
    'refusing to write Travelpayouts fares to the published dataset.\n\n' +
    'Harvesting is fine; re-serving the result from the site is what needs the\n' +
    'display terms confirmed first — specifically whether this project may:\n' +
    '  1. store fares and re-serve them as static data, and for how long\n' +
    '  2. display them without an affiliate click-through\n' +
    '  3. attribute them in the form this repo uses\n' +
    '  4. harvest at the rate this script uses\n\n' +
    `Until then, write somewhere else (the default is ${defaultOut.replace(ROOT, '.')}).`,
  );
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
  writeFileSync(outPath, source);

  const airports = new Set(run.markets.flatMap((m) => [m.origin, m.dest]));
  const carriers = new Set(run.markets.flatMap((m) => m.carriers.map((c) => c.code)));
  log(
    `\nwrote ${outPath}\n` +
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
