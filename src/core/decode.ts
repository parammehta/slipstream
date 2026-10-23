import {
  HEADER_BYTES,
  MAGIC,
  VERSION,
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

  return { rowCount, baseDayEpoch, columns, dicts: meta.dicts, byteLength: buf.byteLength };
}
