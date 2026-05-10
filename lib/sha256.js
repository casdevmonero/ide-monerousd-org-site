/* SubtleCrypto wrapper. Used by publish-site flow + compiler codeHash + tests.
 * Browser-only; for the CLI / Node mirrors the wallet uses node:crypto. */

const enc = new TextEncoder();

function toBytes(input) {
  if (input == null) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return enc.encode(input);
  throw new TypeError('sha256: unsupported input type');
}

function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

/** SHA-256 hex string. */
export async function sha256(input) {
  const data = toBytes(input);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(buf));
}

/** SHA-256 raw bytes. */
export async function sha256Bytes(input) {
  const data = toBytes(input);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(buf);
}
