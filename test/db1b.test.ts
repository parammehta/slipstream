import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb1bProvider } from '../src/harvest/db1b.ts';

const HEADER = [
  'ItinID', 'MktID', 'MktCoupons', 'Year', 'Quarter', 'Origin', 'Dest',
  'RPCarrier', 'TkCarrier', 'OpCarrier', 'BulkFare', 'Passengers',
  'MktFare', 'MktDistance',
].map((h) => `"${h}"`).join(',');

interface RowSpec {
  coupons?: number; origin?: string; dest?: string; carrier?: string;
  bulk?: string; passengers?: number; fare?: number; distance?: number;
}

const row = (r: RowSpec = {}) => [
  '1', '1', String(r.coupons ?? 1), '2025', '1',
  `"${r.origin ?? 'SFO'}"`, `"${r.dest ?? 'JFK'}"`,
  `"${r.carrier ?? 'AA'}"`, `"${r.carrier ?? 'AA'}"`, `"${r.carrier ?? 'AA'}"`,
  r.bulk ?? '0.00', (r.passengers ?? 10).toFixed(2),
  (r.fare ?? 300).toFixed(2), (r.distance ?? 2586).toFixed(2),
].join(',');

async function harvest(rows: string[], opts: { limit?: number; minPassengers?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slipstream-db1b-'));
  const csv = join(dir, 'market.csv');
  writeFileSync(csv, [HEADER, ...rows].join('\n') + '\n');
  const provider = createDb1bProvider({
    csvPath: csv, period: '2025 Q1',
    limit: opts.limit ?? 100, minPassengers: opts.minPassengers ?? 1,
  });
  return provider.run({ cacheDir: dir, log: () => {} });
}

test('parses a market and reports its fare curve', async () => {
  const run = await harvest([row({ fare: 200 }), row({ fare: 400 })]);
  assert.equal(run.markets.length, 1);
  const m = run.markets[0];
  assert.equal(m.origin, 'SFO');
  assert.equal(m.dest, 'JFK');
  assert.equal(m.distanceMiles, 2586);
  assert.equal(m.passengers, 20);
  assert.ok(m.fareQuantiles[0] >= 20000 && m.fareQuantiles[8] <= 40500);
});

test('bulk fares are excluded', async () => {
  const run = await harvest([row({ bulk: '1.00', fare: 50 }), row({ fare: 300 })]);
  assert.equal(run.markets[0].passengers, 10, 'the bulk-fare row was counted');
  assert.ok(run.markets[0].fareQuantiles[0] > 20000, 'the $50 bulk fare entered the curve');
});

test('zero and absurd fares are excluded', async () => {
  const run = await harvest([
    row({ fare: 0 }), row({ fare: 3 }), row({ fare: 99999 }), row({ fare: 250 }),
  ]);
  assert.equal(run.markets[0].passengers, 10);
});

test('coupons beyond the first count as connections', async () => {
  const run = await harvest([
    row({ coupons: 1, passengers: 40 }),
    row({ coupons: 2, passengers: 60 }),
  ]);
  assert.ok(Math.abs(run.markets[0].connectingShare - 0.6) < 1e-9);
});

test('direction is preserved', async () => {
  const run = await harvest([row({}), row({ origin: 'JFK', dest: 'SFO' })]);
  assert.equal(run.markets.length, 2);
});

test('malformed airport codes and self-pairs are skipped', async () => {
  const run = await harvest([
    row({ origin: 'S', dest: 'JFK' }),
    row({ origin: 'SFO', dest: 'SFO' }),
    row({ origin: 'SFO', dest: 'LAX' }),
  ]);
  assert.equal(run.markets.length, 1);
  assert.equal(run.markets[0].dest, 'LAX');
});

test('carrier shares are passenger-weighted', async () => {
  const run = await harvest([
    row({ carrier: 'AA', passengers: 80 }),
    row({ carrier: 'B6', passengers: 20 }),
  ]);
  const [m] = run.markets;
  assert.equal(m.carriers[0].code, 'AA');
  assert.ok(Math.abs(m.carriers[0].share - 0.8) < 1e-9);
});

test('thin markets are dropped by the passenger threshold', async () => {
  const run = await harvest([row({ passengers: 2 })], { minPassengers: 100 }).catch((e) => e);
  assert.ok(run instanceof Error, 'expected a harvest error when nothing qualifies');
  assert.match(run.message, /no markets met/);
});

test('the busiest markets are kept when limited', async () => {
  const run = await harvest([
    row({ origin: 'AAA', dest: 'BBB', passengers: 5 }),
    row({ origin: 'CCC', dest: 'DDD', passengers: 500 }),
  ], { limit: 1 });
  assert.equal(run.markets.length, 1);
  assert.equal(run.markets[0].origin, 'CCC');
});

test('a missing column fails loudly rather than parsing garbage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slipstream-db1b-bad-'));
  const csv = join(dir, 'market.csv');
  writeFileSync(csv, '"Origin","Dest"\n"SFO","JFK"\n');
  const provider = createDb1bProvider({ csvPath: csv, period: 'x' });
  await assert.rejects(
    () => provider.run({ cacheDir: dir, log: () => {} }),
    /column "OpCarrier" not found|column "MktFare" not found|column "Passengers" not found/,
  );
});

test('attribution travels with the run', async () => {
  const run = await harvest([row({})]);
  assert.match(run.attribution, /Bureau of Transportation Statistics/);
  assert.equal(run.period, '2025 Q1');
});
