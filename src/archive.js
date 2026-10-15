// Parser for the coach's archive output.
//
// The archive request asks the model for a line-delimited format rather than
// JSON, because the payload embeds markdown that itself contains code fences —
// JSON would need escaping everywhere and models get that wrong. Exact-line
// markers survive arbitrary code content:
//
//   @@PROBLEM@@
//   ### LC 3 · 无重复字符的最长子串
//   ...
//   @@SYNTAX@@
//   @@ENTRY:cpp-unordered_map-iteration@@
//   ### 语法 · ...
//
// Kept pure so it can be unit-tested without a browser.

import { ARCHIVE_MARKERS } from "./prompts.js";

/** Normalise a model-supplied key into something stable and filename-safe. */
export function normalizeKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** First `### ...` heading in a chunk, stripped of its hashes. */
function headingOf(markdown) {
  for (const line of String(markdown || "").split("\n")) {
    const m = /^#{1,6}\s+(.*\S)\s*$/.exec(line.trim());
    if (m) {
      // "### LC 3 · 无重复字符的最长子串" -> "LC 3 · 无重复字符的最长子串"
      // "### 语法 · unordered_map 遍历"   -> "unordered_map 遍历"
      return m[1].replace(/^语法\s*·\s*/, "").trim();
    }
  }
  return "";
}

/** Drop a trailing lone code fence, which models sometimes add by reflex. */
function trimTrailingFence(lines) {
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  // A legitimate final syntax snippet has balanced fences. Remove only an
  // unmatched closing wrapper, otherwise the saved snippet loses its fence.
  const fenceCount = out.filter(line => /^```/.test(line.trim())).length;
  if (fenceCount % 2 === 1 && out.length && /^```\s*$/.test(out[out.length - 1].trim())) out.pop();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/**
 * @param {string} text raw model output
 * @returns {{problem: {title:string, markdown:string}|null,
 *            syntax: Array<{key:string, title:string, markdown:string}>,
 *            ok: boolean}}
 *   `ok:false` means no recognisable archive structure was found, so the caller
 *   should show the raw text instead of silently archiving nothing.
 */
export function parseArchive(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");

  const problemIdx = lines.findIndex((l) => l.trim() === ARCHIVE_MARKERS.PROBLEM);
  const syntaxIdx = lines.findIndex((l) => l.trim() === ARCHIVE_MARKERS.SYNTAX);

  if (problemIdx < 0 && syntaxIdx < 0) {
    return { problem: null, syntax: [], ok: false };
  }

  // Everything before @@PROBLEM@@ is preamble (some models insist on a
  // sentence of introduction, or wrap the whole reply in a code fence).
  const start = problemIdx >= 0 ? problemIdx + 1 : 0;
  const problemEnd = syntaxIdx >= 0 ? syntaxIdx : lines.length;

  let problem = null;
  if (problemIdx >= 0) {
    const body = trimTrailingFence(lines.slice(start, problemEnd)).join("\n").trim();
    if (body) {
      problem = { title: headingOf(body), markdown: body };
    }
  }

  const syntax = [];
  if (syntaxIdx >= 0) {
    const rest = trimTrailingFence(lines.slice(syntaxIdx + 1));
    let current = null;
    let buf = [];

    const flush = () => {
      if (!current) return;
      const body = buf.join("\n").trim();
      buf = [];
      if (!body) return;
      const key = normalizeKey(current);
      if (!key) return;
      syntax.push({ key, title: headingOf(body), markdown: body });
    };

    for (const line of rest) {
      const trimmed = line.trim();
      if (trimmed.startsWith(ARCHIVE_MARKERS.ENTRY_PREFIX) && trimmed.endsWith("@@")) {
        flush();
        current = trimmed.slice(
          ARCHIVE_MARKERS.ENTRY_PREFIX.length,
          trimmed.length - 2
        );
        continue;
      }
      if (current) buf.push(line);
    }
    flush();
  }

  const ok = Boolean(problem) || syntax.length > 0;
  return { problem, syntax, ok };
}

/**
 * Build the stable key for a problem entry. Prefers the LeetCode number, which
 * is unique; falls back to the slug when the scraper could not find a number.
 */
export function problemKey(problem) {
  const p = problem || {};
  if (p.number) return `LC ${p.number}`;
  if (p.slug) return `lc-${normalizeKey(p.slug)}`;
  return normalizeKey(p.title) || "unknown";
}

function safeMarkers(text) {
  return String(text || "").replace(/<!--\s*\/?lc-coach:/g, "&lt;!-- lc-coach:");
}
function fenced(text, lang = "") {
  const runs = String(text || "").match(/`+/g) || [];
  const fence = "`".repeat(Math.max(3, ...runs.map(s => s.length + 1)));
  return `${fence}${lang}\n${text || "（空）"}\n${fence}`;
}
/** Enforce summary-only storage, and count evidenced syntax questions once. */
export function prepareArchive(snapshot, rawText, memory = {}) {
  const parsed = parseArchive(rawText);
  if (!parsed.problem) throw new Error("模型没有返回有效题目总结，记录已保留，稍后重试。");
  let markdown = parsed.problem.markdown
    .replace(/```[^\n]*\n[\s\S]*?```/g, "（代码已省略；只保留总结）");
  const key = problemKey(snapshot.problem);
  const nextMemory = structuredClone(memory);
  const syntax = [];
  for (const item of parsed.syntax) {
    const evidence = /\*\*提问依据\*\*\s*[：:]\s*(.+)/.exec(item.markdown)?.[1]?.trim();
    if (!evidence) continue;
    const indices = (snapshot.history || []).flatMap((turn, i) =>
      turn.role === "user" && turn.content.trim() === evidence ? [i] : []);
    if (!indices.length) continue; // No invented syntax weaknesses.
    const prior = nextMemory[item.key] || { observations: [], sources: [] };
    const observations = [...new Set([...(prior.observations || []), ...indices.map(i => `${key}:${i}`)])];
    const sources = [...new Set([...(prior.sources || []), key])];
    const body = item.markdown.replace(/^-\s*\*\*(?:提问依据|观察次数|出自)\*\*.*$/gm, "").trim();
    const countLine = `- **观察次数**：${observations.length} 次语法提问${observations.length > 1 ? "（重复出现）" : "（仅观察到一次，尚不推断为常忘）"}`;
    const entry = { key:item.key, markdown:safeMarkers(`${body}\n${countLine}\n- **出自**：${sources.join("、")}`) };
    nextMemory[item.key] = { observations, sources, markdown:entry.markdown };
    syntax.push(entry);
  }
  if (snapshot.fullArchive) {
    const p = snapshot.problem || {};
    markdown += "\n\n#### 整体归档 · 完整题面\n" + (p.description || "（未读取到题面）");
    markdown += "\n\n#### 整体归档 · 我的代码\n" + fenced(snapshot.code, snapshot.language === "C++" ? "cpp" : "");
    markdown += "\n\n#### 整体归档 · 完整问答\n" + (snapshot.history || []).map(turn =>
      `**${turn.role === "assistant" ? "教练" : "我的问题"}**\n\n${turn.content}`).join("\n\n");
  }
  return { problem:{key,markdown:safeMarkers(markdown)}, syntax, memory:nextMemory };
}
