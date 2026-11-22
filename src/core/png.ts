/**
 * Minimal PNG encoder (grayscale + RGB, lossless 1/2/4-bit indexed PLTE or 8-bit,
 * filter=None, single IDAT).
 * Pure Uint8Array — uses CompressionStream (Node 18+, Workers, browsers); no Buffer/node:zlib.
 */

// ---- CRC32 ---------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  if (customCrc32) return customCrc32(bytes) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Helpers -------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

const TYPE_BYTES = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeB = TYPE_BYTES(type);
  const crcSrc = concat([typeB, data]);
  return concat([u32be(data.length), typeB, data, u32be(crc32(crcSrc))]);
}

// ---- Runtime acceleration hook (edge-safe: zero node:* imports here) -----

export type DeflateZlibFn = (input: Uint8Array) => Uint8Array | Promise<Uint8Array>;
export type BytesToBase64Fn = (bytes: Uint8Array) => string;
export type Crc32Fn = (bytes: Uint8Array) => number;

let customDeflateZlib: DeflateZlibFn | null = null;
let customBytesToBase64: BytesToBase64Fn | null = null;
let customCrc32: Crc32Fn | null = null;

/**
 * Optional host hook to accelerate PNG deflate / CRC32 / base64 on runtimes
 * like Node (`node:zlib` async deflate + hardware crc32) without importing Node
 * built-ins into the Worker-safe core module. Pass `null` to restore defaults.
 */
export function configurePngRuntime(opts: {
  deflateZlib?: DeflateZlibFn | null;
  bytesToBase64?: BytesToBase64Fn | null;
  crc32?: Crc32Fn | null;
}): void {
  if ('deflateZlib' in opts) customDeflateZlib = opts.deflateZlib ?? null;
  if ('bytesToBase64' in opts) customBytesToBase64 = opts.bytesToBase64 ?? null;
  if ('crc32' in opts) customCrc32 = opts.crc32 ?? null;
}

// ---- Deflate via Web Streams (or registered host fast path) --------------

async function deflateZlib(input: Uint8Array): Promise<Uint8Array> {
  if (customDeflateZlib) return customDeflateZlib(input);
  // 'deflate' = RFC 1950 zlib-wrapped — what PNG IDAT needs. 'deflate-raw' (RFC 1951) would be wrong.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // TS 5.7 narrows Uint8Array<ArrayBufferLike> away from BufferSource; safe since we never use SharedArrayBuffer.
  void writer.write(input as Uint8Array<ArrayBuffer>);
  void writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

// ---- Encode --------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Prepend scanline filter byte 0 (None) to each row.
 *
 * Crisp bitmap and anti-aliased text has high-contrast glyph edges surrounded by flat
 * background runs. PNG Average filtering (type 3) smears those edges into multi-value
 * sawtooth residuals that bloat deflate by ~22-46% on rendered text pages and cost extra
 * per-pixel work. Filter None preserves exact byte runs for LZ77 match finding.
 */
function filterNone(pixels: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * stride;
    // out[dst] is already 0 (filter type None)
    out.set(pixels.subarray(src, src + rowBytes), dst + 1);
  }
  return out;
}

interface IndexedPack {
  bitDepth: 1 | 2 | 4;
  plte: Uint8Array;
  packed: Uint8Array;
}

/**
 * Pack a grayscale buffer into lossless 1/2/4-bit indexed PNG scanlines (filter=None)
 * when the image uses <= 16 distinct gray levels (typical for crisp bitmap + AA text).
 * Returns null when > 16 unique values appear, falling back to 8-bit grayscale.
 */
function packIndexedGray(pixels: Uint8Array, width: number, height: number): IndexedPack | null {
  const lut = new Int8Array(256).fill(-1);
  const palette: number[] = [];
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i]!;
    if (lut[v] === -1) {
      if (palette.length === 16) return null;
      lut[v] = palette.length;
      palette.push(v);
    }
  }
  const bitDepth: 1 | 2 | 4 = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : 4;
  const plte = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    const v = palette[i]!;
    plte[i * 3] = v;
    plte[i * 3 + 1] = v;
    plte[i * 3 + 2] = v;
  }
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const stride = rowBytes + 1;
  const packed = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * stride + 1; // byte at y * stride stays 0 (filter None)
    if (bitDepth === 1) {
      for (let x = 0; x < width; x++) {
        const idx = lut[pixels[src + x]!]!;
        if (idx) packed[dst + (x >> 3)]! |= 1 << (7 - (x & 7));
      }
    } else if (bitDepth === 2) {
      for (let x = 0; x < width; x++) {
        const idx = lut[pixels[src + x]!]!;
        if (idx) packed[dst + (x >> 2)]! |= idx << (6 - ((x & 3) << 1));
      }
    } else {
      // Pack two 4-bit pixels per byte (single store instead of two RMW ops per pair).
      const pairs = width & ~1;
      for (let x = 0; x < pairs; x += 2) {
        const hi = lut[pixels[src + x]!]!;
        const lo = lut[pixels[src + x + 1]!]!;
        const b = (hi << 4) | lo;
        if (b) packed[dst + (x >> 1)] = b;
      }
      if (pairs < width) {
        const hi = lut[pixels[src + pairs]!]!;
        if (hi) packed[dst + (pairs >> 1)] = hi << 4;
      }
    }
  }
  return { bitDepth, plte, packed };
}

/**
 * Pack an RGB (3 bytes/pixel) buffer into lossless 1/2/4-bit indexed PNG scanlines
 * (filter=None) when the image uses <= 16 distinct RGB colors. Returns null otherwise.
 */
function packIndexedRgb(pixels: Uint8Array, width: number, height: number): IndexedPack | null {
  const map = new Map<number, number>();
  const palette: number[] = [];
  for (let i = 0; i < pixels.length; i += 3) {
    const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!;
    if (!map.has(key)) {
      if (palette.length === 16) return null;
      map.set(key, palette.length);
      palette.push(key);
    }
  }
  const bitDepth: 1 | 2 | 4 = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : 4;
  const plte = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    const key = palette[i]!;
    plte[i * 3] = (key >> 16) & 0xff;
    plte[i * 3 + 1] = (key >> 8) & 0xff;
    plte[i * 3 + 2] = key & 0xff;
  }
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  const stride = rowBytes + 1;
  const packed = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 3;
    const dst = y * stride + 1;
    for (let x = 0; x < width; x++) {
      const p = srcRow + x * 3;
      const idx = map.get((pixels[p]! << 16) | (pixels[p + 1]! << 8) | pixels[p + 2]!)!;
      if (!idx) continue;
      if (bitDepth === 1) {
        packed[dst + (x >> 3)]! |= 1 << (7 - (x & 7));
      } else if (bitDepth === 2) {
        packed[dst + (x >> 2)]! |= idx << (6 - ((x & 3) << 1));
      } else {
        packed[dst + (x >> 1)]! |= idx << (4 - ((x & 1) << 2));
      }
    }
  }
  return { bitDepth, plte, packed };
}

async function encodeIndexedPng(width: number, height: number, pack: IndexedPack): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = pack.bitDepth;
  ihdr[9] = 3; // colorType 3 = indexed-color (PLTE); bytes 10-12 already zero

  const compressed = await deflateZlib(pack.packed);

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', pack.plte),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Encode a single-channel (grayscale) buffer as PNG bytes. pixels is row-major, length = width × height. */
export async function encodeGrayPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height) {
    throw new Error(`encodeGrayPng: pixels.length=${pixels.length} != ${width}×${height}=${width * height}`);
  }
  const indexed = packIndexedGray(pixels, width, height);
  if (indexed) return encodeIndexedPng(width, height, indexed);

  // IHDR: width(4) height(4) bitDepth=8 colorType=0(gray) compress=0 filter=0 interlace=0
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // colorType 0 = grayscale; bytes 10-12 already zero

  const compressed = await deflateZlib(filterNone(pixels, width, height, 1));

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Encode an RGB (3 bytes/pixel, R,G,B) buffer as PNG bytes. length = width × height × 3. */
export async function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height * 3) {
    throw new Error(`encodeRgbPng: pixels.length=${pixels.length} != ${width}×${height}×3=${width * height * 3}`);
  }
  const indexed = packIndexedRgb(pixels, width, height);
  if (indexed) return encodeIndexedPng(width, height, indexed);

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth per channel
  ihdr[9] = 2; // colorType 2 = truecolor RGB; bytes 10-12 already zero

  const compressed = await deflateZlib(filterNone(pixels, width, height, 3));

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Base64-encode bytes. Uses Buffer on Node/Bun (~140x faster), falls back to chunked btoa on edge/browsers. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (customBytesToBase64) return customBytesToBase64(bytes);
  const B = (globalThis as { Buffer?: { from: (buf: ArrayBufferLike, offset: number, len: number) => { toString: (enc: 'base64') => string } } }).Buffer;
  if (B) return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
