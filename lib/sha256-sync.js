/* Synchronous SHA-256 (FIPS 180-4) — pure JS, browser-safe.
 *
 * The IDE's local-VM Run path (`lib/vm.js::execute`) is synchronous,
 * so SubtleCrypto.digest (async) is unusable. SHA-256 is a hot path
 * in the VM (OP.SHA256, OP.MAP_LOAD, OP.MAP_STORE, entrypointSelector),
 * and Web Workers add CSP / message-passing complexity without payoff
 * for short DSOL contracts — so we vendor a small sync implementation
 * here.
 *
 * Implementation is a straight FIPS-180-4 reference. Tested against
 * NIST CAVS vectors plus the `node:crypto` outputs from the backend
 * VM in `tests/unit/sha256-sync.test.js`.
 *
 * NOT a constant-time implementation. Do not use for keystream /
 * HMAC against attacker-controlled inputs that need timing-side-
 * channel resistance — for those, use SubtleCrypto.digest in async
 * code paths.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

function sha256Sync(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError('sha256Sync: input must be string|Uint8Array|ArrayBuffer|TypedArray');
  }

  const bitLen = BigInt(bytes.length) * 8n;
  // Padding: append 0x80, then 0x00 bytes until length ≡ 56 (mod 64),
  // then 8-byte big-endian bit-length.
  const padLen = (bytes.length % 64 < 56)
    ? 56 - (bytes.length % 64)
    : 120 - (bytes.length % 64);
  const padded = new Uint8Array(bytes.length + padLen + 8);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // 8-byte BE bit length at end.
  for (let i = 0; i < 8; i++) {
    padded[padded.length - 1 - i] = Number((bitLen >> BigInt(i * 8)) & 0xffn);
  }

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(chunk + i * 4, false); // big-endian
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false);
  return out;
}

/** Hex string of the SHA-256 digest. */
function sha256SyncHex(input) {
  const d = sha256Sync(input);
  let s = '';
  for (let i = 0; i < d.length; i++) s += d[i].toString(16).padStart(2, '0');
  return s;
}

/** Multi-update API mimicking node:crypto.createHash('sha256').update(...).digest().
 * Useful for the (rare) places where the backend VM chains multiple `.update()`
 * calls before a single `.digest()`. */
function createSha256() {
  const chunks = [];
  let totalLen = 0;
  return {
    update(input) {
      let bytes;
      if (typeof input === 'string') bytes = new TextEncoder().encode(input);
      else if (input instanceof Uint8Array) bytes = input;
      else bytes = new Uint8Array(input);
      chunks.push(bytes);
      totalLen += bytes.length;
      return this;
    },
    digest() {
      const merged = new Uint8Array(totalLen);
      let p = 0;
      for (const c of chunks) { merged.set(c, p); p += c.length; }
      return sha256Sync(merged);
    },
  };
}

export { sha256Sync, sha256SyncHex, createSha256 };
