/* Tiny single-file Markdown renderer. Used by `pages/reference.js` to render
 * LANGUAGE.md, PROTOCOL-DC-V1.md, PROTOCOL-SITES-V1.md inline in the IDE.
 *
 * Why not a library: every npm runtime dep is forbidden (IDE-3/IDE-4). This
 * implementation handles the markdown subset our reference docs actually use:
 *   • headings (# .. ######) with stable slug ids for TOC anchoring
 *   • paragraphs + line breaks
 *   • bullet + numbered lists (one nesting level)
 *   • fenced ``` code blocks with language hint
 *   • inline code (`...`)
 *   • bold (**...**) + italic (*...* / _..._)
 *   • links [text](url) — opens in new tab with rel=noopener
 *   • simple GFM tables
 *   • horizontal rules (---)
 *   • blockquotes (>)
 *
 * Output is HTML — caller is responsible for inserting into a same-origin
 * container (Reference panel) where it's safe.
 *
 * Security: every text fragment is HTML-escaped before formatting. The only
 * raw-HTML insertion is the assembled output. We never execute or eval any
 * incoming markdown. */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return String(s).replace(/[&<>"']/g, c => ESCAPE_MAP[c]); }

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

/** Inline-formatting pass. Order matters: code first (so `**` inside `\`...\``
 * is preserved verbatim), then bold/italic, then links. */
function inline(src) {
  // Pull `inline code` spans out, escape them once, restore via placeholder.
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(esc(c));
    return `\u0000CODE${codes.length - 1}\u0000`;
  });
  // Pull links out so we can escape body and url separately.
  const links = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, text, url, title) => {
    links.push({ text, url, title });
    return `\u0000LINK${links.length - 1}\u0000`;
  });
  // Now escape everything else.
  s = esc(s);
  // Restore code.
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  // Restore links (escaping text + url).
  s = s.replace(/\u0000LINK(\d+)\u0000/g, (_, i) => {
    const { text, url, title } = links[Number(i)];
    const safeUrl = esc(url).replace(/\s/g, '%20');
    const safeText = inline(text).replace(/<\/?p>/g, '');
    const titleAttr = title ? ` title="${esc(title)}"` : '';
    const isExternal = /^https?:\/\//i.test(url);
    const target = isExternal ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${safeUrl}"${titleAttr}${target}>${safeText}</a>`;
  });
  // **bold** and __bold__.
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // *italic* and _italic_ (avoid matching inside words to keep variable names safe).
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return s;
}

/** Render markdown text → HTML string + a TOC array `[{level, text, slug}]`. */
export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const toc = [];
  let i = 0;
  const n = lines.length;
  const slugs = new Set();
  const uniqSlug = (text) => {
    const base = slugify(text);
    let s = base;
    let k = 1;
    while (slugs.has(s)) s = `${base}-${++k}`;
    slugs.add(s);
    return s;
  };

  while (i < n) {
    const line = lines[i];

    // Fenced code block.
    const codeOpen = line.match(/^```(\w*)\s*$/);
    if (codeOpen) {
      const lang = codeOpen[1] || '';
      const buf = [];
      i++;
      while (i < n && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const langClass = lang ? ` class="lang-${esc(lang)}"` : '';
      out.push(`<pre><code${langClass}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // ATX heading.
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const slug = uniqSlug(text);
      toc.push({ level, text, slug });
      out.push(`<h${level} id="${slug}"><a class="md-anchor" href="#${slug}">${inline(text)}</a></h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^-{3,}\s*$/.test(line) || /^\*{3,}\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Blockquote (one level, multi-line).
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < n && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // GFM table — header row, separator row of |---|---|, then body rows.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < n && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const headerCells = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(c => alignFromSep(c));
      i += 2;
      const rows = [];
      while (i < n && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headerCells.map((c, ci) => `<th${aligns[ci] ? ` style="text-align:${aligns[ci]}"` : ''}>${inline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map(r => `<tr>${r.map((c, ci) => `<td${aligns[ci] ? ` style="text-align:${aligns[ci]}"` : ''}>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<table class="md-table">${thead}${tbody}</table>`);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < n && /^\s*[-*+]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul>${buf.map(b => `<li>${inline(b)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < n && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${buf.map(b => `<li>${inline(b)}</li>`).join('')}</ol>`);
      continue;
    }

    // Blank line.
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Paragraph: collect contiguous non-blank lines that aren't a new block start.
    const buf = [line];
    i++;
    while (i < n && !/^\s*$/.test(lines[i])
        && !/^#{1,6}\s+/.test(lines[i])
        && !/^```/.test(lines[i])
        && !/^>\s?/.test(lines[i])
        && !/^\s*[-*+]\s+/.test(lines[i])
        && !/^\s*\d+\.\s+/.test(lines[i])
        && !/^-{3,}\s*$/.test(lines[i])
        && !(/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < n && /^\s*\|?\s*:?-+:?/.test(lines[i + 1]))) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return { html: out.join('\n'), toc };
}

function splitRow(line) {
  // Strip leading/trailing pipes, then split on un-escaped pipes.
  let s = String(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function alignFromSep(cell) {
  const left  = /^:/.test(cell);
  const right = /:$/.test(cell);
  if (left && right) return 'center';
  if (right) return 'right';
  if (left)  return 'left';
  return null;
}
