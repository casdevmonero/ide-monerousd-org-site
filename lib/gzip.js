/* CompressionStream / DecompressionStream wrappers.
 * Site bundles are gzipped before SITE_PUBLISH so the on-chain rootHash + size
 * fields match what `backend/sites/bundle-store.js` stores. */

function toBlob(input) {
  if (input instanceof Blob) return input;
  if (input instanceof ArrayBuffer) return new Blob([input]);
  if (input instanceof Uint8Array) return new Blob([input]);
  if (typeof input === 'string') return new Blob([input], { type: 'text/plain' });
  throw new TypeError('gzip: unsupported input type');
}

export async function gzip(input) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream not available in this browser. Use Chrome/Edge/Brave/Arc/Firefox 102+.');
  }
  const blob = toBlob(input);
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function gunzip(input) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream not available.');
  }
  const blob = toBlob(input);
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
