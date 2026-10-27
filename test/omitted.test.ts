import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSlab, type SlabInput } from '../src/core/encode.ts';
import { decodeSlab } from '../src/core/decode.ts';
import { generateOffers } from '../src/core/synth.ts';
import { OFFER_SCHEMA } from '../src/core/format.ts';

/** A corpus where every row shares one origin, as a published shard does. */
function shardInput(rows = 400, seed = 5): SlabInput {
  const input = generateOffers(rows, seed);
  const origin = input.columns.originId[0];
  for (let i = 0; i < rows; i++) input.columns.originId[i] = origin;
  return input;
}

const OMIT = {
  constants: { originId: { type: 'u16' as const, value: 0 } },
  derived: { arrMin: { type: 'i32' as const, from: ['depMin', 'durationMin'] as [string, string] } },
};

test('omitted columns come back identical', () => {
  const input = shardInput();
  const spec = {
    ...OMIT,
    constants: { originId: { type: 'u16' as const, value: input.columns.originId[0] } },
  };
  const slab = decodeSlab(encodeSlab({ ...input, ...spec }));

  assert.equal(slab.rowCount, input.rowCount);
  for (const { name } of OFFER_SCHEMA) {
    const before = input.columns[name];
    const after = slab.columns[name];
    assert.ok(after, `${name} was not rebuilt`);
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i], before[i], `${name}[${i}] differs`);
    }
  }
});

test('leaving them out makes the file smaller', () => {
  const input = shardInput();
  const spec = {
    ...OMIT,
    constants: { originId: { type: 'u16' as const, value: input.columns.originId[0] } },
  };
  const full = encodeSlab(input).byteLength;
  const trimmed = encodeSlab({ ...input, ...spec }).byteLength;

  // originId is 2 bytes a row and arrMin 4, against 20 for a whole row.
  const saved = (full - trimmed) / input.rowCount;
  assert.ok(saved >= 5.5 && saved <= 6.5, `expected ~6 bytes/row saved, got ${saved.toFixed(2)}`);
});

test('a constant claim that is false is refused', () => {
  const input = shardInput();
  input.columns.originId[17] = 99; // one row disagrees
  assert.throws(
    () => encodeSlab({ ...input, constants: { originId: { type: 'u16', value: input.columns.originId[0] } } }),
    /is not constant — row 17/,
  );
});

test('a derivation that is false is refused', () => {
  const input = shardInput();
  input.columns.arrMin[9] += 1;
  assert.throws(
    () => encodeSlab({ ...input, derived: OMIT.derived }),
    /is not depMin \+ durationMin — row 9/,
  );
});

test('a slab with no omissions carries no extra metadata', () => {
  const buf = encodeSlab(shardInput(50, 2));
  const text = new TextDecoder().decode(new Uint8Array(buf));
  assert.ok(!text.includes('"constants"'), 'wrote an empty constants map');
  assert.ok(!text.includes('"derived"'), 'wrote an empty derived map');
});

test('rebuilt columns are real typed arrays the kernels can use', () => {
  const input = shardInput();
  const slab = decodeSlab(encodeSlab({
    ...input,
    constants: { originId: { type: 'u16', value: input.columns.originId[0] } },
    derived: OMIT.derived,
  }));
  assert.equal(slab.columns.originId.constructor, Uint16Array);
  assert.equal(slab.columns.arrMin.constructor, Int32Array);
  assert.equal(slab.columns.arrMin.length, input.rowCount);
});

test('a derivation whose inputs are missing fails loudly', () => {
  const input = shardInput(20, 3);
  const buf = encodeSlab({
    ...input,
    derived: { arrMin: { type: 'i32', from: ['depMin', 'durationMin'] } },
  });

  // Rewrite the reference inside the metadata only. Decoding the whole
  // buffer as text would mangle the binary columns into replacement
  // characters and change its length.
  const view = new DataView(buf);
  const metaOffset = view.getUint32(16, true);
  const metaLength = view.getUint32(20, true);
  const bytes = new Uint8Array(buf, metaOffset, metaLength);

  const text = new TextDecoder().decode(bytes);
  const broken = text.replace('"durationMin"]', '"zzzzzzzzzzz"]');
  assert.notEqual(broken, text, 'the metadata did not contain the expected reference');
  assert.equal(broken.length, text.length, 'the replacement changed the metadata length');
  bytes.set(new TextEncoder().encode(broken));

  assert.throws(() => decodeSlab(buf), /needs depMin and zzzzzzzzzzz/);
});
