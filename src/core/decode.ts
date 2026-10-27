import {
  HEADER_BYTES,
  MAGIC,
  VERSION,
  allocColumn,
  viewColumn,
  type Slab,
  type SlabMeta,
  type TypedArray,
} from './format.ts';

/**
 * Read a slab without copying: every column is a typed-array view over the
 * original buffer, so decoding a 10MB payload costs a JSON.parse of the
 * metadata and nothing more.
 */
export function decodeSlab(buf: ArrayBuffer): Slab {
  if (buf.byteLength < HEADER_BYTES) throw new Error('decodeSlab: buffer too small');
  const view = new DataView(buf);

  const magic = view.getUint32(0, false);
  if (magic !== MAGIC) throw new Error('decodeSlab: bad magic; not a slab');
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`decodeSlab: unsupported version ${version}`);

  const rowCount = view.getUint32(8, true);
  const baseDayEpoch = view.getUint32(12, true);
  const metaOffset = view.getUint32(16, true);
  const metaLength = view.getUint32(20, true);

  if (metaOffset + metaLength > buf.byteLength) throw new Error('decodeSlab: truncated metadata');

  const metaJson = new TextDecoder().decode(new Uint8Array(buf, metaOffset, metaLength));
  const meta = JSON.parse(metaJson) as SlabMeta;

  const columns: Record<string, TypedArray> = Object.create(null);
  for (const m of meta.columns) {
    if (m.offset + m.length > buf.byteLength) {
      throw new Error(`decodeSlab: column "${m.name}" out of bounds`);
    }
    columns[m.name] = viewColumn(buf, m, rowCount);
  }

  // Columns the file left out are rebuilt here, so every kernel downstream
  // sees a complete slab and none of them know the difference.
  for (const [name, spec] of Object.entries(meta.constants ?? {})) {
    const rebuilt = allocColumn(spec.type, rowCount);
    rebuilt.fill(spec.value);
    columns[name] = rebuilt;
  }
  for (const [name, spec] of Object.entries(meta.derived ?? {})) {
    const a = columns[spec.from[0]];
    const b = columns[spec.from[1]];
    if (!a || !b) throw new Error(`decodeSlab: "${name}" needs ${spec.from.join(' and ')}`);
    const rebuilt = allocColumn(spec.type, rowCount);
    for (let i = 0; i < rowCount; i++) rebuilt[i] = a[i] + b[i];
    columns[name] = rebuilt;
  }

  return { rowCount, baseDayEpoch, columns, dicts: meta.dicts, byteLength: buf.byteLength };
}
