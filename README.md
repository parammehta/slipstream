# slipstream

Flight search where the interesting part is the search UX, not the booking flow.

**[Live demo →](https://slipstream-demo.vercel.app)**

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
| 1 filter (slider drag) | 2.81ms | 2.91ms |
| 4 filters (typical query) | 8.14ms | 8.45ms |
| Histogram, 48 bins | 0.54ms | 0.56ms |
| Window of 40 rows | 0.17ms | 0.19ms |
| **Full frame** (filter + histogram + window) | **9.00ms** | **9.15ms** |

Inside a 16ms frame, so the price slider can re-filter and redraw its own
distribution on every pointer move rather than on commit.

In the browser, driving 60 synthetic pointer moves through the real UI: p50
5.4ms, p95 8.2ms, worst 8.8ms, **zero frames over budget**.

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
  filter.ts      selection vectors, range + oneOf predicates
  sort.ts        stable LSD radix argsort
  histogram.ts   binning over the current selection
  query.ts       windowed materialization for the virtual list
  bitset.ts      membership bitsets
  synth.ts       seeded synthetic offers for tests and benchmarks
demo/
  index.html     self-contained UI with the engine inlined
```

Everything under `src/core` is dependency-free and runs unchanged in a Worker
or in Node.

## The demo

`demo/index.html` is one self-contained file — the engine inlined, 500,000
synthetic offers generated in the browser, a virtualized timetable, live
histogram sliders, and a HUD reporting real measured query and paint times.
No build step; open the file.

## Running it

Requires Node 24+ (native TypeScript stripping, `node:test`). No install step.

```bash
npm test
npm run bench          # or: node scripts/bench.ts 5000000
```

## Roadmap

1. ~~Slab format, filter/sort/histogram kernels, benchmarks~~ — done
2. ~~Results UI: virtualized list, live histogram sliders, frame-timing overlay~~ — done
3. Harvester: scheduled worker against Amadeus Self-Service, Parquet output
4. Worker wrapper: move the engine off the main thread
5. Multi-city legs + the flexible-date price grid
6. URL state: read the hash back on load, not just write it
7. Write-up: benchmarks, format comparison, profiler traces

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
