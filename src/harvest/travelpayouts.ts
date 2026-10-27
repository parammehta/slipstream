import { buildMarkets, type Market } from './market.ts';
import {
  HarvestError,
  type FareObservation,
  type HarvestContext,
  type HarvestProvider,
  type ProviderRun,
} from './provider.ts';

/**
 * Travelpayouts Data API (Aviasales flight price cache).
 *
 * Where DB1B is a historical census of tickets sold, this is a cache of fares
 * returned to real searches on Aviasales in roughly the last 48 hours. The two
 * are complementary and neither replaces the other:
 *
 *   DB1B           what people paid, 2-3 quarters stale, no schedules at all
 *   Travelpayouts  what is quoted right now, including departure times
 *
 * The second difference is the one that matters for this project: these records
 * carry `departure_at`, so for the first time the schedule column is observed
 * rather than modelled. The fare curve is a curve of *quotes*, though, not of
 * transactions — cheap fares that nobody bought are weighted the same as ones
 * that sold out.
 *
 * It is also a cache, not an index. A route nobody has searched recently simply
 * is not in it, so coverage follows Aviasales search volume rather than actual
 * traffic. That is why discovery seeds from origins the DB1B dataset already
 * says are busy, instead of trusting this source to rank routes.
 *
 * Seeding fixes the origins but not the destinations, and the measured skew is
 * larger than it looks: a 20-origin run returned 342 markets of which 178 had
 * one end outside the US domestic network, and the ten busiest by quote count
 * were almost all US-to-CIS (JFK-TAS, JFK-VKO, LAX-EVN, ...). Aviasales grew
 * out of that market and its search traffic still shows it. So quote counts
 * order this dataset consistently against itself, and say nothing about US
 * travel demand -- ranking a US product by them would put Tashkent above
 * Miami. Anything user-facing should weight by DB1B and price from here.
 */

const BASE = 'https://api.travelpayouts.com/aviasales/v3';

/**
 * Observation weight.
 *
 * DB1B reports passengers per record and `Market.passengers` means what it
 * says. Nothing here counts passengers, so every quote weighs 1 and the field
 * holds an observation count: a proxy for search popularity, which correlates
 * with traffic but is not a measurement of it. The emitted module's header says
 * so, because a reader who assumes otherwise will over-read thin markets.
 */
const WEIGHT_PER_QUOTE = 1;

/** Economy. `trip_class` 1 and 2 are business and first. */
const ECONOMY = 0;

export interface TravelpayoutsOptions {
  token: string;
  /** City/airport codes to seed discovery from, uppercase IATA. */
  origins: string[];
  period: string;
  /**
   * Pricing market, which selects currency conventions and point of sale.
   * `us` is the only one this project publishes; changing it changes the fares.
   */
  market?: string;
  currency?: string;
  limit?: number;
  /** Minimum quotes before a market is kept. */
  minQuotes?: number;
  /** Concurrent requests. 24 at once drew no 429, so 6 is deliberately slack. */
  concurrency?: number;
  /** Injected in tests; defaults to `fetch` with the token header. */
  fetchJson?: (url: string) => Promise<unknown>;
}

/** One row of `get_latest_prices`. */
interface LatestRow {
  origin?: unknown;
  destination?: unknown;
  distance?: unknown;
  trip_class?: unknown;
  show_to_affiliates?: unknown;
  actual?: unknown;
}

/** One row of `prices_for_dates`. */
interface DatesRow {
  origin_airport?: unknown;
  destination_airport?: unknown;
  airline?: unknown;
  price?: unknown;
  transfers?: unknown;
  departure_at?: unknown;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Uppercase IATA, or null. Guards against the odd lowercase or padded code. */
function iata(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const code = s.trim().toUpperCase();
  return /^[A-Z0-9]{3}$/.test(code) ? code : null;
}

function rowsOf(payload: unknown, what: string): unknown[] {
  if (!payload || typeof payload !== 'object') {
    throw new HarvestError(`${what}: response was not an object`);
  }
  const body = payload as { data?: unknown; error?: unknown; success?: unknown };
  if (body.success === false || str(body.error)) {
    // The API reports a bad or throttled token in the body with HTTP 200, so a
    // run that only checked status codes would silently harvest nothing.
    throw new HarvestError(
      `${what}: ${str(body.error) ?? 'request rejected'}`,
      'Check TRAVELPAYOUTS_TOKEN is the API token from the Travelpayouts dashboard.',
    );
  }
  return Array.isArray(body.data) ? body.data : [];
}

/**
 * A market discovered from the price cache.
 *
 * `quotes` counts cache entries for the city pair and orders which markets are
 * worth a detail request; `distanceMiles` is carried forward because
 * `prices_for_dates` does not report distance.
 */
interface Candidate {
  origin: string;
  dest: string;
  quotes: number;
  distanceMiles: number;
}

/** Runs `tasks` with at most `limit` in flight, preserving order. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * `fetch` with retries.
 *
 * 429 and 5xx are both transient here, and the API answers a throttle with a
 * `Retry-After` we should honour rather than guess at.
 */
function defaultFetchJson(token: string) {
  return async function fetchJson(url: string): Promise<unknown> {
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: { 'X-Access-Token': token, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 4) {
        throw new HarvestError(
          `HTTP ${res.status} from ${url.replace(/([?&]token=)[^&]*/, '$1<redacted>')}`,
          res.status === 401 || res.status === 403
            ? 'The token was rejected. Confirm TRAVELPAYOUTS_TOKEN in .env.local.'
            : undefined,
        );
      }
      const after = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? after * 1000 : delay));
      delay *= 2;
    }
  };
}

export function createTravelpayoutsProvider(
  options: TravelpayoutsOptions,
): HarvestProvider {
  const {
    token,
    origins,
    period,
    market = 'us',
    currency = 'usd',
    limit = 1200,
    minQuotes = 8,
    concurrency = 6,
  } = options;

  if (!token) {
    throw new HarvestError(
      'Travelpayouts needs an API token',
      'Put TRAVELPAYOUTS_TOKEN=... in .env.local (it is gitignored) and re-run.',
    );
  }
  if (origins.length === 0) {
    throw new HarvestError('Travelpayouts needs at least one seed origin');
  }

  const fetchJson = options.fetchJson ?? defaultFetchJson(token);

  async function discover(log: (m: string) => void): Promise<Candidate[]> {
    const byPair = new Map<string, Candidate>();

    const perOrigin = await pooled(origins, concurrency, async (origin) => {
      const url =
        `${BASE}/get_latest_prices?origin=${origin}&currency=${currency}` +
        `&market=${market}&limit=1000&one_way=true&period_type=year&page=1`;
      return rowsOf(await fetchJson(url), `get_latest_prices ${origin}`);
    });

    let seen = 0;
    let skipped = 0;
    for (const rows of perOrigin) {
      for (const raw of rows) {
        const row = raw as LatestRow;
        seen++;

        // `show_to_affiliates` is the publisher's own flag for whether a cached
        // fare may be surfaced. Respecting it is the cheapest possible form of
        // compliance and costs almost nothing: every row sampled had it set.
        if (row.show_to_affiliates !== true || row.actual !== true) { skipped++; continue; }
        if (num(row.trip_class) !== ECONOMY) { skipped++; continue; }

        const origin = iata(row.origin);
        const dest = iata(row.destination);
        if (!origin || !dest || origin === dest) { skipped++; continue; }

        const key = origin + dest;
        let candidate = byPair.get(key);
        if (!candidate) {
          candidate = { origin, dest, quotes: 0, distanceMiles: 0 };
          byPair.set(key, candidate);
        }
        candidate.quotes++;
        const distance = num(row.distance);
        if (distance && distance > 0) candidate.distanceMiles = distance;
      }
    }

    const candidates = [...byPair.values()].sort((a, b) => b.quotes - a.quotes);
    log(
      `  ${seen.toLocaleString()} cached quotes across ${origins.length} origins` +
      ` (${skipped.toLocaleString()} filtered) -> ${candidates.length} city pairs`,
    );
    return candidates.slice(0, limit);
  }

  async function detail(
    candidates: Candidate[],
    log: (m: string) => void,
  ): Promise<FareObservation[]> {
    const observations: FareObservation[] = [];
    let done = 0;
    let empty = 0;

    await pooled(candidates, concurrency, async (candidate) => {
      const url =
        `${BASE}/prices_for_dates?origin=${candidate.origin}&destination=${candidate.dest}` +
        `&currency=${currency}&market=${market}&limit=1000&one_way=true&sorting=price`;
      const rows = rowsOf(
        await fetchJson(url),
        `prices_for_dates ${candidate.origin}-${candidate.dest}`,
      );
      if (rows.length === 0) empty++;

      for (const raw of rows) {
        const row = raw as DatesRow;

        // The requested codes may be city codes: asking for LAX returns BUR
        // departures too. The airport fields carry what was actually flown, so
        // a market here is a real airport pair rather than a metro pair.
        const origin = iata(row.origin_airport) ?? candidate.origin;
        const dest = iata(row.destination_airport) ?? candidate.dest;
        const carrier = iata(row.airline) ?? str(row.airline)?.toUpperCase();
        const price = num(row.price);
        const transfers = num(row.transfers);

        if (!carrier || !price || price <= 0 || origin === dest) continue;

        observations.push({
          origin,
          dest,
          carrier,
          fareCents: Math.round(price * 100),
          stops: transfers === null ? 0 : Math.max(0, Math.round(transfers)),
          distanceMiles: candidate.distanceMiles || undefined,
          passengers: WEIGHT_PER_QUOTE,
        });
      }

      if (++done % 100 === 0) log(`  ${done}/${candidates.length} markets`);
    });

    log(
      `  ${observations.length.toLocaleString()} quotes from ${candidates.length} city pairs` +
      (empty ? ` (${empty} empty)` : ''),
    );
    return observations;
  }

  return {
    id: 'travelpayouts',
    name: 'Travelpayouts Data API (Aviasales price cache)',
    requiresCredentials: true,

    async run(context: HarvestContext): Promise<ProviderRun> {
      context.log(`discovering markets from ${origins.length} seed origins`);
      const candidates = await discover(context.log);
      if (candidates.length === 0) {
        throw new HarvestError(
          'no markets found in the price cache',
          'The cache only holds routes searched in roughly the last 48 hours. Try more or busier seed origins.',
        );
      }

      context.log(`fetching fares for ${candidates.length} markets`);
      const observations = await detail(candidates, context.log);

      // Quotes are not passengers, so the passenger floor is a quote floor and
      // the dollar window is the one the shared builder already applies.
      const markets: Market[] = buildMarkets(observations, {
        minPassengers: minQuotes,
        limit,
      });
      if (markets.length === 0) {
        throw new HarvestError(
          `no market cleared ${minQuotes} quotes`,
          'Lower --min-quotes or widen --origins.',
        );
      }

      return {
        period,
        attribution:
          'Fares from the Travelpayouts Data API (Aviasales price cache), ' +
          'used under the Travelpayouts affiliate terms.',
        source:
          `Travelpayouts Data API, market=${market}, ${origins.length} seed origins. ` +
          'Each market weight is a count of cached quotes, not passengers.',
        markets,
        cities: new Map(),
      };
    },
  };
}
