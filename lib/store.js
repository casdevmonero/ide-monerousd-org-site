/* Tiny pub/sub store. Single source of truth for app state.
 *
 * Why not Redux/Zustand/etc: the IDE has zero npm deps in production. The
 * store is small enough to inline. Any state mutation goes through `store.set`
 * which performs shallow-merge and notifies subscribers. Subscribers can listen
 * to a specific key path or to the whole store.
 *
 * Schema (all keys optional — components defensive-read):
 *   connection: {
 *     status: 'absent' | 'present' | 'connecting' | 'connected' | 'error',
 *     address: string | null,        // truncated stealth or full
 *     fullAddress: string | null,
 *     network: 'mainnet' | 'testnet' | 'unknown',
 *     error: string | null,
 *     transport: 'wallet-webview' | 'extension' | 'none',
 *   },
 *   project: {
 *     id: string,
 *     name: string,
 *     kind: 'contract' | 'site' | 'mixed',
 *     files: Array<{path, mtime}>,    // metadata only, contents in IDB
 *     activeFile: string | null,
 *     openFiles: string[],
 *     dirty: Set<string>,
 *   },
 *   compile: {
 *     status: 'idle' | 'compiling' | 'ok' | 'error',
 *     bytecode: Uint8Array | null,
 *     bytecodeHex: string | null,
 *     codeHash: string | null,
 *     abi: object | null,
 *     ast: object | null,
 *     sourceMap: object | null,
 *     errors: Array<{file, line, col, message}>,
 *     warnings: Array<{file, line, col, message}>,
 *     compiledAt: number,
 *     elapsedMs: number,
 *   },
 *   localVm: {
 *     state: any,
 *     events: Array,
 *     gasUsed: bigint,
 *     stepCount: number,
 *   },
 *   deployed: {
 *     contracts: Array<{contractId, version, codeHash, txHash, block, name, abi}>,
 *     active: string | null,
 *   },
 *   ui: {
 *     activeActivity: 'files' | 'compiler' | 'run' | 'deploy' | 'site-preview' | 'templates' | 'reference' | 'settings',
 *     terminalOpen: boolean,
 *     terminalTab: 'output' | 'problems',
 *     sideCollapsed: boolean,
 *     pluginCollapsed: boolean,
 *     pageActive: boolean,           // page-content slot showing instead of editor
 *   },
 *   settings: {
 *     indexerUrl: string,
 *     theme: 'dark',                 // locked
 *     keyBindings: 'default' | 'vim',
 *     autoCompile: boolean,
 *   }
 */

const initial = {
  connection: {
    status: 'absent',
    address: null,
    fullAddress: null,
    network: 'unknown',
    error: null,
    transport: 'none',
  },
  project: {
    id: null,
    name: 'Untitled project',
    kind: 'contract',
    files: [],
    activeFile: null,
    openFiles: [],
    dirty: new Set(),
  },
  compile: {
    status: 'idle',
    bytecode: null,
    bytecodeHex: null,
    codeHash: null,
    abi: null,
    ast: null,
    sourceMap: null,
    errors: [],
    warnings: [],
    compiledAt: 0,
    elapsedMs: 0,
  },
  localVm: {
    state: null,
    events: [],
    gasUsed: 0n,
    stepCount: 0,
  },
  deployed: {
    contracts: [],
    active: null,
  },
  ui: {
    activeActivity: 'files',
    terminalOpen: true,
    terminalTab: 'output',
    sideCollapsed: false,
    pluginCollapsed: false,
    pageActive: false,
  },
  settings: {
    indexerUrl: 'https://ion.monerousd.org',
    theme: 'dark',
    keyBindings: 'default',
    autoCompile: true,
  },
};

let state = structuredClone(structuredCloneSafe(initial));
const listeners = new Map();
let nextListenerId = 1;

/** Some types (Set, BigInt) don't survive structuredClone naively — wrap. */
function structuredCloneSafe(obj) {
  // structuredClone supports BigInt + Set natively in modern browsers.
  return obj;
}

export function getState() {
  return state;
}

export function get(key) {
  return state[key];
}

/** Shallow-merge top-level slice. Notifies subscribers of that slice's key
 * and the wildcard '*' subscribers. */
export function set(slice, patch) {
  if (!Object.prototype.hasOwnProperty.call(state, slice)) {
    throw new Error(`store.set: unknown slice "${slice}"`);
  }
  const prev = state[slice];
  const next = (typeof patch === 'function') ? patch(prev) : { ...prev, ...patch };
  state = { ...state, [slice]: next };
  notify(slice, next, prev);
  notify('*', state, null);
}

/** Replace a slice entirely (for reducer-style mutations). */
export function replace(slice, value) {
  if (!Object.prototype.hasOwnProperty.call(state, slice)) {
    throw new Error(`store.replace: unknown slice "${slice}"`);
  }
  const prev = state[slice];
  state = { ...state, [slice]: value };
  notify(slice, value, prev);
  notify('*', state, null);
}

/** Subscribe to a slice. Returns an unsubscribe function. */
export function subscribe(slice, fn) {
  const id = nextListenerId++;
  if (!listeners.has(slice)) listeners.set(slice, new Map());
  listeners.get(slice).set(id, fn);
  return () => {
    const m = listeners.get(slice);
    if (m) m.delete(id);
  };
}

function notify(slice, next, prev) {
  const m = listeners.get(slice);
  if (!m) return;
  for (const fn of m.values()) {
    try { fn(next, prev); }
    catch (err) { console.error(`store listener for "${slice}" threw:`, err); }
  }
}

/** Reset for tests. */
export function _resetForTest() {
  state = structuredClone(structuredCloneSafe(initial));
  listeners.clear();
}
