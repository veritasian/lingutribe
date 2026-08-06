// Shared Markdown → HTML renderer used by Chat, Ask AI (WordPanel), and the
// Read article view. XSS-safe: raw text is HTML-escaped first, then markdown
// transforms are applied on the escaped string, so no user content can
// inject live HTML.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline markdown: code, bold, italic, strikethrough, links. */
function inline(raw: string): string {
  let h = escapeHtml(raw);
  h = h.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  h = h.replace(/(^|_)_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return h;
}

/** Render a markdown string to HTML (block-level). */
export function renderMarkdown(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }

    // Fenced code block ```lang
    const fm = line.match(/^```(\w*)/);
    if (fm) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre class="md-pre"><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // Headings
    const hm = t.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const lv = hm[1].length;
      out.push(`<h${lv} class="md-h${lv}">${inline(hm[2])}</h${lv}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\s*\1\s*\1+$/.test(t)) {
      out.push('<hr class="md-hr"/>');
      i++;
      continue;
    }

    // Blockquote
    if (t.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="md-quote">${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // Table (| a | b | + separator row)
    if (/^\|.+\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const header = t.split("|").slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
        rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim()));
        i++;
      }
      const th = header.map((h) => `<th>${inline(h)}</th>`).join("");
      const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      out.push(`<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // Unordered list
    if (/^(\s*)[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*)[-*+]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*[-*+]\s+/, "")));
        i++;
      }
      out.push(`<ul class="md-list">${items.map((x) => `<li>${x}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^(\s*)\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*)\d+\.\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*\d+\.\s+/, "")));
        i++;
      }
      out.push(`<ol class="md-list">${items.map((x) => `<li>${x}</li>`).join("")}</ol>`);
      continue;
    }

    // Paragraph: gather consecutive non-empty, non-block lines.
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(```|#{1,6}\s|>|[-*+]\s|\d+\.\s)/.test(lines[i]) &&
      !/^\|.+\|$/.test(lines[i].trim())
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p class="md-p">${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}
