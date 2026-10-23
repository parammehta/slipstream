# slipstream

Flight search where the interesting part is the search UX, not the booking flow.

**[Live demo →](https://slipstream-search.vercel.app)**

Free flight APIs are rate-limited to hundreds of calls a day, so there is no
querying a provider per keystroke. Slipstream inverts it: prices are harvested
on a schedule into a columnar binary **slab**, the client downloads one slab,
and every filter, sort, and histogram runs locally over typed arrays. Nothing
touches the network during interaction.

## Status

The query engine and the results UI are built and benchmarked. The harvester
and multi-city/date-grid views are not yet written — see [Roadmap](#roadmap).

## Measured at 1,000,000 rows

Apple Silicon, Node 24, `npm run bench`:

| Operation | p50 | p95 |
| --- | ---: | ---: |
| 1 filter (slider drag) | 2.99ms | 3.33ms |
| 4 filters (typical query) | 8.63ms | 9.55ms |
| Histogram, 48 bins | 0.53ms | 0.62ms |
| Date grid, 60 day buckets | 0.48ms | 0.56ms |
| Window of 40 rows | 0.19ms | 0.21ms |
| **Full frame** (filter + grid + histogram + window) | **9.80ms** | **11.01ms** |

Inside a 16ms frame, so the price slider can re-filter and redraw its own
distribution on every pointer move rather than on commit.

In the browser, driving 40 synthetic pointer moves through the real UI with a
date selected — so the filter, the date grid, both histograms and the list all
recompute every move: p50 5.6ms, p95 7.5ms, worst 7.9ms, **zero frames over
budget**. Picking a date costs 5–7ms, 12.2ms worst.

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
  synth.ts       seeded synthetic offers for tests and benchmarks
demo/
  index.template.html  markup, styles, and the UI script
  index.html           GENERATED — template + src/core inlined
scripts/
  build-demo.ts        inlines src/core into the template
```

Everything under `src/core` is dependency-free and runs unchanged in a Worker
or in Node.

## The demo

`demo/index.html` is one self-contained file — the engine inlined, 500,000
synthetic offers generated in the browser, a virtualized timetable, live
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

Edit the engine in `src/core` and run `npm run build:demo`. `npm test` fails
if the committed file is stale, so the two cannot drift.

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
5. Harvester: scheduled worker against Amadeus Self-Service, Parquet output
6. Worker wrapper: move the engine off the main thread
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

MIT
