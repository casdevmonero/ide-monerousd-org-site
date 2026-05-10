/* Plugin panel — context-aware right-side panel. ABI viewer / deployed list /
 * site preview iframe. Page modules drive content via setPluginPanelContent.
 */

let panelEl = null;
let headerEl = null;
let bodyEl = null;

export function mountPluginPanel({ panel, header, body }) {
  panelEl = panel;
  headerEl = header;
  bodyEl = body;
}

export function setPluginPanelContent(content) {
  if (!bodyEl) return;
  if (content instanceof Node) {
    bodyEl.replaceChildren(content);
  } else {
    bodyEl.innerHTML = content;
  }
}

export function setPluginHeader(text) {
  if (headerEl) headerEl.textContent = text;
}

export function getPluginBodyEl() {
  return bodyEl;
}
