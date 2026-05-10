/* Settings activity — IDE preferences.
 *
 * Side panel:    section navigator (Indexer, Editor, Storage, Keyboard, About)
 * Page content:  settings forms for the active section
 *
 * All settings persist in `localStorage` under `monerousd-ide.settings.*`.
 * The store reads them on boot via `loadSettings()` (called from `app.js`).
 *
 * Locked at v1: theme = dark (light theme isn't built — would require re-shooting
 * the entire visual design + OG card).
 */

import * as store from '../lib/store.js';
import * as idb   from '../lib/idb-projects.js';
import { setSidePanelContent,
         setSideHeader }          from '../components/side-panel.js';
import { setPluginPanelContent,
         setPluginHeader }        from '../components/plugin-panel.js';
import { showToast }              from '../components/toast.js';
import { confirmModal }           from '../components/modal.js';

const SECTIONS = [
  { id: 'indexer',  label: 'Indexer',     blurb: 'Backend endpoint + connectivity' },
  { id: 'editor',   label: 'Editor',      blurb: 'Auto-compile, save, font size' },
  { id: 'storage',  label: 'Storage',     blurb: 'Persistent storage + project data' },
  { id: 'keyboard', label: 'Keyboard',    blurb: 'Shortcuts reference' },
  { id: 'about',    label: 'About',       blurb: 'Build, version, attestation' },
];

const SHORTCUTS = [
  { keys: ['⌘/Ctrl', 'S'],          desc: 'Save the active file' },
  { keys: ['⌘/Ctrl', 'B'],          desc: 'Toggle the side panel' },
  { keys: ['⌘/Ctrl', 'J'],          desc: 'Toggle the terminal panel' },
  { keys: ['⌘/Ctrl', 'Enter'],      desc: 'Compile the active DSOL contract' },
  { keys: ['⌘/Ctrl', 'Shift', 'D'], desc: 'Switch to Deploy & Run activity' },
  { keys: ['⌘/Ctrl', 'P'],          desc: 'Open the command palette' },
  { keys: ['⌘/Ctrl', 'K'],          desc: 'Open the command palette (alias)' },
  { keys: ['Esc'],                  desc: 'Close modal / dismiss command palette' },
];

let activated = false;
let activeSection = 'indexer';

export async function activate({ sideEl, pluginEl, pageEl }) {
  if (!activated) {
    activated = true;
  }
  setSideHeader('Settings');
  setPluginHeader('');
  renderSide();
  renderPage(pageEl);
}

/* ─── Persistence helpers ──────────────────────────────────────────────── */

const KEY = 'monerousd-ide.settings';

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const next = {
      indexerUrl:  typeof parsed.indexerUrl === 'string' ? parsed.indexerUrl : 'https://ion.monerousd.org',
      theme:       'dark',
      keyBindings: 'default',
      autoCompile: parsed.autoCompile !== false,
      fontSize:    Number(parsed.fontSize) >= 10 && Number(parsed.fontSize) <= 24 ? Number(parsed.fontSize) : 13,
    };
    store.set('settings', next);
  } catch {/* ignore */}
}

function saveSettings(patch) {
  store.set('settings', patch);
  try {
    const cur = store.get('settings');
    localStorage.setItem(KEY, JSON.stringify({
      indexerUrl:  cur.indexerUrl,
      autoCompile: cur.autoCompile,
      fontSize:    cur.fontSize,
    }));
  } catch {/* private mode etc. */}
}

/* ─── Side panel ──────────────────────────────────────────────────────── */

function renderSide() {
  const html = `
    <div class="settings-side">
      <nav class="settings-nav" role="list">
        ${SECTIONS.map(s => `
          <button class="settings-item${s.id === activeSection ? ' active' : ''}" type="button" data-section="${s.id}">
            <span class="label">${escapeHtml(s.label)}</span>
            <span class="blurb">${escapeHtml(s.blurb)}</span>
          </button>
        `).join('')}
      </nav>
    </div>
  `;
  setSidePanelContent(html);
  document.getElementById('side-content')?.querySelectorAll('[data-section]').forEach(b => {
    b.addEventListener('click', () => {
      activeSection = b.dataset.section;
      renderSide();
      renderPage(document.getElementById('page-content'));
    });
  });
}

/* ─── Page content ────────────────────────────────────────────────────── */

function renderPage(pageEl) {
  if (!pageEl) return;
  switch (activeSection) {
    case 'indexer':  return renderIndexerSection(pageEl);
    case 'editor':   return renderEditorSection(pageEl);
    case 'storage':  return renderStorageSection(pageEl);
    case 'keyboard': return renderKeyboardSection(pageEl);
    case 'about':    return renderAboutSection(pageEl);
    default:         return renderIndexerSection(pageEl);
  }
}

function renderIndexerSection(pageEl) {
  const cur = store.get('settings');
  pageEl.innerHTML = `
    <div class="page-section settings-page">
      <header class="page-header">
        <h1>Indexer</h1>
        <p>The Ion Swap indexer endpoint. Used to materialize <code>DC_DEPLOY</code> and <code>SITE_PUBLISH</code> ops, fetch contract state, and upload site bundles.</p>
      </header>
      <form class="settings-form" id="form-indexer">
        <div class="form-row">
          <label for="indexer-url">Indexer URL</label>
          <input id="indexer-url" type="url"
                 value="${escapeAttr(cur.indexerUrl || 'https://ion.monerousd.org')}"
                 placeholder="https://ion.monerousd.org" autocomplete="off" />
          <small class="hint">Default: <code>https://ion.monerousd.org</code>. Override only if running your own indexer.</small>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary" type="button" data-action="reset-indexer">Reset</button>
          <button class="btn btn-secondary" type="button" data-action="ping-indexer">Test connection</button>
          <button class="btn btn-primary"   type="submit">Save</button>
        </div>
        <div id="ping-result" class="form-result" hidden></div>
      </form>
    </div>
  `;

  const form = pageEl.querySelector('#form-indexer');
  const input = form.querySelector('#indexer-url');
  const result = pageEl.querySelector('#ping-result');

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = input.value.trim();
    if (!/^https?:\/\//i.test(v)) {
      showToast({ kind: 'warning', title: 'Invalid URL', body: 'Indexer URL must start with http:// or https://' });
      return;
    }
    saveSettings({ indexerUrl: v });
    showToast({ kind: 'success', title: 'Indexer URL saved', body: v });
  });

  pageEl.querySelector('[data-action="reset-indexer"]').addEventListener('click', () => {
    input.value = 'https://ion.monerousd.org';
    saveSettings({ indexerUrl: 'https://ion.monerousd.org' });
    showToast({ kind: 'info', title: 'Reset', body: 'Indexer URL reset to default.' });
  });

  pageEl.querySelector('[data-action="ping-indexer"]').addEventListener('click', async () => {
    const v = input.value.trim().replace(/\/$/, '');
    result.hidden = false;
    result.className = 'form-result muted';
    result.innerHTML = '<span class="spinner-dots"></span> Pinging…';
    try {
      const t0 = performance.now();
      const resp = await fetch(`${v}/v1/health`, { method: 'GET', cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      if (resp.ok) {
        result.className = 'form-result success';
        result.textContent = `✓ Reachable (${ms} ms · HTTP ${resp.status})`;
      } else {
        result.className = 'form-result warning';
        result.textContent = `! Reachable but returned HTTP ${resp.status} (${ms} ms)`;
      }
    } catch (err) {
      result.className = 'form-result error';
      result.textContent = `✗ Unreachable: ${err.message}`;
    }
  });
}

function renderEditorSection(pageEl) {
  const cur = store.get('settings');
  pageEl.innerHTML = `
    <div class="page-section settings-page">
      <header class="page-header">
        <h1>Editor</h1>
        <p>Editor and compile preferences.</p>
      </header>
      <form class="settings-form" id="form-editor">
        <div class="form-row">
          <label class="checkbox">
            <input type="checkbox" id="auto-compile" ${cur.autoCompile ? 'checked' : ''} />
            <span>Auto-compile DSOL on edit (debounced 600 ms)</span>
          </label>
        </div>
        <div class="form-row">
          <label for="font-size">Editor font size</label>
          <input type="number" id="font-size" min="10" max="24" step="1" value="${Number(cur.fontSize) || 13}" />
          <small class="hint">10-24 px. Applied on next file open.</small>
        </div>
        <div class="form-row">
          <label class="checkbox disabled">
            <input type="checkbox" disabled />
            <span>Vim keybindings <em class="muted">(coming in a later release)</em></span>
          </label>
        </div>
        <div class="form-row">
          <label class="checkbox disabled">
            <input type="checkbox" checked disabled />
            <span>Theme: dark <em class="muted">(locked at v1)</em></span>
          </label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Save</button>
        </div>
      </form>
    </div>
  `;
  pageEl.querySelector('#form-editor').addEventListener('submit', (ev) => {
    ev.preventDefault();
    saveSettings({
      autoCompile: pageEl.querySelector('#auto-compile').checked,
      fontSize:    Number(pageEl.querySelector('#font-size').value) || 13,
    });
    showToast({ kind: 'success', title: 'Editor settings saved' });
  });
}

function renderStorageSection(pageEl) {
  pageEl.innerHTML = `
    <div class="page-section settings-page">
      <header class="page-header">
        <h1>Storage</h1>
        <p>The IDE persists projects and files in <code>IndexedDB</code> (origin-scoped). Browsers may evict origin data under storage pressure — use Persistent storage to opt out.</p>
      </header>
      <section class="settings-card">
        <h3>Persistent storage</h3>
        <p id="persist-status" class="muted">Checking…</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="button" data-action="request-persist">Request persistent storage</button>
        </div>
      </section>
      <section class="settings-card">
        <h3>Storage estimate</h3>
        <p id="estimate" class="muted">Querying…</p>
      </section>
      <section class="settings-card danger-card">
        <h3>Danger zone</h3>
        <p>Delete all projects, files, and editor state. Cannot be undone.</p>
        <div class="form-actions">
          <button class="btn btn-danger" type="button" data-action="wipe-all">Erase all local IDE data</button>
        </div>
      </section>
    </div>
  `;

  const persistStatus = pageEl.querySelector('#persist-status');
  const estimate      = pageEl.querySelector('#estimate');

  (async () => {
    try {
      const persisted = await (navigator.storage?.persisted?.() ?? Promise.resolve(false));
      persistStatus.textContent = persisted
        ? '✓ Granted — your projects are protected from automatic eviction.'
        : 'Not granted — the browser may evict your projects under storage pressure.';
      persistStatus.className = persisted ? 'success' : 'muted';
    } catch {
      persistStatus.textContent = 'Browser does not expose persistent storage state.';
    }
    try {
      const est = await idb.storageEstimate();
      if (est) {
        const usedMb = est.usage ? (est.usage / (1024 * 1024)).toFixed(2) : '?';
        const quotaMb = est.quota ? (est.quota / (1024 * 1024)).toFixed(0) : '?';
        const pct = (est.usage && est.quota) ? Math.round((est.usage / est.quota) * 100) : '?';
        estimate.textContent = `Using ${usedMb} MB of ${quotaMb} MB (${pct}%).`;
      } else {
        estimate.textContent = 'Browser does not expose storage estimate API.';
      }
    } catch (err) {
      estimate.textContent = 'Could not query storage estimate.';
    }
  })();

  pageEl.querySelector('[data-action="request-persist"]').addEventListener('click', async () => {
    const ok = await idb.requestPersistentStorage();
    if (ok) {
      showToast({ kind: 'success', title: 'Persistent storage granted' });
      persistStatus.textContent = '✓ Granted — your projects are protected from automatic eviction.';
      persistStatus.className = 'success';
    } else {
      showToast({ kind: 'warning', title: 'Persistent storage declined', body: 'Some browsers only grant persistent storage to PWAs or after engagement signals. Try interacting with the IDE more, then retry.' });
    }
  });

  pageEl.querySelector('[data-action="wipe-all"]').addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Erase all local IDE data?',
      body:  'This deletes every project, file, deployed-contract list, and setting in this browser. Wallet keys are NOT affected (they live in your wallet, never here). This cannot be undone.',
      confirmLabel: 'Erase everything',
      cancelLabel:  'Cancel',
      danger: true,
    });
    if (!ok) return;
    try {
      // Drop the IDB database wholesale.
      await new Promise((res, rej) => {
        const req = indexedDB.deleteDatabase('monerousd-ide');
        req.onsuccess = res;
        req.onerror = () => rej(req.error);
        req.onblocked = () => rej(new Error('Close other tabs of the IDE first.'));
      });
      // Wipe all of our localStorage namespace.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('monerousd-ide.')) localStorage.removeItem(k);
      }
      showToast({ kind: 'success', title: 'Erased', body: 'Reload the page to start fresh.' });
    } catch (err) {
      showToast({ kind: 'error', title: 'Wipe failed', body: err.message });
    }
  });
}

function renderKeyboardSection(pageEl) {
  pageEl.innerHTML = `
    <div class="page-section settings-page">
      <header class="page-header">
        <h1>Keyboard shortcuts</h1>
        <p>Default key bindings.</p>
      </header>
      <table class="shortcuts-table">
        <thead><tr><th>Action</th><th>Shortcut</th></tr></thead>
        <tbody>
          ${SHORTCUTS.map(s => `<tr><td>${escapeHtml(s.desc)}</td><td>${s.keys.map(k => `<kbd>${escapeHtml(k)}</kbd>`).join(' + ')}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderAboutSection(pageEl) {
  const buildId = window.MONEROUSD_IDE_BUILD || 'dev';
  const origin  = window.location.origin;
  const transport = store.get('connection').transport || 'none';

  pageEl.innerHTML = `
    <div class="page-section settings-page">
      <header class="page-header">
        <h1>About MoneroUSD IDE</h1>
        <p>Build dark contracts. Publish sovereign sites. Strengthen the peg.</p>
      </header>
      <section class="settings-card about-card">
        <dl class="about-grid">
          <dt>Build</dt>
          <dd><code>${escapeHtml(String(buildId))}</code></dd>
          <dt>Origin</dt>
          <dd><code>${escapeHtml(origin)}</code></dd>
          <dt>Provider transport</dt>
          <dd>${escapeHtml(transport)}</dd>
          <dt>Storage</dt>
          <dd>IndexedDB (origin-scoped)</dd>
          <dt>License</dt>
          <dd>BSD-3-Clause</dd>
          <dt>Source</dt>
          <dd><a href="https://github.com/monerousd" target="_blank" rel="noopener">github.com/monerousd</a></dd>
        </dl>
      </section>
      <section class="settings-card">
        <h3>Canonical bundle anchor</h3>
        <p class="muted">
          The IDE bundle published to <code>ide.monerousd.org</code> is anchored on the USDm chain via
          <code>SITE_PUBLISH</code>. Whether you're viewing this page on the canonical site, on the
          desktop wallet's sovereign mirror, or on a self-hosted copy you run yourself, the chain
          anchor below is the source of truth for what bytes the canonical IDE serves.
        </p>
        <p id="sovereign-status" class="muted">Checking on-chain anchor for <code>ide.monerousd.org</code>…</p>
      </section>
      <section class="settings-card">
        <h3>Invariants</h3>
        <p>The IDE's safety properties (IDE-1 .. IDE-14) are enforced by static + runtime tests. See the project's <a href="#" data-action="open-invariants">CLAUDE.md</a>.</p>
      </section>
    </div>
  `;

  pageEl.querySelector('[data-action="open-invariants"]').addEventListener('click', (ev) => {
    ev.preventDefault();
    showToast({ kind: 'info', title: 'See CLAUDE.md', body: 'Bundled in the source repo at monerousd-ide/CLAUDE.md.' });
  });

  // Best-effort canonical-bundle anchor check. We always query the anchor
  // for the literal domain `ide.monerousd.org` regardless of where the user
  // loaded the IDE from — that's the bundle whose bytes are chain-anchored.
  // A self-hosted instance of the IDE has its OWN local origin (e.g.
  // http://localhost:8080), and that origin is not anchored on chain by
  // design — so showing the canonical bundle's anchor here is the right
  // reference point, not a per-origin claim.
  const statusEl = pageEl.querySelector('#sovereign-status');
  (async () => {
    try {
      const indexerUrl = store.get('settings').indexerUrl.replace(/\/$/, '');
      const resp = await fetch(`${indexerUrl}/v1/sites/ide.monerousd.org`, { method: 'GET', cache: 'no-store' });
      if (resp.ok) {
        const json = await resp.json().catch(() => null);
        if (json?.rootHash) {
          statusEl.className = 'success';
          statusEl.innerHTML = `✓ Canonical bundle anchored — rootHash <code>${escapeHtml(String(json.rootHash).slice(0, 16))}…</code> at version <code>${escapeHtml(String(json.version || ''))}</code>.`;
        } else {
          statusEl.textContent = `Indexer reachable but no anchor yet for ide.monerousd.org.`;
        }
      } else if (resp.status === 404) {
        statusEl.textContent = 'Canonical bundle not yet anchored on chain. The first SITE_PUBLISH for ide.monerousd.org seeds the recursive bootstrap.';
      } else {
        statusEl.textContent = `Indexer returned HTTP ${resp.status}.`;
      }
    } catch (err) {
      statusEl.textContent = `Indexer unreachable: ${err.message}`;
    }
  })();
}

/* ─── Helpers ────────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
