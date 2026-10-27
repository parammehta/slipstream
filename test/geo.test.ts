import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  positionForTimeZone, nearestAirport, suggestOrigin, distanceKm, currentTimeZone,
  type LocatableAirport,
} from '../src/core/geo.ts';

/** A handful of real airports, positioned as OpenFlights has them. */
const AIRPORTS: LocatableAirport[] = [
  { iata: 'JFK', lat: 40.64, lon: -73.78 },
  { iata: 'LGA', lat: 40.78, lon: -73.87 },
  { iata: 'BOS', lat: 42.36, lon: -71.01 },
  { iata: 'ORD', lat: 41.98, lon: -87.9 },
  { iata: 'DEN', lat: 39.86, lon: -104.67 },
  { iata: 'LAX', lat: 33.94, lon: -118.41 },
  { iata: 'SEA', lat: 47.45, lon: -122.31 },
  { iata: 'PHX', lat: 33.43, lon: -112.01 },
  { iata: 'HNL', lat: 21.32, lon: -157.92 },
  { iata: 'ANC', lat: 61.17, lon: -150.0 },
  { iata: 'NOP', /* no position known */ },
];

test('known zones resolve to a position', () => {
  assert.ok(positionForTimeZone('America/Los_Angeles'));
  assert.ok(positionForTimeZone('America/Chicago'));
  assert.equal(positionForTimeZone('Europe/Berlin'), null);
  assert.equal(positionForTimeZone(undefined), null);
  assert.equal(positionForTimeZone(''), null);
});

test('subdivided zones fall back to their state', () => {
  const indiana = positionForTimeZone('America/Indiana/Vincennes');
  const kentucky = positionForTimeZone('America/Kentucky/Monticello');
  assert.ok(indiana && Math.abs(indiana.lat - 39.77) < 0.01);
  assert.ok(kentucky && Math.abs(kentucky.lat - 38.25) < 0.01);
});

test('distance matches a known pair', () => {
  // JFK to LAX is about 3,970km.
  const km = distanceKm({ lat: 40.64, lon: -73.78 }, { lat: 33.94, lon: -118.41 });
  assert.ok(Math.abs(km - 3970) < 60, `got ${km.toFixed(0)}km`);
});

test('each US zone picks the airport a traveller would expect', () => {
  const cases: Array<[string, string]> = [
    ['America/Los_Angeles', 'LAX'],
    ['America/Denver', 'DEN'],
    ['America/Chicago', 'ORD'],
    ['America/New_York', 'LGA'],
    ['America/Phoenix', 'PHX'],
    ['Pacific/Honolulu', 'HNL'],
    ['America/Anchorage', 'ANC'],
  ];
  for (const [zone, expected] of cases) {
    const got = suggestOrigin(AIRPORTS, zone);
    assert.equal(got?.iata, expected, `${zone} suggested ${got?.iata}`);
  }
});

test('airports with no position are never suggested', () => {
  const only: LocatableAirport[] = [{ iata: 'NOP' }];
  assert.equal(nearestAirport({ lat: 40, lon: -74 }, only), null);
  assert.equal(suggestOrigin(only, 'America/New_York'), null);
});

test('a zone outside the data gets no suggestion', () => {
  assert.equal(suggestOrigin(AIRPORTS, 'Europe/Berlin'), null);
  assert.equal(suggestOrigin(AIRPORTS, 'Asia/Tokyo'), null);
  assert.equal(suggestOrigin(AIRPORTS, null), null);
});

test('a suggestion too far away is withheld rather than stretched', () => {
  // Halifax resolves, but its nearest airport here is Boston at ~650km.
  assert.equal(suggestOrigin(AIRPORTS, 'America/Halifax'), null);
  // Widening the radius finds Boston, which shows the guard is what withheld it.
  assert.equal(suggestOrigin(AIRPORTS, 'America/Halifax', 20_000)?.iata, 'BOS');
});

test('an empty airport list is handled', () => {
  assert.equal(nearestAirport({ lat: 0, lon: 0 }, []), null);
  assert.equal(suggestOrigin([], 'America/Chicago'), null);
});

test('the reported distance is the one used to choose', () => {
  const got = suggestOrigin(AIRPORTS, 'America/Los_Angeles');
  assert.ok(got);
  assert.ok(got.km < 60, `LAX should be close to the Los Angeles centroid, got ${got.km}km`);
});

test('reading the environment zone does not throw', () => {
  const zone = currentTimeZone();
  assert.ok(zone === null || typeof zone === 'string');
});
