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
 * Matches how the wallet's existing dApp provider expects payloads. */
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

export async function deployContract({ bytecode, abi, codeHash, name, constructorArgs }) {
  const p = ensureConnected();
  if (!bytecode) throw new Error('deployContract: bytecode required');
  if (!abi) throw new Error('deployContract: abi required');
  if (!codeHash) throw new Error('deployContract: codeHash required');

  const args = {
    bytecodeHex: bytesToHex(bytecode),
    codeHash:    String(codeHash).replace(/^0x/, '').toLowerCase(),
    abi:         abi,
    name:        name || abi?.name || 'Contract',
  };
  // Constructor args — forwarded only when the contract's ABI
  // declared a constructor and the IDE collected values via the
  // pre-deploy preview modal. Walletside `buildOpFields('DC_DEPLOY')`
  // is the surface that renders these in the approval popup. Older
  // wallets that don't yet read this field will ignore it — the
  // contract still deploys, just without constructor params (the
  // same behavior as before the field existed).
  if (Array.isArray(constructorArgs) && constructorArgs.length > 0) {
    args.constructorArgs = constructorArgs;
  }

  // The wallet's dapp-preload exposes deployContract; this is a 1:1 pass-through.
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
