/* MoneroUSD IDE — boot module.
 *
 * Single ES module loaded at the end of index.html via:
 *   <script type="module" src="/app.js"></script>
 *
 * Responsibilities:
 *   1. Mobile-too-small splash (locked dark, locked desktop — see plan).
 *   2. Mount every chrome component (activity bar, side panel, plugin panel,
 *      tabs, editor, terminal, status bar, connect button, toast, modal, cmdk).
 *   3. Boot the connection store + provider detection.
 *   4. Register global keyboard shortcuts.
 *   5. Activate the default activity (Files) and load the current project.
 *   6. Wire data-action and data-activity click handlers.
 *
 * Per the plan's "no dead buttons" rule, every interactive element rendered
 * by index.html must reach a real handler — that wiring is centralized below.
 */

import * as store              from './lib/store.js';
import * as connectionStore    from './lib/connection-store.js';
import * as idb                from './lib/idb-projects.js';

import { mountToastSystem,    showToast }    from './components/toast.js';
import { mountModalSystem,    showModal,
         hideModal }                          from './components/modal.js';
import { mountCommandPalette, openCmdk,
         closeCmdk }                          from './components/command-palette.js';

import { mountActivityBar }    from './components/activity-bar.js';
import { mountSidePanel,
         setSidePanelContent } from './components/side-panel.js';
import { mountPluginPanel,
         setPluginPanelContent }              from './components/plugin-panel.js';
import { mountTabs,
         tabsApi }             from './components/tabs.js';
import { mountEditor,
         editorApi }           from './components/editor.js';
import { mountTerminal,
         terminalApi }         from './components/terminal.js';
import { mountStatusBar }      from './components/status-bar.js';
import { mountConnectButton }  from './components/connect-button.js';

import { activateActivity }    from './lib/router.js';

/* ─────────────────────────────────────────────────────────────────────────
   Debug hook — connection-store.js does a lazy lookup on this object.
   Surfacing the live store also makes inspection from DevTools trivial.
   ───────────────────────────────────────────────────────────────────────── */
window.__monerousd_ide_store = new Proxy({}, {
  get(_, key) { return store.getState()[key]; },
});

/* ─────────────────────────────────────────────────────────────────────────
   Public app shell: all DOM nodes the components mount onto.
   ───────────────────────────────────────────────────────────────────────── */
const dom = {
  app:         document.getElementById('app'),
  // tooSmall — removed in v1.2.182; chrome.css owns the responsive layout.
  // Top bar
  brand:       document.querySelector('.topbar-brand'),
  projectName: document.getElementById('project-name-input'),
  network:     document.getElementById('network-pill'),
  connectBtn:  document.getElementById('connect-btn'),
  // Activity bar
  activity:    document.querySelector('nav.activity'),
  // Side
  side:        document.querySelector('aside.side'),
  sideHeader:  document.getElementById('side-header-title'),
  sideContent: document.getElementById('side-content'),
  // Editor area
  tabs:        document.getElementById('tabs'),
  monacoHost:  document.getElementById('monaco-host'),
  editorEmpty: document.getElementById('editor-empty'),
  pageContent: document.getElementById('page-content'),
  fallback:    document.getElementById('editor-fallback'),
  fallbackTa:  document.getElementById('editor-fallback-textarea'),
  problems:    document.getElementById('problems-strip'),
  // Plugin
  plugin:      document.querySelector('aside.plugin'),
  pluginHead:  document.getElementById('plugin-header-title'),
  pluginBody:  document.getElementById('plugin-body'),
  // Terminal
  terminal:    document.getElementById('terminal'),
  terminalBody:document.getElementById('terminal-body'),
  terminalRes: document.getElementById('terminal-resize'),
  termFilter:  document.getElementById('terminal-filter-input'),
  termCountOut:document.getElementById('tcount-output'),
  termCountErr:document.getElementById('tcount-problems'),
  // Status
  statusDot:   document.getElementById('status-conn-dot'),
  statusText:  document.getElementById('status-conn-text'),
  statusFile:  document.getElementById('status-file'),
  statusCursor:document.getElementById('status-cursor'),
  statusSync:  document.getElementById('status-sync'),
  statusVersion:document.getElementById('status-version'),
  // Modals
  toastStack:  document.getElementById('toast-stack'),
  modalRoot:   document.getElementById('modal-root'),
  cmdkRoot:    document.getElementById('cmdk-root'),
};

/* ─────────────────────────────────────────────────────────────────────────
   Viewport gate — REMOVED in v1.2.182.
   The IDE now adapts to phones via chrome.css media queries (bottom-tab
   activity bar below 768 px, full-width side panel drawer, plugin panel
   auto-hides). The old "too-small-splash" was a hard block; it's gone.
   ───────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────
   Responsive collapse for plugin/side at narrower breakpoints.
   ───────────────────────────────────────────────────────────────────────── */
function applyResponsiveCollapse() {
  const w = window.innerWidth;
  // Below 1024 hide the plugin panel; below 900 collapse the side panel too.
  if (w < 1024) {
    setPluginCollapsed(true);
  }
  if (w < 900) {
    setSideCollapsed(true);
  }
}

function setSideCollapsed(v) {
  store.set('ui', { sideCollapsed: !!v });
  dom.app.dataset.sideCollapsed = String(!!v);
}

function setPluginCollapsed(v) {
  store.set('ui', { pluginCollapsed: !!v });
  dom.app.dataset.pluginCollapsed = String(!!v);
}

function setTerminalOpen(v) {
  store.set('ui', { terminalOpen: !!v });
  dom.app.dataset.terminalOpen = String(!!v);
  dom.terminal.dataset.hidden = String(!v);
}

/* ─────────────────────────────────────────────────────────────────────────
   Toast / modal / cmdk wiring.
   ───────────────────────────────────────────────────────────────────────── */
mountToastSystem(dom.toastStack);
mountModalSystem(dom.modalRoot);
mountCommandPalette(dom.cmdkRoot, {
  // Commands will register themselves via registerCommand() — see below.
  buildCommands: () => buildCommandList(),
});

// Make a tiny global helper for components that don't import toast directly.
window.__ide_toast = showToast;

/* ─────────────────────────────────────────────────────────────────────────
   Connection store — must boot BEFORE we render the connect button so the
   button reads the initial state.
   ───────────────────────────────────────────────────────────────────────── */
connectionStore.init();
mountConnectButton(dom.connectBtn);

/* ─────────────────────────────────────────────────────────────────────────
   Status bar.
   ───────────────────────────────────────────────────────────────────────── */
mountStatusBar({
  dot:     dom.statusDot,
  text:    dom.statusText,
  file:    dom.statusFile,
  cursor:  dom.statusCursor,
  sync:    dom.statusSync,
  version: dom.statusVersion,
});

/* ─────────────────────────────────────────────────────────────────────────
   Tabs + editor (Monaco) — editor is asynchronous because Monaco loads lazily.
   ───────────────────────────────────────────────────────────────────────── */
mountTabs(dom.tabs);

// Wire empty-state CTAs (delegated below) before the editor mount lands so a
// user clicking immediately after page load doesn't hit a noop.
let editorReady = false;
mountEditor({
  host:        dom.monacoHost,
  empty:       dom.editorEmpty,
  pageSlot:    dom.pageContent,
  fallback:    dom.fallback,
  fallbackTa:  dom.fallbackTa,
  problems:    dom.problems,
}).then(() => {
  editorReady = true;
}).catch((err) => {
  console.error('Editor failed to mount:', err);
  showToast({
    kind: 'error',
    title: 'Editor failed to load',
    body:  err?.message || 'Falling back to a plain textarea.',
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Terminal.
   ───────────────────────────────────────────────────────────────────────── */
mountTerminal({
  body:        dom.terminalBody,
  resizeHandle:dom.terminalRes,
  filterInput: dom.termFilter,
  countOut:    dom.termCountOut,
  countErr:    dom.termCountErr,
});

terminalApi().info('MoneroUSD IDE booted. Welcome.');

/* ─────────────────────────────────────────────────────────────────────────
   Plugin / side / activity bar — these read store state and re-render.
   ───────────────────────────────────────────────────────────────────────── */
mountSidePanel({
  panel:    dom.side,
  header:   dom.sideHeader,
  content:  dom.sideContent,
});
mountPluginPanel({
  panel:    dom.plugin,
  header:   dom.pluginHead,
  body:     dom.pluginBody,
});
mountActivityBar(dom.activity);

/* ─────────────────────────────────────────────────────────────────────────
   Project name input — debounced rename.
   ───────────────────────────────────────────────────────────────────────── */
let renameTimer = null;
dom.projectName.addEventListener('input', () => {
  const name = dom.projectName.value.trim() || 'Untitled project';
  store.set('project', { name });
  clearTimeout(renameTimer);
  renameTimer = setTimeout(async () => {
    const id = store.get('project').id;
    if (id) {
      try { await idb.updateProject(id, { name }); }
      catch (err) { console.warn('rename failed:', err); }
    }
  }, 500);
});

store.subscribe('project', (next) => {
  if (dom.projectName.value !== next.name) {
    dom.projectName.value = next.name;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   Delegated click handlers for any element with [data-action].
   ───────────────────────────────────────────────────────────────────────── */
document.addEventListener('click', (ev) => {
  const target = ev.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  switch (action) {
    case 'connect-wallet':    void connectionStore.connect().catch(showConnectError); return;
    case 'disconnect-wallet': void connectionStore.disconnect(); return;
    case 'toggle-side':       setSideCollapsed(!store.get('ui').sideCollapsed); return;
    case 'toggle-plugin':     setPluginCollapsed(!store.get('ui').pluginCollapsed); return;
    case 'toggle-terminal':   setTerminalOpen(!store.get('ui').terminalOpen); return;
    case 'terminal-clear':    terminalApi().clear(); return;
    case 'goto-home':         ev.preventDefault(); activateActivity('files'); return;
    case 'new-file':          newFilePrompt(); return;
    case 'open-cmdk':         openCmdk(); return;
    case 'compile-now':       triggerCompile(); return;
    case 'deploy-now':        activateActivity('deploy'); return;
    case 'open-templates':    activateActivity('templates'); return;
    case 'open-reference':    activateActivity('reference'); return;
    case 'open-settings':     activateActivity('settings'); return;
    case 'request-persist':   void requestPersist(); return;
    default:
      console.warn('Unhandled data-action:', action, target);
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   Activity bar clicks.

   Desktop: each tap activates the corresponding side-panel content,
   which lives in a permanent left column.

   Mobile (≤ 768 px): the side panel is a drawer overlaying the editor.
   Tapping a different activity tab swaps the drawer's content; tapping
   the SAME tab again closes the drawer. This matches the bottom-tab
   ergonomics every native iOS/Android app uses, and avoids the desktop
   model's "permanent sidebar" which doesn't fit a phone screen.

   We detect mobile via `matchMedia('(max-width: 768px)')` rather than
   reading window.innerWidth — the media query is always in sync with
   the chrome.css breakpoint and survives split-screen / resize events
   without re-binding.
   ───────────────────────────────────────────────────────────────────────── */
const mobileMQ = window.matchMedia('(max-width: 768px)');

function setSideMobileOpen(open) {
  if (!dom.side) return;
  if (open) dom.side.setAttribute('data-mobile-open', 'true');
  else      dom.side.removeAttribute('data-mobile-open');
}

dom.activity.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-activity]');
  if (!btn) return;
  const activity = btn.dataset.activity;
  const wasActive = btn.classList.contains('active');
  if (mobileMQ.matches) {
    // On mobile: tapping the same active tab closes the drawer; any
    // other tap opens the drawer + swaps content.
    const isOpen = dom.side?.getAttribute('data-mobile-open') === 'true';
    if (wasActive && isOpen) {
      setSideMobileOpen(false);
      return;
    }
    activateActivity(activity);
    setSideMobileOpen(true);
    return;
  }
  activateActivity(activity);
});

// On mobile, tapping the editor area (or the terminal) outside the
// drawer dismisses it — gesture parity with iOS sheet dismissal.
document.addEventListener('click', (ev) => {
  if (!mobileMQ.matches) return;
  if (dom.side?.getAttribute('data-mobile-open') !== 'true') return;
  if (ev.target.closest('.activity, .side, .topbar, #cmdk-root, #modal-root, #toast-stack')) return;
  setSideMobileOpen(false);
});

// Resize cleanup: leaving mobile mode while the drawer is open would
// leave the data attribute set, which is harmless on desktop but ugly
// in DevTools. Clear it on every breakpoint crossing.
mobileMQ.addEventListener('change', (ev) => {
  if (!ev.matches) setSideMobileOpen(false);
});

/* ─────────────────────────────────────────────────────────────────────────
   Terminal-tab clicks.
   ───────────────────────────────────────────────────────────────────────── */
document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('[data-terminal-tab]');
  if (!tab) return;
  const which = tab.dataset.terminalTab;
  store.set('ui', { terminalTab: which });
  document.querySelectorAll('.terminal-tab').forEach(b => {
    b.classList.toggle('active', b === tab);
  });
  terminalApi().setTab(which);
  // If terminal is collapsed, re-open on tab click.
  if (!store.get('ui').terminalOpen) setTerminalOpen(true);
});

/* ─────────────────────────────────────────────────────────────────────────
   Keyboard shortcuts.
   ───────────────────────────────────────────────────────────────────────── */
const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
const modKey = (ev) => isMac ? ev.metaKey : ev.ctrlKey;

window.addEventListener('keydown', (ev) => {
  // Esc ALWAYS closes any open cmdk / modal, regardless of where focus
  // currently lives. We check this first so the input-focus bailout
  // below doesn't swallow it — typing into the new-project name input
  // and hitting Esc must dismiss the modal even though the input has
  // focus. (See the keyboard-shortcuts e2e spec.)
  if (ev.key === 'Escape') {
    closeCmdk();
    hideModal();
    return;
  }

  // Block while command palette / modal is captured. Without a modifier
  // key, an input-focused keystroke is a literal character the user is
  // typing — we must not eat it as a global shortcut.
  if (document.activeElement?.matches?.('input, textarea, [contenteditable="true"]')
      && !ev.metaKey && !ev.ctrlKey) return;

  if (!modKey(ev)) return;

  // Cmd/Ctrl + S — save active file (forces a flush)
  if (ev.key === 's' && !ev.shiftKey) {
    ev.preventDefault();
    void editorApi().saveActive();
    return;
  }
  // Cmd/Ctrl + B — toggle side
  if (ev.key === 'b' && !ev.shiftKey) {
    ev.preventDefault();
    setSideCollapsed(!store.get('ui').sideCollapsed);
    return;
  }
  // Cmd/Ctrl + J — toggle terminal
  if (ev.key === 'j' && !ev.shiftKey) {
    ev.preventDefault();
    setTerminalOpen(!store.get('ui').terminalOpen);
    return;
  }
  // Cmd/Ctrl + Enter — compile
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    triggerCompile();
    return;
  }
  // Cmd/Ctrl + Shift + D — deploy activity
  if ((ev.key === 'd' || ev.key === 'D') && ev.shiftKey) {
    ev.preventDefault();
    activateActivity('deploy');
    return;
  }
  // Cmd/Ctrl + P — quick-open (file picker)
  if (ev.key === 'p' && !ev.shiftKey) {
    ev.preventDefault();
    openCmdk({ initialQuery: '' });
    return;
  }
  // Cmd/Ctrl + K — command palette
  if (ev.key === 'k' && !ev.shiftKey) {
    ev.preventDefault();
    openCmdk();
    return;
  }
  // Cmd/Ctrl + N — new file
  if (ev.key === 'n' && !ev.shiftKey) {
    ev.preventDefault();
    newFilePrompt();
    return;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   Compile trigger — defers to the compiler page module so we don't double-
   import the compiler.
   ───────────────────────────────────────────────────────────────────────── */
async function triggerCompile() {
  const mod = await import('./pages/compiler.js');
  await mod.compileNow();
}

/* ─────────────────────────────────────────────────────────────────────────
   New-file prompt — surfaces a modal asking for filename + extension.
   ───────────────────────────────────────────────────────────────────────── */
async function newFilePrompt() {
  const { promptForFilename } = await import('./pages/files.js');
  await promptForFilename();
}

/* ─────────────────────────────────────────────────────────────────────────
   Connect-error helper.
   ───────────────────────────────────────────────────────────────────────── */
function showConnectError(err) {
  const msg = err?.message || String(err);
  if (/no provider/i.test(msg) || /no monerousd/i.test(msg)) {
    showModal({
      title: 'Connect a MoneroUSD wallet',
      body: `<p>To deploy contracts and publish sites you need a MoneroUSD wallet.</p>
             <p>Install the <a href="https://monerousd.org/download" target="_blank" rel="noopener">desktop wallet</a> (recommended) or the <code>monerousd-chrome</code> extension, then refresh this page.</p>
             <p style="margin-top:var(--space-3); color:var(--text-muted); font-size:var(--fs-xs)">Reading, compiling, and local VM runs work without a wallet — only on-chain actions need one.</p>`,
      actions: [
        { label: 'OK', kind: 'primary', onClick: hideModal },
      ],
    });
  } else {
    showToast({ kind: 'error', title: 'Connect failed', body: msg });
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Persistent-storage permission prompt — best-effort, after first compile.
   ───────────────────────────────────────────────────────────────────────── */
let persistAsked = false;
async function requestPersist() {
  if (persistAsked) return;
  persistAsked = true;
  const granted = await idb.requestPersistentStorage();
  if (granted) {
    showToast({
      kind: 'success', title: 'Persistent storage enabled',
      body: 'Your projects will not be evicted when storage is tight.',
    });
  } else {
    showToast({
      kind: 'info', title: 'Persistent storage declined',
      body: 'Browser may evict the IDE\'s IndexedDB under storage pressure. Consider exporting projects with .dsproj.',
    });
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Command palette — registry of every command callable from Cmd+K.
   ───────────────────────────────────────────────────────────────────────── */
function buildCommandList() {
  return [
    { id: 'compile',        title: 'Compile current contract',
      shortcut: isMac ? '⌘ Enter' : 'Ctrl Enter',
      run: triggerCompile },
    { id: 'deploy',         title: 'Deploy on-chain (Deploy & Run activity)',
      shortcut: isMac ? '⌘⇧D' : 'Ctrl Shift D',
      run: () => activateActivity('deploy') },
    { id: 'run-local',      title: 'Run in local VM',
      run: () => activateActivity('run') },
    { id: 'connect',        title: 'Connect MoneroUSD wallet',
      run: () => connectionStore.connect().catch(showConnectError) },
    { id: 'disconnect',     title: 'Disconnect MoneroUSD wallet',
      run: () => connectionStore.disconnect() },
    { id: 'new-file',       title: 'New file…',
      shortcut: isMac ? '⌘N' : 'Ctrl N',
      run: newFilePrompt },
    { id: 'new-project',    title: 'New project…',
      run: async () => { const m = await import('./pages/files.js'); await m.promptForNewProject(); } },
    { id: 'open-templates', title: 'Open templates gallery',
      run: () => activateActivity('templates') },
    { id: 'open-reference', title: 'Open language reference',
      run: () => activateActivity('reference') },
    { id: 'open-settings',  title: 'Open settings',
      run: () => activateActivity('settings') },
    { id: 'export-project', title: 'Export project as .dsproj',
      run: async () => { const m = await import('./pages/files.js'); await m.exportProject(); } },
    { id: 'import-project', title: 'Import .dsproj…',
      run: async () => { const m = await import('./pages/files.js'); await m.importProject(); } },
    { id: 'toggle-side',    title: 'Toggle side panel',
      shortcut: isMac ? '⌘B' : 'Ctrl B',
      run: () => setSideCollapsed(!store.get('ui').sideCollapsed) },
    { id: 'toggle-terminal',title: 'Toggle terminal',
      shortcut: isMac ? '⌘J' : 'Ctrl J',
      run: () => setTerminalOpen(!store.get('ui').terminalOpen) },
    { id: 'clear-terminal', title: 'Clear terminal',
      run: () => terminalApi().clear() },
    { id: 'persist',        title: 'Request persistent storage',
      run: requestPersist },
    { id: 'about',          title: 'About MoneroUSD IDE',
      run: () => showModal({
        title: 'About MoneroUSD IDE',
        body:  `<p>Web IDE for the MoneroUSD chain — author DSOL contracts, run them in a browser-side DarkVM, deploy on-chain, and publish sovereign sites — all signed through your MoneroUSD wallet.</p>
                <p style="color:var(--text-muted); font-size:var(--fs-xs); margin-top:var(--space-3)">Version 1.2.181 · Open source · No CDN · No telemetry · No tracking.</p>`,
        actions: [{ label: 'OK', kind: 'primary', onClick: hideModal }],
      }),
    },
  ];
}

/* ─────────────────────────────────────────────────────────────────────────
   Initial route — open the Files activity, attempt to load the current
   project from IndexedDB, otherwise show the new-project / templates flow.
   ───────────────────────────────────────────────────────────────────────── */
applyResponsiveCollapse();

(async function bootInitialProject() {
  try {
    const id = idb.getCurrentProjectId();
    if (id) {
      const proj = await idb.getProject(id);
      if (proj) {
        store.set('project', {
          id: proj.id,
          name: proj.name,
          kind: proj.kind,
          activeFile: proj.activeFile,
          openFiles: proj.openFiles || [],
        });
        const files = await idb.listFiles(id);
        store.set('project', {
          files: files.map(f => ({ path: f.path, mtime: f.mtime })),
        });
        if (proj.activeFile) {
          await editorApi().openFile(proj.activeFile);
        }
        terminalApi().info(`Loaded project "${proj.name}" (${files.length} files)`);
      } else {
        idb.setCurrentProjectId(null);
      }
    }
  } catch (err) {
    console.error('Project boot failed:', err);
    terminalApi().error(`Project boot failed: ${err.message}`);
  }
  // Always activate the Files activity on first open. The page module reads
  // store state and renders accordingly (empty state ⇒ create/open templates).
  // `force: true` is required because the store's default `activeActivity`
  // is already `'files'`, so a non-forced call would short-circuit before
  // the page module's `activate()` ever ran — leaving `#side-content`
  // empty on a fresh boot.
  activateActivity('files', { force: true });
})();

/* ─────────────────────────────────────────────────────────────────────────
   Surface unhandled errors in the terminal (developers expect this).
   ───────────────────────────────────────────────────────────────────────── */
window.addEventListener('error', (ev) => {
  if (terminalApi) terminalApi().error(`Uncaught: ${ev.message}`);
});
window.addEventListener('unhandledrejection', (ev) => {
  if (terminalApi) terminalApi().error(`Unhandled rejection: ${ev.reason?.message || ev.reason}`);
});

/* eslint-disable no-unused-vars */
// Re-export some module surfaces on window for diagnostics + e2e access.
window.__monerousd_ide = {
  store,
  connectionStore,
  idb,
  showToast,
  showModal,
  editorApi,
  terminalApi,
  tabsApi,
  setSidePanelContent,
  setPluginPanelContent,
  activateActivity,
};
