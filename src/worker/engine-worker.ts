import { encodeSlab } from '../core/encode.ts';
import { decodeSlab } from '../core/decode.ts';
import { generateOffersFromMarkets } from '../core/offers.ts';
import { marketDataset } from '../core/markets.ts';
import { concatSlabs } from '../core/concat.ts';
import { applyFilters, refineSelection, createScratch, type Filter, type Selection } from '../core/filter.ts';
import { argsortColumn } from '../core/sort.ts';
import { histogram } from '../core/histogram.ts';
import { materializeWindow } from '../core/query.ts';
import { topKCombinations, MAX_LEGS, type LegCandidates } from '../core/combine.ts';
import { minPerBucket, valueExtent, MINUTES_PER_DAY, NO_VALUE } from '../core/buckets.ts';
import type { Slab } from '../core/format.ts';

/**
 * The engine host. Owns the slab, the sort permutations and the scratch
 * buffers, and answers queries over postMessage.
 *
 * It runs inside a Worker when the browser allows one, and is driven through
 * the same message protocol on the main thread when it does not — so there is
 * exactly one implementation of the query path either way.
 */

const DAY_BUCKETS = 60;
/** Itineraries shown per multi-city search; also caps per-leg candidates. */
const MAX_RESULTS_PER_TRIP = 40;
const HIST_BINS = 64;
/** Fields packed per row for the virtual list, in this order. */
const ROW_FIELDS = ['depMin', 'arrMin', 'durationMin', 'priceCents', 'stops', 'carrierId', 'originId', 'destId'] as const;

let slab: Slab;
let orders: Record<string, Uint32Array>;
let scratch: ReturnType<typeof createScratch>;
let scratchB: ReturnType<typeof createScratch>;
/** One set of buffers per leg, so legs do not clobber each other. */
let legScratch: Array<ReturnType<typeof createScratch>> = [];
let selection: Selection;
let sortKey = 'priceCents';

/** Reused across queries so a drag allocates nothing. */
const gridOut = new Uint32Array(DAY_BUCKETS);
const priceBinsOut = new Uint32Array(HIST_BINS);
const durBinsOut = new Uint32Array(HIST_BINS);
let priceBackdrop: Uint32Array;
let durBackdrop: Uint32Array;

let priceDomain: [number, number];
let durDomain: [number, number];

function percentile(column: { [i: number]: number }, order: Uint32Array, p: number): number {
  return column[order[Math.min(order.length - 1, Math.floor(order.length * p))]];
}

/**
 * Build the corpus, either by generating it or by fetching published shards.
 *
 * Generating keeps the tests and the benchmark free of a network; fetching is
 * what the page does. Both end at the same slab, so nothing downstream knows
 * which happened.
 */
interface OriginSpec {
  iata: string;
  /** Content-addressed file name from the manifest. */
  file?: string;
  /** Decoded size from the manifest, so progress is against a real total. */
  bytes?: number;
}

/** Report at most every 32KB: a message per chunk would swamp the page. */
const PROGRESS_STEP = 32 * 1024;

async function loadSlab(
  msg: {
    source?: string;
    rows?: number;
    seed?: number;
    origins?: Array<string | OriginSpec>;
    baseUrl?: string;
  },
  report?: (message: unknown) => void,
): Promise<Slab> {
  if (msg.source === 'fetch') {
    const specs: OriginSpec[] = (msg.origins ?? []).map((o) =>
      typeof o === 'string' ? { iata: o } : o,
    );
    if (specs.length === 0) throw new Error('init: fetch needs at least one origin');
    const base = (msg.baseUrl ?? '') + '/data/';

    // Content-Length is the compressed length while the reader yields
    // decompressed bytes, so the manifest's size is the honest total.
    const total = specs.reduce((sum, spec) => sum + (spec.bytes ?? 0), 0);
    let loaded = 0;
    let reported = 0;

    const buffers = await Promise.all(
      specs.map(async (spec) => {
        const res = await fetch(base + (spec.file ?? spec.iata + '.slab'));
        if (!res.ok) throw new Error(`init: ${spec.iata} shard returned HTTP ${res.status}`);
        if (!res.body || !report || total === 0) return res.arrayBuffer();

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.length;
          loaded += value.length;
          if (loaded - reported >= PROGRESS_STEP) {
            reported = loaded;
            report({ type: 'progress', loaded, total });
          }
        }
        const joined = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          joined.set(chunk, at);
          at += chunk.length;
        }
        return joined.buffer;
      }),
    );
    if (report && total > 0) report({ type: 'progress', loaded: total, total });
    return concatSlabs(buffers.map(decodeSlab));
  }

  const rowCount = msg.rows ?? 500_000;
  return decodeSlab(encodeSlab(generateOffersFromMarkets(marketDataset(), rowCount, msg.seed ?? 1)));
}

async function init(
  msg: {
    source?: string;
    rows?: number;
    seed?: number;
    origins?: Array<string | OriginSpec>;
    baseUrl?: string;
  },
  report?: (message: unknown) => void,
) {
  const t0 = performance.now();
  slab = await loadSlab(msg, report);
  const built = performance.now();

  scratch = createScratch(slab.rowCount);
  scratchB = createScratch(slab.rowCount);
  legScratch = Array.from({ length: MAX_LEGS }, () => createScratch(slab.rowCount));

  const sorted = performance.now();
  orders = {
    priceCents: argsortColumn(slab.columns.priceCents),
    durationMin: argsortColumn(slab.columns.durationMin),
    depMin: argsortColumn(slab.columns.depMin),
  };

  const price = slab.columns.priceCents;
  const dur = slab.columns.durationMin;
  // Clip at p99 so one long tail does not flatten the histogram.
  priceDomain = [price[orders.priceCents[0]], percentile(price, orders.priceCents, 0.99)];
  durDomain = [dur[orders.durationMin[0]], percentile(dur, orders.durationMin, 0.99)];

  priceBackdrop = histogram(price, null, priceDomain[0], priceDomain[1], HIST_BINS);
  durBackdrop = histogram(dur, null, durDomain[0], durDomain[1], HIST_BINS);

  const carrierCounts = new Uint32Array(slab.dicts.carriers.length);
  const carrierIds = slab.columns.carrierId;
  for (let i = 0; i < slab.rowCount; i++) carrierCounts[carrierIds[i]]++;

  return {
    type: 'ready',
    rowCount: slab.rowCount,
    byteLength: slab.byteLength,
    baseDayEpoch: slab.baseDayEpoch,
    dicts: slab.dicts,
    noValue: NO_VALUE,
    days: DAY_BUCKETS,
    bins: HIST_BINS,
    rowFields: ROW_FIELDS,
    marketCount: marketDataset().markets.length,
    maxLegs: MAX_LEGS,
    maxTrips: MAX_RESULTS_PER_TRIP,
    period: marketDataset().period,
    attribution: marketDataset().attribution,
    priceDomain,
    durDomain,
    priceBackdrop,
    durBackdrop,
    carrierCounts,
    timings: {
      build: built - t0,
      sort: performance.now() - sorted,
      total: performance.now() - t0,
    },
  };
}

/** Packs a window of rows into one Int32Array for a single transfer. */
function packWindow(offset: number, limit: number): { rows: Int32Array; length: number } {
  const order = orders[sortKey];
  const ids = materializeWindow(order, selection.mask, offset, limit);
  const out = new Int32Array(ids.length * ROW_FIELDS.length);
  for (let i = 0; i < ids.length; i++) packRow(out, i * ROW_FIELDS.length, ids[i]);
  return { rows: out, length: ids.length };
}

function query(msg: {
  filters: Filter[];
  day: number;
  sortKey: string;
  offset: number;
  limit: number;
}) {
  const t0 = performance.now();
  sortKey = msg.sortKey;

  // The date grid must ignore the date filter, or picking a day would blank
  // every other day: filter without it, read the grid, then refine.
  const base = applyFilters(slab, msg.filters, scratch);
  minPerBucket(
    slab.columns.priceCents, slab.columns.depMin,
    MINUTES_PER_DAY, DAY_BUCKETS, base, gridOut,
  );
  selection =
    msg.day < 0
      ? base
      : refineSelection(slab, [dayFilter(msg.day)], base, scratchB);

  if (selection.count === slab.rowCount) {
    priceBinsOut.set(priceBackdrop);
    durBinsOut.set(durBackdrop);
  } else {
    histogram(slab.columns.priceCents, selection, priceDomain[0], priceDomain[1], HIST_BINS, priceBinsOut);
    histogram(slab.columns.durationMin, selection, durDomain[0], durDomain[1], HIST_BINS, durBinsOut);
  }

  const packed = packWindow(msg.offset, msg.limit);
  return {
    count: selection.count,
    scanned: selection.scanned,
    // Copies, because the originals are reused next query and a transfer
    // would detach them.
    grid: gridOut.slice(),
    gridExtent: valueExtent(gridOut),
    priceBins: priceBinsOut.slice(),
    durBins: durBinsOut.slice(),
    rows: packed.rows,
    rowCount: packed.length,
    offset: msg.offset,
    engineMs: performance.now() - t0,
  };
}

function dayFilter(day: number): Filter {
  return {
    kind: 'range',
    column: 'depMin',
    min: day * MINUTES_PER_DAY,
    max: (day + 1) * MINUTES_PER_DAY - 1,
  };
}

/**
 * Walking the global price order costs a pass over every row, which is the
 * right trade when the selection is a large fraction of the slab. A single
 * multi-city leg is the opposite case — one route on one day can be fifty
 * rows out of half a million — and there it is far cheaper to gather that
 * handful and sort it directly.
 */
const DIRECT_SORT_LIMIT = 20_000;

function cheapestRows(selection: Selection, k: number): Uint32Array {
  if (selection.count > DIRECT_SORT_LIMIT) {
    return materializeWindow(orders.priceCents, selection.mask, 0, k);
  }

  const prices = slab.columns.priceCents;
  const rows = selection.rows.slice(0, selection.count);
  // Array#sort on a typed array sorts numerically and in place.
  const sorted = Array.from(rows).sort((a, b) => prices[a] - prices[b]);
  return Uint32Array.from(sorted.slice(0, k));
}

/** Pack one offer's fields, used by both the list and itinerary legs. */
function packRow(out: Int32Array, at: number, row: number): void {
  for (let f = 0; f < ROW_FIELDS.length; f++) {
    out[at + f] = slab.columns[ROW_FIELDS[f]][row];
  }
}

/**
 * Multi-city: filter each leg independently, take its cheapest candidates,
 * then walk the frontier for the cheapest whole trips. The itineraries are
 * never materialised — three legs of 100k offers is 10^15 combinations.
 */
function multiQuery(msg: {
  shared: Filter[];
  legs: Array<{ filters: Filter[] }>;
  k: number;
}) {
  const t0 = performance.now();
  const k = Math.max(1, Math.min(MAX_RESULTS_PER_TRIP, msg.k | 0));
  const legSpecs = msg.legs.slice(0, MAX_LEGS);

  const candidates: LegCandidates[] = [];
  const legCounts = new Uint32Array(legSpecs.length);

  for (let l = 0; l < legSpecs.length; l++) {
    const selection = applyFilters(slab, [...msg.shared, ...legSpecs[l].filters], legScratch[l]);
    legCounts[l] = selection.count;
    // Only the k cheapest can ever appear in a top-k trip.
    const rows = cheapestRows(selection, k);
    const prices = new Uint32Array(rows.length);
    for (let i = 0; i < rows.length; i++) prices[i] = slab.columns.priceCents[rows[i]];
    candidates.push({ prices, rows, length: rows.length });
  }

  const combo = topKCombinations(candidates, k);
  const legCount = legSpecs.length;
  const packed = new Int32Array(combo.count * legCount * ROW_FIELDS.length);
  for (let i = 0; i < combo.count; i++) {
    for (let l = 0; l < legCount; l++) {
      packRow(packed, (i * legCount + l) * ROW_FIELDS.length, combo.rows[i * legCount + l]);
    }
  }

  return {
    count: combo.count,
    legCount,
    legCounts,
    totals: Float64Array.from(combo.totals),
    rows: packed,
    engineMs: performance.now() - t0,
  };
}

/** Scroll-only: the selection is unchanged, just hand back different rows. */
function windowOnly(msg: { offset: number; limit: number }) {
  const t0 = performance.now();
  const packed = packWindow(msg.offset, msg.limit);
  return {
    rows: packed.rows,
    rowCount: packed.length,
    offset: msg.offset,
    engineMs: performance.now() - t0,
  };
}

// ArrayBufferLike, not ArrayBuffer: a typed array's `.buffer` may be a
// SharedArrayBuffer as far as the type system knows, and postMessage accepts
// either.
export async function handleMessage(
  msg: any,
  report?: (message: unknown) => void,
): Promise<{ reply: any; transfer: ArrayBufferLike[] }> {
  if (msg.type === 'ping') {
    // Proves the bundle loaded and is executing. Sent before `init` so the
    // page can tell "worker is broken" from "worker is busy building", which
    // takes longer the larger the dataset is.
    return { reply: { type: 'pong' }, transfer: [] };
  }
  if (msg.type === 'init') {
    try {
      return { reply: await init(msg, report), transfer: [] };
    } catch (err) {
      return { reply: { type: 'error', message: (err as Error).message }, transfer: [] };
    }
  }
  if (msg.type === 'query') {
    const r = query(msg);
    return {
      reply: { type: 'result', id: msg.id, ...r },
      transfer: [r.grid.buffer, r.priceBins.buffer, r.durBins.buffer, r.rows.buffer],
    };
  }
  if (msg.type === 'multiQuery') {
    const r = multiQuery(msg);
    return {
      reply: { type: 'trips', id: msg.id, ...r },
      transfer: [r.totals.buffer, r.rows.buffer, r.legCounts.buffer],
    };
  }

  if (msg.type === 'window') {
    const r = windowOnly(msg);
    return { reply: { type: 'rows', id: msg.id, ...r }, transfer: [r.rows.buffer] };
  }
  return { reply: { type: 'error', message: 'unknown message ' + msg.type }, transfer: [] };
}

// Wired up by the generated bundle, which appends the postMessage loop.
export const ROW_FIELD_COUNT = ROW_FIELDS.length;
