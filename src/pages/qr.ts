/**
 * A small QR code encoder for the setup page (§5.1 step 3). It turns a short link into the matrix
 * of a QR code, so a phone can scan the link from the screen. It follows ISO/IEC 18004: byte mode,
 * error correction level M, the smallest version from 1 to 10 that fits, and the mask with the
 * lowest penalty of the eight. The quiet zone is not part of the matrix: the drawing adds it.
 * It takes printable ASCII only, which is enough for a link.
 */

export interface QrCode {
  version: number;
  mask: number;
  /** One text per row, top to bottom. '1' is a dark square. No quiet zone. */
  rows: string[];
}

/** Error correction level M, by version: codewords per block for error correction, and the blocks. */
interface Layout {
  ecPerBlock: number;
  /** The number of data codewords of each block. */
  blocks: number[];
  /** The centres of the alignment patterns, on both axes. */
  align: number[];
}

const LAYOUTS: Record<number, Layout> = {
  1: { ecPerBlock: 10, blocks: [16], align: [] },
  2: { ecPerBlock: 16, blocks: [28], align: [6, 18] },
  3: { ecPerBlock: 26, blocks: [44], align: [6, 22] },
  4: { ecPerBlock: 18, blocks: [32, 32], align: [6, 26] },
  5: { ecPerBlock: 24, blocks: [43, 43], align: [6, 30] },
  6: { ecPerBlock: 16, blocks: [27, 27, 27, 27], align: [6, 34] },
  7: { ecPerBlock: 18, blocks: [31, 31, 31, 31], align: [6, 22, 38] },
  8: { ecPerBlock: 22, blocks: [38, 38, 39, 39], align: [6, 24, 42] },
  9: { ecPerBlock: 22, blocks: [36, 36, 36, 37, 37], align: [6, 26, 46] },
  10: { ecPerBlock: 26, blocks: [43, 43, 43, 43, 44], align: [6, 28, 50] },
};

export const QR_MAX_VERSION = 10;

/** The bits of level M in the format information. */
const LEVEL_M_BITS = 0b00;

function dataCapacity(version: number): number {
  return LAYOUTS[version]!.blocks.reduce((a, b) => a + b, 0);
}

/** The length field of byte mode has 8 bits up to version 9, and 16 bits from version 10. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** The most bytes that fit in a version, in byte mode at level M. */
export function qrMaxBytes(version: number): number {
  return Math.floor((dataCapacity(version) * 8 - 4 - countBits(version)) / 8);
}

// ---------------------------------------------------------------- Reed-Solomon over GF(256), polynomial 0x11D

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = result[i]! ^ gfMultiply(coef, factor)));
  }
  return result;
}

// ---------------------------------------------------------------- the codewords

function dataCodewords(bytes: number[], version: number): number[] {
  const capacityBits = dataCapacity(version) * 8;
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCapacity(version); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Splits the data into blocks, adds the error correction of each, and interleaves them. */
function allCodewords(data: number[], version: number): number[] {
  const layout = LAYOUTS[version]!;
  const divisor = rsDivisor(layout.ecPerBlock);
  const blocks: number[][] = [];
  const ecs: number[][] = [];
  let at = 0;
  for (const length of layout.blocks) {
    const block = data.slice(at, at + length);
    at += length;
    blocks.push(block);
    ecs.push(rsRemainder(block, divisor));
  }
  const out: number[] = [];
  const longest = Math.max(...layout.blocks);
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < layout.ecPerBlock; i++) for (const e of ecs) out.push(e[i]!);
  return out;
}

// ---------------------------------------------------------------- the matrix

class Matrix {
  readonly dark: boolean[][];
  readonly fixed: boolean[][];
  constructor(readonly size: number) {
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  /** Sets a square of a function pattern. x is the column, y the row. */
  set(x: number, y: number, dark: boolean): void {
    this.dark[y]![x] = dark;
    this.fixed[y]![x] = true;
  }
}

function drawFunctionPatterns(m: Matrix, version: number): void {
  const size = m.size;
  for (let i = 0; i < size; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        m.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = LAYOUTS[version]!.align;
  const last = align.length - 1;
  align.forEach((cx, i) => {
    align.forEach((cy, j) => {
      // No alignment pattern on the three finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) m.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  // The format information is drawn after the mask is chosen. Its squares are kept free here.
  drawFormat(m, 0);
  drawVersion(m, version);
}

/** The 15 bits of the format information: level M, the mask, BCH error correction, and the fixed XOR. */
export function formatBits(mask: number): number {
  const data = (LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(m: Matrix, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const size = m.size;
  for (let i = 0; i <= 5; i++) m.set(8, i, bit(i));
  m.set(8, 7, bit(6));
  m.set(8, 8, bit(7));
  m.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.set(8, size - 15 + i, bit(i));
  // The dark square that is always there.
  m.set(8, size - 8, true);
}

/** The 18 bits of the version information, from version 7 on. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawVersion(m: Matrix, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.set(a, b, dark);
    m.set(b, a, dark);
  }
}

/** Places the codewords in the zigzag order, two columns at a time, from the bottom right. */
function drawCodewords(m: Matrix, codewords: number[]): void {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    // The vertical timing pattern takes column 6.
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (m.fixed[y]![x]) continue;
        // The remainder bits after the last codeword stay light.
        if (i < codewords.length * 8) {
          m.dark[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m: Matrix, mask: number): void {
  const test = MASKS[mask]!;
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) if (!m.fixed[y]![x] && test(x, y)) m.dark[y]![x] = !m.dark[y]![x];
  }
}

/**
 * The penalty of a finished matrix, by the four rules of the standard: runs of five or more squares
 * of one colour, 2 by 2 blocks of one colour, the 1:1:3:1:1 pattern with four light squares on one
 * side, and the distance of the share of dark squares from one half.
 */
export function penalty(dark: boolean[][]): number {
  const size = dark.length;
  const at = (x: number, y: number, column: boolean) => (column ? dark[x]![y]! : dark[y]![x]!);
  let score = 0;
  for (const column of [false, true]) {
    for (let y = 0; y < size; y++) {
      let run = 1;
      let window = 0;
      for (let x = 0; x < size; x++) {
        const d = at(x, y, column);
        if (x > 0) {
          if (d === at(x - 1, y, column)) run++;
          else {
            if (run >= 5) score += 3 + (run - 5);
            run = 1;
          }
        }
        // The last 11 squares as bits. 10111010000 and 00001011101 are the finder-like patterns.
        window = ((window << 1) | (d ? 1 : 0)) & 0x7ff;
        if (x >= 10 && (window === 0x5d0 || window === 0x05d)) score += 40;
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const d = dark[y]![x]!;
      if (d === dark[y]![x + 1] && d === dark[y + 1]![x] && d === dark[y + 1]![x + 1]) score += 3;
    }
  }
  let darkCount = 0;
  for (const row of dark) for (const d of row) if (d) darkCount++;
  const percent = (darkCount * 100) / (size * size);
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);
  return score;
}

function build(codewords: number[], version: number, mask: number): Matrix {
  const m = new Matrix(17 + 4 * version);
  drawFunctionPatterns(m, version);
  drawCodewords(m, codewords);
  applyMask(m, mask);
  drawFormat(m, mask);
  return m;
}

/**
 * The QR code of a text. Without a mask, it tries all eight and keeps the one with the lowest
 * penalty, the first one on a tie. Throws on text that is not printable ASCII or does not fit.
 */
export function qrEncode(text: string, options: { mask?: number } = {}): QrCode {
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('A QR code here takes printable ASCII text only.');
  const bytes = Array.from(text, (c) => c.charCodeAt(0));
  let version = 1;
  while (version <= QR_MAX_VERSION && bytes.length > qrMaxBytes(version)) version++;
  if (version > QR_MAX_VERSION) {
    throw new Error(`The text is too long for a QR code here: ${bytes.length} characters, and at most ${qrMaxBytes(QR_MAX_VERSION)} fit.`);
  }
  if (options.mask !== undefined && !(Number.isInteger(options.mask) && options.mask >= 0 && options.mask <= 7)) {
    throw new Error('The mask is a whole number from 0 to 7.');
  }
  const codewords = allCodewords(dataCodewords(bytes, version), version);
  let best: { mask: number; m: Matrix; score: number } | undefined;
  for (const mask of options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask]) {
    const m = build(codewords, version, mask);
    const score = penalty(m.dark);
    if (best === undefined || score < best.score) best = { mask, m, score };
  }
  const chosen = best!;
  return { version, mask: chosen.mask, rows: chosen.m.dark.map((row) => row.map((d) => (d ? '1' : '0')).join('')) };
}
