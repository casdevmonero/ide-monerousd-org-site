/* Connect/disconnect button in the top bar.
 * Reflects connection store state instantly — no race where button says
 * "Connect" while pill says "Connected". */

import * as store from '../lib/store.js';
import * as conn  from '../lib/connection-store.js';
import { showToast } from './toast.js';
import { showModal, hideModal } from './modal.js';

let btnEl = null;

export function mountConnectButton(el) {
  btnEl = el;
  store.subscribe('connection', render);
  render(store.get('connection'));

  btnEl.addEventListener('click', async () => {
    const c = store.get('connection');
    if (c.status === 'connected') {
      // Show a small menu modal: address + Disconnect / Copy.
      showModal({
        title: 'Connected',
        body: `<div class="connected-info">
                 <div class="connected-row"><span>Address</span><code>${escapeHtml(c.fullAddress || c.address || '')}</code></div>
                 <div class="connected-row"><span>Transport</span><code>${escapeHtml(c.transport || '—')}</code></div>
                 <div class="connected-row"><span>Network</span><code>${escapeHtml(c.network || 'unknown')}</code></div>
               </div>`,
        actions: [
          { label: 'Copy address', kind: 'secondary', onClick: () => {
              navigator.clipboard?.writeText(c.fullAddress || '').then(() => {
                showToast({ kind: 'success', title: 'Address copied' });
              });
            } },
          { label: 'Disconnect', kind: 'danger', onClick: async () => {
              await conn.disconnect();
              hideModal();
              showToast({ kind: 'info', title: 'Disconnected' });
            } },
          { label: 'Close', kind: 'secondary', onClick: hideModal },
        ],
      });
      return;
    }

    if (c.status === 'absent') {
      // Provider absent — guide install.
      showModal({
        title: 'Install a MoneroUSD wallet',
        body: `
          <p>To deploy contracts and publish sites, install one of:</p>
          <ul class="install-list">
            <li>
              <strong>MoneroUSD desktop wallet</strong> — full-featured + sovereign hosting + launchpad.
              <br><a href="https://monerousd.org/download" target="_blank" rel="noopener">Download</a>
            </li>
            <li>
              <strong>monerousd-chrome</strong> — companion-mode extension that injects <code>window.monerousd</code>.
              <br><a href="https://chrome.google.com/webstore/detail/monerousd" target="_blank" rel="noopener">Chrome Web Store</a>
            </li>
          </ul>
          <p style="color:var(--text-muted); font-size:var(--fs-xs); margin-top:var(--space-3)">
            Reading, compiling, and local-VM runs work without a wallet.
          </p>`,
        actions: [{ label: 'Got it', kind: 'primary', onClick: hideModal }],
      });
      return;
    }

    // Otherwise — request connection.
    try {
      await conn.connect();
      showToast({ kind: 'success', title: 'Connected' });
    } catch (err) {
      const msg = err?.message || String(err);
      showToast({ kind: 'error', title: 'Connect failed', body: msg });
    }
  });
}

function render(c) {
  if (!btnEl) return;
  btnEl.classList.remove('connected', 'connecting', 'absent', 'present', 'error');
  switch (c.status) {
    case 'connected':
      btnEl.classList.add('connected');
      btnEl.innerHTML = `
        <span class="conn-dot connected"></span>
        <span>${escapeHtml(c.address || 'Connected')}</span>`;
      btnEl.setAttribute('aria-label', 'Connected — click for details');
      btnEl.title = c.fullAddress || '';
      break;
    case 'connecting':
      btnEl.classList.add('connecting');
      btnEl.innerHTML = `<span class="conn-dot connecting"></span><span>Connecting…</span>`;
      break;
    case 'present':
      btnEl.classList.add('present');
      btnEl.innerHTML = `<span class="conn-dot present"></span><span>Connect MoneroUSD</span>`;
      break;
    case 'error':
      btnEl.classList.add('error');
      btnEl.innerHTML = `<span class="conn-dot error"></span><span>Retry connect</span>`;
      btnEl.title = c.error || '';
      break;
    default:
      btnEl.classList.add('absent');
      btnEl.innerHTML = `<span class="conn-dot"></span><span>Connect MoneroUSD</span>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
