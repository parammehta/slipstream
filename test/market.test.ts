import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkets } from '../src/harvest/market.ts';
import type { FareObservation } from '../src/harvest/provider.ts';

const obs = (o: Partial<FareObservation>): FareObservation => ({
  origin: 'SFO', dest: 'JFK', carrier: 'AA', fareCents: 30000,
  stops: 0, distanceMiles: 2586, passengers: 10, ...o,
});

test('aggregates observations into one market per direction', () => {
  const markets = buildMarkets([
    obs({}), obs({ fareCents: 40000 }),
    obs({ origin: 'JFK', dest: 'SFO' }),
  ], { minPassengers: 1 });
  assert.equal(markets.length, 2);
  const pairs = markets.map((m) => m.origin + m.dest).sort();
  assert.deepEqual(pairs, ['JFKSFO', 'SFOJFK']);
});

test('keeps direction separate so asymmetric pricing survives', () => {
  const markets = buildMarkets([
    obs({ fareCents: 10000, passengers: 100 }),
    obs({ origin: 'JFK', dest: 'SFO', fareCents: 90000, passengers: 100 }),
  ], { minPassengers: 1 });
  const out = Object.fromEntries(markets.map((m) => [m.origin + m.dest, m.fareQuantiles[4]]));
  assert.ok(out.SFOJFK < out.JFKSFO, 'directions were collapsed');
});

test('carrier shares are passenger-weighted and sum to one', () => {
  const markets = buildMarkets([
    obs({ carrier: 'AA', passengers: 75 }),
    obs({ carrier: 'DL', passengers: 25 }),
  ], { minPassengers: 1 });
  const [m] = markets;
  assert.equal(m.carriers[0].code, 'AA');
  assert.ok(Math.abs(m.carriers[0].share - 0.75) < 1e-9);
  assert.ok(Math.abs(m.carriers.reduce((s, c) => s + c.share, 0) - 1) < 1e-9);
});

test('connecting share is passenger-weighted', () => {
  const markets = buildMarkets([
    obs({ stops: 0, passengers: 30 }),
    obs({ stops: 1, passengers: 70 }),
  ], { minPassengers: 1 });
  assert.ok(Math.abs(markets[0].connectingShare - 0.7) < 1e-9);
});

test('implausible fares are discarded at both ends', () => {
  const markets = buildMarkets([
    obs({ fareCents: 1 }),        // bulk/zero fare
    obs({ fareCents: 99_000_00 }), // keypunch error
    obs({ fareCents: 25000 }),
  ], { minPassengers: 1 });
  assert.equal(markets.length, 1);
  assert.ok(markets[0].fareQuantiles.every((q) => q >= 2000 && q <= 400000));
});

test('thin markets are dropped', () => {
  const markets = buildMarkets([obs({ passengers: 3 })], { minPassengers: 20 });
  assert.equal(markets.length, 0);
});

test('observations without passengers are ignored', () => {
  const markets = buildMarkets([obs({ passengers: 0 }), obs({ passengers: -5 })], { minPassengers: 1 });
  assert.equal(markets.length, 0);
});

test('markets come back busiest first and respect the limit', () => {
  const markets = buildMarkets([
    obs({ origin: 'AAA', dest: 'BBB', passengers: 10 }),
    obs({ origin: 'CCC', dest: 'DDD', passengers: 500 }),
    obs({ origin: 'EEE', dest: 'FFF', passengers: 100 }),
  ], { minPassengers: 1, limit: 2 });
  assert.equal(markets.length, 2);
  assert.equal(markets[0].origin, 'CCC');
  assert.equal(markets[1].origin, 'EEE');
});

test('distance is the median of what the source reported', () => {
  const markets = buildMarkets([
    obs({ distanceMiles: 2500 }), obs({ distanceMiles: 2586 }), obs({ distanceMiles: 9999 }),
  ], { minPassengers: 1 });
  assert.equal(markets[0].distanceMiles, 2586);
});

test('an empty harvest produces no markets rather than throwing', () => {
  assert.deepEqual(buildMarkets([]), []);
});
