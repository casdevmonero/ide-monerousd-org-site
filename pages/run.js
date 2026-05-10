/* Run activity — execute the compiled contract against the in-page DarkVM.
 *
 * Side panel:    per-entrypoint argv form + Run button + reset state
 * Plugin panel:  result diff (state + events + gas + steps)
 *
 * IDE-2: VM state is ephemeral — `Map<entrypoint, slots>` lives in this
 *        module and clears when the user clicks Reset, when the project
 *        switches, or when the bytecode changes (compile invalidates).
 *
 * IDE-8: We only feed the VM (bytecode, entrypoint, argv, host) — the host
 *        is constructed locally via vm.makeLocalHost(). User input never
 *        becomes a host callback.
 */

import * as store from '../lib/store.js';
import * as vm    from '../lib/vm.js';
import { setSidePanelContent, setSideHeader }     from '../components/side-panel.js';
import { setPluginPanelContent, setPluginHeader } from '../components/plugin-panel.js';
import { showToast }     from '../components/toast.js';
import { terminalApi }   from '../components/terminal.js';
import { activateActivity } from '../lib/router.js';

let activated = false;
let runStateRef = { state: new Map(), nullifiers: new Set() };
let lastBytecodeHash = null;

export async function activate({ sideEl, pluginEl }) {
  if (!activated) {
    store.subscribe('compile', () => render());
    store.subscribe('localVm', () => renderResult());
    store.subscribe('project', (p, prev) => {
      // Clear local VM state when project changes (IDE-2).
      if (p.id !== prev?.id) resetLocalState();
    });
    activated = true;
  }
  setSideHeader('Run (local VM)');
  setPluginHeader('Local state');
  // If bytecode changed since last activation, drop state.
  const c = store.get('compile');
  if (c.codeHash !== lastBytecodeHash) {
    resetLocalState();
    lastBytecodeHash = c.codeHash;
  }
  render();
  renderResult();
}

/* ─── Render ─────────────────────────────────────────────────────────── */

function render() {
  const c = store.get('compile');
  if (c.status !== 'ok' || !c.abi) {
    setSidePanelContent(`
      <div class="run-empty">
        <div class="run-empty-illus">${ICON_PLAY_BIG}</div>
        <div class="run-empty-title">No compiled contract</div>
        <div class="run-empty-body">Compile a <code>.dsol</code> file first to see entrypoint forms.</div>
        <div class="run-empty-actions">
          <button data-act="goto-compiler" class="btn btn-primary btn-sm">${ICON_HAMMER}<span>Open Compiler</span></button>
        </div>
      </div>
    `);
    document.getElementById('side-content')?.querySelector('[data-act="goto-compiler"]')
      ?.addEventListener('click', () => activateActivity('compiler'));
    return;
  }
  const fns = c.abi.entrypoints || [];
  if (!fns.length) {
    setSidePanelContent(`<div class="run-empty"><p>This contract has no entrypoints to run.</p></div>`);
    return;
  }
  const html = `
    <div class="run-side">
      <div class="run-banner" role="note">
        <strong>Preview only.</strong> This is a read-only DarkVM. Pedersen / range-proof / nullifier crypto is stubbed; deployments are unaffected. Use <em>Deploy &amp; Run</em> for real chain calls.
      </div>
      <div class="run-actions-top">
        <button data-act="reset-state" class="btn btn-secondary btn-sm" title="Clear local state">${ICON_REFRESH}<span>Reset state</span></button>
      </div>
      ${fns.map(fn => renderFunctionCard(fn)).join('')}
    </div>
  `;
  setSidePanelContent(html);

  const root = document.getElementById('side-content');
  if (!root) return;
  root.querySelector('[data-act="reset-state"]')?.addEventListener('click', () => {
    resetLocalState();
    showToast({ kind: 'info', title: 'Local VM state cleared' });
    render();
    renderResult();
  });
  root.querySelectorAll('form[data-fn]').forEach(form => {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fnName = form.dataset.fn;
      const fn = fns.find(f => f.name === fnName);
      if (!fn) return;
      const argv = collectArgs(form, fn);
      runEntrypoint(fn, argv);
    });
  });
}

function renderFunctionCard(fn) {
  // Compiler ABI shape: { name, selector, batch, highRisk, returns, args }.
  // No `params`, no `attrs` — derive @batch/@direct/@highrisk tags from
  // the booleans for display.
  const args = fn.args || [];
  const tags = [
    fn.batch ? '@batch' : '@direct',
    ...(fn.highRisk ? ['@highrisk'] : []),
  ];
  return `
    <form class="run-card" data-fn="${escapeAttr(fn.name)}">
      <div class="run-card-head">
        <div class="run-card-title">
          <span class="abi-name">${escapeHtml(fn.name)}</span>
          <span class="abi-params">(${args.map(a => `${escapeHtml(a.type)} ${escapeHtml(a.name)}`).join(', ')})</span>
        </div>
        <div class="abi-tags">
          ${tags.map(t => `<span class="abi-tag">${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
      ${args.length
        ? `<div class="run-card-args">
            ${args.map((a, i) => renderArgInput(a, i)).join('')}
          </div>`
        : ''
      }
      <div class="run-card-foot">
        <button type="submit" class="btn btn-primary btn-sm">${ICON_PLAY}<span>Run</span></button>
      </div>
    </form>
  `;
}

function renderArgInput(arg, i) {
  const id = `arg-${i}-${arg.name}`;
  const placeholder = isU64Type(arg.type) ? '0' : 'hex or text';
  return `
    <label class="form-row" for="${escapeAttr(id)}">
      <span>${escapeHtml(arg.name)}<small>${escapeHtml(arg.type)}</small></span>
      <input id="${escapeAttr(id)}" name="${escapeAttr(arg.name)}" type="text" placeholder="${escapeAttr(placeholder)}" data-type="${escapeAttr(arg.type)}" autocomplete="off">
    </label>
  `;
}

/* ─── Result panel ───────────────────────────────────────────────────── */

function renderResult() {
  const lv = store.get('localVm');
  if (!lv || (lv.events.length === 0 && lv.stepCount === 0 && (!lv.state || (lv.state.size === 0)))) {
    setPluginPanelContent(`
      <div class="plugin-empty">
        <p>Run an entrypoint to see effects.</p>
        <p style="margin-top:var(--space-2);color:var(--text-muted);font-size:var(--fs-xs)">State persists across runs in this tab — click Reset to clear.</p>
      </div>
    `);
    return;
  }
  const slots = [...(lv.state instanceof Map ? lv.state.entries() : Object.entries(lv.state || {}))];
  const html = `
    <div class="run-result">
      <div class="run-stats">
        <div class="stat"><span>Last result</span><strong class="${lv.lastError ? 'err' : 'ok'}">${lv.lastError ? '✗ Reverted' : '✓ Success'}</strong></div>
        <div class="stat"><span>Steps</span><strong>${lv.stepCount.toLocaleString()}</strong></div>
        <div class="stat"><span>Gas (synthetic)</span><strong>${String(lv.gasUsed)}</strong></div>
        <div class="stat"><span>Slots written</span><strong>${slots.length}</strong></div>
      </div>
      ${lv.lastError ? `<div class="run-error">${escapeHtml(lv.lastError)}</div>` : ''}
      ${lv.lastReturn?.length ? `<details open>
        <summary>Returns (${lv.lastReturn.length})</summary>
        <ul class="abi-list">
          ${lv.lastReturn.map((r, i) => `<li class="abi-item"><div class="abi-sig"><span class="abi-name">[${i}]</span><span class="abi-params">${escapeHtml(formatStackVal(r))}</span></div></li>`).join('')}
        </ul>
      </details>` : ''}
      ${lv.events?.length ? `<details open>
        <summary>Events (${lv.events.length})</summary>
        <ul class="abi-list">
          ${lv.events.map(e => `<li class="abi-item"><div class="abi-sig"><span class="abi-name">${escapeHtml(e.topic || 'event')}</span><span class="abi-params">${escapeHtml(formatStackVal(e.data))}</span></div></li>`).join('')}
        </ul>
      </details>` : ''}
      <details ${slots.length ? 'open' : ''}>
        <summary>State (${slots.length} slot${slots.length === 1 ? '' : 's'})</summary>
        ${slots.length ? `<ul class="abi-list">
          ${slots.map(([k, v]) => `<li class="abi-item">
            <div class="abi-sig">
              <span class="abi-name" title="${escapeAttr(k)}">${truncMiddle(k, 8, 6)}</span>
              <span class="abi-params">${escapeHtml(typeof v === 'object' ? (v.value || JSON.stringify(v)) : String(v))}</span>
            </div>
            <div class="abi-tags">${(v?.isPrivate) ? '<span class="abi-tag">private</span>' : ''}</div>
          </li>`).join('')}
        </ul>` : '<p class="abi-empty">No state yet.</p>'}
      </details>
    </div>
  `;
  setPluginPanelContent(html);
}

/* ─── Run logic ───────────────────────────────────────────────────────── */

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
  if (isU64Type(type)) {
    const n = raw === '' ? 0n : BigInt(raw);
    return { tag: 'u64', value: n };
  }
  // bool → 0/1 u64
  if (type === 'bool') return { tag: 'u64', value: BigInt(raw && raw !== 'false' && raw !== '0' ? 1 : 0) };
  // hex bytes
  if (raw.startsWith('0x') || /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 && raw.length > 0) {
    const hex = raw.replace(/^0x/, '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return { tag: type === 'stealth' ? 'stealth' : 'bytes', value: bytes };
  }
  // utf-8 fallback
  return { tag: type === 'stealth' ? 'stealth' : 'bytes', value: new TextEncoder().encode(raw) };
}

function isU64Type(t) {
  return /^u?int(8|16|32|64|128|256)$/.test(t);
}

function runEntrypoint(fn, argv) {
  const c = store.get('compile');
  if (!c.bytecode) {
    showToast({ kind: 'error', title: 'No bytecode', body: 'Compile first.' });
    return;
  }
  const host = vm.makeLocalHost({
    ctx: { msgSender: 'local-preview', blockNumber: 0, contractId: 'dc1_local_preview', txHash: 'preview' },
    state: runStateRef.state,
  });
  let result;
  const start = performance.now();
  try {
    result = vm.execute({
      bytecode:   c.bytecode,
      entrypoint: fn.name,
      args:       argv,
      ctx:        host.ctx,
      loadSlot:   host.loadSlot,
      storeSlot:  host.storeSlot,
      syscall:    host.syscall,
      emitNullifier: host.emitNullifier,
      emitLog:    (topic, data) => host.events?.push({ topic, data }),
    });
  } catch (err) {
    result = { ok: false, error: err.message, reverted: true, stepsUsed: 0 };
  }
  const elapsed = Math.round(performance.now() - start);

  // Commit storage writes back to the persistent host state.
  //
  // vm.execute() does NOT invoke the host.storeSlot callback during
  // execution — it buffers writes into an internal pendingWrites Map
  // and only flushes them, as `result.diffs`, on a successful RETURN
  // (vm.js:353-356). That mirrors the on-chain semantic: a reverted
  // call produces zero state writes, a successful call produces a
  // single atomic batch.
  //
  // The caller's job is to apply that batch to the persistent state
  // map (host.state === runStateRef.state) so subsequent runs in the
  // same tab see the writes. Skipping this would leave host.state
  // empty forever — every Run would render "Slots written: 0" no
  // matter what the bytecode actually wrote, which is exactly the
  // regression the local-vm-run e2e spec catches.
  if (result.ok && Array.isArray(result.diffs)) {
    for (const d of result.diffs) {
      host.state.set(d.slot, { value: d.value, isPrivate: !!d.isPrivate });
    }
  }

  // Pull events / state from the VM result.
  const events = (result.logs || []).map(l => ({ topic: l.topic, data: l.data }));
  store.set('localVm', {
    state:     host.state,
    events:    events,
    gasUsed:   BigInt(result.stepsUsed || 0),
    stepCount: result.stepsUsed || 0,
    lastError: result.ok ? null : (result.error || 'Reverted'),
    lastReturn: result.returns || result.stack || [],
  });

  if (result.ok) {
    terminalApi().success(`Run ${fn.name}() — ${result.stepsUsed || 0} steps in ${elapsed} ms`);
  } else {
    terminalApi().error(`Run ${fn.name}() reverted: ${result.error || '(unknown)'}`);
  }
}

function resetLocalState() {
  runStateRef = { state: new Map(), nullifiers: new Set() };
  store.set('localVm', {
    state: new Map(),
    events: [],
    gasUsed: 0n,
    stepCount: 0,
    lastError: null,
    lastReturn: [],
  });
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function formatStackVal(v) {
  if (v == null) return '—';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) {
    let s = '';
    for (let i = 0; i < v.length; i++) s += v[i].toString(16).padStart(2, '0');
    return '0x' + s;
  }
  if (v?.t === 'u64') return String(v.v);
  if (v?.t === 'bytes') return formatStackVal(v.v);
  return JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);
}

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

const ICON_PLAY     = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PLAY_BIG = '<svg viewBox="0 0 200 200" width="140" height="140" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="100" cy="100" r="70"/><path d="M85 75l40 25-40 25z" fill="var(--accent)" stroke="none"/></svg>';
const ICON_REFRESH  = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>';
const ICON_HAMMER   = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3l7 7M10 7l4-4 7 7-4 4-7-7zM3 21l8-8"/></svg>';
