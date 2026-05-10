/* Reference activity — bundled docs rendered inline.
 *
 * Side panel:    document switcher + auto-generated TOC for the active doc
 * Page content:  rendered Markdown of the selected doc
 *
 * Docs are bundled at build time into `monerousd-ide/reference/`:
 *   • LANGUAGE.md         — DSOL syntax + semantics (build-1261/dark-contracts/)
 *   • PROTOCOL-DC-V1.md   — DC_DEPLOY / DC_CALL_* / DC_DESTROY ABI
 *   • PROTOCOL-SITES-V1.md— SITE_PUBLISH / SITE_TRANSFER / SITE_REVOKE ABI
 *
 * Loaded lazily via fetch (same-origin static assets — no CDN).
 */

import * as store from '../lib/store.js';
import { setSidePanelContent,
         setSideHeader }          from '../components/side-panel.js';
import { setPluginPanelContent,
         setPluginHeader }        from '../components/plugin-panel.js';
import { showToast }              from '../components/toast.js';
import { render as renderMarkdown } from '../lib/markdown.js';

const DOCS = [
  {
    id: 'language',
    label: 'DSOL Language',
    blurb: 'Syntax, types, modifiers, syscalls.',
    path:  'reference/LANGUAGE.md',
  },
  {
    id: 'dc-protocol',
    label: 'Dark Contracts ABI',
    blurb: 'DC_DEPLOY / DC_CALL_* / DC_DESTROY on-chain ops.',
    path:  'reference/PROTOCOL-DC-V1.md',
  },
  {
    id: 'sites-protocol',
    label: 'Sovereign Sites ABI',
    blurb: 'SITE_PUBLISH / SITE_TRANSFER / SITE_REVOKE on-chain ops.',
    path:  'reference/PROTOCOL-SITES-V1.md',
  },
  {
    id: 'changelog',
    label: 'Changelog',
    blurb: 'IDE release notes.',
    path:  'reference/CHANGELOG.md',
  },
];

let activated = false;
let activeDocId = 'language';
let cachedHtml = new Map(); // id → { html, toc }

export async function activate({ sideEl, pluginEl, pageEl }) {
  if (!activated) {
    activated = true;
  }
  setSideHeader('Reference');
  setPluginHeader('');
  await loadAndRender(pageEl);
}

async function loadAndRender(pageEl) {
  const doc = DOCS.find(d => d.id === activeDocId) || DOCS[0];

  // Render the side panel first with a "loading" TOC so layout is stable.
  renderSide(doc, []);
  if (!pageEl) return;
  pageEl.innerHTML = `<div class="page-section"><div class="reference-loading"><div class="spinner-dots"></div> Loading ${escapeHtml(doc.label)}…</div></div>`;

  let entry = cachedHtml.get(doc.id);
  if (!entry) {
    try {
      const url = new URL(doc.path, window.location.origin).href;
      const resp = await fetch(url, { credentials: 'omit' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const md = await resp.text();
      entry = renderMarkdown(md);
      cachedHtml.set(doc.id, entry);
    } catch (err) {
      pageEl.innerHTML = `
        <div class="page-section">
          <div class="empty-state error">
            <h2>Failed to load ${escapeHtml(doc.label)}</h2>
            <p>${escapeHtml(err.message)}</p>
            <p class="muted">This usually means the docs haven't been bundled into <code>${escapeHtml(doc.path)}</code> yet, or you opened a stripped build. Try <code>./scripts/build-bundle.sh</code> to rebuild.</p>
            <button class="btn btn-secondary" data-action="retry-load" type="button">Retry</button>
          </div>
        </div>
      `;
      pageEl.querySelector('[data-action="retry-load"]')?.addEventListener('click', () => loadAndRender(pageEl));
      renderSide(doc, []);
      return;
    }
  }

  pageEl.innerHTML = `
    <div class="page-section reference-page">
      <header class="reference-head">
        <div class="muted">${escapeHtml(doc.blurb)}</div>
      </header>
      <article class="markdown-body">${entry.html}</article>
    </div>
  `;
  renderSide(doc, entry.toc);

  // Smooth-scroll to a hash if one was set on activation (e.g. via a link).
  if (window.location.hash && window.location.hash.length > 1) {
    const target = pageEl.querySelector(window.location.hash);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Wire all anchor clicks within the rendered doc to scroll within the page
  // container instead of changing window.location.hash globally.
  pageEl.querySelectorAll('a.md-anchor').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const slug = a.getAttribute('href').replace('#', '');
      const el = pageEl.querySelector(`#${CSS.escape(slug)}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function renderSide(activeDoc, toc) {
  const pickerHtml = DOCS.map(d => `
    <button type="button" class="ref-doc${d.id === activeDoc.id ? ' active' : ''}" data-doc-id="${d.id}">
      <div class="ref-doc-label">${escapeHtml(d.label)}</div>
      <div class="ref-doc-blurb">${escapeHtml(d.blurb)}</div>
    </button>
  `).join('');

  const tocHtml = toc.length === 0
    ? '<div class="muted ref-toc-empty">Document outline will appear here.</div>'
    : `<nav class="ref-toc" aria-label="Document outline">${
        toc
          .filter(t => t.level >= 2 && t.level <= 4)
          .map(t => `<a class="ref-toc-item ref-toc-l${t.level}" href="#${escapeAttr(t.slug)}" data-slug="${escapeAttr(t.slug)}">${escapeHtml(t.text)}</a>`)
          .join('')
      }</nav>`;

  setSidePanelContent(`
    <div class="reference-side">
      <section class="ref-doc-list">${pickerHtml}</section>
      <section class="ref-toc-section">
        <div class="section-title">On this page</div>
        ${tocHtml}
      </section>
      <section class="ref-help">
        <div class="ref-help-title">Want to learn more?</div>
        <a href="https://explorer.monerousd.org" target="_blank" rel="noopener" class="ref-help-link">Open Explorer ↗</a>
        <a href="https://github.com/monerousd" target="_blank" rel="noopener" class="ref-help-link">GitHub ↗</a>
      </section>
    </div>
  `);

  const root = document.getElementById('side-content');
  root?.querySelectorAll('[data-doc-id]').forEach(b => b.addEventListener('click', () => {
    activeDocId = b.dataset.docId;
    void loadAndRender(document.getElementById('page-content'));
  }));
  root?.querySelectorAll('.ref-toc-item').forEach(a => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    const slug = a.dataset.slug;
    const el = document.getElementById('page-content')?.querySelector(`#${CSS.escape(slug)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
