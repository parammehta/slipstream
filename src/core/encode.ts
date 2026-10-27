import {
  HEADER_BYTES,
  MAGIC,
  VERSION,
  BYTES_PER,
  align8,
  type ColumnMeta,
  type ConstantColumn,
  type DerivedColumn,
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
  /**
   * Columns to leave out of the file and rebuild on decode. Both kinds are
   * checked against the data here, at build time, because a wrong claim
   * would corrupt every row silently.
   */
  constants?: Record<string, ConstantColumn>;
  derived?: Record<string, DerivedColumn>;
}

/** Refuses to omit a column whose values do not match the claim. */
function verifyOmissions(input: SlabInput): void {
  const { rowCount, columns } = input;

  for (const [name, spec] of Object.entries(input.constants ?? {})) {
    const column = columns[name];
    if (!column) throw new Error(`encodeSlab: cannot check constant "${name}", column missing`);
    for (let i = 0; i < rowCount; i++) {
      if (column[i] !== spec.value) {
        throw new Error(
          `encodeSlab: "${name}" is not constant — row ${i} is ${column[i]}, not ${spec.value}`,
        );
      }
    }
  }

  for (const [name, spec] of Object.entries(input.derived ?? {})) {
    const column = columns[name];
    const a = columns[spec.from[0]];
    const b = columns[spec.from[1]];
    if (!column || !a || !b) throw new Error(`encodeSlab: cannot check derived "${name}"`);
    for (let i = 0; i < rowCount; i++) {
      if (column[i] !== a[i] + b[i]) {
        throw new Error(
          `encodeSlab: "${name}" is not ${spec.from.join(' + ')} — row ${i} is ${column[i]}, ` +
          `expected ${a[i] + b[i]}`,
        );
      }
    }
  }
}

/**
 * Serialize columns into a single ArrayBuffer. Columns keep their natural
 * alignment so the decoder can create zero-copy views over the same memory.
 */
export function encodeSlab(input: SlabInput): ArrayBuffer {
  const { rowCount, schema, columns } = input;
  verifyOmissions(input);

  const omitted = new Set([
    ...Object.keys(input.constants ?? {}),
    ...Object.keys(input.derived ?? {}),
  ]);

  const columnMeta: ColumnMeta[] = [];
  let cursor = HEADER_BYTES;
  for (const { name, type } of schema) {
    if (omitted.has(name)) continue;
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
    ...(input.constants ? { constants: input.constants } : {}),
    ...(input.derived ? { derived: input.derived } : {}),
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
