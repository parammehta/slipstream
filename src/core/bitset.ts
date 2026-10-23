/**
 * Bitsets over row ids. One bit per row keeps a 1M-row mask at 128KB, which
 * fits in L2 and makes intersecting several filters close to free.
 */

export function createBitset(rowCount: number): Uint32Array {
  return new Uint32Array((rowCount + 31) >>> 5);
}

/** Set bits [0, rowCount) and clear the padding bits in the final word. */
export function fillOnes(bs: Uint32Array, rowCount: number): Uint32Array {
  bs.fill(0xffffffff);
  const rem = rowCount & 31;
  if (rem !== 0 && bs.length > 0) {
    bs[bs.length - 1] = (((1 << rem) >>> 0) - 1) >>> 0;
  }
  return bs;
}

export function getBit(bs: Uint32Array, i: number): boolean {
  return ((bs[i >>> 5] >>> (i & 31)) & 1) === 1;
}

export function setBit(bs: Uint32Array, i: number): void {
  bs[i >>> 5] |= (1 << (i & 31)) >>> 0;
}

export function clearBit(bs: Uint32Array, i: number): void {
  bs[i >>> 5] &= ~((1 << (i & 31)) >>> 0);
}

/** Hamming weight of a 32-bit word (SWAR). */
function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function popcount(bs: Uint32Array): number {
  let total = 0;
  for (let w = 0; w < bs.length; w++) total += popcount32(bs[w]);
  return total;
}

export function andInto(target: Uint32Array, other: Uint32Array): void {
  for (let w = 0; w < target.length; w++) target[w] &= other[w];
}
