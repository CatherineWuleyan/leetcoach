#!/usr/bin/env node
// LC Coach local bridge: lets the Chrome extension talk to your ChatGPT
// subscription through the official Codex CLI.
//
// Why a bridge instead of calling an API directly:
//   A ChatGPT subscription credential is not valid against api.openai.com, and
//   there is no documented contract for third-party clients to use it (see
//   openai/codex issue #36886, still open). The supported way to spend a
//   subscription is the official CLI. So the extension POSTs here, and this
//   process runs `codex exec` and hands back the final message.
//
// Nothing is installed and no credential is copied: the Codex binary ships
// inside the ChatGPT desktop app, and it reuses the login already in
// ~/.codex/auth.json.

import http from "node:http";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  stripAnsi,
  extractAnswer,
  parseUsage,
  detectAuthError,
  flattenToPrompt,
} from "./lib.mjs";
import { upsertArchive } from "./obsidian.mjs";

/* ------------------------------------------------------------------ config */

const DEFAULT_PORT = 8788;
const DEFAULT_TIMEOUT_MS = 180000;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
LC Coach 本地桥 — 用你的 ChatGPT 订阅驱动扩展，不需要 API key

用法:
  node bridge/server.mjs [选项]

选项:
  --port <n>        监听端口 (默认 ${DEFAULT_PORT})
  --token <str>     固定访问令牌 (默认每次随机生成)
  --codex <path>    指定 codex 可执行文件 (默认自动查找)
  --timeout <ms>    单次请求超时 (默认 ${DEFAULT_TIMEOUT_MS})
  --model <name>    传给 codex 的模型名 (默认用 Codex 自己的默认)
  --archive-only    只提供文件归档，不调用 Codex
  --archive-path <p> 只允许写入指定文件
  --quiet           不打印连接令牌
  --help            显示本帮助

只监听 127.0.0.1，外部网络无法访问。`);
  process.exit(0);
}

const ARCHIVE_ONLY = args.includes("--archive-only");
const ARCHIVE_TARGET = flag("--archive-path", "");
const QUIET = args.includes("--quiet");
const PORT = Number(flag("--port", process.env.LC_COACH_PORT || DEFAULT_PORT));
const TIMEOUT_MS = Number(flag("--timeout", DEFAULT_TIMEOUT_MS));
const FIXED_TOKEN = flag("--token", process.env.LC_COACH_TOKEN || "");
const FORCED_CODEX = flag("--codex", process.env.LC_COACH_CODEX || "");
const FORCED_MODEL = flag("--model", process.env.LC_COACH_MODEL || "");

const TOKEN = FIXED_TOKEN || crypto.randomBytes(24).toString("hex");

/* ------------------------------------------------------------------ codex discovery */

const CODEX_CANDIDATES = [
  // Ships inside the ChatGPT desktop app — no install required.
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  path.join(os.homedir(), ".local/bin/codex"),
  path.join(os.homedir(), ".npm-global/bin/codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

function findCodex() {
  if (FORCED_CODEX) return FORCED_CODEX;
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  for (const c of CODEX_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  return "codex"; // fall back to PATH; a clear error surfaces on first request
}

const CODEX_BIN = findCodex();

// Scratch cwd. The sandbox is read-only so nothing lands here, but Codex
// insists on a working root.
const WORKDIR = mkdtempSync(path.join(os.tmpdir(), "lc-coach-"));

/* ------------------------------------------------------------------ codex runner */

function runCodex({ execArgs, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CODEX_BIN, execArgs, {
        cwd: WORKDIR,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new Error(`无法启动 codex：${err.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(
        new Error(
          `Codex 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回。` +
            `可以调大超时（--timeout），或把问题问得更小一点。`
        )
      );
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `无法执行 codex（${CODEX_BIN}）：${err.message}。用 --codex <路径> 指定正确的可执行文件。`
        )
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/* ------------------------------------------------------------------ http */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-LC-Coach-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(),
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 4_000_000) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** Reject DNS-rebinding attempts and any non-extension browser origin. */
function originAllowed(req) {
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // curl, or another non-browser client
  return /^chrome-extension:\/\//.test(origin);
}

/* ------------------------------------------------------------------ obsidian */

/**
 * The extension can only reach this process, so the write happens here. Guard
 * the target anyway: the token is the only thing standing between a leaked
 * secret and an arbitrary file write.
 */
function checkWritablePath(target) {
  if (!target) return { ok: false, reason: "缺少 path。" };
  const resolved = path.resolve(target);
  if (!resolved.endsWith(".md")) {
    return { ok: false, reason: "归档路径必须以 .md 结尾。" };
  }
  if (ARCHIVE_TARGET && resolved !== path.resolve(ARCHIVE_TARGET)) {
    return { ok:false, reason:"此归档桥仅允许写入配置的 leetcode hot 100.md。" };
  }
  const home = os.homedir();
  if (!resolved.startsWith(home + path.sep)) {
    return {
      ok: false,
      reason: `安全限制：只允许写入主目录（${home}）以内的 .md 文件。`,
    };
  }
  return { ok: true, resolved };
}

/** Write via a temp file + rename so a crash cannot truncate the archive. */
function writeFileAtomic(target, text) {
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.lc-coach-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, target);
}

/**
 * iCloud Drive is protected by macOS, so the most likely failure here is a
 * permission one, not a bug. Say exactly how to fix it.
 */
function explainFsError(err, target) {
  if (err.code === "EPERM" || err.code === "EACCES") {
    const isICloud = /\/Library\/Mobile Documents\//.test(String(target));
    return (
      `没有权限写 ${target}\n\n` +
      (isICloud
        ? ICLOUD_HINT +
          "\n\n如果不想授权，也可以把归档路径改成 iCloud 之外的位置（例如 ~/Documents/leetcode hot 100.md）。"
        : `去 系统设置 → 隐私与安全性 → 完全磁盘访问权限，把运行本桥的终端加进去并打开开关，然后重启终端。`)
    );
  }
  if (err.code === "ENOENT") {
    return `路径不存在且无法创建：${err.message}`;
  }
  return `写入失败：${err.message}`;
}

/**
 * Metadata reads succeed on an inaccessible file (and on a writable directory),
 * so `existsSync` alone produces a false "all good". Probe what actually matters:
 *   - if the target exists, try to open THAT FILE for append (no bytes written)
 *   - otherwise, try to create a file in the directory
 *
 * The distinction matters: a directory can be fully writable while a specific
 * file inside it is unopenable.
 */
function probeTargetWritable(target) {
  const dir = path.dirname(target);

  if (!existsSync(dir)) {
    return { checked: true, writable: false, scope: "dir", reason: "目录不存在" };
  }

  if (existsSync(target)) {
    try {
      const fd = openSync(target, "a");
      closeSync(fd);
      return { checked: true, writable: true, scope: "file", reason: null };
    } catch (err) {
      return {
        checked: true,
        writable: false,
        scope: "file",
        reason: err.code || err.message,
      };
    }
  }

  const probe = path.join(dir, `.lc-coach-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, "ok", "utf8");
    unlinkSync(probe);
    return { checked: true, writable: true, scope: "dir", reason: null };
  } catch (err) {
    try {
      unlinkSync(probe);
    } catch {}
    return { checked: true, writable: false, scope: "dir", reason: err.code || err.message };
  }
}

const ICLOUD_HINT =
  "这个目录在 iCloud Drive 下，macOS 默认禁止普通程序写入。" +
  "去 系统设置 → 隐私与安全性 → 完全磁盘访问权限，把「终端」加进去并打开开关，" +
  "然后完全退出终端再重开。";

const STALE_FILE_HINT =
  "无法打开这个文件（连只读都不行），但同一目录是可以正常写入的——" +
  "所以这不是目录权限问题，而是这个文件被系统挡在外面，常见原因是 iCloud 同步状态或 App Sandbox 容器归属。\n" +
  "建议按顺序试：\n" +
  "  1. 在 Finder 或 Obsidian 里打开这个文件确认内容还在（**归档前先确认里面的内容不需要另外备份**）\n" +
  "  2. 给运行本桥的终端开启「完全磁盘访问权限」，然后完全退出终端重开\n" +
  "  3. 仍然不行的话，把归档路径改成一个新文件名（同一目录即可），归档会自动创建它";

function describePath(target) {
  if (!target) return { path: "", guardOk: false, guardReason: "缺少 path" };
  const g = checkWritablePath(target);
  if (!g.ok) return {path:target,guardOk:false,guardReason:g.reason};
  const dir = path.dirname(target);
  let size = null;
  let fileExists = false;
  try {
    fileExists = existsSync(target);
    if (fileExists) size = statSync(target).size;
  } catch (err) {
    return {
      path: target,
      guardOk: false,
      guardReason: `无法读取该路径：${err.message}`,
    };
  }

  const probe = probeTargetWritable(target);
  const isICloud = /\/Library\/Mobile Documents\//.test(target);

  let hint = null;
  if (!probe.writable) {
    if (probe.scope === "file" && fileExists) hint = STALE_FILE_HINT;
    else if (isICloud) hint = ICLOUD_HINT;
  }

  return {
    path: target,
    guardOk: g.ok,
    guardReason: g.reason || null,
    dirExists: existsSync(dir),
    fileExists,
    size,
    writable: probe.writable,
    writeScope: probe.scope,
    writeProbeChecked: probe.checked,
    writeError: probe.writable ? null : probe.reason,
    hint,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...corsHeaders(), "Access-Control-Max-Age": "600" });
    res.end();
    return;
  }

  if (!originAllowed(req)) {
    json(res, 403, { error: "仅允许来自本机 127.0.0.1 的扩展请求。" });
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      mode: ARCHIVE_ONLY ? "archive-only" : "codex-and-archive",
      codexBin: CODEX_BIN,
      workdir: WORKDIR,
      timeoutMs: TIMEOUT_MS,
      defaultModel: FORCED_MODEL || null,
    });
    return;
  }

  // Everything past here requires the token.
  if (req.headers["x-lc-coach-token"] !== TOKEN) {
    json(res, 401, {
      error: "令牌不对。把启动时终端打印的那串令牌粘到扩展设置里。",
    });
    return;
  }

  if (url.pathname === "/models") {
    // Codex chooses its own model unless one is forced, so there is nothing
    // useful to enumerate. "default" tells the extension to omit -m.
    json(res, 200, {
      data: [
        { id: "default", label: "Codex 默认模型" },
        ...(FORCED_MODEL ? [{ id: FORCED_MODEL, label: FORCED_MODEL }] : []),
      ],
    });
    return;
  }

  if (ARCHIVE_ONLY && url.pathname === "/chat") {
    json(res, 403, {error:"此桥仅用于本地文件归档。"});
    return;
  }
  if (url.pathname === "/chat" && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      json(res, 400, { error: "请求体不是合法 JSON：" + err.message });
      return;
    }

    const model = String(payload.model || "").trim() || FORCED_MODEL;
    const prompt = flattenToPrompt({
      system: payload.system,
      messages: payload.messages || [],
    });

    const baseFlags = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      WORKDIR,
    ];
    const optionalFlags = ["--ignore-user-config", "--color", "never"];
    const modelFlags = model && model !== "default" ? ["-m", model] : [];

    const fullArgs = [...baseFlags, ...optionalFlags, ...modelFlags, "-"];
    const minimalArgs = [...baseFlags, ...modelFlags, "-"];

    const timeoutMs = Math.min(Number(payload.timeoutMs) || TIMEOUT_MS, TIMEOUT_MS);
    const t0 = Date.now();

    let result;
    try {
      result = await runCodex({ execArgs: fullArgs, prompt, timeoutMs });
    } catch (err) {
      json(res, 504, { error: err.message });
      return;
    }

    // A different build may not recognise an optional flag. Retry without them.
    const unsupported =
      /unexpected argument|unrecognized|unknown (flag|option)|invalid value/i.test(
        stripAnsi(result.stderr)
      );
    if (result.code !== 0 && unsupported) {
      try {
        result = await runCodex({ execArgs: minimalArgs, prompt, timeoutMs });
      } catch (err) {
        json(res, 504, { error: err.message });
        return;
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (result.code !== 0) {
      json(res, 502, {
        error:
          detectAuthError(result.stderr) ||
          `codex 退出码 ${result.code}。stderr 末尾：\n` +
            stripAnsi(result.stderr).trim().split("\n").slice(-8).join("\n"),
      });
      return;
    }

    const text = extractAnswer(result.stdout, result.stderr);
    if (!text) {
      json(res, 502, {
        error:
          "Codex 没有返回任何文本。stderr 末尾：\n" +
          stripAnsi(result.stderr).trim().split("\n").slice(-8).join("\n"),
      });
      return;
    }

    const usage = parseUsage(result.stderr);
    console.log(`  ✓ ${elapsed}s  ${text.length} 字符  tokens=${usage ?? "?"}`);
    json(res, 200, { text, usage: { totalTokens: usage }, elapsedSeconds: Number(elapsed) });
    return;
  }

  if (url.pathname === "/obsidian/status") {
    const target = url.searchParams.get("path") || "";
    json(res, 200, describePath(target));
    return;
  }

  if (url.pathname === "/obsidian/upsert" && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      json(res, 400, { error: "请求体不是合法 JSON：" + err.message });
      return;
    }

    const target = String(payload.path || "");
    const guard = checkWritablePath(target);
    if (!guard.ok) {
      json(res, 400, { error: guard.reason });
      return;
    }

    try {
      const before = existsSync(target) ? readFileSync(target, "utf8") : "";
      const after = upsertArchive(before, {
        problem: payload.problem || null,
        syntax: Array.isArray(payload.syntax) ? payload.syntax : [],
      });

      if (after === before) {
        console.log("  · 归档无变化，跳过写入");
        json(res, 200, { ok: true, changed: false, bytes: after.length });
        return;
      }

      writeFileAtomic(target, after);
      const delta = after.length - before.length;
      console.log(
        `  ✓ 归档 ${target}    ${before.length} → ${after.length} 字节 (${
          delta >= 0 ? "+" : ""
        }${delta})`
      );
      json(res, 200, {
        ok: true,
        changed: true,
        bytes: after.length,
        deltaBytes: delta,
        counts: {
          problems: (after.match(/<!-- lc-coach:problem:/g) || []).length,
          syntax: (after.match(/<!-- lc-coach:syntax:/g) || []).length,
        },
      });
    } catch (err) {
      console.error("  ✗ 归档失败：", err.message);
      json(res, 500, { error: explainFsError(err, target) });
    }
    return;
  }

  json(res, 404, { error: "没有这个接口。" });
});

/* ------------------------------------------------------------------ boot */

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n端口 ${PORT} 已被占用。换一个：node bridge/server.mjs --port 8789\n` +
        `（记得同时改扩展设置里的 Base URL）\n`
    );
  } else {
    console.error("\n桥启动失败：", err.message, "\n");
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  if (QUIET) return;
  const line = "─".repeat(66);
  console.log(`\n${line}`);
  console.log("  LC Coach 本地桥已启动 — 用你的 ChatGPT 订阅，不需要 API key");
  console.log(line);
  console.log(`  地址    http://127.0.0.1:${PORT}`);
  console.log(`  令牌    ${TOKEN}`);
  console.log(`  codex   ${CODEX_BIN}`);
  console.log(`  超时    ${TIMEOUT_MS / 1000}s`);
  console.log(line);
  console.log("  扩展里：设置 → 服务商选「Codex（本地桥）」");
  console.log("          Base URL 填上面的地址，API Key 填上面的令牌");
  console.log(`\n  保持这个窗口开着。按 Ctrl+C 停止。\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\n桥已停止。\n");
    process.exit(0);
  });
}
