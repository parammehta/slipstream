import {
  HEADER_BYTES,
  MAGIC,
  VERSION,
  BYTES_PER,
  align8,
  type ColumnMeta,
  type DType,
  type SlabMeta,
  type TypedArray,
} from './format.ts';

export interface SlabInput {
  rowCount: number;
  baseDayEpoch: number;
  columns: Record<string, TypedArray>;
  dicts: Record<string, string[]>;
  schema: ReadonlyArray<{ name: string; type: DType }>;
}

/**
 * Serialize columns into a single ArrayBuffer. Columns keep their natural
 * alignment so the decoder can create zero-copy views over the same memory.
 */
export function encodeSlab(input: SlabInput): ArrayBuffer {
  const { rowCount, schema, columns } = input;

  const columnMeta: ColumnMeta[] = [];
  let cursor = HEADER_BYTES;
  for (const { name, type } of schema) {
    const col = columns[name];
    if (!col) throw new Error(`encodeSlab: missing column "${name}"`);
    if (col.length !== rowCount) {
      throw new Error(`encodeSlab: column "${name}" has ${col.length} rows, expected ${rowCount}`);
    }
    cursor = align8(cursor);
    const length = rowCount * BYTES_PER[type];
    columnMeta.push({ name, type, offset: cursor, length });
    cursor += length;
  }

  const metaOffset = align8(cursor);
  const meta: SlabMeta = {
    columns: columnMeta,
    dicts: input.dicts,
    baseDayEpoch: input.baseDayEpoch,
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));

  const buf = new ArrayBuffer(metaOffset + metaBytes.byteLength);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint32(0, MAGIC, false);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, 0, true); // flags, reserved
  view.setUint32(8, rowCount, true);
  view.setUint32(12, input.baseDayEpoch, true);
  view.setUint32(16, metaOffset, true);
  view.setUint32(20, metaBytes.byteLength, true);
  view.setUint32(24, 0, true); // reserved
  view.setUint32(28, 0, true); // reserved

  for (const m of columnMeta) {
    const col = columns[m.name];
    bytes.set(new Uint8Array(col.buffer, col.byteOffset, col.byteLength), m.offset);
  }
  bytes.set(metaBytes, metaOffset);

  return buf;
}
