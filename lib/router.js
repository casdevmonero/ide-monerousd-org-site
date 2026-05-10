/* Activity router. Each activity owns the side-panel + plugin-panel content
 * and either the editor body OR the page-content slot.
 *
 * Activities:
 *   files         — file explorer (side); ABI / inspector (plugin); editor
 *   compiler      — compile errors / ABI viewer (side); deploy CTA (plugin); editor
 *   run           — local-VM run forms (side); state view (plugin); editor
 *   deploy        — connect status + deployed list (side); call form (plugin); editor
 *   site-preview  — site files (side); blob preview (plugin); editor
 *   templates     — categories (side); none; PAGE-CONTENT
 *   reference     — TOC (side); none; PAGE-CONTENT
 *   settings      — sections (side); none; PAGE-CONTENT
 *
 * Each activity module is a single import; router lazy-loads it on first
 * activation and caches the module reference.
 */

import * as store from './store.js';
import { setSidePanelContent } from '../components/side-panel.js';
import { setPluginPanelContent } from '../components/plugin-panel.js';

const cache = new Map(); // activity name → module
const usesPageContent = new Set(['templates', 'reference', 'settings']);
const HEADERS = {
  'files':        ['Files',         'Inspector'],
  'compiler':     ['Compiler',      'ABI · Bytecode'],
  'run':          ['Run (local VM)','Local state'],
  'deploy':       ['Deploy & Run',  'Deployed contracts'],
  'site-preview': ['Site files',    'Preview'],
  'templates':    ['Templates',     ''],
  'reference':    ['Reference',     ''],
  'settings':     ['Settings',      ''],
};

const SIDE_HEADER = document.getElementById('side-header-title');
const PLUGIN_HEADER = document.getElementById('plugin-header-title');
const APP = document.getElementById('app');
const EDITOR_EMPTY = document.getElementById('editor-empty');
const PAGE_CONTENT = document.getElementById('page-content');
const MONACO_HOST = document.getElementById('monaco-host');
// `.editor-fallback` is `position: absolute; inset: 0` so when the editor
// component has it visible (Monaco failed to mount), it overlays the
// page-content slot and intercepts every click. The editor component owns
// when it's shown via the `hidden` attribute; the router owns whether it's
// visible at all per activity. We toggle `style.display` here — restoring
// it to '' on editor activities lets the editor component's `hidden`
// attribute take effect again.
const EDITOR_FALLBACK = document.getElementById('editor-fallback');

const ACTIVITY_BUTTONS = () => Array.from(document.querySelectorAll('.activity-btn'));

/** Activate an activity. Idempotent: clicking the active activity is a no-op
 * unless force=true. */
export async function activateActivity(name, opts = {}) {
  if (!HEADERS[name]) {
    console.warn('Unknown activity:', name);
    return;
  }
  const cur = store.get('ui').activeActivity;
  if (cur === name && !opts.force) {
    return;
  }

  store.set('ui', { activeActivity: name, pageActive: usesPageContent.has(name) });
  APP.dataset.activeActivity = name;
  if (SIDE_HEADER)   SIDE_HEADER.textContent = HEADERS[name][0];
  if (PLUGIN_HEADER) PLUGIN_HEADER.textContent = HEADERS[name][1];

  // Update button visual state.
  for (const b of ACTIVITY_BUTTONS()) {
    b.classList.toggle('active', b.dataset.activity === name);
    b.setAttribute('aria-current', b.dataset.activity === name ? 'page' : 'false');
  }

  // Show/hide editor vs page-content based on activity kind.
  //
  // The `.page-content` element is hidden by default (CSS in editor.css)
  // and only made visible by the `[data-active="true"]` attribute selector
  // — that's where the fade-in animation hangs. We MUST drive visibility
  // through the attribute, not `style.display`, because once an inline
  // `display: none` is set it would beat the CSS rule on the next
  // activation.
  if (usesPageContent.has(name)) {
    if (MONACO_HOST)     MONACO_HOST.style.display     = 'none';
    if (EDITOR_EMPTY)    EDITOR_EMPTY.style.display    = 'none';
    if (EDITOR_FALLBACK) EDITOR_FALLBACK.style.display = 'none';
    if (PAGE_CONTENT)    PAGE_CONTENT.dataset.active   = 'true';
  } else {
    if (PAGE_CONTENT)    PAGE_CONTENT.dataset.active   = 'false';
    if (MONACO_HOST)     MONACO_HOST.style.display     = '';
    if (EDITOR_FALLBACK) EDITOR_FALLBACK.style.display = '';
    // editor-empty visibility is owned by the editor component (toggled when
    // there's no active model) — leave it alone. Likewise editor-fallback's
    // `hidden` attribute remains the editor component's source of truth;
    // clearing the inline `display` here just lifts our per-activity override.
  }

  // Lazy-load the page module.
  let mod = cache.get(name);
  if (!mod) {
    try {
      mod = await import(`../pages/${name}.js`);
      cache.set(name, mod);
    } catch (err) {
      console.error(`Failed to load activity "${name}":`, err);
      setSidePanelContent(`<div class="empty-state"><h3>Failed to load</h3><p>Activity <code>${name}</code> module failed: ${escapeHtml(err.message)}</p></div>`);
      return;
    }
  }

  // Each activity module exports an `activate({sideEl, pluginEl, pageEl})` fn.
  try {
    if (typeof mod.activate === 'function') {
      await mod.activate({
        sideEl:   document.getElementById('side-content'),
        pluginEl: document.getElementById('plugin-body'),
        pageEl:   PAGE_CONTENT,
      }, opts);
    }
  } catch (err) {
    console.error(`activate("${name}") threw:`, err);
    setSidePanelContent(`<div class="empty-state"><h3>Activate failed</h3><p>${escapeHtml(err.message)}</p></div>`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
