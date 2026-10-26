import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from '../src/worker/engine-worker.ts';

/** The engine is stateful: init once, then reuse across these tests. */
const ready = (await handleMessage({ type: 'init', rows: 60_000, seed: 3 })).reply;

test('init reports a usable dataset', () => {
  assert.equal(ready.type, 'ready');
  assert.equal(ready.rowCount, 60_000);
  assert.ok(ready.dicts.airports.length > 10);
  assert.ok(ready.dicts.carriers.length > 3);
  assert.ok(ready.priceDomain[0] < ready.priceDomain[1]);
  assert.ok(ready.marketCount > 100);
  assert.equal(ready.maxLegs, 4);
  assert.match(ready.period, /\d{4}/);
});

test('ping answers before any heavy work', async () => {
  assert.equal((await handleMessage({ type: 'ping' })).reply.type, 'pong');
});

test('an unfiltered query returns every row', async () => {
  const { reply } = await handleMessage({
    type: 'query', id: 1, filters: [], day: -1, sortKey: 'priceCents', offset: 0, limit: 10,
  });
  assert.equal(reply.type, 'result');
  assert.equal(reply.count, 60_000);
  assert.equal(reply.rowCount, 10);
  assert.equal(reply.grid.length, 60);
  assert.ok(reply.gridExtent.filled > 0);
});

test('results come back sorted by the requested key', async () => {
  const { reply } = await handleMessage({
    type: 'query', id: 2, filters: [], day: -1, sortKey: 'priceCents', offset: 0, limit: 20,
  });
  const PRICE = 3; // index into ROW_FIELDS
  const FIELDS = ready.rowFields.length;
  for (let i = 1; i < reply.rowCount; i++) {
    assert.ok(
      reply.rows[i * FIELDS + PRICE] >= reply.rows[(i - 1) * FIELDS + PRICE],
      'rows are not ascending by price',
    );
  }
});

test('a day filter restricts results to that day', async () => {
  const { reply } = await handleMessage({
    type: 'query', id: 3, filters: [], day: 11, sortKey: 'priceCents', offset: 0, limit: 25,
  });
  const FIELDS = ready.rowFields.length;
  for (let i = 0; i < reply.rowCount; i++) {
    assert.equal(Math.floor(reply.rows[i * FIELDS] / 1440), 11, 'a row departed on another day');
  }
  assert.ok(reply.count < 60_000);
});

test('the date grid ignores the day filter', async () => {
  const withDay = (await handleMessage({
    type: 'query', id: 4, filters: [], day: 11, sortKey: 'priceCents', offset: 0, limit: 1,
  })).reply;
  assert.ok(withDay.gridExtent.filled > 1, 'picking a day blanked the rest of the grid');
});

test('multi-city returns whole trips, cheapest first', async () => {
  const origins = [0, 1];
  const { reply } = await handleMessage({
    type: 'multiQuery', id: 5, k: 20, shared: [],
    legs: origins.map((o) => ({ filters: [{ kind: 'oneOf', column: 'originId', values: [o] }] })),
  });
  assert.equal(reply.type, 'trips');
  assert.equal(reply.legCount, 2);
  assert.ok(reply.count > 0);
  for (let i = 1; i < reply.count; i++) {
    assert.ok(reply.totals[i] >= reply.totals[i - 1], 'trips are not ascending by total');
  }});

test('each trip leg honours its own filter', async () => {
  const { reply } = await handleMessage({
    type: 'multiQuery', id: 6, k: 10, shared: [],
    legs: [
      { filters: [{ kind: 'oneOf', column: 'originId', values: [0] }] },
      { filters: [{ kind: 'oneOf', column: 'originId', values: [2] }] },
    ],
  });
  const FIELDS = ready.rowFields.length;
  const ORIGIN = 6;
  for (let i = 0; i < reply.count; i++) {
    const legA = (i * 2) * FIELDS;
    const legB = (i * 2 + 1) * FIELDS;
    assert.equal(reply.rows[legA + ORIGIN], 0, 'leg 1 left the wrong airport');
    assert.equal(reply.rows[legB + ORIGIN], 2, 'leg 2 left the wrong airport');
  }
});

test('the trip total equals the sum of its legs', async () => {
  const { reply } = await handleMessage({
    type: 'multiQuery', id: 7, k: 8, shared: [],
    legs: [
      { filters: [{ kind: 'oneOf', column: 'originId', values: [0] }] },
      { filters: [{ kind: 'oneOf', column: 'originId', values: [1] }] },
      { filters: [{ kind: 'oneOf', column: 'originId', values: [2] }] },
    ],
  });
  const FIELDS = ready.rowFields.length;
  const PRICE = 3;
  for (let i = 0; i < reply.count; i++) {
    let sum = 0;
    for (let l = 0; l < reply.legCount; l++) sum += reply.rows[(i * reply.legCount + l) * FIELDS + PRICE];
    assert.equal(sum, reply.totals[i], `trip ${i} total does not match its legs`);
  }
});

test('shared filters apply to every leg', async () => {
  const { reply } = await handleMessage({
    type: 'multiQuery', id: 8, k: 10,
    shared: [{ kind: 'oneOf', column: 'stops', values: [0] }],
    legs: [{ filters: [] }, { filters: [] }],
  });
  const FIELDS = ready.rowFields.length;
  const STOPS = 4;
  for (let i = 0; i < reply.count * reply.legCount; i++) {
    assert.equal(reply.rows[i * FIELDS + STOPS], 0, 'a connecting flight survived a nonstop filter');
  }
});

test('an unflyable leg yields no trips rather than a partial one', async () => {
  const { reply } = await handleMessage({
    type: 'multiQuery', id: 9, k: 10, shared: [],
    legs: [
      { filters: [] },
      { filters: [{ kind: 'range', column: 'priceCents', min: 1, max: 1 }] },
    ],
  });
  assert.equal(reply.count, 0);
  assert.equal(reply.legCounts[1], 0);
});

test('an unknown message is reported, not silently dropped', async () => {
  assert.equal((await handleMessage({ type: 'nonsense' })).reply.type, 'error');
});

test('a fetch init with no origins fails cleanly', async () => {
  const { reply } = await handleMessage({ type: 'init', source: 'fetch', origins: [] });
  assert.equal(reply.type, 'error');
  assert.match(reply.message, /at least one origin/);
});
