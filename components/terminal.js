/* Terminal — append-only log surface. Two tabs: Output (info/success/error)
 * and Problems (compile errors only). Filter input narrows visible rows.
 *
 * No node-pty, no shell — this is purely a log panel. */

import * as store from '../lib/store.js';

let dom = null;
let lines = [];     // {kind, msg, ts, tab}
let problems = [];  // structured compile errors
let resizeStart = null;

const MAX_LINES = 5000;

export function mountTerminal({ body, resizeHandle, filterInput, countOut, countErr }) {
  dom = { body, resizeHandle, filterInput, countOut, countErr };

  filterInput.addEventListener('input', () => {
    render();
  });

  // Resize handle.
  resizeHandle.addEventListener('mousedown', (ev) => {
    resizeStart = {
      y: ev.clientY,
      h: parseInt(getComputedStyle(document.getElementById('terminal')).height, 10) || 220,
    };
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('mousemove', onResize);
    window.addEventListener('mouseup', stopResize, { once: true });
    ev.preventDefault();
  });
  function onResize(ev) {
    if (!resizeStart) return;
    const dy = resizeStart.y - ev.clientY;
    const next = Math.min(Math.max(120, resizeStart.h + dy), Math.floor(window.innerHeight * 0.75));
    document.getElementById('terminal').style.setProperty('--terminal-height', `${next}px`);
    document.getElementById('terminal').style.height = `${next}px`;
  }
  function stopResize() {
    resizeStart = null;
    document.body.style.cursor = '';
    window.removeEventListener('mousemove', onResize);
  }

  store.subscribe('ui', (u) => {
    document.getElementById('terminal').dataset.hidden = String(!u.terminalOpen);
    render();
  });
}

function pushLine(line) {
  lines.push({ ...line, ts: Date.now() });
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  render();
}

function render() {
  if (!dom?.body) return;
  const tab = store.get('ui').terminalTab || 'output';
  const filter = (dom.filterInput?.value || '').toLowerCase();

  let visible;
  if (tab === 'problems') {
    visible = problems
      .filter(p => !filter || p.message.toLowerCase().includes(filter) || (p.file || '').toLowerCase().includes(filter))
      .map(p => ({
        kind: p.severity === 'warning' ? 'warning' : 'error',
        msg: `${p.file ? `${p.file}:${p.line}:${p.col} ` : ''}${p.message}`,
      }));
  } else {
    visible = lines
      .filter(l => !filter || l.msg.toLowerCase().includes(filter));
  }

  if (!visible.length) {
    dom.body.dataset.empty = 'true';
    dom.body.innerHTML = (tab === 'problems')
      ? '<div class="terminal-empty">No problems detected.</div>'
      : '<div class="terminal-empty">Terminal output will appear here.</div>';
  } else {
    dom.body.dataset.empty = 'false';
    dom.body.innerHTML = visible.map(l => `<div class="line line-${l.kind}">${prefix(l.kind)}<span>${escapeForLog(l.msg)}</span></div>`).join('');
    dom.body.scrollTop = dom.body.scrollHeight;
  }

  if (dom.countOut) dom.countOut.textContent = String(lines.length);
  if (dom.countErr) {
    const errs = problems.filter(p => p.severity !== 'warning').length;
    dom.countErr.textContent = String(errs);
    dom.countErr.style.display = errs ? '' : 'none';
  }
}

function prefix(kind) {
  switch (kind) {
    case 'success': return '<span class="line-prefix line-prefix-ok">✓</span>';
    case 'error':   return '<span class="line-prefix line-prefix-err">✗</span>';
    case 'warning': return '<span class="line-prefix line-prefix-warn">!</span>';
    case 'info':
    default:        return '<span class="line-prefix line-prefix-info">›</span>';
  }
}

/* Linkify tx hashes / contract IDs / domains in log lines. */
function escapeForLog(s) {
  // First HTML-escape, then safely linkify recognized ID prefixes.
  let safe = String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  // tx hashes (64 hex chars)
  safe = safe.replace(/\b([0-9a-f]{64})\b/gi, (_, h) =>
    `<a class="log-link" href="https://explorer.monerousd.org/tx/${h}" target="_blank" rel="noopener">${h.slice(0,8)}…${h.slice(-4)}</a>`);
  // dc1_ contract ids
  safe = safe.replace(/\b(dc1_[a-z0-9]{12,})\b/g, (_, id) =>
    `<a class="log-link" href="https://explorer.monerousd.org/contract/${id}" target="_blank" rel="noopener">${id}</a>`);
  return safe;
}

/* ─── Public API ─── */
export function terminalApi() {
  return {
    info:    (msg) => pushLine({ kind: 'info',    msg }),
    success: (msg) => pushLine({ kind: 'success', msg }),
    warn:    (msg) => pushLine({ kind: 'warning', msg }),
    error:   (msg) => pushLine({ kind: 'error',   msg }),
    raw:     (msg) => pushLine({ kind: 'info',    msg }),
    setProblems: (list) => {
      problems = Array.isArray(list) ? list : [];
      render();
    },
    setTab: (t) => {
      store.set('ui', { terminalTab: t });
      render();
    },
    clear: () => {
      const tab = store.get('ui').terminalTab || 'output';
      if (tab === 'problems') problems = [];
      else lines = [];
      render();
    },
    getLines: () => [...lines],
  };
}
