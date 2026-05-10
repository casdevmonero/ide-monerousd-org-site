/* Activity bar visual sync. The router owns the state — we just visually
 * show/hide the site-preview button when the active project becomes a site
 * project, and animate the active rail.
 */

import * as store from '../lib/store.js';

let panelEl = null;

export function mountActivityBar(el) {
  panelEl = el;

  // Subscribe to the project slice so we can show the Site Preview button when
  // a site project is active.
  store.subscribe('project', (p) => {
    const siteBtn = panelEl.querySelector('[data-activity="site-preview"]');
    if (!siteBtn) return;
    const visible = p.kind === 'site' || p.kind === 'mixed';
    siteBtn.hidden = !visible;
  });

  // Subscribe to compile errors so the Compiler button gets a red dot when
  // there are unread problems. (Reset when user switches to compiler.)
  store.subscribe('compile', (c) => {
    const compilerBtn = panelEl.querySelector('[data-activity="compiler"]');
    if (!compilerBtn) return;
    if (c.errors?.length) {
      compilerBtn.classList.add('has-errors');
    } else {
      compilerBtn.classList.remove('has-errors');
    }
  });

  store.subscribe('ui', (u, prev) => {
    if (u.activeActivity === 'compiler') {
      const compilerBtn = panelEl.querySelector('[data-activity="compiler"]');
      compilerBtn?.classList.remove('has-errors');
    }
  });

  // Initial render.
  const init = store.get('project');
  const siteBtn = panelEl.querySelector('[data-activity="site-preview"]');
  if (siteBtn) siteBtn.hidden = !(init.kind === 'site' || init.kind === 'mixed');
}
