/**
 * Benchmarks the query engine at portfolio-demo scale.
 *
 *   node scripts/bench.ts [rowCount]
 *
 * The number that matters is the p95 filter time: to hold 60fps while a
 * slider is being dragged, a filter pass plus a histogram rebuild has to fit
 * comfortably inside 16ms.
 */
import { encodeSlab } from '../src/core/encode.ts';
import { decodeSlab } from '../src/core/decode.ts';
import { generateOffersFromMarkets } from '../src/core/offers.ts';
import { marketDataset } from '../src/core/markets.ts';
import { applyFilters, createScratch, type Filter } from '../src/core/filter.ts';
import { argsortColumn } from '../src/core/sort.ts';
import { histogram } from '../src/core/histogram.ts';
import { minPerBucket, MINUTES_PER_DAY } from '../src/core/buckets.ts';
import { materializeWindow } from '../src/core/query.ts';

const ROWS = Number(process.argv[2] ?? 1_000_000);

function time(label: string, runs: number, fn: () => void): number {
  for (let i = 0; i < Math.min(5, runs); i++) fn(); // warm up the JIT
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[(runs * 0.5) | 0];
  const p95 = samples[Math.min(runs - 1, (runs * 0.95) | 0)];
  console.log(`  ${label.padEnd(34)} p50 ${p50.toFixed(2).padStart(7)}ms   p95 ${p95.toFixed(2).padStart(7)}ms`);
  return p50;
}

const dataset = marketDataset();
console.log(
  `\nslipstream engine bench — ${ROWS.toLocaleString()} rows over ` +
  `${dataset.markets.length.toLocaleString()} harvested markets (${dataset.period})\n`,
);

console.log('build');
const t0 = performance.now();
const input = generateOffersFromMarkets(dataset, ROWS, 1);
console.log(`  generate                           ${(performance.now() - t0).toFixed(0)}ms`);

const t1 = performance.now();
const buf = encodeSlab(input);
console.log(`  encode                             ${(performance.now() - t1).toFixed(0)}ms`);

const t2 = performance.now();
const slab = decodeSlab(buf);
console.log(`  decode (zero-copy)                 ${(performance.now() - t2).toFixed(2)}ms`);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)}MB`;
console.log(`  slab size                          ${mb(buf.byteLength)}  (${(buf.byteLength / ROWS).toFixed(1)} bytes/row)`);

console.log('\nsort (once per sort key, at load)');
const orders: Record<string, Uint32Array> = {};
for (const key of ['priceCents', 'durationMin', 'depMin']) {
  const t = performance.now();
  orders[key] = argsortColumn(slab.columns[key]);
  console.log(`  argsort ${key.padEnd(26)} ${(performance.now() - t).toFixed(0)}ms`);
}

console.log('\ninteraction (must fit in a 16ms frame)');
const scratch = createScratch(ROWS);
const bins = new Uint32Array(48);
const prices = slab.columns.priceCents;

let priceMin = Infinity;
let priceMax = 0;
for (let i = 0; i < prices.length; i++) {
  if (prices[i] < priceMin) priceMin = prices[i];
  if (prices[i] > priceMax) priceMax = prices[i];
}

const dragging: Filter[] = [{ kind: 'range', column: 'priceCents', min: priceMin, max: 80_000 }];
const realistic: Filter[] = [
  { kind: 'range', column: 'priceCents', min: 20_000, max: 120_000 },
  { kind: 'range', column: 'durationMin', min: 0, max: 900 },
  { kind: 'oneOf', column: 'stops', values: [0, 1] },
  { kind: 'oneOf', column: 'carrierId', values: [0, 1, 2, 3, 5, 8] },
];

time('1 filter  (slider drag)', 50, () => {
  applyFilters(slab, dragging, scratch);
});
time('4 filters (typical query)', 50, () => {
  applyFilters(slab, realistic, scratch);
});

const selection = applyFilters(slab, realistic, scratch);
const { mask, count } = selection;
time('histogram 48 bins (masked)', 50, () => {
  histogram(prices, selection, priceMin, priceMax, 48, bins);
});
time('window 40 rows @ offset 0', 50, () => {
  materializeWindow(orders.priceCents, mask, 0, 40);
});
time('window 40 rows @ offset 5000', 50, () => {
  materializeWindow(orders.priceCents, mask, 5000, 40);
});

const DAY_BUCKETS = 60;
const grid = new Uint32Array(DAY_BUCKETS);
const dep = slab.columns.depMin;
time('date grid (60 day buckets)', 50, () => {
  minPerBucket(prices, dep, MINUTES_PER_DAY, DAY_BUCKETS, selection, grid);
});

console.log('\nfull frame budget (filter + grid + histogram + window)');
time('4 filters + grid + histogram + window', 50, () => {
  const r = applyFilters(slab, realistic, scratch);
  minPerBucket(prices, dep, MINUTES_PER_DAY, DAY_BUCKETS, r, grid);
  histogram(prices, r, priceMin, priceMax, 48, bins);
  materializeWindow(orders.priceCents, r.mask, 0, 40);
});

console.log(`\nselectivity: ${count.toLocaleString()} / ${ROWS.toLocaleString()} rows (${((count / ROWS) * 100).toFixed(1)}%)\n`);
