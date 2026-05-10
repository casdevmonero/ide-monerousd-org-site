/* Modal dialog. Centered, backdrop-blurred, focus-trapped.
 *
 * API:
 *   mountModalSystem(rootEl)
 *   showModal({ title, body, actions, onClose })
 *      body may be a string (HTML) or a DOM Node.
 *      actions: [{ label, kind?: 'primary'|'secondary'|'danger', onClick }]
 *   hideModal()
 */

let rootEl = null;
let lastFocus = null;
let activeOnClose = null;

export function mountModalSystem(el) {
  rootEl = el;
  rootEl.addEventListener('click', (ev) => {
    if (ev.target === rootEl) hideModal();
  });
}

export function showModal({ title = '', body = '', actions = [], onClose, size = 'md' } = {}) {
  if (!rootEl) throw new Error('mountModalSystem not called');
  hideModal({ silent: true });

  lastFocus = document.activeElement;
  activeOnClose = onClose || null;

  const dialog = document.createElement('div');
  dialog.className = `modal modal-${size}`;
  dialog.setAttribute('role', 'document');

  // Header
  const head = document.createElement('header');
  head.className = 'modal-head';
  head.innerHTML = `
    <div class="modal-title">${escapeHtml(title)}</div>
    <button class="modal-close" type="button" aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>`;
  head.querySelector('.modal-close').addEventListener('click', hideModal);

  // Body
  const bodyEl = document.createElement('div');
  bodyEl.className = 'modal-body';
  if (body instanceof Node) {
    bodyEl.appendChild(body);
  } else {
    bodyEl.innerHTML = body;
  }

  // Actions
  const actionsEl = document.createElement('div');
  actionsEl.className = 'modal-actions';
  if (actions.length === 0) {
    actions = [{ label: 'OK', kind: 'primary', onClick: hideModal }];
  }
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-${a.kind || 'secondary'}`;
    btn.textContent = a.label;
    if (a.disabled) btn.disabled = true;
    btn.addEventListener('click', () => {
      try { a.onClick?.({ hide: hideModal }); } catch (err) { console.error(err); }
    });
    actionsEl.appendChild(btn);
  }

  dialog.appendChild(head);
  dialog.appendChild(bodyEl);
  dialog.appendChild(actionsEl);

  rootEl.replaceChildren(dialog);
  rootEl.dataset.hidden = 'false';
  rootEl.setAttribute('aria-hidden', 'false');

  // Focus first focusable
  const focusable = dialog.querySelector('input, button, [tabindex]:not([tabindex="-1"]), select, textarea');
  focusable?.focus();

  // Trap Tab inside the dialog.
  rootEl.addEventListener('keydown', trapTab);
}

function trapTab(ev) {
  if (ev.key !== 'Tab') return;
  const focusables = rootEl.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"]), select, textarea, a[href]');
  const list = Array.from(focusables).filter(el => !el.disabled && el.offsetParent !== null);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

export function hideModal({ silent = false } = {}) {
  if (!rootEl) return;
  rootEl.replaceChildren();
  rootEl.dataset.hidden = 'true';
  rootEl.setAttribute('aria-hidden', 'true');
  rootEl.removeEventListener('keydown', trapTab);
  if (lastFocus && typeof lastFocus.focus === 'function') {
    try { lastFocus.focus(); } catch { /* ignore */ }
  }
  lastFocus = null;
  if (!silent && typeof activeOnClose === 'function') {
    try { activeOnClose(); } catch (err) { console.error(err); }
  }
  activeOnClose = null;
}

/** Convenience: prompt for a string. Returns Promise<string|null>. */
export function promptModal({ title, label, placeholder = '', initialValue = '', validate, confirmLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <label class="modal-input-label">${escapeHtml(label || '')}</label>
      <input class="modal-input" type="text" autocomplete="off" spellcheck="false" />
      <div class="modal-input-error" hidden></div>
    `;
    const input = wrap.querySelector('.modal-input');
    const errEl = wrap.querySelector('.modal-input-error');
    input.value = initialValue;
    input.placeholder = placeholder;
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); confirm(); }
    });

    const confirm = () => {
      const v = input.value;
      if (validate) {
        const err = validate(v);
        if (err) {
          errEl.textContent = err;
          errEl.hidden = false;
          return;
        }
      }
      resolve(v);
      hideModal({ silent: true });
    };
    const cancel = () => {
      resolve(null);
      hideModal({ silent: true });
    };

    showModal({
      title,
      body: wrap,
      actions: [
        { label: 'Cancel',     kind: 'secondary', onClick: cancel },
        { label: confirmLabel, kind: 'primary',   onClick: confirm },
      ],
      onClose: () => resolve(null),
    });

    // Re-focus after the wrap is inserted.
    setTimeout(() => input.focus(), 0);
  });
}

/** Convenience: confirm dialog. Returns Promise<boolean>. */
export function confirmModal({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    showModal({
      title,
      body,
      actions: [
        { label: cancelLabel,  kind: 'secondary', onClick: () => { resolve(false); hideModal({ silent: true }); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary',
          onClick: () => { resolve(true); hideModal({ silent: true }); } },
      ],
      onClose: () => resolve(false),
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
