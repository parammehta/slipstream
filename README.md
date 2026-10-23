# slipstream

Flight search where the interesting part is the search UX, not the booking flow.

**[Live demo →](https://slipstream-search.vercel.app)**

There is no free flight-pricing API to call per keystroke. The ones that
existed were rate-limited to hundreds of calls a day, and Amadeus — the last
one with an open self-service tier — decommissioned it on 17 July 2026,
leaving enterprise contracts and paid scrapers. Fare data is something you
acquire in bulk, offline.

So Slipstream is built that way round: fares are harvested on a schedule into
a columnar binary **slab**, the client downloads one slab, and every filter,
sort, and histogram runs locally over typed arrays. Nothing touches the
network during interaction.

## Status

The query engine and the results UI are built and benchmarked. The harvester
and multi-city/date-grid views are not yet written — see [Roadmap](#roadmap).

## Measured at 1,000,000 rows

Apple Silicon, Node 24, `npm run bench`:

| Operation | p50 | p95 |
| --- | ---: | ---: |
| 1 filter (slider drag) | 2.64ms | 2.70ms |
| 4 filters (typical query) | 5.71ms | 5.75ms |
| Histogram, 48 bins | 0.18ms | 0.18ms |
| Date grid, 60 day buckets | 0.20ms | 0.20ms |
| Window of 40 rows | 0.47ms | 0.50ms |
| **Full frame** (filter + grid + histogram + window) | **6.68ms** | **6.71ms** |

Selectivity for that query is 7.3%; the earlier 9.80ms figure was measured
against a synthetic route set whose filters kept 22% of rows, so less of the
work got skipped.

Inside a 16ms frame, so the price slider can re-filter and redraw its own
distribution on every pointer move rather than on commit.

### In the browser, worker vs main thread

The engine runs in a Web Worker. `?engine=inline` forces the same code onto
the main thread, and `?rows=` changes the dataset, so the trade is measurable
rather than asserted. Dragging the price slider one move per frame:

| | main thread | worker |
| --- | ---: | ---: |
| 500k — blocked per move | 4.6ms | **2.3ms** |
| 500k — latency to redraw | 4.6ms | 13.9ms |
| 3M — blocked per query | **161ms** | **~2ms** |
| 3M — latency to redraw | 161ms | 134ms |

At 500k the main thread was already inside budget, and the worker costs ~9ms
of extra latency to buy half the blocking — a wash. At 3M it is the difference
between a page that responds and a page frozen for a sixth of a second on
every single move: the engine time *is* the block when it runs inline, which
is why those two columns are identical there.

The worker is kept because the architecture should hold at the dataset sizes
this design exists for, not just at the one the demo ships with.

Load-time costs: decode 0.22ms (zero-copy), argsort 10–19ms per sort key.
Slab size is 20.0 bytes/row — 19MB for 1M rows, ~7.2x smaller than the
equivalent JSON before compression, and far cheaper to parse.

## How it goes fast

**Columnar layout.** Each field is one typed array over a single ArrayBuffer.
A price filter touches 4MB, not the 120MB a row-oriented JSON payload would.
Decoding is `JSON.parse` of a small metadata blob plus typed-array views —
there is no per-row object allocation anywhere.

**Selection vectors, not repeated full scans.** The first predicate scans every
row and writes survivors into a `Uint32Array`; each subsequent predicate only
re-checks what is left. This is what took four filters from 16.4ms to 8.1ms.
The inner loops write unconditionally and advance the write cursor by 0 or 1,
so there is no branch to mispredict.

**Radix argsort.** Sort orders are permutations computed once per key at load
with a stable 4-pass LSD radix sort — no comparator calls. Re-sorting the
results is then just picking a different permutation, which is free.

**The date grid reads off a partial selection.** The cheapest-fare-per-day grid
has to ignore the date filter — otherwise picking a day would blank every other
day. Rather than run the whole query twice, the engine filters *without* the
date predicate, reads the grid off that selection, then refines the same
selection by the chosen day. One extra narrow pass over rows that already
survived everything else, instead of a second full scan.

**The engine runs off the main thread.** The page owns no slab, no sort
orders and no scratch buffers: it sends filters and a window, and receives a
count, the grid, two histograms and a packed `Int32Array` of just the rows it
is about to paint. One query is in flight at a time — a request arriving while
the engine is busy collapses into a single follow-up, so a fast drag produces
one query per turnaround instead of a queue that keeps running after the user
lets go. Where a Worker cannot be created (a `file://` origin, mostly) the
same bundle is evaluated on the main thread behind the same message protocol,
so there is one implementation of the query path either way.

**Windowed materialization.** The virtualized list asks for the ~40 rows it is
about to paint. `materializeWindow` walks the sort order, skips rows outside
the membership bitset, and stops at the limit — the full result set is never
materialized.

## Layout

```
src/core/
  format.ts      slab header, column schema, dtype helpers
  encode.ts      columns  -> ArrayBuffer
  decode.ts      ArrayBuffer -> zero-copy typed-array views
  filter.ts      selection vectors, range + oneOf predicates, refinement
  buckets.ts     cheapest value per bucket, for the date grid
  sort.ts        stable LSD radix argsort
  histogram.ts   binning over the current selection
  query.ts       windowed materialization for the virtual list
  bitset.ts      membership bitsets
  routes.ts      GENERATED — real airports, airlines and routes
  synth.ts       seeded offers over those real routes
src/worker/
  engine-worker.ts     owns the slab; answers queries over postMessage
demo/
  index.template.html  markup, styles, and the UI script
  index.html           GENERATED — template + src/core inlined
scripts/
  build-demo.ts        inlines src/core into the template
```

Everything under `src/core` is dependency-free and runs unchanged in a Worker
or in Node.

## The data

Fares are generated, but the geography is not. `src/core/routes.ts` is built
from the [OpenFlights](https://openflights.org/data.html) database: **138
airports, 32 airlines and 4,564 routes that genuinely exist between them**,
with real coordinates.

That matters because duration falls out of great-circle distance rather than
being invented. Checked against published schedules:

| | generated | real | |
| --- | ---: | ---: | ---: |
| SIN–HKG | 232m | ~230m | 1% |
| SFO–LHR | 686m | ~640m | 7% |
| JFK–LAX | 338m | ~375m | 10% |
| LHR–CDG | 66m | ~75m | 12% |

Carriers are drawn from a per-route bitmask of airlines that actually fly it,
so BA appears on LHR–JFK, AI on BOM–DEL, and nobody flies a route they do not
serve — the generator asserts zero violations across 300,000 offers.

Two things the curation has to get right, both learned the hard way:
codeshare rows are excluded (otherwise United "serves" Dubai–Doha), and
airlines are picked *before* airports, because choosing airports first leaves
pairs like Mumbai and Delhi in the set with no route between them. The
generator refuses to emit an airport with no routes.

Refresh it with `node scripts/fetch-routes.ts`; the output is committed, so
builds and tests never touch the network.

## The demo

`demo/index.html` is one self-contained file — the engine inlined, 500,000
offers generated in the browser over real routes, a virtualized timetable, live
histogram sliders, a departure-date grid colour-coded by the cheapest fare that
day, and a HUD reporting real measured query and paint times.

Every view has a URL. The hash is written as you filter and read back on load,
so a link reproduces the exact screen — it describes the whole view rather than
patching onto whatever the recipient already had open.
It is committed, so opening the file directly still works.

It is **generated**, not hand-maintained. ES module imports are blocked for
`file://` origins, so a page split across modules would only work over HTTP —
which is why the engine is inlined. Rather than keep a second copy of it by
hand, `scripts/build-demo.ts` strips the types from `src/core/*.ts` (using
Node's built-in `stripTypeScriptTypes`, so the build has no dependencies) and
injects them into `demo/index.template.html`.

Edit the engine in `src/core` or `src/worker` and run `npm run build:demo`.
`npm test` fails if the committed file is stale, so the two cannot drift.

Query-string switches:

| | |
| --- | --- |
| `?rows=3000000` | size of the generated dataset (1k – 20M) |
| `?engine=inline` | force the main-thread fallback instead of the Worker |

## Running it

Requires Node 24+ (native TypeScript stripping, `node:test`). No install step.

```bash
npm test               # 56 tests, including the demo staleness check
npm run bench          # or: node scripts/bench.ts 5000000
npm run build:demo     # regenerate demo/index.html from src/core
npm run check:demo     # verify it is current without writing
```

## Roadmap

1. ~~Slab format, filter/sort/histogram kernels, benchmarks~~ — done
2. ~~Results UI: virtualized list, live histogram sliders, frame-timing overlay~~ — done
3. ~~Generate the demo from `src/core` so the engine has one source of truth~~ — done
4. ~~Flexible-date price grid: cheapest fare per day, filterable~~ — done
5. Harvester: real *fares*. Real routes are in (see [The data](#the-data)).
   The intended source is the US DOT's DB1B ticket sample — actual fares
   paid, published in bulk, no account required.
6. ~~Worker wrapper: move the engine off the main thread~~ — done
7. Multi-city legs
8. ~~URL state: read the hash back on load, not just write it~~ — done
9. Write-up: benchmarks, format comparison, profiler traces

## Design notes

- **Column widths** are the smallest that cannot overflow realistic data:
  `durationMin` as u16 caps at ~45 days, `priceCents` as u32 at ~$42M.
- **Timestamps** are minutes from a base day stored in the header, keeping
  them in i32 and out of float math. UTC throughout; the IANA zone lives on
  the airport and formatting happens only at the edge of the UI.
- **Dictionaries** (carriers, airports) ride in the metadata blob. They are
  small, and keeping them out of the column data preserves alignment.

## License

Code: MIT.

Route data derives from the OpenFlights database, which is published under the
[Open Database License](https://opendatacommons.org/licenses/odbl/1-0/).
