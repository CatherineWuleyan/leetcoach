// Obsidian 归档 markdown 的纯函数改写模块。
//
// 设计原则：全部操作在「按行切分」的字符串数组上完成，用注释标记对
// （<!-- lc-coach:problem:key --> ... <!-- /lc-coach:problem:key -->）来定位条目。
// 对 key 一律使用「整行字符串相等」比较（indexOf / findIndex），绝不把 key 拼进
// 正则，因此 key 里的空格、点号、加号、括号等都不需要转义，也不会导致崩溃。
//
// 这样做的核心好处：任何一次改写都只是在数组上做 splice，
// 既有的、非本次归档的内容永远不会被触碰，且天然满足幂等性。

const H1 = "# LeetCode Hot 100 归档";
const NOTE = "> 由 LC Coach 自动生成。每个条目都被注释标记包裹，请勿手动删除标记。";
const PROBLEM_HEADING = "## 一、题目归档";
const SYNTAX_HEADING = "## 二、语法归档";
const MANUAL_HEADING = "## 三、手记";

/** 区域标题（二级标题）与条目标记的对应关系 */
const KINDS = {
  problem: { heading: PROBLEM_HEADING },
  syntax: { heading: SYNTAX_HEADING },
  manual: { heading: MANUAL_HEADING },
};

/** 生成一份全新的骨架文档（以单个换行符结尾，保证结果稳定）。 */
export function buildSkeleton() {
  return [H1, "", NOTE, "", PROBLEM_HEADING, "", SYNTAX_HEADING, ""].join("\n");
}

/** 统一换行符，避免 CRLF 让整行比较失败。 */
function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

/** 构造某个条目的开/闭标记行。key 直接拼接，不做正则处理。 */
function markerLines(kind, key) {
  return {
    open: `<!-- lc-coach:${kind}:${key} -->`,
    close: `<!-- /lc-coach:${kind}:${key} -->`,
  };
}

/** 判断是否是本模块自己的「开标记」行（不含 key，仅用于跳过块内内容）。 */
function isOpenMarker(line) {
  const t = line.trim();
  return t.startsWith("<!-- lc-coach:") && t.endsWith("-->");
}

/** 判断是否是本模块自己的「闭标记」行。 */
function isCloseMarker(line) {
  return line.trim().startsWith("<!-- /lc-coach:");
}

/** 判断是否二级标题行。 */
function isLevel2(line) {
  return /^##\s/.test(line.trim());
}

/**
 * 保证某个二级标题存在。
 * - 若已存在则原样返回；
 * - 若给了 beforeHeading 且该标题存在，就插到它前面（保证「题目归档」永远在「语法归档」之前）；
 * - 否则追加到文末。
 * 插入时补一个空行，保持 markdown 段落分隔，同时不动其他任何一行。
 */
function ensureHeading(lines, heading, beforeHeading) {
  if (lines.some((l) => l.trim() === heading)) return lines;

  if (beforeHeading) {
    const at = lines.findIndex((l) => l.trim() === beforeHeading);
    if (at >= 0) {
      const out = lines.slice();
      const needBlank = at > 0 && out[at - 1].trim() !== "";
      out.splice(at, 0, ...(needBlank ? ["", heading, ""] : [heading, ""]));
      return out;
    }
  }

  // 追加到文末：先丢掉尾部空行，再补 "标题 + 空行"，得到规范的结尾换行。
  const out = lines.slice();
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  if (out.length) out.push("");
  out.push(heading, "");
  return out;
}

/** 整篇一个一级标题都没有时，才在开头补上我们的一级标题（不覆盖用户自己的标题）。 */
function ensureH1(lines) {
  if (lines.some((l) => /^#\s/.test(l.trim()))) return lines;
  return [H1, "", ...lines];
}

/**
 * 找到某个二级标题「区域」的结束位置。
 * 区域 = 该标题之后、下一个「不在条目块内部」的二级标题之前（没有则到文末）。
 * 之所以要跳过块内部：条目的 markdown 正文里也可能出现 `## ` 行，
 * 不能把它误当成区域边界。
 */
function findRegionEnd(lines, regionStart) {
  let inBlock = false;
  for (let i = regionStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isCloseMarker(line)) {
      inBlock = false;
      continue;
    }
    if (isOpenMarker(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock && isLevel2(line)) return i;
  }
  return lines.length;
}

/**
 * upsert 单个条目。
 * - key 或 markdown 为空（去掉空白后）→ 直接跳过，不写入空标记对；
 * - 标记对已存在 → 原地替换标记之间的内容（位置不变、不产生重复）；
 * - 不存在 → 追加到对应区域末尾（区域最后一条之后、下一个二级标题之前）。
 */
function upsertBlock(lines, kind, key, markdown) {
  const safeKey = key == null ? "" : String(key).trim();
  const bodyRaw = markdown == null ? "" : normalizeNewlines(markdown);
  // 规则：空 key / 空 markdown 的条目跳过，绝不写空标记对。
  if (!safeKey || bodyRaw.trim() === "") return lines;

  const { open, close } = markerLines(kind, safeKey);
  const block = [open, ...bodyRaw.trim().split("\n"), close];

  let openIdx = lines.findIndex((l) => l.trim() === open);
  let closeIdx = lines.findIndex((l) => l.trim() === close);

  // 情况一：成对存在 → 原地替换（这是 upsert 的核心，保证幂等）。
  if (openIdx >= 0 && closeIdx > openIdx) {
    const out = lines.slice();
    out.splice(openIdx, closeIdx - openIdx + 1, ...block);
    return out;
  }

  // 情况二：只有半个标记（文件被手工改坏）→ 只摘掉这个孤立标记行，
  // 不删除其附近内容，然后按「新增」处理，尽量不破坏用户数据。
  let base = lines;
  if (openIdx >= 0 && closeIdx < 0) {
    base = lines.filter((_, i) => i !== openIdx);
  } else if (closeIdx >= 0 && openIdx < 0) {
    base = lines.filter((_, i) => i !== closeIdx);
  }

  // 情况三：新增 → 定位目标区域的插入点。
  const heading = KINDS[kind] ? KINDS[kind].heading : null;
  const regionStart = heading ? base.findIndex((l) => l.trim() === heading) : -1;

  if (regionStart < 0) {
    // 理论上不会发生（调用前已补齐标题）；兜底追加到文末。
    const out = base.slice();
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    if (out.length) out.push("");
    out.push(...block, "");
    return out;
  }

  const regionEnd = findRegionEnd(base, regionStart);
  // 从区域末尾往前跳过空行，插到最后一条非空内容之后。
  let insertAt = regionEnd;
  while (insertAt > regionStart + 1 && base[insertAt - 1].trim() === "") insertAt--;

  const out = base.slice();
  out.splice(insertAt, 0, "", ...block);
  return out;
}

/**
 * 把本次的题目 / 语法归档 upsert 进文档全文，返回改写后的完整文档。
 * 纯函数、不抛异常：任何异常都会被兜住并原样返回入参。
 */
export function upsertArchive(docText, sections) {
  try {
    const sec = sections && typeof sections === "object" ? sections : {};
    const isBlank = typeof docText !== "string" || docText.trim() === "";

    // 空文档 → 从骨架开始；非空 → 在原文的行数组上做手术。
    let lines = isBlank
      ? buildSkeleton().split("\n")
      : normalizeNewlines(docText).split("\n");

    // 先补齐结构：一级标题（仅当整篇没有）、题目标题、语法标题。
    lines = ensureH1(lines);
    lines = ensureHeading(lines, PROBLEM_HEADING, SYNTAX_HEADING);
    lines = ensureHeading(lines, SYNTAX_HEADING, null);

    // 题目条目：只进题目区。
    if (sec.problem && typeof sec.problem === "object") {
      lines = upsertBlock(lines, "problem", sec.problem.key, sec.problem.markdown);
    }

    // 语法条目：逐个进语法区（可能是 0 到多个）。
    const syntaxList = Array.isArray(sec.syntax) ? sec.syntax : [];
    for (const item of syntaxList) {
      if (item && typeof item === "object") {
        lines = upsertBlock(lines, "syntax", item.key, item.markdown);
      }
    }

    if (sec.manual && typeof sec.manual === "object") {
      lines = ensureHeading(lines, MANUAL_HEADING, null);
      lines = upsertBlock(lines, "manual", sec.manual.key, sec.manual.markdown);
    }

    return lines.join("\n");
  } catch {
    // 兜底：宁可不改，也不抛异常。
    return typeof docText === "string" ? docText : "";
  }
}

/** User-written Markdown has a separate block that summaries never replace. */
export function upsertManualNote(docText, note) {
  if (typeof note?.key !== "string" || !note.key.trim() || note.key.length > 256 || /[\r\n<>]/.test(note.key)
      || typeof note.text !== "string" || typeof note.title !== "string") throw new Error("手记内容无效。");
  const key = note.key.trim();
  if (!note.text.trim()) {
    const lines = normalizeNewlines(docText || "").split("\n");
    const markers = markerLines("manual", key);
    const open = lines.findIndex(line => line.trim() === markers.open);
    const close = lines.findIndex(line => line.trim() === markers.close);
    if (open >= 0 && close > open) lines.splice(open, close - open + 1);
    return lines.join("\n");
  }
  // Reserved archive markers inside a note are literal text, never boundaries.
  const safe = text => text.replace(/<!--\s*\/?lc-coach:/g, match => "&lt;" + match.slice(1));
  const title = safe(note.title.replace(/[\r\n]+/g, " ").trim() || key);
  return upsertArchive(docText, { manual: { key, markdown: `### ${title}\n\n${safe(note.text)}` } });
}
