import { OFFER_SCHEMA, allocColumn, BYTES_PER, type Slab, type TypedArray } from './format.ts';

/**
 * Join several slabs into one.
 *
 * Offers are published as one file per origin airport, so a search that spans
 * more than one origin — a multi-city trip, say — holds several shards at
 * once. Rather than teach every kernel about a list of slabs, the shards are
 * concatenated into a single slab and the engine carries on unchanged.
 *
 * All shards must come from the same build: they share one dictionary, so a
 * carrier id means the same airline in every file.
 */
export function concatSlabs(slabs: Slab[]): Slab {
  if (slabs.length === 0) throw new Error('concatSlabs: nothing to join');
  if (slabs.length === 1) return slabs[0];

  const first = slabs[0];
  for (const slab of slabs) {
    if (slab.baseDayEpoch !== first.baseDayEpoch) {
      throw new Error('concatSlabs: shards disagree on the base day');
    }
    if (slab.dicts.airports.length !== first.dicts.airports.length) {
      throw new Error('concatSlabs: shards were built with different dictionaries');
    }
  }

  let rowCount = 0;
  for (const slab of slabs) rowCount += slab.rowCount;

  const columns: Record<string, TypedArray> = Object.create(null);
  let byteLength = 0;
  for (const { name, type } of OFFER_SCHEMA) {
    const merged = allocColumn(type, rowCount);
    let at = 0;
    for (const slab of slabs) {
      const column = slab.columns[name];
      if (!column) throw new Error(`concatSlabs: a shard is missing "${name}"`);
      merged.set(column as never, at);
      at += slab.rowCount;
    }
    columns[name] = merged;
    byteLength += rowCount * BYTES_PER[type];
  }

  return { rowCount, baseDayEpoch: first.baseDayEpoch, columns, dicts: first.dicts, byteLength };
}
