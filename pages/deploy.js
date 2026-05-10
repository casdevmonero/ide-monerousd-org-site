/* Deploy & Run activity — the centerpiece.
 *
 * Side panel:    connection state + Deploy CTA + Deployed contracts list
 * Plugin panel:  selected contract's per-entrypoint Call form + on-chain state
 *
 * Flow:
 *   1. User compiles a .dsol contract (compiler.js stores bytecode + abi).
 *   2. User connects a MoneroUSD wallet (window.monerousd).
 *   3. User clicks "Deploy on-chain" → provider.deployContract(...).
 *      The wallet renders `buildOpFields('DC_DEPLOY')` (IDE-9). On approval,
 *      we receive { contractId, txHash } and add the contract to
 *      `store.deployed.contracts`.
 *   4. We poll `${indexerUrl}/v1/contracts/:contractId` per rule 17 with a
 *      tx-hash explorer link fallback if polling times out.
 *   5. User can call any entrypoint of any deployed contract (commit-reveal
 *      or direct mode). Each call is a separate approval.
 *
 * Persistence: `store.deployed.contracts` mirrors to localStorage via the
 * "monerousd-ide.deployed" key, scoped per project so different projects
 * don't see each other's contracts. State refresh is best-effort — the chain
 * is the source of truth.
 */

import * as store from '../lib/store.js';
import * as provider from '../lib/provider.js';
import { setSidePanelContent, setSideHeader }     from '../components/side-panel.js';
import { setPluginPanelContent, setPluginHeader } from '../components/plugin-panel.js';
import { showToast }     from '../components/toast.js';
import { showModal, hideModal, confirmModal } from '../components/modal.js';
import { terminalApi }   from '../components/terminal.js';
import { activateActivity } from '../lib/router.js';

let activated = false;
const POLL_DEPLOY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_500;
const STORAGE_KEY = (projectId) => `monerousd-ide.deployed.${projectId || 'no-project'}`;

export async function activate({ sideEl, pluginEl }) {
  if (!activated) {
    store.subscribe('compile',    () => render());
    store.subscribe('connection', () => render());
    store.subscribe('deployed',   () => render());
    store.subscribe('project',    (p, prev) => {
      if (p.id !== prev?.id) {
        loadDeployedFromStorage(p.id);
        render();
      }
    });
    activated = true;
    loadDeployedFromStorage(store.get('project').id);
  }
  setSideHeader('Deploy & Run');
  setPluginHeader('Deployed contracts');
  render();
}

/* ─── Render ─────────────────────────────────────────────────────────── */

function render() {
  renderSide();
  renderPlugin();
}

function renderSide() {
  const compile = store.get('compile');
  const conn = store.get('connection');
  const deployed = store.get('deployed').contracts || [];

  let connBlock;
  if (conn.status === 'connected') {
    connBlock = `
      <div class="deploy-conn ok">
        <span class="conn-dot connected"></span>
        <div class="deploy-conn-text">
          <div class="conn-headline">Connected</div>
          <code class="conn-addr" title="${escapeAttr(conn.fullAddress || '')}">${escapeHtml(conn.address || '')}</code>
        </div>
        <button data-action="disconnect-wallet" class="btn-link">Disconnect</button>
      </div>
    `;
  } else if (conn.status === 'connecting') {
    connBlock = `<div class="deploy-conn"><span class="conn-dot connecting"></span><div>Connecting…</div></div>`;
  } else if (conn.status === 'present') {
    connBlock = `
      <div class="deploy-conn">
        <span class="conn-dot present"></span>
        <div class="deploy-conn-text">
          <div class="conn-headline">Wallet detected</div>
          <div class="conn-sub">Click connect to sign deploys + calls.</div>
        </div>
        <button data-action="connect-wallet" class="btn btn-primary btn-sm">Connect MoneroUSD</button>
      </div>
    `;
  } else if (conn.status === 'error') {
    connBlock = `
      <div class="deploy-conn err">
        <span class="conn-dot error"></span>
        <div class="deploy-conn-text">
          <div class="conn-headline">Connection error</div>
          <div class="conn-sub">${escapeHtml(conn.error || 'Unknown error')}</div>
        </div>
        <button data-action="connect-wallet" class="btn btn-primary btn-sm">Retry</button>
      </div>
    `;
  } else {
    connBlock = `
      <div class="deploy-conn absent">
        <span class="conn-dot"></span>
        <div class="deploy-conn-text">
          <div class="conn-headline">No MoneroUSD wallet</div>
          <div class="conn-sub">Install the desktop wallet or the monerousd-chrome extension.</div>
        </div>
        <button data-action="connect-wallet" class="btn btn-primary btn-sm">How to install</button>
      </div>
    `;
  }

  const canDeploy = compile.status === 'ok' && conn.status === 'connected';
  const deployTitle = compile.status !== 'ok'
    ? 'Compile a .dsol file first'
    : conn.status !== 'connected'
      ? 'Connect a MoneroUSD wallet first'
      : 'Deploys go through your wallet';

  const html = `
    <div class="deploy-side">
      ${connBlock}
      <div class="deploy-cta">
        <button data-act="do-deploy" class="btn btn-primary btn-md ${canDeploy ? '' : 'soft'}" title="${escapeAttr(deployTitle)}">
          ${ICON_CLOUD}<span>Deploy on-chain</span>
        </button>
        <button data-act="goto-compiler" class="btn btn-secondary btn-sm">${ICON_HAMMER}<span>Compiler</span></button>
      </div>
      ${compile.status === 'ok' ? `
        <div class="deploy-summary">
          <div><span>Bytecode</span><code>${compile.bytecode?.length ?? 0} B</code></div>
          <div><span>codeHash</span><code title="${escapeAttr(compile.codeHash || '')}">${truncMiddle(compile.codeHash || '', 10, 6)}</code></div>
          <div><span>Entrypoints</span><code>${compile.abi?.entrypoints?.length ?? 0}</code></div>
        </div>
      ` : ''}
      <div class="deploy-list">
        <div class="deploy-list-head"><span>Deployed contracts</span><span class="muted">${deployed.length}</span></div>
        ${deployed.length ? deployed.map(renderDeployedRow).join('') : `
          <div class="deploy-list-empty">
            <p>Nothing deployed yet from this project.</p>
            <p class="muted">After deploy, contracts appear here with explorer links and per-entrypoint call forms in the right panel.</p>
          </div>
        `}
      </div>
      <div class="deploy-fineprint muted">
        Every deploy/call goes through your wallet's existing approval popup. The IDE never sees your keys.
      </div>
    </div>
  `;
  setSidePanelContent(html);

  const root = document.getElementById('side-content');
  if (!root) return;
  root.querySelector('[data-act="do-deploy"]')?.addEventListener('click', doDeploy);
  root.querySelector('[data-act="goto-compiler"]')?.addEventListener('click', () => activateActivity('compiler'));
  root.querySelectorAll('[data-act="select-contract"]').forEach(el => {
    el.addEventListener('click', () => {
      store.set('deployed', { active: el.dataset.id });
    });
  });
  root.querySelectorAll('[data-act="forget-contract"]').forEach(el => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await forgetContract(el.dataset.id);
    });
  });
  root.querySelectorAll('[data-act="explorer-link"]').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
    });
  });
}

function renderDeployedRow(c) {
  const active = store.get('deployed').active === c.contractId ? 'active' : '';
  const explorer = `https://explorer.monerousd.org/contract/${encodeURIComponent(c.contractId)}`;
  const txExplorer = c.txHash ? `https://explorer.monerousd.org/tx/${encodeURIComponent(c.txHash)}` : null;
  return `
    <div class="deploy-row ${active}" data-act="select-contract" data-id="${escapeAttr(c.contractId)}" tabindex="0">
      <div class="deploy-row-top">
        <div class="deploy-row-name">${escapeHtml(c.name || 'Contract')}</div>
        <div class="deploy-row-status">${c.status === 'pending' ? `<span class="badge pending">Pending…</span>` :
                                       c.status === 'confirmed' ? `<span class="badge ok">On-chain</span>` :
                                       c.status === 'destroyed' ? `<span class="badge gone">Destroyed</span>` :
                                       `<span class="badge">Unknown</span>`}</div>
      </div>
      <div class="deploy-row-id"><code title="${escapeAttr(c.contractId)}">${truncMiddle(c.contractId, 10, 6)}</code></div>
      <div class="deploy-row-meta">
        <span>v${escapeHtml(String(c.version || 1))}</span>
        ${c.block != null ? `<span>blk ${c.block}</span>` : ''}
        <a class="log-link" href="${explorer}" target="_blank" rel="noopener" data-act="explorer-link">Explorer ↗</a>
        ${txExplorer ? `<a class="log-link" href="${txExplorer}" target="_blank" rel="noopener" data-act="explorer-link">tx ↗</a>` : ''}
        <button class="btn-link danger" data-act="forget-contract" data-id="${escapeAttr(c.contractId)}" title="Remove from this list (chain unaffected)">Forget</button>
      </div>
    </div>
  `;
}

/* ─── Plugin (per-contract Call form + state) ────────────────────────── */

function renderPlugin() {
  const deployed = store.get('deployed').contracts || [];
  const activeId = store.get('deployed').active;
  const c = deployed.find(x => x.contractId === activeId) || deployed[0];
  if (!c) {
    setPluginPanelContent(`
      <div class="plugin-empty">
        <p>Deploy a contract or select one from the list to call its entrypoints.</p>
      </div>
    `);
    return;
  }

  const fns = c.abi?.entrypoints || [];
  const html = `
    <div class="deploy-plugin">
      <div class="deploy-plugin-head">
        <div class="deploy-plugin-title">${escapeHtml(c.name || 'Contract')}</div>
        <code class="deploy-plugin-id" title="${escapeAttr(c.contractId)}">${truncMiddle(c.contractId, 10, 6)}</code>
      </div>
      ${fns.length ? `
        <div class="call-cards">
          ${fns.map(fn => renderCallCard(c, fn)).join('')}
        </div>` : `
        <p class="abi-empty">No entrypoints in ABI.</p>
      `}
      <details class="onchain-state">
        <summary>On-chain state</summary>
        <div data-state-for="${escapeAttr(c.contractId)}" class="state-body"><em class="muted">Loading…</em></div>
      </details>
      <div class="deploy-plugin-foot">
        <button data-act="destroy" class="btn-link danger">Destroy contract (DC_DESTROY)</button>
      </div>
    </div>
  `;
  setPluginPanelContent(html);

  const root = document.getElementById('plugin-body');
  if (!root) return;
  root.querySelectorAll('form[data-call]').forEach(form => {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fnName = form.dataset.call;
      const fn = fns.find(f => f.name === fnName);
      if (!fn) return;
      const argv = collectArgs(form, fn);
      const mode = form.querySelector('select[name="mode"]')?.value || (modeFor(fn));
      doCall(c, fn, argv, mode);
    });
  });
  root.querySelector('[data-act="destroy"]')?.addEventListener('click', () => doDestroy(c));

  // Kick off state fetch.
  void refreshState(c).catch(err => {
    const slot = root.querySelector(`[data-state-for="${cssAttrEsc(c.contractId)}"]`);
    if (slot) slot.innerHTML = `<em class="muted">State unavailable: ${escapeHtml(err.message)}</em>`;
  });
}

function renderCallCard(contract, fn) {
  // The compiler ABI (lib/dsol-compiler.js, search "entrypoints.push") emits
  // entries shaped as:
  //   { name, selector, batch: boolean, highRisk: boolean, returns, args: [{name,type}] }
  // No `params` field, no `attrs` field. We derive UI flags from `batch` /
  // `highRisk`, and we synthesize `@batch` / `@direct` / `@highrisk` tag
  // strings purely for display so the user sees the same syntax they wrote.
  const args = fn.args || [];
  const defaultMode = modeFor(fn);
  const showMode = fn.batch === true;
  const tags = [
    fn.batch ? '@batch' : '@direct',
    ...(fn.highRisk ? ['@highrisk'] : []),
  ];
  return `
    <form class="call-card" data-call="${escapeAttr(fn.name)}">
      <div class="call-card-head">
        <span class="abi-name">${escapeHtml(fn.name)}</span>
        <span class="abi-params">(${args.map(a => `${escapeHtml(a.type)} ${escapeHtml(a.name)}`).join(', ')})</span>
        <span class="abi-tags">${tags.map(t => `<span class="abi-tag">${escapeHtml(t)}</span>`).join('')}</span>
      </div>
      ${args.length ? `<div class="call-args">
        ${args.map((a) => `
          <label class="form-row">
            <span>${escapeHtml(a.name)}<small>${escapeHtml(a.type)}</small></span>
            <input name="${escapeAttr(a.name)}" type="text" autocomplete="off" data-type="${escapeAttr(a.type)}">
          </label>`).join('')}
      </div>` : ''}
      ${showMode ? `<label class="form-row">
        <span>Mode</span>
        <select name="mode">
          <option value="commit-reveal" ${defaultMode === 'commit-reveal' ? 'selected' : ''}>Commit-reveal</option>
          <option value="direct" ${defaultMode === 'direct' ? 'selected' : ''}>Direct</option>
        </select>
      </label>` : ''}
      <div class="call-foot">
        <button type="submit" class="btn btn-primary btn-sm">${ICON_BOLT}<span>Call</span></button>
      </div>
    </form>
  `;
}

/* ─── Actions ────────────────────────────────────────────────────────── */

async function doDeploy() {
  const compile = store.get('compile');
  if (compile.status !== 'ok') {
    showToast({ kind: 'warning', title: 'Compile first' });
    return;
  }
  const conn = store.get('connection');
  if (conn.status !== 'connected') {
    showToast({ kind: 'warning', title: 'Connect a MoneroUSD wallet first' });
    return;
  }
  const name = compile.abi?.name || 'Contract';
  showToast({ kind: 'info', title: `Deploying ${name}…`, body: 'Approve in your wallet popup.' });
  terminalApi().info(`Deploy → wallet popup for ${name} (${compile.bytecode.length} B, codeHash ${truncMiddle(compile.codeHash, 8, 4)})`);
  let res;
  try {
    res = await provider.deployContract({
      bytecode: compile.bytecode,
      abi:      compile.abi,
      codeHash: compile.codeHash,
      name,
    });
  } catch (err) {
    if (err?.name === 'ProviderUnavailableError' || err?.name === 'NotConnectedError') {
      showToast({ kind: 'error', title: 'Wallet not available', body: err.message });
    } else if (/reject|cancel|denied|user/i.test(String(err?.message))) {
      showToast({ kind: 'info', title: 'Deploy canceled' });
    } else {
      showToast({ kind: 'error', title: 'Deploy failed', body: err?.message || String(err) });
      terminalApi().error(`Deploy failed: ${err?.message || err}`);
    }
    return;
  }
  if (!res?.contractId) {
    showToast({ kind: 'error', title: 'Deploy returned no contractId', body: JSON.stringify(res || {}) });
    terminalApi().error('Deploy returned no contractId — wallet contract.');
    return;
  }
  const contract = {
    contractId: res.contractId,
    txHash:     res.txHash || null,
    name:       name,
    abi:        compile.abi,
    codeHash:   compile.codeHash,
    bytecodeSize: compile.bytecode?.length ?? 0,
    version:    1,
    block:      null,
    status:     'pending',
    deployedAt: Date.now(),
    onChainState: null,
  };
  appendDeployed(contract);
  showToast({ kind: 'success', title: 'Deploy broadcast', body: `tx ${truncMiddle(res.txHash || res.contractId, 8, 4)}` });
  terminalApi().success(`Deploy submitted — contractId ${truncMiddle(res.contractId, 10, 6)}, tx ${truncMiddle(res.txHash || '', 8, 4)}`);
  // Poll for materialization.
  void pollContractMaterialization(contract);
}

async function doCall(contract, fn, argv, mode) {
  const conn = store.get('connection');
  if (conn.status !== 'connected') {
    showToast({ kind: 'warning', title: 'Connect a MoneroUSD wallet first' });
    return;
  }
  showToast({ kind: 'info', title: `Calling ${fn.name}()…`, body: 'Approve in your wallet popup.' });
  terminalApi().info(`Call → ${contract.name}.${fn.name}(${argv.length} args) mode=${mode} — wallet popup`);
  let res;
  try {
    res = await provider.callContract({
      contractId: contract.contractId,
      entrypoint: fn.name,
      argv,
      mode,
    });
  } catch (err) {
    if (/reject|cancel|denied|user/i.test(String(err?.message))) {
      showToast({ kind: 'info', title: 'Call canceled' });
    } else {
      showToast({ kind: 'error', title: 'Call failed', body: err?.message || String(err) });
      terminalApi().error(`Call ${fn.name}() failed: ${err?.message || err}`);
    }
    return;
  }
  showToast({ kind: 'success', title: `Call broadcast`, body: `tx ${truncMiddle(res.txHash || '', 8, 4)}` });
  terminalApi().success(`Call ${fn.name}() submitted — tx ${truncMiddle(res.txHash || '', 8, 4)}`);
  // Refresh state shortly.
  setTimeout(() => { void refreshState(contract); }, 4_000);
}

async function doDestroy(contract) {
  const ok = await confirmModal({
    title: 'Destroy contract?',
    body: `<p>Destroying <strong>${escapeHtml(contract.name)}</strong> emits a DC_DESTROY op on chain. The contract will no longer accept calls.</p>
           <p style="color:var(--text-muted);font-size:var(--fs-xs);">This requires your wallet's approval. State up to this point is preserved on-chain (auditable in the explorer).</p>`,
    danger: true,
    confirmLabel: 'Destroy',
  });
  if (!ok) return;
  try {
    const res = await provider.destroyContract({ contractId: contract.contractId });
    showToast({ kind: 'success', title: 'Destroy broadcast', body: `tx ${truncMiddle(res?.txHash || '', 8, 4)}` });
    contract.status = 'destroyed';
    persistDeployed();
    render();
  } catch (err) {
    if (/reject|cancel|denied|user/i.test(String(err?.message))) {
      showToast({ kind: 'info', title: 'Destroy canceled' });
    } else {
      showToast({ kind: 'error', title: 'Destroy failed', body: err?.message || String(err) });
    }
  }
}

async function forgetContract(contractId) {
  const ok = await confirmModal({
    title: 'Forget this contract?',
    body: `<p>Remove from this list. The contract on-chain is unaffected — you can re-add it later.</p>`,
    confirmLabel: 'Remove',
  });
  if (!ok) return;
  const list = (store.get('deployed').contracts || []).filter(c => c.contractId !== contractId);
  store.set('deployed', {
    contracts: list,
    active: list[0]?.contractId || null,
  });
  persistDeployed();
  showToast({ kind: 'info', title: 'Removed from list' });
}

/* ─── Polling materialization (rule 17) ──────────────────────────────── */

async function pollContractMaterialization(contract) {
  const indexerUrl = store.get('settings').indexerUrl;
  const start = Date.now();
  while (Date.now() - start < POLL_DEPLOY_TIMEOUT_MS) {
    try {
      const r = await fetch(`${indexerUrl}/v1/contracts/${encodeURIComponent(contract.contractId)}`, {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.contractId === contract.contractId) {
          contract.status = 'confirmed';
          contract.block = j.block ?? contract.block;
          contract.version = j.version ?? contract.version;
          persistDeployed();
          render();
          terminalApi().success(`Materialized ${truncMiddle(contract.contractId, 10, 6)} — blk ${contract.block}`);
          showToast({ kind: 'success', title: 'On-chain', body: `${contract.name} live at blk ${contract.block}` });
          return;
        }
      }
    } catch { /* network blip */ }
    await sleep(POLL_INTERVAL_MS);
  }
  // Timed out — fall back to explorer link per rule 17.
  terminalApi().warn(`Polling for ${truncMiddle(contract.contractId, 10, 6)} timed out — verify in explorer.`);
  showModal({
    title: 'Still confirming…',
    body: `<p>Your contract has been broadcast but hasn't been seen by the indexer yet.</p>
           <p>Tx: <code>${escapeHtml(contract.txHash || 'unknown')}</code></p>
           <p>Open the <a href="https://explorer.monerousd.org/tx/${encodeURIComponent(contract.txHash || '')}" target="_blank" rel="noopener">explorer</a> to track confirmation. Once mined, the contract will appear here automatically on the next refresh.</p>`,
    actions: [{ label: 'OK', kind: 'primary', onClick: hideModal }],
  });
}

async function refreshState(contract) {
  const indexerUrl = store.get('settings').indexerUrl;
  const root = document.getElementById('plugin-body');
  const slot = root?.querySelector(`[data-state-for="${cssAttrEsc(contract.contractId)}"]`);
  if (!slot) return;
  try {
    const r = await fetch(`${indexerUrl}/v1/contracts/${encodeURIComponent(contract.contractId)}/state`, {
      headers: { 'Accept': 'application/json' }, cache: 'no-store',
    });
    if (!r.ok) {
      slot.innerHTML = `<em class="muted">No state available (HTTP ${r.status})</em>`;
      return;
    }
    const j = await r.json();
    contract.onChainState = j;
    slot.innerHTML = renderStateMap(j);
  } catch (err) {
    slot.innerHTML = `<em class="muted">State unavailable: ${escapeHtml(err.message)}</em>`;
  }
}

function renderStateMap(j) {
  const slots = j?.slots || j?.state || {};
  const entries = Object.entries(slots);
  if (!entries.length) return `<em class="muted">No state slots populated yet.</em>`;
  return `<ul class="abi-list">${entries.map(([k, v]) => `
    <li class="abi-item">
      <div class="abi-sig">
        <span class="abi-name" title="${escapeAttr(k)}">${truncMiddle(k, 8, 6)}</span>
        <span class="abi-params">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>
      </div>
    </li>`).join('')}</ul>`;
}

/* ─── Storage ─────────────────────────────────────────────────────────── */

function appendDeployed(contract) {
  const cur = store.get('deployed');
  const list = [contract, ...(cur.contracts || []).filter(c => c.contractId !== contract.contractId)];
  store.set('deployed', { contracts: list, active: contract.contractId });
  persistDeployed();
}

function persistDeployed() {
  try {
    const projectId = store.get('project').id;
    const list = store.get('deployed').contracts || [];
    // Strip non-serializable fields (e.g. function refs in abi.sourceMap).
    const safe = list.map(c => ({
      contractId: c.contractId,
      txHash: c.txHash,
      name: c.name,
      abi: c.abi,
      codeHash: c.codeHash,
      bytecodeSize: c.bytecodeSize,
      version: c.version,
      block: c.block,
      status: c.status,
      deployedAt: c.deployedAt,
    }));
    localStorage.setItem(STORAGE_KEY(projectId), JSON.stringify(safe));
  } catch { /* private mode — ignore */ }
}

function loadDeployedFromStorage(projectId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(projectId));
    if (!raw) {
      store.set('deployed', { contracts: [], active: null });
      return;
    }
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    store.set('deployed', { contracts: list, active: list[0]?.contractId || null });
  } catch { /* ignore */ }
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function modeFor(fn) {
  // Default to commit-reveal for @batch entrypoints (which can mutate
  // private state) and direct for @direct (read-only / non-mutating).
  // The compiler ABI exposes this as a boolean: see the renderCallCard
  // header comment.
  return fn.batch ? 'commit-reveal' : 'direct';
}

function collectArgs(form, fn) {
  const out = [];
  for (const a of (fn.args || [])) {
    const inp = form.querySelector(`input[name="${cssAttrEsc(a.name)}"]`);
    const raw = (inp?.value || '').trim();
    out.push(parseArg(raw, a.type));
  }
  return out;
}

function parseArg(raw, type) {
  if (/^u?int(8|16|32|64|128|256)$/.test(type)) {
    return { tag: 'u64', value: raw === '' ? '0' : raw };
  }
  if (type === 'bool') return { tag: 'u64', value: raw && raw !== 'false' && raw !== '0' ? '1' : '0' };
  return { tag: type === 'stealth' ? 'stealth' : 'bytes', value: raw };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function truncMiddle(s, head, tail) {
  if (!s) return '—';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function cssAttrEsc(s) { return String(s).replace(/[^\w-]/g, '_'); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }

const ICON_CLOUD  = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 16h2a4 4 0 0 0 0-8 6 6 0 0 0-11.6-1.5A4.5 4.5 0 0 0 7 16h2"/><path d="M12 12v9M9 18l3 3 3-3"/></svg>';
const ICON_HAMMER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3l7 7M10 7l4-4 7 7-4 4-7-7zM3 21l8-8"/></svg>';
const ICON_BOLT   = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>';
