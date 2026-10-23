# slipstream

Flight search where the interesting part is the search UX, not the booking flow.

**[slipstream-search.vercel.app](https://slipstream-search.vercel.app)** — the
write-up and the engine behind it · **[open the search →](https://slipstream-search.vercel.app/search)**

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
| 1 filter (slider drag) | 2.43ms | 2.49ms |
| 4 filters (typical query) | 6.99ms | 7.16ms |
| Histogram, 48 bins | 0.60ms | 0.61ms |
| Date grid, 60 day buckets | 0.66ms | 0.67ms |
| Window of 40 rows | 0.53ms | 0.54ms |
| **Full frame** (filter + grid + histogram + window) | **8.79ms** | **8.87ms** |
| Multi-city: 3 leg queries + combine | 7.42ms | 7.54ms |
| — of which, combining 40 trips | **0.02ms** | 0.03ms |

Measured over the harvested dataset rather than a synthetic one, so the
numbers reflect the distributions the product actually queries. Selectivity
for that query is 25.1% — real fare curves cluster, so filters keep more rows
and less work gets skipped than synthetic data suggested.

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

**Multi-city is a composition, not a row type.** A three-leg trip over 100k
offers per leg is 10^15 combinations, so itineraries are never materialised.
Each leg is filtered and sorted independently — work the engine already does —
and the cheapest whole trips are walked out of the frontier: the cheapest trip
is the cheapest offer on every leg, and every trip after it differs from one
already found by a single step up on a single leg. A heap over that frontier
yields them in order, so forty itineraries cost forty pops. That step measures
**0.02ms**; the legs' own queries are the entire cost.

This is why multi-city needed no change to the slab format, which is the
opposite of what I expected before writing it.

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
  combine.ts     top-k itineraries over a frontier heap
  bitset.ts      membership bitsets
  markets.ts     GENERATED — harvested markets and their fare curves
  offers.ts      offers sampled from real fare curves
  routes.ts      GENERATED — OpenFlights routes, used by the benchmark
  synth.ts       seeded offers over those routes, for tests and benchmarks
src/harvest/
  provider.ts    the fare-source interface
  db1b.ts        US DOT DB1B, streaming and two-pass
  distribution.ts  fare curves as quantiles
  market.ts      observations -> markets
  emit.ts        markets -> generated module
src/worker/
  engine-worker.ts     owns the slab; answers queries over postMessage
demo/
  index.template.html     the search UI: markup, styles, script
  landing.template.html   the landing page and write-up
  index.html              GENERATED — the landing page
  search/index.html       GENERATED — the search, engine inlined
scripts/
  build-demo.ts           inlines src/core into the template
```

Everything under `src/core` is dependency-free and runs unchanged in a Worker
or in Node.

## The data

**The fares are real.** `src/core/markets.ts` is harvested from the US DOT's
[Airline Origin and Destination Survey (DB1B)](https://www.transtats.bts.gov/):
a 10% sample of tickets sold by US reporting carriers, published quarterly, in
the public domain. No account, no key, no rate limit.

From 2025 Q1 — 1.7GB of ticket records, 65,100 directional markets — the
harvester keeps the busiest **1,200 markets across 90 airports and 31
carriers**, each carrying its observed fare curve (p10..p90) rather than a
formula. What comes out is recognisably the real market:

| | distance | p10 | median | p90 | carriers |
| --- | ---: | ---: | ---: | ---: | --- |
| LAX→JFK | 2,475mi | $148 | $293 | $1,103 | DL 44%, B6 35%, AA 19% |
| LGA→ORD | 733mi | $73 | $153 | $308 | UA 33%, AA 27%, YX 14% |
| LAX→HNL | 2,556mi | $123 | $198 | $408 | HA 38%, UA 22%, DL 16% |

JetBlue and Delta splitting the JFK transcon, a $1,103 p90 where the premium
cabins sit, Hawaiian leading Los Angeles–Honolulu, Republic flying regional
for the majors out of LaGuardia — none of that is modelled. It is what was
sold.

**What is modelled: departure times.** DB1B records what was paid and how far
the passenger flew, never when they left. So schedules are generated —
duration from distance, connection likelihood from each market's *observed*
connecting share, block times jittered because real aircraft differ. Fares,
routes, carriers and carrier mix come from the data; clocks do not.

Two filters matter more than they look. Bulk fares (`BulkFare > 0`) are
tour-operator inventory rather than what a passenger paid, and fares under $20
are award tickets, employee travel and keypunch errors — both drag the curve
down and both are excluded.

City names come from [OpenFlights](https://openflights.org/data.html), which
DB1B does not carry.

### Re-harvesting

The download is ~90MB compressed and 1.7GB extracted, so it is deliberately
not part of any build:

```bash
curl -L -o db1b.zip \
  https://transtats.bts.gov/PREZIP/Origin_and_Destination_Survey_DB1BMarket_2025_1.zip
unzip db1b.zip
node scripts/harvest.ts --csv Origin_and_Destination_Survey_DB1BMarket_2025_1.csv \
  --period "2025 Q1" --limit 1200
```

Two streaming passes, ~25s: one to rank markets by traffic, one to build fare
curves for the survivors. Holding every fare in memory would take gigabytes; a
histogram per market takes a few megabytes.

`src/harvest/provider.ts` is an interface, not a shape fitted to DB1B — a
second source (an affiliate fare feed, say) implements `run()` and everything
downstream is shared.

## The demo

`demo/search/index.html` is one self-contained file — the engine inlined, 500,000
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

The build emits two pages: `/` is the landing page and write-up, `/search`
is the search itself.

Query-string switches:

| | |
| --- | --- |
| `?rows=3000000` | size of the generated dataset (1k – 20M) |
| `?engine=inline` | force the main-thread fallback instead of the Worker |

## Running it

Requires Node 24+ (native TypeScript stripping, `node:test`). No install step.

```bash
npm test               # 125 tests, including the demo staleness check
npm run bench          # or: node scripts/bench.ts 5000000
npm run build:demo     # regenerate demo/index.html from src/core
npm run check:demo     # verify it is current without writing
```

`npm test` and `npm run bench` need no dependencies. `npm run typecheck` does
(`npm install` first) — and it earns its keep: `erasableSyntaxOnly` catches
TypeScript that Node's type stripping cannot erase, which is otherwise only
discovered at runtime.

## Roadmap

1. ~~Slab format, filter/sort/histogram kernels, benchmarks~~ — done
2. ~~Results UI: virtualized list, live histogram sliders, frame-timing overlay~~ — done
3. ~~Generate the demo from `src/core` so the engine has one source of truth~~ — done
4. ~~Flexible-date price grid: cheapest fare per day, filterable~~ — done
5. ~~Harvester: real fares from the US DOT DB1B ticket sample~~ — done
6. ~~Worker wrapper: move the engine off the main thread~~ — done
7. ~~Multi-city legs~~ — done
8. ~~URL state: read the hash back on load, not just write it~~ — done
9. ~~Write-up: benchmarks, format comparison, the assumptions that measurement
   overturned~~ — done; it is the site's landing page
   (`demo/landing.template.html`)

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

Fare data: US Department of Transportation, Bureau of Transportation
Statistics, Airline Origin and Destination Survey (DB1B). Public domain.

Airport and city data derives from the OpenFlights database, published under
the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/).
