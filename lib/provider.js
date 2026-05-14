/* Typed wrapper around `window.monerousd`. Every chain-touching call is here.
 *
 * IDE-1: walletBroadcast() is the only path. Each provider method ends up
 *        invoking the wallet's main.js → broadcastAttestation → relay flow.
 *
 * IDE-9: never construct a custom approval modal. We pass arguments straight
 *        through; the wallet renders `buildOpFields('DC_DEPLOY' | …)`.
 *
 * Methods used:
 *   connect()
 *   getAddress() / getAddressSilent()
 *   deployContract({ bytecode, abi, codeHash, name? })
 *   callContract({ contractId, entrypoint, argv, mode })
 *   publishSite({ domain, bundleHex, bundleSize, rootHash, version, contentType })
 *   destroyContract({ contractId })
 *
 * Each call returns the wallet's RPC reply: usually `{ txHash, opHash, ... }`
 * or rejects with a structured error.
 */

import { getProvider, isConnected } from './connection-store.js';

class ProviderUnavailableError extends Error {
  constructor() {
    super('No MoneroUSD wallet detected. Install the desktop wallet or the monerousd-chrome extension.');
    this.name = 'ProviderUnavailableError';
  }
}

class NotConnectedError extends Error {
  constructor() {
    super('Wallet present but not connected. Click Connect MoneroUSD.');
    this.name = 'NotConnectedError';
  }
}

function ensureProvider() {
  const p = getProvider();
  if (!p) throw new ProviderUnavailableError();
  return p;
}

function ensureConnected() {
  const p = ensureProvider();
  if (!isConnected()) throw new NotConnectedError();
  return p;
}

/** Bytes/Uint8Array → lowercase hex without 0x prefix.
 * Used by site-publish + a few legacy paths. Newer DC ops use bytesToB64
 * because the wallet's `dapp-provider:deployContract` IPC expects
 * `bytecodeB64` (matches the backend bundle-store + dispatch path which
 * also speaks base64). */
export function bytesToHex(bytes) {
  if (!bytes) return '';
  if (typeof bytes === 'string') {
    return bytes.replace(/^0x/, '').toLowerCase();
  }
  const u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) {
    s += u8[i].toString(16).padStart(2, '0');
  }
  return s;
}

/** Bytes/Uint8Array → standard base64 (no URL-safe alphabet, no line breaks).
 * Browser-safe; no Buffer dependency. */
export function bytesToB64(bytes) {
  if (!bytes) return '';
  if (typeof bytes === 'string') {
    // Already a string — assume it's hex; convert hex→bytes→base64 so
    // upstream callers can keep passing whatever shape they have.
    const hex = bytes.replace(/^0x/, '');
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i*2, 2), 16);
    bytes = arr;
  }
  const u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export async function deployContract({ bytecode, abi, codeHash, name, constructorArgs }) {
  const p = ensureConnected();
  if (!bytecode) throw new Error('deployContract: bytecode required');
  if (!abi) throw new Error('deployContract: abi required');
  if (!codeHash) throw new Error('deployContract: codeHash required');

  // The wallet's `dapp-provider:deployContract` IPC (build-1261/main.js:5115)
  // requires exactly these field names:
  //
  //    bytecodeB64       base64-encoded raw bytecode
  //    abiJson           JSON-stringified ABI (string, not object)
  //    sourceHash        optional content hash (the IDE's codeHash)
  //    saltHex           optional deploy-side salt (we don't use it)
  //    constructorArgs   object (not array) — handler accepts {} or null
  //    stepLimit         number (default 1_000_000)
  //    memoryLimit       number (default 262_144)
  //
  // The OLDER {bytecodeHex, abi, codeHash, name} shape (pre-v1.2.213
  // IDE) is incompatible with current wallets and will fail with
  // "bytecodeB64 required". Test fixture:
  // tests/e2e/compile-deploy-popup.spec.js stubs the provider so this
  // mismatch wasn't caught until a real wallet round-trip.
  const args = {
    bytecodeB64: bytesToB64(bytecode),
    abiJson:     typeof abi === 'string' ? abi : JSON.stringify(abi),
    sourceHash:  String(codeHash).replace(/^0x/, '').toLowerCase(),
    saltHex:     '',
    constructorArgs: Array.isArray(constructorArgs)
      ? (constructorArgs.length ? { args: constructorArgs } : {})
      : (constructorArgs || {}),
    stepLimit:   1_000_000,
    memoryLimit: 262_144,
  };

  return await p.deployContract(args);
}

export async function callContract({ contractId, entrypoint, argv, mode }) {
  const p = ensureConnected();
  if (!contractId)  throw new Error('callContract: contractId required');
  if (!entrypoint)  throw new Error('callContract: entrypoint required');
  const callMode = mode || 'direct';
  if (!['direct', 'commit-reveal', 'commit', 'reveal'].includes(callMode)) {
    throw new Error(`callContract: invalid mode "${callMode}"`);
  }
  return await p.callContract({
    contractId: String(contractId),
    entrypoint: String(entrypoint),
    argv: Array.isArray(argv) ? argv : [],
    mode: callMode,
  });
}

export async function destroyContract({ contractId }) {
  const p = ensureConnected();
  if (!contractId) throw new Error('destroyContract: contractId required');
  if (typeof p.destroyContract !== 'function') {
    throw new Error('Wallet does not expose destroyContract. Update your wallet.');
  }
  return await p.destroyContract({ contractId: String(contractId) });
}

export async function publishSite({ domain, bundle, version, contentType }) {
  const p = ensureConnected();
  if (!domain)    throw new Error('publishSite: domain required');
  if (!bundle)    throw new Error('publishSite: bundle required');
  if (!version)   throw new Error('publishSite: version required');
  if (!contentType) throw new Error('publishSite: contentType required');
  if (typeof p.publishSite !== 'function') {
    throw new Error('Wallet does not expose publishSite. Update to v1.2.181 or newer.');
  }
  // Compute the rootHash so the wallet can show a stable preview.
  const { sha256 } = await import('./sha256.js');
  const rootHash = await sha256(bundle);
  return await p.publishSite({
    domain:      String(domain),
    bundleHex:   bytesToHex(bundle),
    bundleSize:  bundle.byteLength ?? bundle.length,
    rootHash:    rootHash,
    version:     String(version),
    contentType: String(contentType),
  });
}

export async function getAddress() {
  const p = ensureProvider();
  if (typeof p.getAddress !== 'function') {
    throw new Error('Wallet provider does not expose getAddress.');
  }
  return await p.getAddress();
}

/** Best-effort: returns null instead of throwing when not connected. */
export async function getAddressSilent() {
  const p = getProvider();
  if (!p) return null;
  try {
    if (typeof p.getAddressSilent === 'function') return await p.getAddressSilent();
    if (typeof p.getAddress === 'function') return await p.getAddress();
  } catch { /* ignore */ }
  return null;
}

export {
  ProviderUnavailableError,
  NotConnectedError,
};
