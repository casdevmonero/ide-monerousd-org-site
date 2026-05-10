/* Templates activity — gallery of bundled DSOL contracts + site starters.
 *
 * Side panel:    category filter + search
 * Page content:  responsive grid of template cards. Click a card → opens a
 *                detail modal with full preview source, "Open in editor" CTA.
 *
 * Each "Open" creates a new project pre-seeded with the template's files
 * (or imports the files into the active project if it's empty).
 */

import * as store from '../lib/store.js';
import * as idb   from '../lib/idb-projects.js';
import { editorApi }              from '../components/editor.js';
import { setSidePanelContent,
         setSideHeader }          from '../components/side-panel.js';
import { setPluginPanelContent,
         setPluginHeader }        from '../components/plugin-panel.js';
import { showToast }              from '../components/toast.js';
import { showModal,
         hideModal,
         confirmModal }           from '../components/modal.js';
import { activateActivity }       from '../lib/router.js';

import { DSOL_TEMPLATES, SITE_TEMPLATES } from '../templates/manifest.js';

let activated = false;
let filter = { category: 'all', search: '' };

const ICON_DSOL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 4 7v10l8 5 8-5V7Z"/><path d="m4 7 8 5 8-5"/><path d="M12 22V12"/></svg>`;
const ICON_SITE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;

export async function activate({ sideEl, pluginEl, pageEl }) {
  if (!activated) {
    activated = true;
  }
  setSideHeader('Templates');
  setPluginHeader('');
  renderSide();
  renderPage(pageEl);
}

/* ─── Side panel — categories + search ─────────────────────────────────── */

function renderSide() {
  const html = `
    <div class="templates-side">
      <div class="form-row">
        <input id="tpl-search" class="search-input" type="search"
               placeholder="Search templates…" autocomplete="off"
               value="${escapeAttr(filter.search)}" />
      </div>
      <nav class="category-list" role="list">
        ${categoryItem('all',     'All templates',  DSOL_TEMPLATES.length + SITE_TEMPLATES.length)}
        ${categoryItem('contract','Dark Contracts', DSOL_TEMPLATES.length, ICON_DSOL)}
        ${categoryItem('site',    'Sovereign sites',SITE_TEMPLATES.length, ICON_SITE)}
      </nav>
      <div class="templates-help">
        <details>
          <summary>What is a template?</summary>
          <p>A starting point. Opening one creates a new project pre-seeded with the files. You can then edit, compile, deploy, or publish — fully under your wallet's control.</p>
        </details>
      </div>
    </div>
  `;
  setSidePanelContent(html);
  const root = document.getElementById('side-content');
  root?.querySelectorAll('[data-category]').forEach(b => b.addEventListener('click', () => {
    filter.category = b.dataset.category;
    renderSide();
    renderPage(document.getElementById('page-content'));
  }));
  const searchInput = root?.querySelector('#tpl-search');
  searchInput?.addEventListener('input', () => {
    filter.search = searchInput.value;
    renderPage(document.getElementById('page-content'));
  });
}

function categoryItem(id, label, count, icon = '') {
  const active = filter.category === id ? ' active' : '';
  return `<button class="category-item${active}" data-category="${id}" type="button">
    ${icon ? `<span class="icon">${icon}</span>` : '<span class="icon"></span>'}
    <span class="label">${escapeHtml(label)}</span>
    <span class="count">${count}</span>
  </button>`;
}

/* ─── Page content — gallery grid ──────────────────────────────────────── */

function renderPage(pageEl) {
  if (!pageEl) return;
  const matches = pickTemplates();
  if (matches.length === 0) {
    pageEl.innerHTML = `
      <div class="page-section">
        <div class="empty-state">
          <h2>No matching templates</h2>
          <p>Try clearing the search filter.</p>
          <button class="btn btn-secondary" data-action="clear-filter" type="button">Clear filter</button>
        </div>
      </div>
    `;
    pageEl.querySelector('[data-action="clear-filter"]')?.addEventListener('click', () => {
      filter = { category: 'all', search: '' };
      renderSide();
      renderPage(pageEl);
    });
    return;
  }

  pageEl.innerHTML = `
    <div class="page-section templates-page">
      <header class="page-header">
        <h1>Templates</h1>
        <p>Pick a starting point. Each template opens as a new project — fully editable, ready to compile, run locally, deploy on-chain, or publish as a sovereign site.</p>
      </header>
      <div class="templates-grid">
        ${matches.map(renderCard).join('')}
      </div>
    </div>
  `;

  pageEl.querySelectorAll('.template-card').forEach(card => {
    const tpl = matches.find(t => t.fqId === card.dataset.tplFqid);
    if (!tpl) return;
    card.addEventListener('click', (ev) => {
      // Don't trigger detail modal when clicking the inline "Open" button.
      if (ev.target.closest('[data-action="open-template"]')) return;
      openDetail(tpl);
    });
    card.querySelector('[data-action="open-template"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void openTemplate(tpl);
    });
  });
}

function pickTemplates() {
  const list = [];
  if (filter.category === 'all' || filter.category === 'contract') {
    for (const t of DSOL_TEMPLATES) list.push({ ...t, kind: 'contract', fqId: `contract:${t.id}` });
  }
  if (filter.category === 'all' || filter.category === 'site') {
    for (const t of SITE_TEMPLATES) list.push({ ...t, kind: 'site', fqId: `site:${t.id}` });
  }
  if (filter.search) {
    const q = filter.search.toLowerCase();
    return list.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.blurb.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q)
    );
  }
  return list;
}

function renderCard(tpl) {
  const icon = tpl.kind === 'contract' ? ICON_DSOL : ICON_SITE;
  const kindLabel = tpl.kind === 'contract' ? 'Dark Contract' : 'Sovereign site';
  const fileCount = tpl.files.length;
  return `
    <article class="template-card" data-tpl-fqid="${escapeAttr(tpl.fqId)}" tabindex="0">
      <div class="card-icon">${icon}</div>
      <div class="card-kind">${kindLabel}</div>
      <h3 class="card-name">${escapeHtml(tpl.name)}</h3>
      <p class="card-blurb">${escapeHtml(tpl.blurb)}</p>
      <footer class="card-footer">
        <span class="file-count">${fileCount} file${fileCount === 1 ? '' : 's'}</span>
        <button class="btn btn-primary btn-sm" data-action="open-template" type="button">Open</button>
      </footer>
    </article>
  `;
}

/* ─── Detail modal ─────────────────────────────────────────────────────── */

function openDetail(tpl) {
  const wrap = document.createElement('div');
  wrap.className = 'template-detail';

  const tabsHtml = tpl.files.length > 1
    ? `<nav class="detail-tabs" role="tablist">
        ${tpl.files.map((f, i) => `<button role="tab" class="detail-tab${i === 0 ? ' active' : ''}" data-file-idx="${i}" type="button">${escapeHtml(f.path)}</button>`).join('')}
      </nav>`
    : '';

  wrap.innerHTML = `
    <header class="detail-head">
      <div class="detail-icon">${tpl.kind === 'contract' ? ICON_DSOL : ICON_SITE}</div>
      <div>
        <div class="detail-kind">${tpl.kind === 'contract' ? 'Dark Contract' : 'Sovereign site'}</div>
        <h2>${escapeHtml(tpl.name)}</h2>
        <p>${escapeHtml(tpl.blurb)}</p>
      </div>
    </header>
    ${tabsHtml}
    <pre class="detail-source"><code class="lang-${tpl.kind === 'contract' ? 'dsol' : 'html'}">${escapeHtml(tpl.files[0].content)}</code></pre>
  `;

  showModal({
    title:  `${tpl.kind === 'contract' ? 'Dark Contract' : 'Sovereign site'} · ${tpl.name}`,
    body:   wrap,
    size:   'lg',
    actions: [
      { label: 'Cancel', kind: 'secondary', onClick: () => hideModal() },
      { label: 'Open in editor', kind: 'primary', onClick: async () => {
          hideModal();
          await openTemplate(tpl);
        } },
    ],
  });

  // Wire tab switching.
  wrap.querySelectorAll('[data-file-idx]').forEach(b => b.addEventListener('click', () => {
    const idx = Number(b.dataset.fileIdx);
    const f = tpl.files[idx];
    wrap.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    b.classList.add('active');
    const code = wrap.querySelector('.detail-source code');
    if (code) {
      code.textContent = f.content;
      code.className = `lang-${langClassFromPath(f.path)}`;
    }
  }));
}

/* ─── Open a template into a new project ───────────────────────────────── */

async function openTemplate(tpl) {
  const cur = store.get('project');
  // If the current project is empty (no id, or zero files) we can splat into it.
  const empty = !cur.id || (await idb.listFiles(cur.id).catch(() => [])).length === 0;
  if (!empty) {
    const proceed = await confirmModal({
      title: `Replace current project?`,
      body:  `Open "${tpl.name}" as a new project? Your current project "${escapeHtml(cur.name || 'Untitled')}" stays saved — you can return via Files → New project or via the command palette.`,
      confirmLabel: 'Open as new project',
      cancelLabel:  'Cancel',
    });
    if (!proceed) return;
  }

  try {
    const project = await idb.createProject({
      name: tpl.name,
      kind: tpl.kind,
      files: tpl.files.map(f => ({ path: f.path, content: f.content })),
    });
    idb.setCurrentProjectId(project.id);

    store.set('project', {
      id: project.id,
      name: project.name,
      kind: project.kind,
      files: tpl.files.map(f => ({ path: f.path, mtime: Date.now() })),
      activeFile: tpl.files[0]?.path || null,
      openFiles: tpl.files[0] ? [tpl.files[0].path] : [],
      dirty: new Set(),
    });

    if (tpl.files[0]) {
      await editorApi().openFile(tpl.files[0].path);
    }

    showToast({ kind: 'success', title: 'Project opened', body: `"${tpl.name}" is ready in the editor.` });

    // Switch to the most relevant activity.
    if (tpl.kind === 'contract') {
      await activateActivity('compiler');
    } else {
      await activateActivity('site-preview');
    }
  } catch (err) {
    showToast({ kind: 'error', title: 'Failed to open template', body: err.message });
  }
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function langClassFromPath(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (ext === 'dsol') return 'dsol';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'javascript';
  if (ext === 'json') return 'json';
  return 'plaintext';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
