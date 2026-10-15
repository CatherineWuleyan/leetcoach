// Pure helpers for the LC Coach bridge. Extracted so they can be unit-tested
// without starting an HTTP server or shelling out to Codex.

export function stripAnsi(s) {
  return String(s || "").replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Codex prints only the final agent message to stdout. When stdout is empty
 * (some builds, or a crash mid-stream) fall back to the human-readable
 * transcript on stderr: the answer is whatever follows the last bare "codex"
 * marker, up to the token accounting footer.
 */
export function extractAnswer(stdout, stderr) {
  const clean = stripAnsi(stdout).trim();
  if (clean) return clean;

  const text = stripAnsi(stderr);
  const idx = text.lastIndexOf("\ncodex\n");
  if (idx >= 0) {
    let tail = text.slice(idx + "\ncodex\n".length);
    const cut = tail.search(/\ntokens used\n/);
    if (cut >= 0) tail = tail.slice(0, cut);
    const t = tail.trim();
    if (t) return t;
  }
  return "";
}

export function parseUsage(stderr) {
  const m = /tokens used\s*\n\s*([\d,]+)/.exec(stripAnsi(stderr));
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export function detectAuthError(stderr) {
  const t = stripAnsi(stderr);
  if (/not logged in|login required|401|unauthorized/i.test(t)) {
    return "Codex 未登录。在终端跑一次：codex login";
  }
  if (/usage limit|rate limit|429|quota/i.test(t)) {
    return "Codex 额度或速率受限。等一会儿再试，或减少自动总结的频率。";
  }
  return null;
}

/**
 * Codex has no system-prompt parameter, so the persona and the mode rules are
 * flattened into a single prompt.
 *
 * The tool-use ban is not optional: Codex is an agent, and without an explicit
 * prohibition it will try to explore the filesystem or run commands instead of
 * just answering the question.
 */
export function flattenToPrompt({ system, messages }) {
  const parts = [];

  parts.push(
    [
      "你是一个纯文本助手，被本地桥接程序调用。",
      "",
      "【运行约束 — 最高优先级】",
      "1. 禁止读取任何文件、禁止执行任何命令、禁止调用任何工具、禁止联网搜索。",
      "2. 你的输出就是最终答复本身。不要描述你的过程，不要输出思考过程。",
      "3. 严格按下面【角色设定】里的人格和规则回答。",
      "4. 直接给出答复正文，不要加任何前后缀说明。",
    ].join("\n")
  );

  parts.push("【角色设定】\n" + (system || ""));

  const first = messages?.[0]?.content || "";
  parts.push("【题目上下文与任务】\n" + first);

  const rest = (messages || []).slice(1);
  if (rest.length) {
    const lines = rest.map(
      (m) => (m.role === "assistant" ? "【教练之前说】\n" : "【学生说】\n") + m.content
    );
    parts.push("【对话记录】\n" + lines.join("\n\n"));
  }

  parts.push("现在请给出你的答复正文（只输出正文）：");
  return parts.join("\n\n");
}
