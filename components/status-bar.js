/* Status bar — connection pill, file path, cursor position, sync state, version.
 * Subscribes to the connection + project + ui store slices and re-renders on
 * change. */

import * as store from '../lib/store.js';

let dom = null;

export function mountStatusBar(els) {
  dom = els;
  store.subscribe('connection', renderConnection);
  store.subscribe('project',    renderProject);
  store.subscribe('compile',    renderCompile);
  renderConnection(store.get('connection'));
  renderProject(store.get('project'));
}

function renderConnection(c) {
  if (!dom?.dot || !dom?.text) return;
  let label = 'Disconnected';
  let cls = 'status-conn-dot';
  switch (c.status) {
    case 'connected':
      label = c.address ? `Connected · ${c.address}` : 'Connected';
      cls = 'status-conn-dot connected';
      break;
    case 'connecting':
      label = 'Connecting…';
      cls = 'status-conn-dot connecting';
      break;
    case 'present':
      label = 'Wallet detected';
      cls = 'status-conn-dot present';
      break;
    case 'error':
      label = `Error: ${c.error || 'unknown'}`;
      cls = 'status-conn-dot error';
      break;
    default:
      label = 'Disconnected';
      cls = 'status-conn-dot';
  }
  dom.dot.className = cls;
  dom.text.textContent = label;
}

function renderProject(p) {
  if (!dom?.file) return;
  if (p.activeFile) {
    dom.file.hidden = false;
    dom.file.textContent = p.activeFile;
  } else {
    dom.file.hidden = true;
    dom.file.textContent = '—';
  }
}

function renderCompile(c) {
  if (!dom?.sync) return;
  if (c.status === 'compiling') dom.sync.textContent = 'Compiling…';
  else if (c.status === 'ok')   dom.sync.textContent = `Compiled ${c.elapsedMs}ms · ${shortHash(c.codeHash)}`;
  else if (c.status === 'error')dom.sync.textContent = `${c.errors?.length ?? 1} error${c.errors?.length === 1 ? '' : 's'}`;
  else                          dom.sync.textContent = 'IndexedDB · ready';
}

function shortHash(h) {
  if (!h) return '';
  return h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

/* Editor cursor + total-line-count → status bar (called by editor.js).
 *
 * v1.2.182 — surface BOTH the cursor's `Ln,Col` AND the file's total
 * line count. Total lines is the most-asked-for status-bar metric in
 * any code editor (it's what tells you "is this file 50 lines or 2k?").
 *
 * `lines` is the active model's getLineCount(); `line`/`col` are the
 * 1-based cursor coordinates Monaco emits in its onDidChangeCursorPosition
 * event. We render `Ln 12 / 487 · Col 24` — the slash makes the
 * relationship clear without an extra status item.
 *
 * Older callers that only pass (line, col) keep working — `lines`
 * defaults to undefined and we fall back to the legacy "Ln X, Col Y"
 * format. */
export function setCursor(line, col, lines) {
  if (!dom?.cursor) return;
  dom.cursor.hidden = false;
  if (Number.isFinite(lines) && lines > 0) {
    dom.cursor.textContent = `Ln ${line} / ${lines} · Col ${col}`;
  } else {
    dom.cursor.textContent = `Ln ${line}, Col ${col}`;
  }
}

/** Hide the cursor / line-count item — called when no editor model is active. */
export function clearCursor() {
  if (dom?.cursor) dom.cursor.hidden = true;
}

export function setSyncText(text) {
  if (dom?.sync) dom.sync.textContent = text;
}
