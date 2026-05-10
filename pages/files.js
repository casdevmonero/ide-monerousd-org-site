/* Files activity — project tree + file CRUD + project lifecycle.
 *
 * Side panel:    project header + file tree + new/upload/refresh/delete actions
 * Plugin panel:  inspector for the active file (size, mtime, language, path)
 *
 * The page never owns truth — every state mutation goes through `idb-*` and
 * the store. The activity-bar/side-panel observers re-render on store change.
 *
 * Public API consumed by app.js + command-palette:
 *   activate({sideEl, pluginEl, pageEl})
 *   promptForFilename()           – modal: pick name + extension, creates a file
 *   promptForNewProject()         – modal: name + kind, creates a project, opens it
 *   exportProject()               – serialize current project as .dsproj download
 *   importProject()               – pick .dsproj, restore as a new project
 */

import * as store from '../lib/store.js';
import * as idb   from '../lib/idb-projects.js';
import { editorApi }       from '../components/editor.js';
import { tabsApi }         from '../components/tabs.js';
import { setSidePanelContent, setSideHeader }   from '../components/side-panel.js';
import { setPluginPanelContent, setPluginHeader } from '../components/plugin-panel.js';
import { showToast }       from '../components/toast.js';
import { showModal,
         hideModal,
         promptModal,
         confirmModal }    from '../components/modal.js';
import { terminalApi }     from '../components/terminal.js';
import { activateActivity } from '../lib/router.js';

import * as tar  from '../lib/tar.js';
import * as gzip from '../lib/gzip.js';
import { DSOL_TEMPLATES, SITE_TEMPLATES } from '../templates/manifest.js';

let activated = false;

export async function activate({ sideEl, pluginEl }) {
  if (!activated) {
    // Re-render on project changes (file tree, dirty flags, active file).
    store.subscribe('project', () => renderSide());
    activated = true;
  }
  setSideHeader('Files');
  setPluginHeader('Inspector');
  await renderSide();
  renderInspector();
}

/* ─── Side panel ────────────────────────────────────────────────────────── */

async function renderSide() {
  const p = store.get('project');
  if (!p.id) {
    setSidePanelContent(emptySideHtml());
    // Empty-state CTAs reuse the same data-action values as the
    // non-empty branch (`files-newproject`, `files-templates`,
    // `files-import`). They MUST be wired here too — otherwise they're
    // dead buttons (rule 23 / `tests/static/no-dead-buttons.test.js`).
    wireSideHandlers();
    return;
  }

  // Refresh files from IDB so the tree reflects what's on disk, not the
  // optimistic in-memory list. listFiles() is fast (single index range scan).
  let files;
  try {
    files = await idb.listFiles(p.id);
  } catch (err) {
    setSidePanelContent(`<div class="empty-state error">Failed to load files: ${escapeHtml(err.message)}</div>`);
    return;
  }
  const tree = buildTree(files.map(f => f.path));
  const dirty = p.dirty instanceof Set ? p.dirty : new Set(p.dirty || []);

  const html = `
    <div class="files-side">
      <div class="files-actions">
        <button data-action="files-new"        class="btn btn-secondary btn-sm" title="New file (⌘N)">
          ${ICON_PLUS}<span>New file</span>
        </button>
        <button data-action="files-upload"     class="btn btn-secondary btn-sm" title="Upload files">
          ${ICON_UPLOAD}<span>Upload</span>
        </button>
        <button data-action="files-export"     class="btn btn-secondary btn-sm" title="Export as .dsproj">
          ${ICON_DOWNLOAD}<span>Export</span>
        </button>
      </div>
      <div class="files-tree" role="tree" aria-label="Project files">
        ${renderTree(tree, '', p.activeFile, dirty)}
      </div>
      <div class="files-projectactions">
        <button data-action="files-templates"  class="btn-link" title="Open templates gallery">Browse templates →</button>
        <button data-action="files-import"     class="btn-link" title="Import .dsproj">Import .dsproj…</button>
        <button data-action="files-newproject" class="btn-link" title="Create a new project">New project…</button>
        <button data-action="files-deleteproj" class="btn-link danger" title="Delete this project">Delete project</button>
      </div>
    </div>
  `;
  setSidePanelContent(html);
  wireSideHandlers();
  wireFileTreeHandlers();
}

/* Wire every data-action button under #side-content. Idempotent — safe
 * to call after each setSidePanelContent() because the elements were
 * just (re)rendered and no prior listeners are attached. Used by both
 * the empty-state branch AND the non-empty branch of renderSide() so
 * neither path leaves dead buttons (rule 23). */
function wireSideHandlers() {
  const root = document.getElementById('side-content');
  if (!root) return;
  root.querySelectorAll('[data-action="files-new"]').forEach(b => b.addEventListener('click', promptForFilename));
  root.querySelectorAll('[data-action="files-upload"]').forEach(b => b.addEventListener('click', uploadFiles));
  root.querySelectorAll('[data-action="files-export"]').forEach(b => b.addEventListener('click', exportProject));
  root.querySelectorAll('[data-action="files-import"]').forEach(b => b.addEventListener('click', importProject));
  root.querySelectorAll('[data-action="files-templates"]').forEach(b => b.addEventListener('click', () => activateActivity('templates')));
  root.querySelectorAll('[data-action="files-newproject"]').forEach(b => b.addEventListener('click', promptForNewProject));
  root.querySelectorAll('[data-action="files-deleteproj"]').forEach(b => b.addEventListener('click', deleteCurrentProject));
}

/* Wire the file tree's per-row click + context menu. Only meaningful
 * when a project is open (the tree is empty otherwise). */
function wireFileTreeHandlers() {
  const root = document.getElementById('side-content');
  if (!root) return;
  root.querySelectorAll('.tree-file').forEach(el => {
    el.addEventListener('click', () => editorApi().openFile(el.dataset.path));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showFileContextMenu(el.dataset.path, ev.clientX, ev.clientY);
    });
  });
  root.querySelectorAll('.tree-dir').forEach(el => {
    el.addEventListener('click', () => {
      el.classList.toggle('collapsed');
    });
  });
}

function emptySideHtml() {
  return `
    <div class="files-empty">
      <div class="files-empty-illus" aria-hidden="true">
        <svg viewBox="0 0 200 200" width="160" height="160" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M40 60 h60 l10 10 h50 v90 H40z"/>
          <path d="M50 90 h100 M50 110 h100 M50 130 h60"/>
        </svg>
      </div>
      <div class="files-empty-title">No project open</div>
      <div class="files-empty-body">Pick a starter or create a blank project.</div>
      <div class="files-empty-actions">
        <button data-action="files-newproject" class="btn btn-primary btn-sm">${ICON_PLUS}<span>New project</span></button>
        <button data-action="files-templates"  class="btn btn-secondary btn-sm">${ICON_TEMPLATE}<span>Templates</span></button>
        <button data-action="files-import"     class="btn btn-secondary btn-sm">${ICON_UPLOAD}<span>Import .dsproj</span></button>
      </div>
    </div>
  `;
}

/* ─── Plugin (inspector) ────────────────────────────────────────────────── */

function renderInspector() {
  const p = store.get('project');
  if (!p?.activeFile) {
    setPluginPanelContent(`
      <div class="plugin-empty">
        <p>Select a file to see details.</p>
      </div>
    `);
    return;
  }
  // Async refresh — show skeleton then fill.
  setPluginPanelContent(`<div class="plugin-empty">Loading…</div>`);
  if (!p.id) return;
  idb.readFile(p.id, p.activeFile).then(rec => {
    const size = rec?.content?.length ?? 0;
    const lang = languageFromPath(p.activeFile);
    const mtime = rec?.mtime ? new Date(rec.mtime).toLocaleString() : '—';
    setPluginPanelContent(`
      <div class="inspector">
        <div class="inspector-row"><span>Path</span><code>${escapeHtml(p.activeFile)}</code></div>
        <div class="inspector-row"><span>Language</span><code>${escapeHtml(lang)}</code></div>
        <div class="inspector-row"><span>Size</span><code>${size} chars</code></div>
        <div class="inspector-row"><span>Modified</span><code>${escapeHtml(mtime)}</code></div>
      </div>
    `);
  }).catch(err => {
    setPluginPanelContent(`<div class="plugin-empty error">Failed to read file: ${escapeHtml(err.message)}</div>`);
  });
}

// Re-render inspector on active-file change.
let lastActive = null;
store.subscribe('project', (p) => {
  if (p.activeFile !== lastActive) {
    lastActive = p.activeFile;
    if (store.get('ui').activeActivity === 'files') renderInspector();
  }
});

/* ─── Tree builder ─────────────────────────────────────────────────────── */

function buildTree(paths) {
  const root = { dirs: {}, files: [] };
  for (const path of paths.slice().sort()) {
    const segs = path.split('/');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (!cur.dirs[seg]) cur.dirs[seg] = { dirs: {}, files: [] };
      cur = cur.dirs[seg];
    }
    cur.files.push(segs[segs.length - 1]);
  }
  return root;
}

function renderTree(node, prefix, activePath, dirty) {
  let html = '';
  const dirNames = Object.keys(node.dirs).sort();
  for (const name of dirNames) {
    html += `<div class="tree-dir" role="treeitem" aria-expanded="true">
      <span class="tree-dir-name">${ICON_FOLDER}<span>${escapeHtml(name)}</span></span>
      <div class="tree-children">${renderTree(node.dirs[name], prefix + name + '/', activePath, dirty)}</div>
    </div>`;
  }
  for (const name of node.files.slice().sort()) {
    const full = prefix + name;
    const isActive = (full === activePath);
    const isDirty  = dirty.has(full);
    html += `<div class="tree-file ${isActive ? 'active' : ''}" data-path="${escapeAttr(full)}" role="treeitem" tabindex="0" title="${escapeAttr(full)}">
      <span class="tree-file-icon">${pathIcon(full)}</span>
      <span class="tree-file-name">${escapeHtml(name)}</span>
      ${isDirty ? '<span class="tree-file-dirty" aria-label="Modified">●</span>' : ''}
    </div>`;
  }
  return html;
}

/* ─── File context menu (rename, delete, duplicate) ─────────────────────── */

function showFileContextMenu(path, x, y) {
  hideContextMenu();
  const m = document.createElement('div');
  m.className = 'context-menu';
  m.style.position = 'fixed';
  m.style.left = `${x}px`;
  m.style.top  = `${y}px`;
  m.innerHTML = `
    <button data-act="open">Open</button>
    <button data-act="rename">Rename…</button>
    <button data-act="duplicate">Duplicate</button>
    <button data-act="delete" class="danger">Delete</button>
  `;
  document.body.appendChild(m);
  const close = () => {
    m.remove();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  setTimeout(() => {
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
  }, 0);
  m.querySelectorAll('button').forEach(btn => btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    close();
    const act = btn.dataset.act;
    if (act === 'open')      await editorApi().openFile(path);
    if (act === 'rename')    await renameFilePrompt(path);
    if (act === 'duplicate') await duplicateFile(path);
    if (act === 'delete')    await deleteFilePrompt(path);
  }));
}

function hideContextMenu() {
  document.querySelectorAll('.context-menu').forEach(el => el.remove());
}

/* ─── File operations ──────────────────────────────────────────────────── */

export async function promptForFilename() {
  const p = store.get('project');
  if (!p.id) {
    // No project — chain into new-project prompt then re-attempt.
    const proj = await promptForNewProject();
    if (!proj) return null;
  }
  const value = await promptModal({
    title: 'New file',
    label: 'File path (e.g. Counter.dsol or src/utils.dsol)',
    placeholder: 'NewFile.dsol',
    validate(v) {
      if (!v) return 'Enter a name';
      if (!idb.isValidPath(v)) return 'Invalid path — only letters, digits, /._-@ allowed';
      return null;
    },
    confirmLabel: 'Create',
  });
  if (!value) return null;
  const project = store.get('project');
  // Conflict guard.
  const existing = await idb.readFile(project.id, value).catch(() => null);
  if (existing) {
    showToast({ kind: 'warning', title: 'File exists', body: `${value} is already in this project.` });
    await editorApi().openFile(value);
    return value;
  }
  await idb.writeFile(project.id, value, defaultStarterFor(value));
  await refreshProjectFiles();
  await editorApi().openFile(value);
  showToast({ kind: 'success', title: 'File created', body: value });
  return value;
}

async function renameFilePrompt(path) {
  const p = store.get('project');
  if (!p.id) return;
  const value = await promptModal({
    title: 'Rename file',
    label: 'New path',
    placeholder: path,
    initialValue: path,
    validate(v) {
      if (!v || v === path) return null;
      if (!idb.isValidPath(v)) return 'Invalid path';
      return null;
    },
    confirmLabel: 'Rename',
  });
  if (!value || value === path) return;
  try {
    await idb.renameFile(p.id, path, value);
    // Update open files / active file references.
    const openFiles = (p.openFiles || []).map(f => f === path ? value : f);
    const activeFile = (p.activeFile === path) ? value : p.activeFile;
    store.set('project', { openFiles, activeFile });
    await refreshProjectFiles();
    if (activeFile === value) await editorApi().openFile(value);
    showToast({ kind: 'success', title: 'Renamed', body: `${path} → ${value}` });
  } catch (err) {
    showToast({ kind: 'error', title: 'Rename failed', body: err.message });
  }
}

async function duplicateFile(path) {
  const p = store.get('project');
  if (!p.id) return;
  const rec = await idb.readFile(p.id, path);
  if (!rec) return;
  const dup = nextAvailablePath(path);
  await idb.writeFile(p.id, dup, rec.content);
  await refreshProjectFiles();
  await editorApi().openFile(dup);
  showToast({ kind: 'success', title: 'Duplicated', body: dup });
}

async function deleteFilePrompt(path) {
  const ok = await confirmModal({
    title: 'Delete file',
    body: `<p>Permanently delete <code>${escapeHtml(path)}</code> from this project?</p>
           <p style="color:var(--text-muted);font-size:var(--fs-xs);">This cannot be undone. Other files in the project are untouched.</p>`,
    danger: true,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  const p = store.get('project');
  if (!p.id) return;
  try {
    await idb.deleteFile(p.id, path);
    // Tabs, active file.
    const openFiles = (p.openFiles || []).filter(f => f !== path);
    const activeFile = (p.activeFile === path) ? (openFiles.at(-1) ?? null) : p.activeFile;
    store.set('project', { openFiles, activeFile });
    if (activeFile) await editorApi().openFile(activeFile);
    await refreshProjectFiles();
    showToast({ kind: 'info', title: 'Deleted', body: path });
  } catch (err) {
    showToast({ kind: 'error', title: 'Delete failed', body: err.message });
  }
}

async function uploadFiles() {
  const p = store.get('project');
  if (!p.id) {
    showToast({ kind: 'warning', title: 'No project open', body: 'Create a project first.' });
    return;
  }
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.onchange = async () => {
    const files = Array.from(inp.files || []);
    inp.remove();
    if (!files.length) return;
    let imported = 0;
    for (const f of files) {
      const path = f.webkitRelativePath || f.name;
      if (!idb.isValidPath(path)) {
        terminalApi().warn(`Skipped invalid path: ${path}`);
        continue;
      }
      try {
        const text = await f.text();
        await idb.writeFile(p.id, path, text);
        imported += 1;
      } catch (err) {
        terminalApi().error(`Upload ${path} failed: ${err.message}`);
      }
    }
    await refreshProjectFiles();
    showToast({ kind: 'success', title: `Imported ${imported} file${imported === 1 ? '' : 's'}` });
  };
  inp.click();
}

/* ─── Project lifecycle ─────────────────────────────────────────────────── */

export async function promptForNewProject() {
  return new Promise((resolve) => {
    const tmplOptions = [
      { id: '__blank-contract', name: 'Blank contract project', kind: 'contract', files: [
        { path: 'Main.dsol', content: defaultStarterFor('Main.dsol') },
      ]},
      { id: '__blank-site', name: 'Blank site project', kind: 'site', files: [
        { path: 'index.html', content: '<!doctype html>\n<html>\n  <head><meta charset="utf-8"><title>New site</title></head>\n  <body>\n    <h1>Hello, MoneroUSD</h1>\n  </body>\n</html>\n' },
      ]},
      { id: '__blank-mixed', name: 'Blank mixed project (contract + site)', kind: 'mixed', files: [
        { path: 'Main.dsol',  content: defaultStarterFor('Main.dsol') },
        { path: 'site/index.html', content: '<!doctype html>\n<html><head><meta charset="utf-8"><title>App</title></head><body><h1>App</h1></body></html>\n' },
      ]},
    ];
    showModal({
      title: 'New project',
      body: `
        <form id="new-proj-form" autocomplete="off">
          <label class="form-row">
            <span>Project name</span>
            <input id="np-name" type="text" required maxlength="60" placeholder="My contract" value="My project">
          </label>
          <label class="form-row">
            <span>Starter</span>
            <select id="np-template">
              ${tmplOptions.map(t => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)}</option>`).join('')}
              <optgroup label="DSOL templates">
                ${DSOL_TEMPLATES.map(t => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)} — ${escapeHtml(t.blurb)}</option>`).join('')}
              </optgroup>
              <optgroup label="Site starters">
                ${SITE_TEMPLATES.map(t => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.name)} — ${escapeHtml(t.blurb)}</option>`).join('')}
              </optgroup>
            </select>
          </label>
        </form>
      `,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: () => { hideModal(); resolve(null); } },
        { label: 'Create', kind: 'primary', onClick: async () => {
            const name = document.getElementById('np-name').value.trim() || 'Untitled project';
            const tid  = document.getElementById('np-template').value;
            hideModal();
            try {
              const proj = await createProjectFromTemplate(name, tid, tmplOptions);
              resolve(proj);
            } catch (err) {
              showToast({ kind: 'error', title: 'Create failed', body: err.message });
              resolve(null);
            }
          },
        },
      ],
      onClose: () => resolve(null),
    });
    setTimeout(() => document.getElementById('np-name')?.focus(), 30);
  });
}

async function createProjectFromTemplate(name, templateId, blanks) {
  let kind = 'contract', files = [];
  const blank = blanks.find(b => b.id === templateId);
  if (blank) {
    kind = blank.kind;
    files = blank.files;
  } else {
    const tmpl = DSOL_TEMPLATES.find(t => t.id === templateId)
              || SITE_TEMPLATES.find(t => t.id === templateId);
    if (!tmpl) throw new Error('Template not found');
    kind = SITE_TEMPLATES.includes(tmpl) ? 'site' : 'contract';
    files = tmpl.files;
  }
  const proj = await idb.createProject({ name, kind, files });
  idb.setCurrentProjectId(proj.id);
  store.set('project', {
    id: proj.id,
    name: proj.name,
    kind: proj.kind,
    activeFile: proj.activeFile,
    openFiles: proj.activeFile ? [proj.activeFile] : [],
    files: files.map(f => ({ path: f.path, mtime: Date.now() })),
    dirty: new Set(),
  });
  if (proj.activeFile) await editorApi().openFile(proj.activeFile);
  await refreshProjectFiles();
  terminalApi().success(`Created project "${name}"`);
  showToast({ kind: 'success', title: 'Project created', body: name });
  return proj;
}

async function deleteCurrentProject() {
  const p = store.get('project');
  if (!p.id) return;
  const ok = await confirmModal({
    title: 'Delete project',
    body: `<p>Permanently delete <strong>${escapeHtml(p.name)}</strong> and all its files from this browser?</p>
           <p style="color:var(--text-muted);font-size:var(--fs-xs);">Deployed contracts on the chain are NOT affected. Export with .dsproj first if you want a backup.</p>`,
    danger: true,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  try {
    // Close all open Monaco models.
    const open = (p.openFiles || []).slice();
    for (const f of open) await editorApi().closeFile(f);
    await idb.deleteProject(p.id);
    idb.setCurrentProjectId(null);
    store.replace('project', {
      id: null, name: 'Untitled project', kind: 'contract',
      files: [], activeFile: null, openFiles: [], dirty: new Set(),
    });
    showToast({ kind: 'info', title: 'Project deleted' });
    activateActivity('files');
  } catch (err) {
    showToast({ kind: 'error', title: 'Delete failed', body: err.message });
  }
}

/* ─── .dsproj export / import ──────────────────────────────────────────── */

export async function exportProject() {
  const p = store.get('project');
  if (!p.id) {
    showToast({ kind: 'warning', title: 'No project open' });
    return;
  }
  // Flush any dirty editor state to IDB first.
  await editorApi().saveActive().catch(() => null);
  const files = await idb.listFiles(p.id);
  const enc = new TextEncoder();
  const entries = [
    {
      name: 'project.json',
      data: enc.encode(JSON.stringify({
        version: 1,
        name: p.name,
        kind: p.kind,
        activeFile: p.activeFile,
        exportedAt: new Date().toISOString(),
      }, null, 2)),
    },
    ...files.map(f => ({ name: `files/${f.path}`, data: enc.encode(f.content || '') })),
  ];
  let tarBuf, gz;
  try {
    tarBuf = tar.pack(entries);
    gz = await gzip.gzip(tarBuf);
  } catch (err) {
    showToast({ kind: 'error', title: 'Export failed', body: err.message });
    return;
  }
  const blob = new Blob([gz], { type: 'application/gzip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(p.name)}.dsproj`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  showToast({ kind: 'success', title: 'Exported', body: a.download });
}

export async function importProject() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.dsproj,.tar.gz,application/gzip';
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.onchange = async () => {
    const f = inp.files?.[0];
    inp.remove();
    if (!f) return;
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const tarBuf = await gzip.gunzip(buf);
      const entries = tar.unpack(tarBuf);
      const meta = entries.find(e => e.name === 'project.json');
      if (!meta) throw new Error('Not a valid .dsproj — missing project.json');
      const json = JSON.parse(new TextDecoder().decode(meta.data));
      if (json.version !== 1) throw new Error(`Unsupported .dsproj version: ${json.version}`);
      const fileEntries = entries
        .filter(e => e.name.startsWith('files/'))
        .map(e => ({
          path:    e.name.slice('files/'.length),
          content: new TextDecoder().decode(e.data),
        }))
        .filter(e => idb.isValidPath(e.path));
      const proj = await idb.createProject({
        name: `${json.name} (imported)`,
        kind: json.kind || 'contract',
        files: fileEntries,
      });
      idb.setCurrentProjectId(proj.id);
      store.set('project', {
        id: proj.id, name: proj.name, kind: proj.kind,
        activeFile: proj.activeFile,
        openFiles: proj.activeFile ? [proj.activeFile] : [],
        files: fileEntries.map(x => ({ path: x.path, mtime: Date.now() })),
        dirty: new Set(),
      });
      if (proj.activeFile) await editorApi().openFile(proj.activeFile);
      await refreshProjectFiles();
      showToast({ kind: 'success', title: 'Imported', body: proj.name });
    } catch (err) {
      showToast({ kind: 'error', title: 'Import failed', body: err.message });
    }
  };
  inp.click();
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

async function refreshProjectFiles() {
  const p = store.get('project');
  if (!p.id) return;
  const files = await idb.listFiles(p.id);
  store.set('project', { files: files.map(f => ({ path: f.path, mtime: f.mtime })) });
}

function languageFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'dsol':  return 'DSOL';
    case 'html':  return 'HTML';
    case 'css':   return 'CSS';
    case 'js':    return 'JavaScript';
    case 'mjs':   return 'JavaScript (ESM)';
    case 'ts':    return 'TypeScript';
    case 'json':  return 'JSON';
    case 'md':    return 'Markdown';
    case 'svg':   return 'SVG';
    case 'txt':   return 'Plain text';
    default:      return ext ? ext.toUpperCase() : 'Plain text';
  }
}

function defaultStarterFor(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'dsol') {
    return `// New DSOL contract\n//\n// Replace 'NewContract' with your name. Compile with ⌘Enter.\n\ndark contract NewContract {\n  private uint64 value;\n\n  @batch\n  entry setValue(uint64 v) {\n    value = v;\n  }\n\n  @direct\n  entry getValue() returns (uint64 when revealed) {\n    return value;\n  }\n}\n`;
  }
  if (ext === 'html') {
    return '<!doctype html>\n<html>\n  <head><meta charset="utf-8"><title>New page</title></head>\n  <body>\n    <h1>Hello</h1>\n  </body>\n</html>\n';
  }
  if (ext === 'css') return '/* New stylesheet */\n';
  if (ext === 'js' || ext === 'mjs') return '// New module\n';
  if (ext === 'json') return '{\n}\n';
  if (ext === 'md') return '# New document\n';
  return '';
}

function nextAvailablePath(path) {
  const dot = path.lastIndexOf('.');
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext  = dot > 0 ? path.slice(dot)    : '';
  let n = 2;
  let candidate;
  do {
    candidate = `${base}-${n}${ext}`;
    n += 1;
  } while ((store.get('project').files || []).some(f => f.path === candidate));
  return candidate;
}

function slugify(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }

function pathIcon(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'dsol') return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#FF6600" stroke-width="2" aria-hidden="true"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/></svg>';
  if (ext === 'html') return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#FF8833" stroke-width="1.5" aria-hidden="true"><path d="M4 4l1.5 16L12 22l6.5-2L20 4z"/></svg>';
  if (ext === 'css')  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#38bdf8" stroke-width="1.5" aria-hidden="true"><path d="M4 4l1.5 16L12 22l6.5-2L20 4z"/></svg>';
  if (ext === 'js' || ext === 'mjs') return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#facc15" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  if (ext === 'json') return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#86efac" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  if (ext === 'md')   return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#a0a0a0" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/></svg>';
}

const ICON_PLUS     = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_UPLOAD   = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M6 10l6-6 6 6M4 20h16"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M6 10l6 6 6-6M4 20h16"/></svg>';
const ICON_FOLDER   = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>';
const ICON_TEMPLATE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>';
