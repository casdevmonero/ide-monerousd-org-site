/* Compiler activity — invoke DSOL compiler in-page, surface errors + ABI.
 *
 * Side panel:    "Compile" CTA, errors / warnings, "Deploy on-chain" CTA
 * Plugin panel:  ABI viewer (functions / events / state), bytecode hex
 *
 * Auto-compile is wired in editor.js (debounced 600ms on edit). This module
 * also exposes `compileNow()` which app.js calls on Cmd/Ctrl + Enter and
 * cmdk's "Compile current contract" action.
 *
 * The compile result lives in `store.compile`. Diagnostics flow into:
 *   • Monaco model markers (red squiggles) via editorApi().setDiagnostics(...)
 *   • Terminal "Problems" tab via terminalApi().setProblems(...)
 *   • Activity-bar red dot (subscribed by activity-bar.js)
 *
 * IDE-9 — the "Deploy on-chain" CTA passes raw {bytecode, abi, codeHash} to
 * `provider.deployContract`; the wallet renders the approval modal. There is
 * no IDE-side approval renderer.
 */

import * as store from '../lib/store.js';
import { compileSource } from '../lib/dsol-compiler.js';
import { editorApi }     from '../components/editor.js';
import { terminalApi }   from '../components/terminal.js';
import { setSidePanelContent, setSideHeader }     from '../components/side-panel.js';
import { setPluginPanelContent, setPluginHeader } from '../components/plugin-panel.js';
import { showToast }     from '../components/toast.js';
import { activateActivity } from '../lib/router.js';
import { STDLIB }        from '../templates/manifest.js';

let activated = false;

export async function activate({ sideEl, pluginEl }) {
  if (!activated) {
    store.subscribe('compile', () => render());
    store.subscribe('project', (p, prev) => {
      if (p.activeFile !== prev?.activeFile) render();
    });
    activated = true;
  }
  setSideHeader('Compiler');
  setPluginHeader('ABI · Bytecode');
  render();
  // Try to compile the active file immediately so the user sees something.
  const p = store.get('project');
  if (p?.activeFile?.endsWith('.dsol')) {
    void compileNow().catch(err => terminalApi().error(`Compile: ${err.message}`));
  }
}

/* ─── Render ─────────────────────────────────────────────────────────── */

function render() {
  renderSide();
  renderPlugin();
}

function renderSide() {
  const c = store.get('compile');
  const p = store.get('project');
  const fileName = p.activeFile || '(no file)';
  const ext = (p.activeFile || '').split('.').pop()?.toLowerCase();
  const isDsol = ext === 'dsol';

  let statusBlock;
  if (!isDsol) {
    statusBlock = `<div class="compile-status idle">
      <div class="compile-headline">Open a <code>.dsol</code> file to compile</div>
      <div class="compile-sub">The compiler runs in-page and supports DSOL only.</div>
    </div>`;
  } else if (c.status === 'compiling') {
    statusBlock = `<div class="compile-status compiling">
      <div class="compile-pulse" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="compile-headline">Compiling ${escapeHtml(fileName)}…</div>
    </div>`;
  } else if (c.status === 'ok') {
    statusBlock = `<div class="compile-status ok">
      <div class="compile-headline">${ICON_CHECK} Compiled in ${c.elapsedMs} ms</div>
      <div class="compile-meta">
        <div><span>Bytecode</span><code>${(c.bytecode?.length ?? 0)} bytes</code></div>
        <div><span>codeHash</span><code title="${escapeAttr(c.codeHash || '')}">${truncMiddle(c.codeHash || '—', 10, 6)}</code></div>
        <div><span>Entrypoints</span><code>${c.abi?.entrypoints?.length ?? 0}</code></div>
      </div>
    </div>`;
  } else if (c.status === 'error') {
    statusBlock = `<div class="compile-status error">
      <div class="compile-headline">${ICON_X} Compile failed (${c.errors.length} error${c.errors.length === 1 ? '' : 's'})</div>
    </div>`;
  } else {
    statusBlock = `<div class="compile-status idle">
      <div class="compile-headline">Press ⌘ Enter to compile</div>
      <div class="compile-sub">Auto-compile runs after each edit.</div>
    </div>`;
  }

  let diagBlock = '';
  if (c.errors?.length || c.warnings?.length) {
    const items = [
      ...(c.errors || []).map(e => ({ ...e, kind: 'error' })),
      ...(c.warnings || []).map(w => ({ ...w, kind: 'warning' })),
    ];
    diagBlock = `
      <div class="diag-list">
        ${items.map(d => `
          <div class="diag-item diag-${d.kind}">
            <span class="diag-icon">${d.kind === 'error' ? ICON_X : ICON_BANG}</span>
            <div class="diag-body">
              <div class="diag-msg">${escapeHtml(d.message || 'Unknown error')}</div>
              <div class="diag-loc">${escapeHtml(d.file || fileName)}:${d.line || '?'}:${d.col || '?'}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  const conn = store.get('connection');
  const canDeploy = isDsol && c.status === 'ok' && conn.status === 'connected';
  const deployTitle = !isDsol
    ? 'Open a .dsol file to enable deploy'
    : c.status !== 'ok'
      ? 'Compile successfully first'
      : conn.status !== 'connected'
        ? 'Connect a MoneroUSD wallet first'
        : 'Deploy on-chain via your wallet';

  const html = `
    <div class="compiler-side">
      ${statusBlock}
      <div class="compiler-actions">
        <!-- Per IDE rule 10: button is always clickable. compileNow() shows a
             toast when no .dsol file is active rather than disabling. -->
        <button data-action="compile-now" class="btn btn-secondary btn-sm ${isDsol ? '' : 'soft'}" title="${isDsol ? 'Compile (⌘ Enter)' : 'Open a .dsol file to compile'}">
          ${ICON_HAMMER}<span>Compile</span>
          <kbd>⌘ Enter</kbd>
        </button>
        <button data-act="goto-deploy" class="btn btn-primary btn-md ${canDeploy ? '' : 'soft'}" title="${escapeAttr(deployTitle)}">
          ${ICON_CLOUD}<span>Deploy on-chain</span>
        </button>
      </div>
      ${diagBlock}
      <div class="compile-tips">
        <details>
          <summary>Tips</summary>
          <ul>
            <li>Click <em>Run (local VM)</em> to test against an in-memory DarkVM.</li>
            <li>Inheritance via <code>is Ownable</code> resolves from the bundled stdlib.</li>
            <li>Bytecode size is shown above; the chain accepts up to ~700 bytes per op.</li>
          </ul>
        </details>
      </div>
    </div>
  `;
  setSidePanelContent(html);

  const root = document.getElementById('side-content');
  if (!root) return;
  root.querySelector('[data-act="goto-deploy"]')?.addEventListener('click', () => activateActivity('deploy'));
}

function renderPlugin() {
  const c = store.get('compile');
  if (c.status !== 'ok' || !c.abi) {
    setPluginPanelContent(`
      <div class="plugin-empty">
        <p>Compile a contract to see its ABI here.</p>
      </div>
    `);
    return;
  }
  const abi = c.abi;
  const entries = abi.entrypoints || [];
  const events  = abi.events || [];
  const state   = abi.state || abi.stateVars || [];

  // Canonical ABI shape (lib/dsol-compiler.js, buildAbi):
  //   entrypoints[i] = { name, selector, batch, highRisk, returns, args }
  //   state[i]       = { name, kind, slot, private, valueType, keyType }
  //   events[i]      = { name, args }
  // The synthesized `@batch`/`@direct`/`@highrisk` tag strings here are
  // display-only — they don't exist on the underlying ABI object, so any
  // code that consumes the ABI elsewhere must read `fn.batch`/`fn.highRisk`
  // directly. See pages/deploy.js::renderCallCard for the same convention.
  const html = `
    <div class="abi-viewer">
      <details open>
        <summary>Entrypoints (${entries.length})</summary>
        ${entries.length
          ? `<ul class="abi-list">
              ${entries.map(fn => {
                const tags = [
                  fn.batch ? '@batch' : '@direct',
                  ...(fn.highRisk ? ['@highrisk'] : []),
                ];
                return `
                <li class="abi-item">
                  <div class="abi-sig">
                    <span class="abi-name">${escapeHtml(fn.name)}</span>
                    <span class="abi-params">(${(fn.args || []).map(a => `${escapeHtml(a.type)} ${escapeHtml(a.name)}`).join(', ')})</span>
                    ${fn.returns ? `<span class="abi-ret">→ ${escapeHtml(formatReturn(fn.returns))}</span>` : ''}
                  </div>
                  <div class="abi-tags">
                    ${tags.map(t => `<span class="abi-tag">${escapeHtml(t)}</span>`).join('')}
                  </div>
                </li>
              `;}).join('')}
            </ul>`
          : `<p class="abi-empty">No entrypoints declared.</p>`}
      </details>
      <details>
        <summary>State (${state.length})</summary>
        ${state.length
          ? `<ul class="abi-list">
              ${state.map(s => {
                const typeStr = s.kind === 'mapping'
                  ? `mapping(${s.keyType} => ${s.valueType})`
                  : (s.valueType || s.type || '');
                const visibility = s.private ? 'private' : 'public';
                return `
                <li class="abi-item">
                  <div class="abi-sig">
                    <span class="abi-name">${escapeHtml(s.name)}</span>
                    <span class="abi-params">: ${escapeHtml(typeStr)}</span>
                  </div>
                  <div class="abi-tags">
                    <span class="abi-tag">${escapeHtml(visibility)}</span>
                  </div>
                </li>
              `;}).join('')}
            </ul>`
          : `<p class="abi-empty">No state declared.</p>`}
      </details>
      <details>
        <summary>Events (${events.length})</summary>
        ${events.length
          ? `<ul class="abi-list">
              ${events.map(e => `
                <li class="abi-item">
                  <div class="abi-sig">
                    <span class="abi-name">${escapeHtml(e.name)}</span>
                    <span class="abi-params">(${(e.args || []).map(a => `${escapeHtml(a.type)} ${escapeHtml(a.name)}`).join(', ')})</span>
                  </div>
                </li>
              `).join('')}
            </ul>`
          : `<p class="abi-empty">No events declared.</p>`}
      </details>
      <details>
        <summary>Bytecode (${c.bytecode?.length ?? 0} bytes)</summary>
        <pre class="bytecode-hex"><code>${formatBytecode(c.bytecodeHex || '')}</code></pre>
      </details>
      <details>
        <summary>codeHash</summary>
        <pre class="bytecode-hex"><code>${escapeHtml(c.codeHash || '')}</code></pre>
      </details>
    </div>
  `;
  setPluginPanelContent(html);
}

/* ─── Compile entry point ─────────────────────────────────────────────── */

let compileToken = 0;

export async function compileNow() {
  const p = store.get('project');
  const file = p.activeFile;
  if (!file || !file.endsWith('.dsol')) {
    showToast({ kind: 'info', title: 'Nothing to compile', body: 'Open a .dsol file first.' });
    return;
  }
  const src = editorApi().getActiveContent() || '';
  if (!src.trim()) {
    showToast({ kind: 'warning', title: 'Empty source' });
    store.set('compile', {
      status: 'error',
      errors: [{ file, line: 1, col: 1, message: 'Source is empty.' }],
      warnings: [],
    });
    pushDiagnosticsToTerminal();
    return;
  }
  const myToken = ++compileToken;
  const start = performance.now();
  store.set('compile', { status: 'compiling' });
  let result, err;
  try {
    result = compileSource(src, { stdlibMap: STDLIB });
  } catch (e) {
    err = e;
  }
  if (myToken !== compileToken) return; // superseded by a later compile
  const elapsed = Math.round(performance.now() - start);
  if (err) {
    const parsed = parseCompileError(err, file);
    store.set('compile', {
      status: 'error',
      bytecode: null, bytecodeHex: null, codeHash: null,
      abi: null, ast: null, sourceMap: null,
      errors: parsed,
      warnings: [],
      compiledAt: Date.now(),
      elapsedMs: elapsed,
    });
    pushDiagnosticsToTerminal();
    pushDiagnosticsToMonaco();
    terminalApi().error(`Compile failed in ${elapsed}ms`);
    return;
  }
  const hex = bytesToHex(result.bytecode);
  store.set('compile', {
    status: 'ok',
    bytecode: result.bytecode,
    bytecodeHex: hex,
    codeHash: result.codeHash,
    abi: result.abi,
    ast: result.ast,
    sourceMap: result.sourceMap,
    errors: [],
    warnings: [],
    compiledAt: Date.now(),
    elapsedMs: elapsed,
  });
  pushDiagnosticsToTerminal();
  pushDiagnosticsToMonaco();
  // Reset Run / Deploy if the bytecode shape changed.
  store.set('localVm', { state: null, events: [], gasUsed: 0n, stepCount: 0 });
  terminalApi().success(`Compiled — bytecode ${result.bytecode.length} B, codeHash ${truncMiddle(result.codeHash, 8, 4)} (${elapsed} ms)`);
  // First-success persistent-storage hint.
  if (typeof window.__monerousd_ide?.requestPersist === 'function') {
    void window.__monerousd_ide.requestPersist();
  }
}

/* ─── Diagnostics plumbing ───────────────────────────────────────────── */

function pushDiagnosticsToTerminal() {
  const c = store.get('compile');
  const items = [
    ...(c.errors || []).map(e => ({ severity: 'error',   ...e })),
    ...(c.warnings || []).map(w => ({ severity: 'warning', ...w })),
  ];
  terminalApi().setProblems(items);
}

function pushDiagnosticsToMonaco() {
  const editor = editorApi();
  if (editor.mode() !== 'monaco') return;
  const p = store.get('project');
  if (!p.activeFile) return;
  const model = editor.getModel(p.activeFile);
  if (!model) return;
  const c = store.get('compile');
  if (c.errors?.length || c.warnings?.length) {
    editor.setDiagnostics(model, c.errors || [], c.warnings || []);
  } else {
    editor.clearDiagnostics(model);
  }
}

/* ─── Error parsing ──────────────────────────────────────────────────── */

function parseCompileError(err, file) {
  const msg = err?.message || String(err);
  // Pattern: "<msg> at line X col Y" or "<msg> (line X)"
  const m1 = msg.match(/(.*?)\s+at line\s+(\d+)\s+col\s+(\d+)/i);
  const m2 = msg.match(/(.*?)\s*\(line\s+(\d+)\)/i);
  if (m1) return [{ file, line: Number(m1[2]), col: Number(m1[3]), message: m1[1].trim() }];
  if (m2) return [{ file, line: Number(m2[2]), col: 1, message: m2[1].trim() }];
  return [{ file, line: 1, col: 1, message: msg }];
}

/* ─── Helpers ────────────────────────────────────────────────────────── */

function bytesToHex(bytes) {
  if (!bytes) return '';
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function truncMiddle(s, head, tail) {
  if (!s) return '—';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatBytecode(hex) {
  // Group into 16-byte rows: " 32 a1 ff ..." with offset.
  if (!hex) return '';
  const rows = [];
  for (let i = 0; i < hex.length; i += 32) {
    const row = hex.slice(i, i + 32);
    const pairs = row.match(/../g) || [];
    rows.push(`${(i / 2).toString(16).padStart(4, '0')}  ${pairs.join(' ')}`);
  }
  return rows.join('\n');
}

function formatReturn(r) {
  if (typeof r === 'string') return r;
  if (Array.isArray(r))      return r.map(x => x.type || x).join(', ');
  if (r?.type)               return r.type + (r.modifier ? ' ' + r.modifier : '');
  return JSON.stringify(r);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }

const ICON_CHECK  = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-11"/></svg>';
const ICON_X      = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const ICON_BANG   = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v9M12 18h.01"/></svg>';
const ICON_HAMMER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 21h10M14 3l7 7M10 7l4-4 7 7-4 4-7-7zM3 21l8-8"/></svg>';
const ICON_CLOUD  = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 16h2a4 4 0 0 0 0-8 6 6 0 0 0-11.6-1.5A4.5 4.5 0 0 0 7 16h2"/><path d="M12 12v9M9 18l3 3 3-3"/></svg>';
