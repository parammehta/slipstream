# Slab format v1

A slab is a single `ArrayBuffer`: a fixed header, 8-byte-aligned column data,
then a UTF-8 JSON metadata blob at the tail.

```
offset  size  field
0       4     magic         0x534c4142 ("SLAB", big-endian)
4       2     version       u16, currently 1
6       2     flags         u16, reserved
8       4     rowCount      u32
12      4     baseDayEpoch  u32, days since 1970-01-01
16      4     metaOffset    u32, byte offset of the JSON blob
20      4     metaLength    u32, byte length of the JSON blob
24      8     reserved
32      ...   column data, each column aligned to 8 bytes
```

Metadata:

```json
{
  "columns": [{ "name": "priceCents", "type": "u32", "offset": 32, "length": 4000000 }],
  "dicts": { "airports": ["SFO", "JFK"], "carriers": ["AA", "UA"] },
  "baseDayEpoch": 20000
}
```

## Why the tail, and why JSON

The metadata is written last so the encoder can stream column data without
knowing the final offsets up front, and it is JSON because it is small
(kilobytes against megabytes of columns) and self-describing — a future
version can add columns without a decoder change.

Alignment matters more than it looks: typed-array views require their byte
offset to be a multiple of the element size, so a misaligned column would
force a copy and give up the zero-copy decode entirely.

## Column types

| Type | Bytes | Used for |
| --- | ---: | --- |
| `u8` | 1 | `stops`, `carrierId` |
| `u16` | 2 | `durationMin`, `originId`, `destId` |
| `u32` | 4 | `priceCents` |
| `i32` | 4 | `depMin`, `arrMin` |

Signed columns sort correctly because `toSortKeys` biases them by 2^31 before
the radix passes, mapping two's-complement order onto unsigned order.

## Compatibility

The decoder rejects an unknown `version` outright rather than guessing. Adding
a column is backward-compatible for readers that look columns up by name;
changing a column's dtype is not, and requires a version bump.
