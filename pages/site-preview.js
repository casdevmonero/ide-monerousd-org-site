/* Site Preview activity — author + preview + publish a sovereign site bundle.
 *
 * Side panel:    site-asset tree (same project but filtered to non-DSOL files)
 *                + version + content-type + Publish button
 * Plugin panel:  blob: sandboxed iframe live preview
 *
 * IDE-12: the preview iframe is built from a `blob:` URL with
 *         `sandbox="allow-scripts"` (NO `allow-same-origin`). The provider
 *         (`window.monerousd`) is NEVER injected into the iframe — the user
 *         must use the IDE's own Publish CTA to broadcast SITE_PUBLISH.
 *
 * IDE-1: publishing flows through `window.monerousd.publishSite({...})`. The
 *        wallet renders the existing `buildOpFields('SITE_PUBLISH')` approval
 *        modal (SW-14, including the reserve-contribution callout). The IDE
 *        never holds keys.
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
         promptModal }            from '../components/modal.js';
import { terminalApi }            from '../components/terminal.js';

import * as tar  from '../lib/tar.js';
import * as gzip from '../lib/gzip.js';
import { sha256 } from '../lib/sha256.js';
import * as provider from '../lib/provider.js';
import { computeSiteFee, formatUSDm, bondTierLabel } from '../lib/fee-curve.js';

let activated = false;
let previewBlobUrl = null;       // tracked so we can revokeObjectURL between renders
let previewObjectUrls = new Map(); // sub-asset blob URLs (css/js/imgs)
let publishInflight = false;

const SITE_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'txt', 'md', 'wasm', 'woff', 'woff2', 'ttf']);
const TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md']);

export async function activate({ sideEl, pluginEl }) {
  if (!activated) {
    store.subscribe('project', () => { void renderSide(); void renderPreview(); });
    activated = true;
  }
  setSideHeader('Site files');
  setPluginHeader('Preview');
  await renderSide();
  await renderPreview();
}

/* ─── Side panel ────────────────────────────────────────────────────────── */

async function renderSide() {
  const p = store.get('project');
  if (!p.id) {
    setSidePanelContent(`<div class="empty-state">
      <h3>No project</h3>
      <p>Create a site project from <a href="#" data-action="open-templates">Templates</a> to get started.</p>
    </div>`);
    document.querySelector('[data-action="open-templates"]')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      import('../lib/router.js').then(m => m.activateActivity('templates'));
    });
    return;
  }

  const files = await idb.listFiles(p.id).catch(() => []);
  const siteFiles = files.filter(f => isSiteAsset(f.path));
  const totalBytes = siteFiles.reduce((s, f) => s + (typeof f.content === 'string' ? new Blob([f.content]).size : (f.content?.length || 0)), 0);
  const hasIndex = siteFiles.some(f => f.path === 'index.html' || f.path.endsWith('/index.html'));

  // Suggest a domain default based on project name.
  const defaultDomain = `${slugify(p.name) || 'my-site'}.dark-sites.local`;

  const conn = store.get('connection');
  const isConn = conn.status === 'connected';
  const canPublish = isConn && hasIndex && siteFiles.length > 0;

  const html = `
    <div class="site-side">
      <section class="site-summary">
        <div class="row">
          <span class="label">Files</span>
          <span class="value">${siteFiles.length}</span>
        </div>
        <div class="row">
          <span class="label">Size (uncompressed)</span>
          <span class="value">${formatBytes(totalBytes)}</span>
        </div>
        <div class="row">
          <span class="label">Entry point</span>
          <span class="value">${hasIndex ? '<code>index.html</code>' : '<em class="muted">missing</em>'}</span>
        </div>
      </section>

      <section class="site-tree">
        <div class="section-title">Site assets</div>
        ${siteFiles.length === 0
          ? '<div class="empty-state-small">No HTML/CSS/JS files in this project. Add an <code>index.html</code> to enable preview.</div>'
          : `<ul class="files-list">
              ${siteFiles.sort((a, b) => a.path.localeCompare(b.path)).map(f =>
                `<li><button class="file-link" data-path="${escapeAttr(f.path)}">${escapeHtml(f.path)}</button></li>`
              ).join('')}
            </ul>`}
      </section>

      <section class="publish-form">
        <div class="section-title">Publish</div>
        <div class="form-row">
          <label for="site-domain">Domain</label>
          <input id="site-domain" type="text" value="${escapeAttr(defaultDomain)}" autocomplete="off" spellcheck="false" />
          <small class="hint">Use <code>dark-sites.local/&lt;name&gt;</code> for third-party sites, or an official domain (allowlist).</small>
        </div>
        <div class="form-row">
          <label for="site-version">Version</label>
          <input id="site-version" type="text" value="0.1.0" autocomplete="off" spellcheck="false" />
        </div>
        <div class="form-row">
          <label for="site-content-type">Content type</label>
          <select id="site-content-type">
            <option value="static" selected>static</option>
            <option value="spa">spa</option>
            <option value="spa-with-api">spa-with-api</option>
          </select>
        </div>

        <div id="site-fee-preview" class="fee-preview muted">
          <div class="fee-row"><span>Bond</span><span class="value">—</span></div>
          <div class="fee-row"><span>Update fee</span><span class="value">—</span></div>
          <div class="fee-row total"><span>Total</span><span class="value">—</span></div>
          <div class="fee-callout">100% of fees route to the protocol reserve — every publish strengthens the peg.</div>
        </div>

        <button data-action="publish-site"
                class="btn btn-primary btn-block ${canPublish ? '' : 'soft-disabled'}"
                ${publishInflight ? 'disabled' : ''}
                title="${publishTitle(isConn, hasIndex, siteFiles.length)}">
          ${publishInflight ? '<span class="spinner-dots"></span> Publishing…' : 'Publish site on-chain'}
        </button>
      </section>

      <section class="site-help">
        <details>
          <summary>How publishing works</summary>
          <ul class="help-list">
            <li>Files are packed into a deterministic tarball and gzipped.</li>
            <li>SHA-256 of the gzip becomes <code>rootHash</code> — anchored on chain via <code>SITE_PUBLISH</code>.</li>
            <li>Wallet popup shows fee + reserve callout. You approve, wallet broadcasts.</li>
            <li>Wallet T1 mirror + every Ion Swap indexer serves <code>${escapeHtml(defaultDomain)}</code> at the new <code>rootHash</code>.</li>
          </ul>
        </details>
      </section>
    </div>
  `;
  setSidePanelContent(html);

  const root = document.getElementById('side-content');
  if (!root) return;

  root.querySelectorAll('.file-link').forEach(b => b.addEventListener('click', () => editorApi().openFile(b.dataset.path)));
  root.querySelector('[data-action="publish-site"]')?.addEventListener('click', () => doPublish());

  // Live fee preview as the user types.
  const domainInput = root.querySelector('#site-domain');
  const versionInput = root.querySelector('#site-version');
  const updateFee = () => updateFeePreview(root, domainInput.value, siteFiles);
  domainInput?.addEventListener('input', updateFee);
  versionInput?.addEventListener('input', updateFee);
  updateFee();
}

async function updateFeePreview(root, domain, siteFiles) {
  const feeBox = root.querySelector('#site-fee-preview');
  if (!feeBox) return;
  if (!domain || !domain.trim()) {
    feeBox.querySelector('.fee-row:nth-child(1) .value').textContent = '—';
    feeBox.querySelector('.fee-row:nth-child(2) .value').textContent = '—';
    feeBox.querySelector('.fee-row.total .value').textContent       = '—';
    return;
  }
  // Estimate compressed size by gzipping the contents we have right now.
  let compressedSize = 0;
  try {
    const tarball = await packSiteTar(siteFiles);
    const gz = await gzip.gzip(tarball);
    compressedSize = gz.byteLength;
  } catch {
    // Estimate: assume gzip ratio ≈ 0.4 for typical web bundles.
    const total = siteFiles.reduce((s, f) => s + (typeof f.content === 'string' ? new Blob([f.content]).size : (f.content?.length || 0)), 0);
    compressedSize = Math.max(1, Math.round(total * 0.4));
  }

  // We don't yet know whether this is a first publish — show the bond as
  // "if first publish" for honesty and let the wallet enforce.
  // Heuristic: try the indexer to check. Best-effort only.
  let isFirstPublish = true;
  try {
    const url = `${store.get('settings').indexerUrl.replace(/\/$/, '')}/v1/sites/${encodeURIComponent(domain)}`;
    const resp = await fetch(url, { method: 'HEAD' });
    if (resp.ok) isFirstPublish = false;
  } catch {/* assume first-publish */}

  const fee = computeSiteFee({ domain, bundleSize: compressedSize, isFirstPublish });
  feeBox.querySelector('.fee-row:nth-child(1) .value').innerHTML = isFirstPublish
    ? `${formatUSDm(fee.bondAtomic)} USDm <small class="muted">(${escapeHtml(bondTierLabel(domain))})</small>`
    : '<em class="muted">no bond — domain already registered</em>';
  feeBox.querySelector('.fee-row:nth-child(2) .value').textContent = `${formatUSDm(fee.updateAtomic)} USDm  · ${formatBytes(compressedSize)} gzipped`;
  feeBox.querySelector('.fee-row.total .value').textContent       = `${formatUSDm(fee.totalAtomic)} USDm`;
}

function publishTitle(isConn, hasIndex, fileCount) {
  if (!isConn)    return 'Connect a MoneroUSD wallet to publish';
  if (!fileCount) return 'Add HTML/CSS/JS files to publish';
  if (!hasIndex)  return 'Add an index.html entry point to publish';
  return 'Broadcast SITE_PUBLISH — wallet will show the approval popup';
}

/* ─── Plugin panel: live preview iframe ─────────────────────────────────── */

async function renderPreview() {
  const p = store.get('project');
  if (!p.id) {
    setPluginPanelContent('<div class="empty-state-mini"><div class="muted">Open a site project to preview.</div></div>');
    return;
  }
  const files = await idb.listFiles(p.id).catch(() => []);
  const siteFiles = files.filter(f => isSiteAsset(f.path));
  const indexFile = siteFiles.find(f => f.path === 'index.html') || siteFiles.find(f => f.path.endsWith('/index.html'));
  if (!indexFile) {
    setPluginPanelContent(`
      <div class="empty-state-mini">
        <div class="muted">No <code>index.html</code> found.</div>
        <div class="hint">Add one to your project to enable preview.</div>
      </div>
    `);
    cleanupBlobUrls();
    return;
  }

  // Build a blob: URL for the index document, rewriting same-project relative
  // refs to inline blob URLs so the sandboxed iframe can resolve them.
  cleanupBlobUrls();
  const fileMap = new Map(siteFiles.map(f => [normalize(f.path), f]));
  const indexBytes = encodeIfText(indexFile);
  const rewritten  = await rewriteSameOriginRefs(indexBytes, indexFile.path, fileMap);
  const indexBlob  = new Blob([rewritten], { type: 'text/html' });
  previewBlobUrl   = URL.createObjectURL(indexBlob);

  const refreshIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
  const html = `
    <div class="preview-wrap">
      <div class="preview-toolbar">
        <span class="muted">Sandboxed preview · provider not injected</span>
        <button data-action="preview-refresh" class="btn btn-secondary btn-sm" title="Refresh preview">${refreshIcon} Refresh</button>
      </div>
      <iframe
        id="site-preview-iframe"
        sandbox="allow-scripts"
        src="${previewBlobUrl}"
        title="Site preview"
        class="preview-iframe"></iframe>
    </div>
  `;
  setPluginPanelContent(html);
  const body = document.getElementById('plugin-body');
  body?.querySelector('[data-action="preview-refresh"]')?.addEventListener('click', () => renderPreview());
}

function cleanupBlobUrls() {
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = null;
  }
  for (const url of previewObjectUrls.values()) URL.revokeObjectURL(url);
  previewObjectUrls.clear();
}

/** Rewrite href="style.css" / src="app.js" / `<link>` etc. to blob: URLs so
 * the sandboxed iframe can fetch them. */
async function rewriteSameOriginRefs(htmlText, indexPath, fileMap) {
  let s = String(htmlText);
  const baseDir = indexPath.includes('/') ? indexPath.slice(0, indexPath.lastIndexOf('/') + 1) : '';
  const replaceRef = async (rawRef) => {
    if (!rawRef) return rawRef;
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawRef)) return rawRef;   // absolute scheme, leave alone
    if (rawRef.startsWith('#')) return rawRef;
    if (rawRef.startsWith('data:')) return rawRef;
    if (rawRef.startsWith('blob:')) return rawRef;

    const target = normalize(joinPath(baseDir, rawRef.split('#')[0].split('?')[0]));
    const f = fileMap.get(target);
    if (!f) return rawRef;
    if (previewObjectUrls.has(target)) return previewObjectUrls.get(target);

    const mime = mimeOf(target);
    const bytes = encodeIfText(f);
    let content = bytes;
    // Recursive rewrite for nested HTML or CSS @import / url() refs.
    if (mime === 'text/html')        content = await rewriteSameOriginRefs(bytes, target, fileMap);
    else if (mime === 'text/css')    content = await rewriteCssUrls(bytes, target, fileMap);

    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    previewObjectUrls.set(target, url);
    return url;
  };

  // Sequentially rewrite all matches so async replacers run in order.
  // <link href="...">, <script src="...">, <img src="...">, <a href="...">,
  // <source src="...">, <video src="...">, <audio src="...">.
  const pattern = /\b(href|src)=("([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  const matches = [];
  let m;
  while ((m = pattern.exec(s)) !== null) {
    matches.push({ start: m.index, full: m[0], attr: m[1], ref: m[3] ?? m[4] ?? m[5] });
  }
  // Walk in reverse so indices stay valid as we splice.
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, full, attr, ref } = matches[i];
    const newRef = await replaceRef(ref);
    if (newRef === ref) continue;
    const replacement = `${attr}="${newRef}"`;
    s = s.slice(0, start) + replacement + s.slice(start + full.length);
  }
  return s;
}

async function rewriteCssUrls(cssText, cssPath, fileMap) {
  const baseDir = cssPath.includes('/') ? cssPath.slice(0, cssPath.lastIndexOf('/') + 1) : '';
  let s = String(cssText);
  const pattern = /url\(\s*(["']?)([^)"']+)\1\s*\)/g;
  const matches = [];
  let m;
  while ((m = pattern.exec(s)) !== null) {
    matches.push({ start: m.index, full: m[0], quote: m[1], ref: m[2] });
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, full, quote, ref } = matches[i];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;
    const target = normalize(joinPath(baseDir, ref.split('#')[0].split('?')[0]));
    const f = fileMap.get(target);
    if (!f) continue;
    let url = previewObjectUrls.get(target);
    if (!url) {
      const mime = mimeOf(target);
      url = URL.createObjectURL(new Blob([encodeIfText(f)], { type: mime }));
      previewObjectUrls.set(target, url);
    }
    const replacement = `url(${quote}${url}${quote})`;
    s = s.slice(0, start) + replacement + s.slice(start + full.length);
  }
  return s;
}

/* ─── Publish flow ──────────────────────────────────────────────────────── */

async function doPublish() {
  if (publishInflight) return;
  const p = store.get('project');
  if (!p.id) return;

  const root = document.getElementById('side-content');
  const domain      = root.querySelector('#site-domain')?.value?.trim();
  const version     = root.querySelector('#site-version')?.value?.trim();
  const contentType = root.querySelector('#site-content-type')?.value || 'static';

  if (!domain) {
    showToast({ kind: 'warning', title: 'Domain required', body: 'Pick a domain like myname.dark-sites.local.' });
    return;
  }
  if (!/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)?$/i.test(domain)) {
    showToast({ kind: 'warning', title: 'Invalid domain', body: 'Use lowercase letters, digits, dots, hyphens (and optional /name).' });
    return;
  }
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    showToast({ kind: 'warning', title: 'Invalid version', body: 'Use semantic versioning, e.g. 0.1.0.' });
    return;
  }

  const conn = store.get('connection');
  if (conn.status !== 'connected') {
    showToast({ kind: 'warning', title: 'Connect wallet first', body: 'Click Connect MoneroUSD in the top bar to publish.' });
    return;
  }

  // Flush editor before reading files (any in-progress edits not yet persisted).
  try { await editorApi().saveActive(); } catch {/* ignore */}

  const files = await idb.listFiles(p.id);
  const siteFiles = files.filter(f => isSiteAsset(f.path));
  if (!siteFiles.length) {
    showToast({ kind: 'warning', title: 'No site files', body: 'Add HTML/CSS/JS files to your project before publishing.' });
    return;
  }
  if (!siteFiles.some(f => f.path === 'index.html' || f.path.endsWith('/index.html'))) {
    showToast({ kind: 'warning', title: 'No index.html', body: 'Add an index.html entry point.' });
    return;
  }
  if (siteFiles.some(f => !isValidPath(f.path))) {
    showToast({ kind: 'error', title: 'Invalid path', body: 'One or more files have a path that fails the bundle path-traversal guard.' });
    return;
  }

  publishInflight = true;
  await renderSide();

  try {
    terminalApi().info(`Packing ${siteFiles.length} files for ${domain}…`);
    const tarball = await packSiteTar(siteFiles);
    const bundle  = await gzip.gzip(tarball);
    const rootHash = await sha256(bundle);

    terminalApi().info(`Bundle: ${formatBytes(bundle.byteLength)} gzipped · rootHash ${rootHash.slice(0, 12)}…`);
    terminalApi().info(`Broadcasting SITE_PUBLISH for ${domain} v${version} — wallet will show the approval popup.`);

    const result = await provider.publishSite({
      domain,
      bundle,
      version,
      contentType,
    });

    const txHash = result?.txHash || result?.tx_hash || null;
    if (txHash) {
      terminalApi().success(`SITE_PUBLISH broadcast — tx ${txHash}`);
    } else {
      terminalApi().success(`SITE_PUBLISH broadcast accepted by wallet.`);
    }
    showToast({
      kind: 'success',
      title: `Published ${domain}`,
      body: txHash ? `tx ${txHash.slice(0, 8)}…${txHash.slice(-4)}` : 'Awaiting chain confirmation.',
      actions: txHash ? [{ label: 'Open in Explorer', onClick: () => window.open(`https://explorer.monerousd.org/tx/${txHash}`, '_blank', 'noopener') }] : [],
    });

    // Best-effort: ingest the bundle to the operator's indexer so it can serve
    // the bundle to peers. The wallet's publishSite IPC may already handle this;
    // running it here is a fallback and is idempotent (bundle is content-addressed).
    try {
      const indexerUrl = store.get('settings').indexerUrl.replace(/\/$/, '');
      const ingestResp = await fetch(`${indexerUrl}/api/sites/${encodeURIComponent(domain)}/bundle`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Root-Hash': rootHash, 'X-Version': version },
        body:    bundle,
      });
      if (ingestResp.ok) {
        terminalApi().info(`Bundle ingested by indexer ${indexerUrl}`);
      } else {
        terminalApi().warn(`Indexer ingest returned ${ingestResp.status} — wallet's primary path may already have ingested it.`);
      }
    } catch (err) {
      terminalApi().warn(`Indexer ingest skipped: ${err.message}`);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    if (err?.name === 'ProviderUnavailableError') {
      showToast({ kind: 'error', title: 'Wallet not available', body: 'Install the desktop wallet or the monerousd-chrome extension.' });
    } else if (err?.name === 'NotConnectedError') {
      showToast({ kind: 'warning', title: 'Wallet not connected', body: 'Click Connect MoneroUSD in the top bar.' });
    } else if (/reject|cancel|denied|user/i.test(msg)) {
      showToast({ kind: 'info', title: 'Publish canceled', body: 'You declined the wallet approval popup.' });
    } else {
      showToast({ kind: 'error', title: 'Publish failed', body: msg });
    }
    terminalApi().error(`Publish failed: ${msg}`);
  } finally {
    publishInflight = false;
    await renderSide();
  }
}

async function packSiteTar(siteFiles) {
  const entries = siteFiles
    .map(f => ({
      path: f.path,
      content: typeof f.content === 'string' ? f.content : (f.content || new Uint8Array(0)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return tar.pack(entries);
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function isSiteAsset(path) {
  const ext = path.split('.').pop().toLowerCase();
  return SITE_EXTENSIONS.has(ext);
}

function encodeIfText(file) {
  const ext = file.path.split('.').pop().toLowerCase();
  if (typeof file.content === 'string') {
    return new TextEncoder().encode(file.content);
  }
  if (file.content instanceof Uint8Array) return file.content;
  if (file.content) return new Uint8Array(file.content);
  return new Uint8Array(0);
}

function mimeOf(path) {
  const ext = path.split('.').pop().toLowerCase();
  switch (ext) {
    case 'html': case 'htm': return 'text/html';
    case 'css':              return 'text/css';
    case 'js': case 'mjs':   return 'application/javascript';
    case 'json':             return 'application/json';
    case 'svg':              return 'image/svg+xml';
    case 'png':              return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif':              return 'image/gif';
    case 'webp':             return 'image/webp';
    case 'ico':              return 'image/x-icon';
    case 'woff':             return 'font/woff';
    case 'woff2':            return 'font/woff2';
    case 'ttf':              return 'font/ttf';
    case 'wasm':             return 'application/wasm';
    case 'md':               return 'text/markdown';
    case 'txt':              return 'text/plain';
    default:                 return 'application/octet-stream';
  }
}

function joinPath(base, rel) {
  if (rel.startsWith('/')) return rel.replace(/^\/+/, '');
  return `${base}${rel}`;
}

function normalize(path) {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

function isValidPath(path) {
  if (typeof path !== 'string' || !path.length) return false;
  if (path.startsWith('/')) return false;
  if (path.split('/').some(seg => seg === '..')) return false;
  return /^[\w\-./@]+$/.test(path);
}

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function formatBytes(n) {
  if (!n || !Number.isFinite(n)) return '0 B';
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function escapeAttr(s) { return escapeHtml(s); }
