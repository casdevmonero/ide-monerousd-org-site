/* Toast notifications. Stacked top-right, auto-dismiss (success: 4s, error: 8s,
 * info/warning: 5s). Slide-in from right (200ms cubic-bezier). Click a toast
 * to dismiss it early. Reduced-motion users get a fade.
 *
 * API:
 *   mountToastSystem(stackEl)
 *   showToast({ kind, title, body, ttlMs?, actions? })
 */

let stackEl = null;
let nextId = 1;

const KIND_TTL = {
  success: 4000,
  info:    5000,
  warning: 7000,
  error:   8000,
};

const KIND_ICON = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9 12l2 2 4-4" /></svg>',
  error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>',
  info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v.01M12 11v6" /></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.3l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z" /><path d="M12 9v4M12 17v.01" /></svg>',
};

export function mountToastSystem(el) {
  stackEl = el;
}

export function showToast({ kind = 'info', title = '', body = '', ttlMs, actions = [] } = {}) {
  if (!stackEl) {
    console.warn('Toast system not mounted; falling back to console:', kind, title, body);
    return null;
  }
  if (!KIND_TTL[kind]) kind = 'info';

  const id = nextId++;
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.dataset.toastId = String(id);
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  const safeTitle = escapeHtml(title);
  const safeBody  = escapeHtml(body);

  node.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${KIND_ICON[kind]}</span>
    <div class="toast-body">
      ${safeTitle ? `<div class="toast-title">${safeTitle}</div>` : ''}
      ${safeBody  ? `<div class="toast-msg">${safeBody}</div>`     : ''}
      ${actions.length ? `<div class="toast-actions">${actions.map((a, i) => `<button class="toast-action" type="button" data-toast-action-idx="${i}">${escapeHtml(a.label)}</button>`).join('')}</div>` : ''}
    </div>
    <button class="toast-close" type="button" aria-label="Dismiss">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  `;

  // Wire dismiss + actions.
  const dismiss = () => {
    if (!node.isConnected) return;
    node.classList.add('toast-leaving');
    setTimeout(() => node.remove(), 180);
  };
  node.querySelector('.toast-close').addEventListener('click', dismiss);
  for (const btn of node.querySelectorAll('[data-toast-action-idx]')) {
    const idx = Number(btn.dataset.toastActionIdx);
    btn.addEventListener('click', () => {
      try { actions[idx]?.onClick?.(); } finally { dismiss(); }
    });
  }

  stackEl.appendChild(node);

  const ms = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : KIND_TTL[kind];
  setTimeout(dismiss, ms);

  return { id, dismiss };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
