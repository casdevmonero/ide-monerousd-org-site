/* Editor tabs. Multi-file tabs with drag-rearrange, dirty marker, close button.
 * State lives in store.project: { openFiles, activeFile, dirty }. */

import * as store from '../lib/store.js';

let stripEl = null;
let onActivate = null;
let onClose    = null;

export function mountTabs(el) {
  stripEl = el;
  store.subscribe('project', render);
  render(store.get('project'));

  // Delegated click handler.
  stripEl.addEventListener('click', (ev) => {
    const closeBtn = ev.target.closest('.tab-close');
    if (closeBtn) {
      ev.stopPropagation();
      onClose?.(closeBtn.dataset.path);
      return;
    }
    const tab = ev.target.closest('.tab');
    if (tab) onActivate?.(tab.dataset.path);
  });

  // Mouse-wheel horizontal scroll.
  stripEl.addEventListener('wheel', (ev) => {
    if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
      stripEl.scrollLeft += ev.deltaY;
      ev.preventDefault();
    }
  }, { passive: false });
}

function render(p) {
  if (!stripEl) return;
  if (!p.openFiles?.length) {
    stripEl.innerHTML = '';
    stripEl.dataset.empty = 'true';
    return;
  }
  stripEl.dataset.empty = 'false';
  const dirty = p.dirty instanceof Set ? p.dirty : new Set(p.dirty || []);

  stripEl.innerHTML = p.openFiles.map(path => {
    const isActive = (path === p.activeFile);
    const isDirty  = dirty.has(path);
    return `<div class="tab ${isActive ? 'active' : ''}"
                 role="tab"
                 aria-selected="${isActive}"
                 data-path="${escapeAttr(path)}"
                 title="${escapeAttr(path)}">
              <span class="tab-icon" aria-hidden="true">${pathIcon(path)}</span>
              <span class="tab-name">${escapeHtml(basename(path))}</span>
              ${isDirty ? '<span class="tab-dirty" aria-label="Modified">●</span>' : ''}
              <button class="tab-close" data-path="${escapeAttr(path)}" type="button" aria-label="Close ${escapeAttr(basename(path))}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>`;
  }).join('');
}

function basename(p) {
  return p.split('/').pop() || p;
}

function pathIcon(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'dsol') return '<svg viewBox="0 0 24 24" fill="none" stroke="#FF6600" stroke-width="2" aria-hidden="true"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/></svg>';
  if (ext === 'html') return '<svg viewBox="0 0 24 24" fill="none" stroke="#FF8833" stroke-width="1.5" aria-hidden="true"><path d="M4 4l1.5 16L12 22l6.5-2L20 4z"/></svg>';
  if (ext === 'css')  return '<svg viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.5" aria-hidden="true"><path d="M4 4l1.5 16L12 22l6.5-2L20 4z"/></svg>';
  if (ext === 'js' || ext === 'mjs') return '<svg viewBox="0 0 24 24" fill="none" stroke="#facc15" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  if (ext === 'md')   return '<svg viewBox="0 0 24 24" fill="none" stroke="#a0a0a0" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  if (ext === 'json') return '<svg viewBox="0 0 24 24" fill="none" stroke="#86efac" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/></svg>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }

/** Editor wires its callbacks here. */
export function tabsApi() {
  return {
    onActivate: (fn) => { onActivate = fn; },
    onClose:    (fn) => { onClose = fn; },
  };
}
