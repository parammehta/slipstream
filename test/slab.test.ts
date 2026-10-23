import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSlab } from '../src/core/encode.ts';
import { decodeSlab } from '../src/core/decode.ts';
import { generateOffers } from '../src/core/synth.ts';
import { OFFER_SCHEMA, MAGIC } from '../src/core/format.ts';

test('encode/decode round-trips every column exactly', () => {
  const input = generateOffers(5000, 42);
  const slab = decodeSlab(encodeSlab(input));

  assert.equal(slab.rowCount, input.rowCount);
  assert.equal(slab.baseDayEpoch, input.baseDayEpoch);
  assert.deepEqual(slab.dicts, input.dicts);

  for (const { name } of OFFER_SCHEMA) {
    const before = input.columns[name];
    const after = slab.columns[name];
    assert.ok(after, `missing column ${name}`);
    assert.equal(after.constructor, before.constructor, `${name} changed type`);
    assert.equal(after.length, before.length, `${name} changed length`);
    for (let i = 0; i < before.length; i++) {
      if (after[i] !== before[i]) assert.fail(`${name}[${i}]: ${after[i]} !== ${before[i]}`);
    }
  }
});

test('columns are zero-copy views over one buffer', () => {
  const buf = encodeSlab(generateOffers(64, 7));
  const slab = decodeSlab(buf);
  for (const name of Object.keys(slab.columns)) {
    assert.equal(slab.columns[name].buffer, buf, `${name} was copied`);
  }
});

test('columns are naturally aligned', () => {
  const buf = encodeSlab(generateOffers(37, 3)); // odd row count -> padding exercised
  const slab = decodeSlab(buf);
  for (const [name, col] of Object.entries(slab.columns)) {
    assert.equal(col.byteOffset % col.BYTES_PER_ELEMENT, 0, `${name} misaligned`);
  }
});

test('header carries the slab magic', () => {
  const buf = encodeSlab(generateOffers(8, 1));
  assert.equal(new DataView(buf).getUint32(0, false), MAGIC);
});

test('rejects a buffer that is not a slab', () => {
  assert.throws(() => decodeSlab(new ArrayBuffer(64)), /bad magic/);
  assert.throws(() => decodeSlab(new ArrayBuffer(4)), /too small/);
});

test('is dramatically smaller than the equivalent JSON', () => {
  const input = generateOffers(20_000, 11);
  const binary = encodeSlab(input).byteLength;

  const rows = [];
  for (let i = 0; i < input.rowCount; i++) {
    rows.push({
      departureTime: input.columns.depMin[i],
      arrivalTime: input.columns.arrMin[i],
      durationMinutes: input.columns.durationMin[i],
      priceCents: input.columns.priceCents[i],
      stops: input.columns.stops[i],
      carrier: input.dicts.carriers[input.columns.carrierId[i]],
      origin: input.dicts.airports[input.columns.originId[i]],
      destination: input.dicts.airports[input.columns.destId[i]],
    });
  }
  const json = new TextEncoder().encode(JSON.stringify(rows)).byteLength;

  // Measured at ~7.2x uncompressed. Brotli narrows the gap on the JSON side
  // but not the decode cost, which is the reason the format exists.
  const ratio = json / binary;
  assert.ok(ratio > 6, `expected >6x reduction, got ${ratio.toFixed(1)}x`);
});
