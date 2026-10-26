/**
 * Publishes the offer corpus as one slab per origin airport.
 *
 *   node scripts/build-slabs.ts [rowCount]
 *
 * Shipping one global file would mean a 5.9MB download to search a single
 * route. Nobody searches every origin at once, so the corpus is partitioned
 * by origin and a visitor fetches the ~68KB that covers theirs.
 *
 * Rows inside a shard are sorted by destination then departure. Order costs
 * nothing to produce here and is worth a great deal on the wire: random order
 * is the worst case for a compressor, and sorting cuts the corpus from 9.4MB
 * to 5.9MB compressed.
 *
 * Output lands in demo/data and is generated at build time rather than
 * committed, so the repository does not carry 19MB of derived binaries.
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeSlab } from '../src/core/encode.ts';
import { generateOffersFromMarkets } from '../src/core/offers.ts';
import { marketDataset } from '../src/core/markets.ts';
import { OFFER_SCHEMA, allocColumn, type TypedArray } from '../src/core/format.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'demo/data');
const ROWS = Math.max(1000, Number(process.argv[2]) || 1_000_000);

const dataset = marketDataset();
const corpus = generateOffersFromMarkets(dataset, ROWS, 1);
const columns = corpus.columns;

// Partition by origin.
const byOrigin = new Map<number, number[]>();
for (let i = 0; i < ROWS; i++) {
  const origin = columns.originId[i];
  let rows = byOrigin.get(origin);
  if (!rows) byOrigin.set(origin, (rows = []));
  rows.push(i);
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

interface ShardEntry {
  iata: string;
  file: string;
  rows: number;
  bytes: number;
}

const shards: ShardEntry[] = [];
let totalBytes = 0;

for (const [originId, rows] of byOrigin) {
  // Sorted by destination, then departure: runs of equal values compress,
  // and near-sorted timestamps leave small deltas behind them.
  rows.sort(
    (a, b) => columns.destId[a] - columns.destId[b] || columns.depMin[a] - columns.depMin[b],
  );

  const shardColumns: Record<string, TypedArray> = Object.create(null);
  for (const { name, type } of OFFER_SCHEMA) {
    const source = columns[name];
    const target = allocColumn(type, rows.length);
    for (let i = 0; i < rows.length; i++) target[i] = source[rows[i]];
    shardColumns[name] = target;
  }

  const buffer = encodeSlab({
    rowCount: rows.length,
    baseDayEpoch: corpus.baseDayEpoch,
    columns: shardColumns,
    dicts: corpus.dicts,
    schema: OFFER_SCHEMA,
  });

  const iata = dataset.airports[originId].iata;
  const file = `${iata}.slab`;
  writeFileSync(join(OUT, file), Buffer.from(buffer));
  shards.push({ iata, file, rows: rows.length, bytes: buffer.byteLength });
  totalBytes += buffer.byteLength;
}

shards.sort((a, b) => b.rows - a.rows);

const manifest = {
  version: 1,
  period: dataset.period,
  attribution: dataset.attribution,
  baseDayEpoch: corpus.baseDayEpoch,
  rows: ROWS,
  // The dictionaries live here too, so the page can populate its airport and
  // airline pickers before fetching a single shard.
  airports: dataset.airports.map((a) => ({ iata: a.iata, city: a.city })),
  carriers: dataset.carriers,
  shards,
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest));

const kb = (n: number) => (n / 1024).toFixed(0) + 'KB';
const mean = totalBytes / shards.length;
console.log(
  `wrote ${shards.length} shards to demo/data (${ROWS.toLocaleString()} offers, ${kb(totalBytes)} raw)\n` +
  `  busiest  ${shards[0].iata} ${shards[0].rows.toLocaleString()} rows, ${kb(shards[0].bytes)}\n` +
  `  mean     ${kb(mean)}\n` +
  `  smallest ${shards[shards.length - 1].iata} ${shards[shards.length - 1].rows} rows, ` +
  `${kb(shards[shards.length - 1].bytes)}`,
);
