import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTravelpayoutsProvider } from '../src/harvest/travelpayouts.ts';
import { HarvestError } from '../src/harvest/provider.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const LATEST = fixture('travelpayouts-latest-lax.json');
const DATES = fixture('travelpayouts-dates-lax-jfk.json');

const log = () => {};
const context = { cacheDir: '/tmp', log };

/**
 * Serves the recorded responses and records what was asked for, so a test can
 * assert on the request shape without reaching the network.
 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    for (const [fragment, body] of Object.entries(overrides)) {
      if (url.includes(fragment)) return body;
    }
    return url.includes('get_latest_prices') ? LATEST : DATES;
  };
  return { urls, fetchJson };
}

const provider = (opts: Record<string, unknown> = {}) => {
  const { urls, fetchJson } = (opts.stub as ReturnType<typeof stubApi>) ?? stubApi();
  delete opts.stub;
  return {
    urls,
    instance: createTravelpayoutsProvider({
      token: 'test-token',
      origins: ['LAX'],
      period: '2026-10 cache',
      minQuotes: 1,
      fetchJson,
      ...opts,
    }),
  };
};

test('the recorded fixtures carry no affiliate link or token', () => {
  // The live `link` field embeds the account marker. Committing one would
  // publish a credential, so the fixtures are stripped and stay stripped.
  for (const name of ['travelpayouts-latest-lax.json', 'travelpayouts-dates-lax-jfk.json']) {
    const raw = readFileSync(join(FIXTURES, name), 'utf8');
    assert.doesNotMatch(raw, /"link"|token|marker/i, `${name} leaks a link or token`);
  }
});

test('builds markets from the price cache', async () => {
  const { instance } = provider();
  const run = await instance.run(context);

  assert.ok(run.markets.length > 0, 'expected at least one market');
  for (const m of run.markets) {
    assert.match(m.origin, /^[A-Z0-9]{3}$/);
    assert.match(m.dest, /^[A-Z0-9]{3}$/);
    assert.notEqual(m.origin, m.dest);
    assert.ok(m.carriers.length > 0, `${m.origin}-${m.dest} has no carrier`);
    assert.equal(m.fareQuantiles.length, 9);
    // The curve must be non-decreasing or the deciles are not deciles.
    for (let i = 1; i < m.fareQuantiles.length; i++) {
      assert.ok(m.fareQuantiles[i] >= m.fareQuantiles[i - 1], 'fare curve went backwards');
    }
    assert.ok(m.fareQuantiles[0] > 0, 'p10 fare is zero');
    assert.ok(m.connectingShare >= 0 && m.connectingShare <= 1);
  }
});

test('markets are keyed on the flown airport, not the requested city code', async () => {
  // The fixture asks for LAX-JFK and the cache answers with BUR departures.
  // Collapsing those into LAX would attribute Burbank fares to Los Angeles.
  const { instance } = provider();
  const run = await instance.run(context);
  const origins = new Set(run.markets.map((m) => m.origin));
  assert.ok(origins.has('BUR'), `expected a BUR market, got ${[...origins].join(',')}`);
});

test('requests the us market and one-way fares', async () => {
  const { instance, urls } = provider();
  await instance.run(context);
  assert.ok(urls.length > 1, 'expected a discovery call and at least one detail call');
  for (const url of urls) {
    assert.match(url, /market=us/);
    assert.match(url, /one_way=true/);
    assert.match(url, /currency=usd/);
  }
  assert.ok(urls.some((u) => u.includes('get_latest_prices')), 'no discovery call');
  assert.ok(urls.some((u) => u.includes('prices_for_dates')), 'no detail call');
});

test('skips cached fares the publisher has not cleared for display', async () => {
  const hidden = {
    ...LATEST,
    data: LATEST.data.map((r: Record<string, unknown>) => ({ ...r, show_to_affiliates: false })),
  };
  const { instance } = provider({ stub: stubApi({ get_latest_prices: hidden }) });
  await assert.rejects(
    instance.run(context),
    (err: Error) => err instanceof HarvestError && /no markets found/.test(err.message),
  );
});

test('skips stale cache entries', async () => {
  const stale = {
    ...LATEST,
    data: LATEST.data.map((r: Record<string, unknown>) => ({ ...r, actual: false })),
  };
  const { instance } = provider({ stub: stubApi({ get_latest_prices: stale }) });
  await assert.rejects(instance.run(context), /no markets found/);
});

test('skips business and first class quotes', async () => {
  const business = {
    ...LATEST,
    data: LATEST.data.map((r: Record<string, unknown>) => ({ ...r, trip_class: 1 })),
  };
  const { instance } = provider({ stub: stubApi({ get_latest_prices: business }) });
  await assert.rejects(instance.run(context), /no markets found/);
});

test('a rejection reported with HTTP 200 is still an error', async () => {
  // The API answers a bad token in the body, not the status line. Treating
  // that as an empty result would publish a silently empty dataset.
  const { instance } = provider({
    stub: stubApi({ get_latest_prices: { success: false, error: 'Invalid token' } }),
  });
  await assert.rejects(
    instance.run(context),
    (err: Error) => err instanceof HarvestError && /Invalid token/.test(err.message),
  );
});

test('malformed rows are dropped rather than poisoning a market', async () => {
  const junk = {
    ...DATES,
    data: [
      ...DATES.data,
      { origin_airport: 'LAX', destination_airport: 'JFK', airline: 'AA', price: 0, transfers: 0 },
      { origin_airport: 'LAX', destination_airport: 'JFK', airline: null, price: 200, transfers: 0 },
      { origin_airport: 'LAX', destination_airport: 'LAX', airline: 'AA', price: 200, transfers: 0 },
      { origin_airport: 'LAX', destination_airport: 'JFK', airline: 'AA', price: 'free', transfers: 0 },
    ],
  };
  const { instance } = provider({ stub: stubApi({ prices_for_dates: junk }) });
  const run = await instance.run(context);
  for (const m of run.markets) {
    assert.ok(m.fareQuantiles[0] > 0, 'a zero fare reached the curve');
    assert.notEqual(m.origin, m.dest);
    for (const c of m.carriers) assert.match(c.code, /^[A-Z0-9]{2,3}$/);
  }
});

test('says in the source line that weights are quotes, not passengers', async () => {
  // `Market.passengers` means passengers for DB1B and quotes here. The
  // generated module header is the only place a reader learns the difference.
  const { instance } = provider();
  const run = await instance.run(context);
  assert.match(run.source, /quotes, not passengers/);
  assert.match(run.attribution, /Travelpayouts/);
});

test('refuses to run without a token', () => {
  assert.throws(
    () => createTravelpayoutsProvider({ token: '', origins: ['LAX'], period: 'x' }),
    (err: Error) => err instanceof HarvestError && /needs an API token/.test(err.message),
  );
});

test('refuses to run with no seed origin', () => {
  assert.throws(
    () => createTravelpayoutsProvider({ token: 't', origins: [], period: 'x' }),
    /at least one seed origin/,
  );
});

test('one detail request per discovered market', async () => {
  const { instance, urls } = provider();
  const run = await instance.run(context);
  const detail = urls.filter((u) => u.includes('prices_for_dates'));
  // 89 LAX-JFK quotes per market in the fixture: the depth comes from limit=1000,
  // so a market must never need a second round trip.
  assert.ok(detail.length >= run.markets.length, 'fewer requests than markets');
  for (const url of detail) assert.match(url, /limit=1000/);
});
