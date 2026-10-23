/**
 * Slab: a columnar binary container for flight offers.
 *
 * Layout:
 *   [0,32)            header
 *   [32, metaOffset)  column data, each column 8-byte aligned
 *   [metaOffset, +metaLength)  UTF-8 JSON metadata (column table + dictionaries)
 *
 * Columns are stored as parallel arrays so a filter pass touches only the
 * bytes it needs. Strings live in dictionaries and are referenced by integer
 * id, which is what keeps the payload an order of magnitude under JSON.
 */

export const MAGIC = 0x534c4142; // 'SLAB' big-endian read
export const VERSION = 1;
export const HEADER_BYTES = 32;

export type DType = 'u8' | 'u16' | 'u32' | 'i32';

export const BYTES_PER: Record<DType, number> = { u8: 1, u16: 2, u32: 4, i32: 4 };

export type TypedArray = Uint8Array | Uint16Array | Uint32Array | Int32Array;

export interface ColumnMeta {
  name: string;
  type: DType;
  /** Byte offset from the start of the buffer. */
  offset: number;
  /** Byte length of the column. */
  length: number;
}

export interface SlabMeta {
  columns: ColumnMeta[];
  /** Dictionary name -> ordered string values; ids index into this array. */
  dicts: Record<string, string[]>;
  /** Days since the Unix epoch; all minute-based columns are relative to this. */
  baseDayEpoch: number;
}

export interface Slab {
  rowCount: number;
  baseDayEpoch: number;
  columns: Record<string, TypedArray>;
  dicts: Record<string, string[]>;
  /** Total bytes of the encoded slab, for reporting. */
  byteLength: number;
}

/**
 * Canonical offer schema. Widths are chosen to be the smallest that cannot
 * overflow for realistic data: durationMin caps at ~45 days, priceCents at
 * ~$42M, and stops/carrierId at 255 distinct values.
 */
export const OFFER_SCHEMA: ReadonlyArray<{ name: string; type: DType }> = [
  { name: 'depMin', type: 'i32' },
  { name: 'arrMin', type: 'i32' },
  { name: 'durationMin', type: 'u16' },
  { name: 'priceCents', type: 'u32' },
  { name: 'stops', type: 'u8' },
  { name: 'carrierId', type: 'u8' },
  { name: 'originId', type: 'u16' },
  { name: 'destId', type: 'u16' },
];

export function allocColumn(type: DType, rowCount: number): TypedArray {
  switch (type) {
    case 'u8':
      return new Uint8Array(rowCount);
    case 'u16':
      return new Uint16Array(rowCount);
    case 'u32':
      return new Uint32Array(rowCount);
    case 'i32':
      return new Int32Array(rowCount);
  }
}

export function viewColumn(buf: ArrayBuffer, meta: ColumnMeta, rowCount: number): TypedArray {
  switch (meta.type) {
    case 'u8':
      return new Uint8Array(buf, meta.offset, rowCount);
    case 'u16':
      return new Uint16Array(buf, meta.offset, rowCount);
    case 'u32':
      return new Uint32Array(buf, meta.offset, rowCount);
    case 'i32':
      return new Int32Array(buf, meta.offset, rowCount);
  }
}

export function align8(n: number): number {
  return (n + 7) & ~7;
}
