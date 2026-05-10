/* Bytes ↔ hex helpers — browser substitute for `Buffer.from(...).toString('hex')`
 * and the inverse, plus a handful of tiny utilities used across vm.js,
 * tar.js, and the provider hex-encoder.
 *
 * Pure synchronous code, no dependencies.
 */

const HEX = '0123456789abcdef';

export function bytesToHex(b) {
  if (b == null) return '';
  const u8 = (b instanceof Uint8Array) ? b
           : (b instanceof ArrayBuffer) ? new Uint8Array(b)
           : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
           : null;
  if (!u8) throw new TypeError('bytesToHex: input must be Uint8Array|ArrayBuffer|TypedArray');
  let s = '';
  for (let i = 0; i < u8.length; i++) {
    const v = u8[i];
    s += HEX[(v >> 4) & 0xf];
    s += HEX[v & 0xf];
  }
  return s;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string') throw new TypeError('hexToBytes: input must be string');
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex string');
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = stripped.charCodeAt(i * 2);
    const lo = stripped.charCodeAt(i * 2 + 1);
    out[i] = (parseHex(hi) << 4) | parseHex(lo);
  }
  return out;
}

function parseHex(code) {
  // 0..9
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  // a..f
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  // A..F
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  throw new Error('hexToBytes: invalid hex character');
}

export function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; }
  return out;
}

export function utf8(s) { return new TextEncoder().encode(String(s)); }
export function utf8Decode(b) { return new TextDecoder().decode(b); }

/** Constant-time equality of two Uint8Array. */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i] ^ b[i];
  return acc === 0;
}
