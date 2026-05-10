/* Browser-side TAR pack/unpack — single-file implementation.
 *
 * Used for:
 *   • `.dsproj` export/import (project tarball, IDE-3 user-initiated only)
 *   • Site-publish bundle pre-gzip (deterministic ordering for SW-1)
 *
 * Format: ustar (POSIX tar). 512-byte header + file content padded to 512.
 * Reproducible: file list is sorted alphabetically; mtime + uid/gid forced to
 * 0 so the same input bytes produce the same output bytes (IDE-11 critical).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const BLOCK_SIZE = 512;

function pad(str, len, char = '\0') {
  if (str.length >= len) return str.slice(0, len);
  return str + char.repeat(len - str.length);
}

function octal(n, len) {
  // POSIX tar uses null-terminated zero-padded octal; len includes the null.
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function writeHeader(name, size, mode = 0o644, type = '0') {
  const buf = new Uint8Array(BLOCK_SIZE);
  const view = (offset, str) => {
    const bytes = enc.encode(str);
    buf.set(bytes.slice(0, str.length), offset);
  };
  // Long names not supported in this minimal impl — bail out.
  if (name.length > 99) {
    throw new Error(`tar: file path too long for ustar (max 99 chars): ${name}`);
  }
  view(0,   pad(name, 100));            // name
  view(100, pad(octal(mode, 8),  8));    // mode
  view(108, pad(octal(0, 8),     8));    // uid (forced 0)
  view(116, pad(octal(0, 8),     8));    // gid (forced 0)
  view(124, pad(octal(size, 12), 12));   // size
  view(136, pad(octal(0, 12),    12));   // mtime (forced 0 for reproducibility)
  // checksum bytes initially spaces:
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  buf[156] = type.charCodeAt(0);          // typeflag
  view(257, pad('ustar\0', 6));           // magic
  view(263, '00');                        // version
  view(265, pad('root', 32));             // uname
  view(297, pad('root', 32));             // gname

  // Compute checksum
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += buf[i];
  view(148, pad(octal(sum, 7), 7) + ' ');
  return buf;
}

function paddedLength(n) {
  return Math.ceil(n / BLOCK_SIZE) * BLOCK_SIZE;
}

/** Pack a list of {path, content} entries into a tarball.
 * - `content` is Uint8Array | string | ArrayBuffer.
 * - Output is deterministic: entries sorted by path, mtime/uid/gid zeroed. */
export function pack(entries) {
  const norm = entries.map(e => ({
    path: String(e.path).replace(/^\/+/, ''),
    content: typeof e.content === 'string' ? enc.encode(e.content)
            : e.content instanceof Uint8Array ? e.content
            : new Uint8Array(e.content),
    mode: e.mode ?? 0o644,
  }));
  norm.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const totalBytes =
    norm.reduce((s, e) => s + BLOCK_SIZE + paddedLength(e.content.length), 0)
    + BLOCK_SIZE * 2; // two zero blocks

  const out = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const e of norm) {
    out.set(writeHeader(e.path, e.content.length, e.mode), cursor);
    cursor += BLOCK_SIZE;
    out.set(e.content, cursor);
    cursor += paddedLength(e.content.length);
  }
  // Trailing two zero blocks already zero-initialized.
  return out;
}

/** Unpack a tarball into a list of {path, content}. */
export function unpack(buf) {
  const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
  const out = [];
  let cursor = 0;
  while (cursor < u8.length - BLOCK_SIZE) {
    const header = u8.subarray(cursor, cursor + BLOCK_SIZE);
    // End-of-archive: all-zero block.
    let allZero = true;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    const nameRaw = dec.decode(header.subarray(0, 100));
    const name = nameRaw.replace(/\0+$/, '');
    const sizeRaw = dec.decode(header.subarray(124, 136)).replace(/[\0\s]+/g, '');
    const size = parseInt(sizeRaw, 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 0x30);

    cursor += BLOCK_SIZE;
    if (typeflag === '0' || typeflag === '\0') {
      const content = u8.slice(cursor, cursor + size);
      // IDE-10 path-traversal guard: reject any '../' segments and absolute paths.
      if (name.split('/').some(seg => seg === '..') || name.startsWith('/')) {
        throw new Error(`tar: refusing path-traversal entry: ${name}`);
      }
      if (name) out.push({ path: name, content });
    }
    cursor += paddedLength(size);
  }
  return out;
}
