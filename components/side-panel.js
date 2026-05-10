/* Side panel — host for the active activity's side content.
 * Page modules call `setSidePanelContent(html | node)` to populate.
 */

let panelEl = null;
let headerEl = null;
let contentEl = null;

export function mountSidePanel({ panel, header, content }) {
  panelEl = panel;
  headerEl = header;
  contentEl = content;
}

export function setSidePanelContent(content) {
  if (!contentEl) return;
  if (content instanceof Node) {
    contentEl.replaceChildren(content);
  } else {
    contentEl.innerHTML = content;
  }
}

export function setSideHeader(text) {
  if (headerEl) headerEl.textContent = text;
}

export function getSideContentEl() {
  return contentEl;
}
