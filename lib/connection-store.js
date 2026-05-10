/* Single source of truth for `window.monerousd` provider state.
 *
 * IDE-1: every chain-touching action goes through `window.monerousd`. This
 * module never holds keys, never signs locally — it only tracks whether the
 * provider is available and the connected stealth address.
 *
 * IDE-13: provider methods only invoked from `https://ide.monerousd.org` /
 *         `http://localhost:27752/ide.monerousd.org/`. Origin enforcement is
 *         on the WALLET side; we just trust the provider to enforce it.
 *
 * Two transport paths share the same `window.monerousd` interface:
 *   - wallet <webview> (preload script injects the provider)
 *   - monerousd-chrome extension (content script injects the provider)
 *
 * The IDE doesn't need to distinguish them for chain calls, but does report
 * the transport in status output for diagnostics.
 */

import { set, subscribe } from './store.js';

let provider = null;
let pollHandle = null;
let connectInflight = null;

const TRANSPORT_KEYS = {
  walletWebview: '__MONEROUSD_TRANSPORT_WALLET__',
  extension:     '__MONEROUSD_TRANSPORT_EXTENSION__',
};

/** Detect provider presence. Re-runs on storage/visibility events because the
 * extension can be installed mid-session and `window.monerousd` then appears. */
export function init() {
  detectProvider();

  // The provider may be injected late (extension install, webview late preload).
  // Poll every 600ms for up to 12s after page load, then back off.
  let tries = 0;
  pollHandle = setInterval(() => {
    detectProvider();
    if (++tries > 20 && getStatus() === 'present') {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    if (tries > 40) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }, 600);

  // Listen for explicit provider-ready events the wallet/extension dispatch.
  window.addEventListener('monerousd#initialized', () => detectProvider(), { once: false });
  window.addEventListener('monerousd#disconnected', () => set('connection', {
    status: provider ? 'present' : 'absent',
    address: null,
    fullAddress: null,
    error: null,
  }));
  window.addEventListener('monerousd#accountChanged', (ev) => {
    if (ev?.detail?.address) {
      set('connection', {
        status: 'connected',
        address: truncate(ev.detail.address),
        fullAddress: ev.detail.address,
        error: null,
      });
    }
  });
  window.addEventListener('monerousd#networkChanged', (ev) => {
    if (ev?.detail?.network) {
      set('connection', { network: ev.detail.network });
    }
  });
}

function detectProvider() {
  const p = window.monerousd ?? null;
  if (!p) {
    if (provider) {
      provider = null;
      set('connection', {
        status: 'absent',
        address: null,
        fullAddress: null,
        transport: 'none',
        error: null,
      });
    }
    return;
  }
  const transport = window[TRANSPORT_KEYS.walletWebview] ? 'wallet-webview'
                  : window[TRANSPORT_KEYS.extension]     ? 'extension'
                  : (p.__transport === 'wallet' ? 'wallet-webview' : 'extension');

  if (provider !== p) {
    provider = p;
    set('connection', {
      status: 'present',
      transport,
      error: null,
    });
    // Best-effort prior-session restore: ask the provider if there is already
    // a granted account (no popup). The wallet/extension may decline silently.
    tryGetAccountSilent();
  }
}

async function tryGetAccountSilent() {
  if (!provider?.getAddressSilent && !provider?.getAddress) return;
  try {
    const fn = provider.getAddressSilent ?? (() => null);
    const addr = await fn.call(provider);
    if (addr && typeof addr === 'string') {
      set('connection', {
        status: 'connected',
        address: truncate(addr),
        fullAddress: addr,
        error: null,
      });
    }
  } catch {
    // Silent failure: the user will click Connect explicitly.
  }
}

export function getProvider() {
  return provider;
}

export function getStatus() {
  return state().connection.status;
}

function state() { /* lazy import to avoid circular dep */
  // eslint-disable-next-line no-undef
  return window.__monerousd_ide_store ?? { connection: { status: 'absent' } };
}

export async function connect() {
  if (!provider) {
    set('connection', {
      status: 'absent',
      error: 'No MoneroUSD wallet detected. Install the desktop wallet or the monerousd-chrome extension.',
    });
    throw new Error('No provider');
  }
  if (connectInflight) return connectInflight;

  set('connection', { status: 'connecting', error: null });

  connectInflight = (async () => {
    try {
      // Provider's connect() returns the active stealth address.
      const result = await provider.connect();
      const address = (typeof result === 'string')
        ? result
        : (result?.address ?? null);
      if (!address) {
        throw new Error('Provider returned no address.');
      }
      set('connection', {
        status: 'connected',
        address: truncate(address),
        fullAddress: address,
        error: null,
      });
      return address;
    } catch (err) {
      const msg = err?.message || String(err);
      set('connection', {
        status: provider ? 'present' : 'absent',
        error: msg,
      });
      throw err;
    } finally {
      connectInflight = null;
    }
  })();
  return connectInflight;
}

export async function disconnect() {
  if (!provider) return;
  try {
    if (typeof provider.disconnect === 'function') {
      await provider.disconnect();
    }
  } catch {
    // Provider may not support explicit disconnect; we just forget locally.
  }
  set('connection', {
    status: provider ? 'present' : 'absent',
    address: null,
    fullAddress: null,
    error: null,
  });
}

export function subscribeConnection(fn) {
  return subscribe('connection', fn);
}

export function isConnected() {
  return state().connection.status === 'connected';
}

function truncate(addr) {
  if (!addr || typeof addr !== 'string') return addr;
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
