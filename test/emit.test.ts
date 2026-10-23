import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitMarketModule } from '../src/harvest/emit.ts';
import type { Market } from '../src/harvest/market.ts';
import type { MarketAirport, MarketCarrierShare, MarketDataset } from '../src/core/market-data.ts';

const market = (over: Partial<Market> = {}): Market => ({
  origin: 'SFO', dest: 'JFK', distanceMiles: 2586,
  carriers: [{ code: 'AA', share: 0.6 }, { code: 'DL', share: 0.4 }],
  fareQuantiles: [12000, 15000, 18000, 21000, 24000, 28000, 33000, 40000, 52000],
  passengers: 1234, connectingShare: 0.3, ...over,
});

/** Emit a module, then import it the way the build will. */
async function roundTrip(markets: Market[], cities = new Map<string, string>()) {
  const dir = mkdtempSync(join(tmpdir(), 'slipstream-emit-'));
  mkdirSync(join(dir, 'core'), { recursive: true });
  cpSync(new URL('../src/core/market-data.ts', import.meta.url), join(dir, 'core/market-data.ts'));
  const file = join(dir, 'core/markets.ts');
  writeFileSync(file, emitMarketModule({
    markets, cities, period: '2025 Q1', attribution: 'Test data', source: 'test',
  }));
  const mod = await import(file);
  return mod.marketDataset() as MarketDataset;
}

test('a market survives the round trip', async () => {
  const ds = await roundTrip([market()]);
  assert.equal(ds.markets.length, 1);
  const m = ds.markets[0];
  assert.equal(ds.airports[m.origin].iata, 'SFO');
  assert.equal(ds.airports[m.dest].iata, 'JFK');
  assert.equal(m.distanceMiles, 2586);
  assert.equal(m.passengers, 1234);
  assert.ok(Math.abs(m.connectingShare - 0.3) < 0.01);
});

test('the fare curve comes back in cents, to the dollar', async () => {
  const ds = await roundTrip([market()]);
  assert.deepEqual(ds.markets[0].fareQuantiles, [12000, 15000, 18000, 21000, 24000, 28000, 33000, 40000, 52000]);
});

test('carrier shares survive, in order', async () => {
  const ds = await roundTrip([market()]);
  const m = ds.markets[0];
  assert.equal(ds.carriers[m.carriers[0].id], 'AA');
  assert.equal(ds.carriers[m.carriers[1].id], 'DL');
  assert.ok(Math.abs(m.carriers[0].share - 0.6) < 0.01);
  assert.ok(Math.abs(m.carriers[1].share - 0.4) < 0.01);
});

test('airports and carriers are deduplicated across markets', async () => {
  const ds = await roundTrip([
    market(),
    market({ origin: 'JFK', dest: 'SFO' }),
    market({ origin: 'SFO', dest: 'LAX', carriers: [{ code: 'AA', share: 1 }] }),
  ]);
  assert.deepEqual(ds.airports.map((a: MarketAirport) => a.iata).sort(), ['JFK', 'LAX', 'SFO']);
  assert.deepEqual(ds.carriers.sort(), ['AA', 'DL']);
});

test('city names are attached when known, code used when not', async () => {
  const ds = await roundTrip([market()], new Map([['SFO', 'San Francisco']]));
  const byIata = Object.fromEntries(ds.airports.map((a: MarketAirport) => [a.iata, a.city]));
  assert.equal(byIata.SFO, 'San Francisco');
  assert.equal(byIata.JFK, 'JFK');
});

test('markets with many carriers keep the significant ones', async () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ code: 'C' + i, share: 1 / 14 }));
  const ds = await roundTrip([market({ carriers: many })]);
  const m = ds.markets[0];
  assert.ok(m.carriers.length <= 8, `kept ${m.carriers.length} carriers`);
  assert.ok(m.carriers.length >= 1);
});

test('a carrier below the noise floor is dropped, not kept at zero', async () => {
  const ds = await roundTrip([market({
    carriers: [{ code: 'AA', share: 0.995 }, { code: 'XX', share: 0.005 }],
  })]);
  assert.deepEqual(ds.markets[0].carriers.map((c: MarketCarrierShare) => ds.carriers[c.id]), ['AA']);
});

test('several markets decode independently', async () => {
  const ds = await roundTrip([
    market({ passengers: 100, distanceMiles: 300 }),
    market({ origin: 'LAX', dest: 'ORD', passengers: 900, distanceMiles: 1745,
             carriers: [{ code: 'UA', share: 1 }] }),
  ]);
  assert.equal(ds.markets.length, 2);
  assert.equal(ds.markets[0].distanceMiles, 300);
  assert.equal(ds.markets[1].distanceMiles, 1745);
  assert.equal(ds.carriers[ds.markets[1].carriers[0].id], 'UA');
});

test('period and attribution travel with the data', async () => {
  const ds = await roundTrip([market()]);
  assert.equal(ds.period, '2025 Q1');
  assert.equal(ds.attribution, 'Test data');
});
