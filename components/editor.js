/* Editor shell — Monaco mount + textarea fallback.
 *
 * Loads Monaco's ESM bundle from `/lib/monaco/monaco.esm.js`. If that import
 * fails (Monaco not yet vendored, or asset 404), we fall back to a single-file
 * textarea editor — no Monaco features, but multi-file editing still works.
 *
 * Public API:
 *   await mountEditor({ host, empty, pageSlot, fallback, fallbackTa, problems })
 *   editorApi() => {
 *     openFile(path),
 *     closeFile(path),
 *     saveActive(),
 *     getActiveContent(),
 *     getActiveLanguage(),
 *     setContent(path, content),
 *     focus(),
 *     getMonaco(),
 *     getModel(path),
 *   }
 *
 * The page modules call `editorApi().getActiveContent()` to feed the compiler.
 */

import * as store          from '../lib/store.js';
import * as idb             from '../lib/idb-projects.js';
import { setCursor, clearCursor } from './status-bar.js';
import { registerDsolLanguage, setAst, setDiagnostics, clearDiagnostics } from '../lib/dsol-language.js';
import { tabsApi }          from './tabs.js';

let monaco = null;
let editor = null;
let dom    = null;
let mode   = 'pending'; // 'monaco' | 'fallback' | 'pending'
const models = new Map();   // path → IModel | { value }

const TYPELESS_PLACEHOLDER = `// Welcome to MoneroUSD IDE
// Start by opening a template (left activity bar → Templates) or creating a new file.

dark contract Counter {
  private uint64 count;

  @batch
  entry increment() {
    count = count + 1;
  }

  @direct
  entry getCount() returns (uint64 when revealed) {
    return count;
  }
}
`;

/** Load Monaco; on failure, fall back to a textarea editor. */
export async function mountEditor(els) {
  dom = els;
  try {
    await loadMonaco();
    mountMonaco();
    mode = 'monaco';
  } catch (err) {
    console.warn('Monaco unavailable; using textarea fallback.', err);
    mountFallback();
    mode = 'fallback';
  }

  // Wire tabs callbacks.
  tabsApi().onActivate(async (path) => {
    await openFile(path);
  });
  tabsApi().onClose((path) => {
    void closeFile(path);
  });

  showEmptyIfNoFiles();
  return mode;
}

/* ─── Monaco ─── */

async function loadMonaco() {
  // v1.2.182 — load Monaco via its AMD bundle (`vs/loader.js`), not via
  // `import()` of an ESM bundle.
  //
  // Why AMD: Monaco's source is full of `import './foo.css';` statements
  // that browsers' native ES modules reject (CSS imports require an
  // `assert { type: 'css' }` and Monaco doesn't do that). Bundlers
  // (webpack/rollup/esbuild) transparently handle these, but we don't
  // run a bundler — IDE-4 says everything is vendored, and adding a
  // bundle step would put the IDE on a long build pipeline. Monaco's
  // AMD bundle ships pre-built with its own loader that injects <link>
  // tags for every CSS file as it resolves modules. This is what every
  // other Monaco-using site does without webpack.
  //
  // Stub Monaco's web workers (IDE-6 — no 'unsafe-eval'). The
  // DefaultWorkerFactory expects a Worker constructor; an inert object
  // satisfies the interface and language services run main-thread.
  window.MonacoEnvironment = {
    getWorker() {
      return {
        postMessage() {},
        addEventListener() {},
        removeEventListener() {},
        terminate() {},
        onmessage: null,
        onerror: null,
      };
    },
  };

  // 1) Load vs/loader.js via a <script> tag (it self-installs on window).
  //    Same-origin path — the IDE-4 guard test (no-cdn) confirms.
  await new Promise((resolve, reject) => {
    if (window.require && typeof window.require.config === 'function') {
      // Loader already on the page (e.g., test re-mount).
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = '/lib/monaco/vs/loader.js';
    s.async = false;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('Monaco AMD loader failed to load'));
    document.head.appendChild(s);
  });

  // 2) Point the AMD loader at the vendored vs/ tree.
  window.require.config({ paths: { vs: '/lib/monaco/vs' } });

  // 3) Load editor.main and wait for the AMD callback.
  await new Promise((resolve, reject) => {
    window.require(
      ['vs/editor/editor.main'],
      () => resolve(),
      (err) => reject(new Error('Monaco require(editor.main) failed: ' + (err?.message || err))),
    );
  });

  // editor.main installs a global `window.monaco` namespace. Capture it
  // for the rest of this module.
  if (!window.monaco || !window.monaco.editor) {
    throw new Error('Monaco loaded but window.monaco.editor is missing');
  }
  monaco = window.monaco;
}

function mountMonaco() {
  registerDsolLanguage(monaco);

  editor = monaco.editor.create(dom.host, {
    value: '',
    language: 'dsol',
    theme: 'monerousd-dark',
    automaticLayout: true,
    fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    fontLigatures: true,
    minimap: { enabled: false },
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    padding: { top: 14, bottom: 14 },
    bracketPairColorization: { enabled: true },
    guides: {
      indentation: true,
      bracketPairs: true,
    },
    tabSize: 2,
    insertSpaces: true,
    wordWrap: 'off',
  });

  // Cursor → status bar.
  // v1.2.182 surfaces total-line-count alongside Ln/Col so the user
  // always knows how big the file is without scrolling. We pass the
  // current model's getLineCount() at the moment the cursor moves;
  // it's a constant-time call on Monaco's piece-table model.
  //
  // Edge cases the explorer flagged in the v1.2.183 audit:
  //   - On the very first model attach the cursor position can be null
  //     (Monaco hasn't placed a caret yet). Default to Ln 1 / Col 1
  //     instead of bailing — otherwise the status item stays hidden
  //     forever until the user clicks into the editor.
  //   - When the active file closes / project is dropped, clear the
  //     cursor item explicitly so the status bar doesn't show stale
  //     coordinates from a model that no longer exists.
  const reportCursor = () => {
    const m = editor.getModel();
    const lines = m ? m.getLineCount() : 0;
    const pos = editor.getPosition();
    const line = pos ? pos.lineNumber : 1;
    const col  = pos ? pos.column     : 1;
    if (!m || lines === 0) {
      clearCursor();
      return;
    }
    setCursor(line, col, lines);
  };
  editor.onDidChangeCursorPosition(reportCursor);
  editor.onDidChangeModel(reportCursor);
  // Initial paint — Monaco fires neither cursor nor model events on the
  // empty initial state, so kick the status bar once explicitly to land
  // a "Ln 1 / 1 · Col 1" the moment a file is opened.
  reportCursor();

  editor.onDidChangeModelContent(() => {
    // Insertions/deletions change the line count — re-emit so the
    // status bar's "Ln X / N" stays accurate without a cursor move.
    reportCursor();

    const p = store.get('project');
    if (!p.activeFile) return;
    const dirty = p.dirty instanceof Set ? new Set(p.dirty) : new Set(p.dirty || []);
    dirty.add(p.activeFile);
    store.set('project', { dirty });
    debouncedAutoSave(p.activeFile);
    debouncedAutoCompile();
  });
}

/* ─── Fallback ─── */

function mountFallback() {
  if (dom.fallback) dom.fallback.hidden = false;
  if (dom.host)     dom.host.style.display = 'none';
  dom.fallbackTa.addEventListener('input', () => {
    const p = store.get('project');
    if (!p.activeFile) return;
    models.set(p.activeFile, { value: dom.fallbackTa.value });
    const dirty = p.dirty instanceof Set ? new Set(p.dirty) : new Set(p.dirty || []);
    dirty.add(p.activeFile);
    store.set('project', { dirty });
    debouncedAutoSave(p.activeFile);
    debouncedAutoCompile();
  });
  dom.fallbackTa.addEventListener('keyup', () => {
    const ta = dom.fallbackTa;
    const before = ta.value.slice(0, ta.selectionStart);
    const lines = before.split('\n');
    setCursor(lines.length, lines.at(-1).length + 1);
  });
}

/* ─── Public API ─── */

async function openFile(path) {
  if (!path) return;
  const p = store.get('project');
  let openFiles = Array.isArray(p.openFiles) ? [...p.openFiles] : [];
  if (!openFiles.includes(path)) openFiles.push(path);

  // Load content from IDB if we don't already have a model.
  let content = '';
  if (!models.has(path)) {
    if (p.id) {
      const f = await idb.readFile(p.id, path).catch(() => null);
      content = f?.content ?? '';
    }
  } else if (mode === 'fallback') {
    content = models.get(path)?.value ?? '';
  }

  if (mode === 'monaco') {
    let m = models.get(path);
    if (!m) {
      const lang = languageFromPath(path);
      const uri  = monaco.Uri.parse(`inmemory://project/${encodeURIComponent(path)}`);
      m = monaco.editor.createModel(content, lang, uri);
      models.set(path, m);
    }
    editor.setModel(m);
  } else {
    if (!models.has(path)) models.set(path, { value: content });
    dom.fallbackTa.value = models.get(path).value;
  }

  store.set('project', { openFiles, activeFile: path });
  showEmptyIfNoFiles();
}

async function closeFile(path) {
  const p = store.get('project');
  const openFiles = (p.openFiles || []).filter(x => x !== path);
  // Save before closing if dirty.
  const dirty = p.dirty instanceof Set ? p.dirty : new Set(p.dirty || []);
  if (dirty.has(path)) {
    await saveFile(path);
    dirty.delete(path);
  }

  let activeFile = p.activeFile;
  if (activeFile === path) {
    activeFile = openFiles.at(-1) || null;
  }
  store.set('project', { openFiles, activeFile, dirty });

  // Dispose Monaco model.
  if (mode === 'monaco') {
    const m = models.get(path);
    if (m && typeof m.dispose === 'function') m.dispose();
    models.delete(path);
  } else {
    models.delete(path);
  }

  if (activeFile) {
    await openFile(activeFile);
  } else if (mode === 'monaco') {
    editor.setModel(null);
    showEmptyIfNoFiles();
  } else {
    dom.fallbackTa.value = '';
    showEmptyIfNoFiles();
  }
}

async function saveActive() {
  const p = store.get('project');
  if (!p.activeFile) return;
  await saveFile(p.activeFile);
}

async function saveFile(path) {
  const p = store.get('project');
  if (!p.id) return;  // No project yet — caller should create one first.
  const content = (mode === 'monaco')
    ? models.get(path)?.getValue() ?? ''
    : models.get(path)?.value ?? dom.fallbackTa.value;
  await idb.writeFile(p.id, path, content);
  const dirty = p.dirty instanceof Set ? new Set(p.dirty) : new Set(p.dirty || []);
  dirty.delete(path);
  store.set('project', { dirty });
}

function getActiveContent() {
  const p = store.get('project');
  if (!p.activeFile) return '';
  if (mode === 'monaco') return models.get(p.activeFile)?.getValue() ?? '';
  return models.get(p.activeFile)?.value ?? dom.fallbackTa.value;
}

function getActiveLanguage() {
  const p = store.get('project');
  if (!p.activeFile) return 'plaintext';
  return languageFromPath(p.activeFile);
}

async function setContent(path, content) {
  if (mode === 'monaco') {
    let m = models.get(path);
    if (!m) {
      const lang = languageFromPath(path);
      const uri  = monaco.Uri.parse(`inmemory://project/${encodeURIComponent(path)}`);
      m = monaco.editor.createModel(content, lang, uri);
      models.set(path, m);
    } else {
      m.setValue(content);
    }
  } else {
    models.set(path, { value: content });
    if (store.get('project').activeFile === path) dom.fallbackTa.value = content;
  }
  const p = store.get('project');
  if (p.id) await idb.writeFile(p.id, path, content);
}

function focus() {
  if (mode === 'monaco' && editor) editor.focus();
  else if (mode === 'fallback') dom.fallbackTa.focus();
}

function getMonaco() { return monaco; }
function getModel(path) { return models.get(path); }

/* ─── Helpers ─── */

function languageFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'dsol': return 'dsol';
    case 'html': return 'html';
    case 'css':  return 'css';
    case 'js':
    case 'mjs':  return 'javascript';
    case 'ts':   return 'typescript';
    case 'json': return 'json';
    case 'md':   return 'markdown';
    case 'txt':  return 'plaintext';
    default:     return 'plaintext';
  }
}

function showEmptyIfNoFiles() {
  if (!dom?.empty || !dom?.host) return;
  const hasFiles = (store.get('project').openFiles || []).length > 0;
  if (!hasFiles) {
    dom.empty.style.display = '';
    dom.host.style.visibility = 'hidden';
    if (dom.fallback) dom.fallbackTa.style.visibility = 'hidden';
  } else {
    dom.empty.style.display = 'none';
    dom.host.style.visibility = '';
    if (dom.fallback) dom.fallbackTa.style.visibility = '';
  }
}

/* ─── Auto-save + auto-compile ─── */

let autoSaveTimer = null;
function debouncedAutoSave(path) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => { void saveFile(path); }, 500);
}

let autoCompileTimer = null;
function debouncedAutoCompile() {
  if (!store.get('settings').autoCompile) return;
  const lang = getActiveLanguage();
  if (lang !== 'dsol') return;
  clearTimeout(autoCompileTimer);
  autoCompileTimer = setTimeout(async () => {
    try {
      const mod = await import('../pages/compiler.js');
      await mod.compileNow();
    } catch (err) {
      console.warn('auto-compile failed:', err);
    }
  }, 600);
}

/* ─── Public API factory ─── */

export function editorApi() {
  return {
    openFile,
    closeFile,
    saveActive,
    saveFile,
    getActiveContent,
    getActiveLanguage,
    setContent,
    focus,
    getMonaco,
    getModel,
    setAst:         (uri, ast) => mode === 'monaco' && setAst(monaco, uri, ast),
    setDiagnostics: (model, errors, warnings) => mode === 'monaco' && setDiagnostics(monaco, model, errors, warnings),
    clearDiagnostics:(model)  => mode === 'monaco' && clearDiagnostics(monaco, model),
    mode:           () => mode,
  };
}
