/**
 * Composing multi-city itineraries out of one-way offers.
 *
 * A three-leg trip over 100k offers per leg has 10^15 combinations, so the
 * itineraries are never materialised. Each leg is filtered and sorted
 * independently — work the engine already does — and the cheapest
 * combinations are walked out of the frontier.
 *
 * The cheapest itinerary is necessarily the cheapest offer on every leg. The
 * next cheapest differs from some already-found combination by one step up on
 * exactly one leg, so a heap over that frontier yields them in order. Finding
 * 40 itineraries costs 40 pops, not 10^15 comparisons.
 *
 * This is why multi-city needed no change to the slab: itineraries are a
 * query-time composition, not a row type.
 */

/** Packing the index tuple into one integer caps both of these. */
export const MAX_LEGS = 4;
export const MAX_RESULTS = 255;

export interface LegCandidates {
  /** Fares in cents, ascending. */
  prices: Uint32Array;
  /** Row ids, parallel to `prices`. */
  rows: Uint32Array;
  length: number;
}

export interface Combination {
  /** Flattened: result i uses rows[i * legCount + leg]. */
  rows: Uint32Array;
  /** Total fare in cents, ascending. */
  totals: Float64Array;
  count: number;
  legCount: number;
}

const EMPTY: Combination = {
  rows: new Uint32Array(0),
  totals: new Float64Array(0),
  count: 0,
  legCount: 0,
};

/** Index tuples pack one byte per leg, which is why both limits are 255. */
function packKey(indices: Int32Array, offset: number, legCount: number): number {
  let key = 0;
  for (let l = 0; l < legCount; l++) key = key * 256 + indices[offset + l];
  return key;
}

export function topKCombinations(legs: LegCandidates[], k: number): Combination {
  const legCount = legs.length;
  if (legCount === 0 || k <= 0) return EMPTY;
  if (legCount > MAX_LEGS) throw new Error(`topKCombinations: at most ${MAX_LEGS} legs`);
  if (k > MAX_RESULTS) throw new Error(`topKCombinations: at most ${MAX_RESULTS} results`);
  // One empty leg means the trip cannot be flown at all.
  for (const leg of legs) if (leg.length === 0) return { ...EMPTY, legCount };

  // Binary heap over frontier tuples, as parallel arrays to avoid per-node
  // objects: a drag re-runs this on every frame.
  const capacity = (k + 1) * legCount + legCount + 1;
  const heapTotals = new Float64Array(capacity);
  const heapIdx = new Int32Array(capacity * legCount);
  let heapSize = 0;

  const swap = (a: number, b: number) => {
    const t = heapTotals[a];
    heapTotals[a] = heapTotals[b];
    heapTotals[b] = t;
    for (let l = 0; l < legCount; l++) {
      const ti = heapIdx[a * legCount + l];
      heapIdx[a * legCount + l] = heapIdx[b * legCount + l];
      heapIdx[b * legCount + l] = ti;
    }
  };

  const push = (total: number, source: Int32Array, sourceOffset: number) => {
    if (heapSize >= capacity) return; // frontier is bounded by k; nothing to lose
    const at = heapSize++;
    heapTotals[at] = total;
    for (let l = 0; l < legCount; l++) heapIdx[at * legCount + l] = source[sourceOffset + l];
    let node = at;
    while (node > 0) {
      const parent = (node - 1) >> 1;
      if (heapTotals[parent] <= heapTotals[node]) break;
      swap(parent, node);
      node = parent;
    }
  };

  const pop = () => {
    swap(0, --heapSize);
    let node = 0;
    for (;;) {
      const left = node * 2 + 1;
      const right = left + 1;
      let smallest = node;
      if (left < heapSize && heapTotals[left] < heapTotals[smallest]) smallest = left;
      if (right < heapSize && heapTotals[right] < heapTotals[smallest]) smallest = right;
      if (smallest === node) break;
      swap(node, smallest);
      node = smallest;
    }
  };

  const seen = new Set<number>();
  const start = new Int32Array(legCount);
  let startTotal = 0;
  for (let l = 0; l < legCount; l++) startTotal += legs[l].prices[0];
  push(startTotal, start, 0);
  seen.add(0);

  const outRows = new Uint32Array(k * legCount);
  const outTotals = new Float64Array(k);
  const neighbour = new Int32Array(legCount);
  let found = 0;

  while (found < k && heapSize > 0) {
    const total = heapTotals[0];
    // Copy before pop: popping overwrites slot 0.
    for (let l = 0; l < legCount; l++) neighbour[l] = heapIdx[l];
    pop();

    for (let l = 0; l < legCount; l++) {
      outRows[found * legCount + l] = legs[l].rows[neighbour[l]];
    }
    outTotals[found] = total;
    found++;

    // Step up one leg at a time; every unseen successor joins the frontier.
    for (let l = 0; l < legCount; l++) {
      const next = neighbour[l] + 1;
      if (next >= legs[l].length || next > MAX_RESULTS) continue;
      neighbour[l] = next;
      const key = packKey(neighbour, 0, legCount);
      if (!seen.has(key)) {
        seen.add(key);
        let sum = 0;
        for (let j = 0; j < legCount; j++) sum += legs[j].prices[neighbour[j]];
        push(sum, neighbour, 0);
      }
      neighbour[l] = next - 1;
    }
  }

  return {
    rows: found === k ? outRows : outRows.subarray(0, found * legCount),
    totals: found === k ? outTotals : outTotals.subarray(0, found),
    count: found,
    legCount,
  };
}
