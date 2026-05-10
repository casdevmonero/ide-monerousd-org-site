/* Command palette (Cmd/Ctrl+K). Algolia-style fuzzy match across all
 * registered commands. Up/down arrows navigate, Enter runs, Esc closes.
 *
 * API:
 *   mountCommandPalette(rootEl, { buildCommands: () => Command[] })
 *   openCmdk({ initialQuery? })
 *   closeCmdk()
 */

let rootEl = null;
let buildCommands = () => [];
let currentList = [];
let activeIdx = 0;
let inputEl = null;

export function mountCommandPalette(el, { buildCommands: build }) {
  rootEl = el;
  if (typeof build === 'function') buildCommands = build;
  rootEl.addEventListener('click', (ev) => {
    if (ev.target === rootEl) closeCmdk();
  });
}

export function openCmdk({ initialQuery = '' } = {}) {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="cmdk">
      <div class="cmdk-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input class="cmdk-input" type="text" placeholder="Type a command…" autocomplete="off" spellcheck="false" />
        <kbd class="cmdk-hint">esc</kbd>
      </div>
      <ul class="cmdk-list" role="listbox"></ul>
      <div class="cmdk-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span><kbd>↵</kbd> Run</span>
        <span><kbd>esc</kbd> Close</span>
      </div>
    </div>`;
  rootEl.dataset.hidden = 'false';
  rootEl.setAttribute('aria-hidden', 'false');

  inputEl = rootEl.querySelector('.cmdk-input');
  inputEl.value = initialQuery;
  inputEl.addEventListener('input', () => render(inputEl.value));
  inputEl.addEventListener('keydown', onKey);
  setTimeout(() => inputEl.focus(), 0);

  render(initialQuery);
}

export function closeCmdk() {
  if (!rootEl) return;
  rootEl.replaceChildren();
  rootEl.dataset.hidden = 'true';
  rootEl.setAttribute('aria-hidden', 'true');
  inputEl = null;
  currentList = [];
  activeIdx = 0;
}

function render(query) {
  const all = buildCommands();
  const q = query.trim().toLowerCase();
  const matches = q
    ? all.map(c => ({ c, score: fuzzyScore(c.title, q) })).filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score).map(x => x.c)
    : all;
  currentList = matches;
  if (activeIdx >= matches.length) activeIdx = 0;

  const ul = rootEl.querySelector('.cmdk-list');
  if (!ul) return;
  if (!matches.length) {
    ul.innerHTML = `<li class="cmdk-empty">No commands match.</li>`;
    return;
  }
  ul.innerHTML = matches.map((c, i) => `
    <li class="cmdk-item ${i === activeIdx ? 'active' : ''}" data-idx="${i}" role="option" aria-selected="${i === activeIdx}">
      <span class="cmdk-title">${highlight(c.title, q)}</span>
      ${c.shortcut ? `<span class="cmdk-shortcut">${escapeHtml(c.shortcut)}</span>` : ''}
    </li>
  `).join('');
  for (const li of ul.querySelectorAll('.cmdk-item')) {
    li.addEventListener('click', () => runIdx(Number(li.dataset.idx)));
    li.addEventListener('mouseenter', () => {
      activeIdx = Number(li.dataset.idx);
      updateActive();
    });
  }
}

function updateActive() {
  const ul = rootEl?.querySelector('.cmdk-list');
  if (!ul) return;
  for (const li of ul.querySelectorAll('.cmdk-item')) {
    const i = Number(li.dataset.idx);
    li.classList.toggle('active', i === activeIdx);
    li.setAttribute('aria-selected', i === activeIdx);
  }
  // Scroll into view if needed.
  const active = ul.querySelector('.cmdk-item.active');
  if (active && active.scrollIntoViewIfNeeded) active.scrollIntoViewIfNeeded(false);
  else active?.scrollIntoView?.({ block: 'nearest' });
}

function onKey(ev) {
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    activeIdx = Math.min(activeIdx + 1, currentList.length - 1);
    updateActive();
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    activeIdx = Math.max(activeIdx - 1, 0);
    updateActive();
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    runIdx(activeIdx);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    closeCmdk();
  }
}

function runIdx(i) {
  const cmd = currentList[i];
  if (!cmd) return;
  closeCmdk();
  Promise.resolve().then(() => {
    try { cmd.run?.(); }
    catch (err) {
      console.error('cmdk command failed:', cmd.id, err);
    }
  });
}

/* ─── Fuzzy matching (lightweight, no deps) ─── */
function fuzzyScore(text, query) {
  if (!query) return 1;
  const t = text.toLowerCase();
  let ti = 0, qi = 0, score = 0, streak = 0;
  while (ti < t.length && qi < query.length) {
    if (t[ti] === query[qi]) {
      score += 1 + streak;
      streak += 1;
      qi += 1;
    } else {
      streak = 0;
    }
    ti += 1;
  }
  return qi === query.length ? score : 0;
}

function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const t = text;
  const out = [];
  let qi = 0;
  for (let i = 0; i < t.length; i++) {
    if (qi < query.length && t[i].toLowerCase() === query[qi]) {
      out.push(`<mark>${escapeHtml(t[i])}</mark>`);
      qi++;
    } else {
      out.push(escapeHtml(t[i]));
    }
  }
  return out.join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
