// Minimal, dependency-free Markdown renderer.
//
// Deliberately NOT a bundled third-party parser. The previous extension did
// `el.innerHTML = aiResponse` on raw model output, which is an XSS hole the
// moment a model emits a <script> or an onerror attribute (models do this by
// accident when discussing HTML, and a poisoned problem statement could make
// it deliberate).
//
// This renderer escapes ALL input first, then re-introduces only the specific
// tags it generates itself. Model output can therefore never inject markup.

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FENCE = /```([a-zA-Z0-9+#._-]*)[ \t]*\n?([\s\S]*?)```/g;
const PLACEHOLDER = /\u0000B(\d+)\u0000/g;

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>'
    );
}

export function renderMarkdown(src) {
  const text = String(src ?? "").replace(/\r\n?/g, "\n");

  // 1. Lift fenced code out before any other processing so its contents are
  //    never treated as markdown.
  const blocks = [];
  const stripped = text.replace(FENCE, (_m, lang, code) => {
    blocks.push({ lang: lang || "", code });
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  // 2. Escape everything that remains.
  const escaped = escapeHtml(stripped);
  const lines = escaped.split("\n");

  const out = [];
  let para = [];
  let listType = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join("<br>"))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    if (/^\u0000B\d+\u0000$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push(line.trim());
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const lvl = heading[1].length;
      out.push(`<h${lvl}>${inline(heading[2])}</h${lvl}>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push("<hr>");
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    para.push(line);
  }

  flushPara();
  closeList();

  // 3. Re-insert code blocks, escaping their contents too.
  return out.join("\n").replace(PLACEHOLDER, (_m, i) => {
    const b = blocks[Number(i)];
    if (!b) return "";
    const lang = b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : "";
    const code = escapeHtml(b.code.replace(/\n+$/, ""));
    return `<pre><code${lang}>${code}</code></pre>`;
  });
}
