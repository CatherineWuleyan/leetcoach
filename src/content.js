// Content script: runs on leetcode.cn and leetcode.com problem pages.
//
// Responsibilities
//   1. Scrape the problem so the side panel never has to guess.
//   2. Inject the MAIN-world network hook and relay what it captures.
//   3. Detect the submission verdict (Chinese AND English wording).
//   4. Answer diagnostics requests so extraction failures are debuggable
//      instead of silent.

(() => {
if (globalThis.__LC_COACH_CONTENT_READY__) return;

const TAG = "lc-coach-hook";
const IS_CN = location.hostname.endsWith("leetcode.cn");

/* ------------------------------------------------------------------ helpers */

function txt(el) {
  return el ? (el.innerText || el.textContent || "").trim() : "";
}

function firstMatch(selectors) {
  for (const sel of selectors) {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const t = txt(el);
        if (t) return { el, text: t, selector: sel };
      }
    } catch (_) {
      /* invalid selector, skip */
    }
  }
  return null;
}

/** Collapse the messy textContent of LeetCode's description into clean lines. */
function tidy(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n")
    .trim();
}

function slugFromUrl() {
  const m = location.pathname.match(/\/problems\/([^/]+)/);
  return m ? m[1] : "";
}

/* ------------------------------------------------------------------ scraping */

const DIAG = {};

function scrapeTitle() {
  DIAG.title = [];
  const candidates = [
    '[data-cy="question-title"]',
    'div.text-title-large',
    'div[class*="text-title-large"]',
    'a[class*="text-title-large"]',
    'h1',
    'h3',
  ];
  const hit = firstMatch(candidates);
  if (hit) {
    DIAG.title.push(`selector 命中: ${hit.selector} -> ${hit.text.slice(0, 80)}`);
    return hit.text;
  }
  DIAG.title.push("所有 selector 未命中，改用 document.title");
  // "1. 两数之和 - 力扣（LeetCode）" | "Two Sum - LeetCode"
  const raw = document.title || "";
  DIAG.title.push(`document.title = ${raw}`);
  return tidy(raw.replace(/\s*[-|]\s*(力扣（LeetCode）|力扣|LeetCode).*$/i, ""));
}

function scrapeDifficulty() {
  DIAG.difficulty = [];
  const hit = firstMatch([
    'div[class*="text-difficulty-easy"]',
    'div[class*="text-difficulty-medium"]',
    'div[class*="text-difficulty-hard"]',
    'div[class*="text-olive"]',
    'div[class*="text-yellow"]',
    'div[class*="text-pink"]',
    'span[class*="text-difficulty"]',
  ]);
  if (hit) {
    DIAG.difficulty.push(`selector 命中: ${hit.selector} -> ${hit.text}`);
    return hit.text.split("\n")[0];
  }
  // scan small elements for a known label
  const labels = IS_CN ? ["简单", "中等", "困难"] : ["Easy", "Medium", "Hard"];
  for (const el of document.querySelectorAll("div,span")) {
    if (el.children.length) continue;
    const t = txt(el);
    if (labels.includes(t)) {
      DIAG.difficulty.push(`文本扫描命中: <${el.tagName.toLowerCase()}> -> ${t}`);
      return t;
    }
  }
  DIAG.difficulty.push("未命中");
  return "";
}

function scrapeDescription() {
  DIAG.description = [];
  const candidates = [
    '[data-track-load="description_content"]',
    'div[class*="question-content"]',
    "div.elfjS",
    'div[class*="description"] div[class*="content"]',
    'div[class*="description"]',
  ];
  for (const sel of candidates) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = tidy(el.innerText || el.textContent || "");
      if (t.length > 60) {
        DIAG.description.push(`selector 命中: ${sel} -> ${t.length} 字符`);
        return t;
      }
      DIAG.description.push(`selector ${sel} 命中但太短(${t.length})，跳过`);
    } catch (_) {
      /* ignore */
    }
  }
  DIAG.description.push("所有 selector 未命中");
  return "";
}

/** Examples and constraints, best effort — the plain description is enough
 *  for the model, this just makes the prompt tidier when it works. */
function splitSections(desc) {
  const examples = [];
  const constraints = [];

  const lines = String(desc || "").split("\n");
  const exRe = IS_CN ? /^(示例|輸入|输入)\s*\d*/ : /^(Example|Input|Output)\s*\d*/i;
  const conRe = IS_CN ? /^(提示|约束|说明)\s*[:：]?/ : /^(Constraints?|Note)\s*[:：]?/i;

  let bucket = null;
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const joined = buf.join("\n").trim();
    if (joined) {
      if (bucket === "ex") examples.push(joined);
      else if (bucket === "con") constraints.push(joined);
    }
    buf = [];
  };

  for (const line of lines) {
    if (exRe.test(line)) {
      flush();
      bucket = "ex";
      buf.push(line);
    } else if (conRe.test(line)) {
      flush();
      bucket = "con";
      buf.push(line);
    } else if (bucket) {
      buf.push(line);
    }
  }
  flush();
  return { examples, constraints };
}

function scrapeTopics() {
  DIAG.topics = [];
  const out = [];
  for (const a of document.querySelectorAll('a[href*="/tag/"], a[href*="/topic/"]')) {
    const t = txt(a);
    if (t && t.length < 40 && !out.includes(t)) out.push(t);
  }
  DIAG.topics.push(`找到 ${out.length} 个: ${out.slice(0, 8).join(", ")}`);
  return out.slice(0, 12);
}

function scrapeNumber(title) {
  const m = String(title || "").match(/^\s*(\d+)\s*[.、]/);
  if (m) return m[1];
  const fromTitle = String(document.title || "").match(/^\s*(\d+)\s*[.、]/);
  return fromTitle ? fromTitle[1] : "";
}

function scrapeLanguage() {
  DIAG.language = [];
  const sels = [
    'button[id^="headlessui-listbox-button"]',
    'div[class*="lang"] button',
    'button[class*="lang"]',
    'div[class*="language"]',
  ];
  const hit = firstMatch(sels);
  if (hit) {
    const t = hit.text.split("\n")[0].trim();
    if (t.length < 24) {
      DIAG.language.push(`selector 命中: ${hit.selector} -> ${t}`);
      return t;
    }
    DIAG.language.push(`selector ${hit.selector} 文本过长("${t.slice(0, 40)}")，跳过`);
  }
  DIAG.language.push("未命中");
  return "";
}

function scrape() {
  const title = scrapeTitle();
  const description = scrapeDescription();
  const { examples, constraints } = splitSections(description);

  return {
    domain: location.hostname,
    slug: slugFromUrl(),
    url: location.href,
    number: scrapeNumber(title),
    title,
    difficulty: scrapeDifficulty(),
    description,
    examples,
    constraints,
    topics: scrapeTopics(),
    language: scrapeLanguage(),
    diag: JSON.parse(JSON.stringify(DIAG)),
    scrapedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ verdict */

// Both sites, both languages. Order matters: check failure modes before the
// generic success words so "解答错误" never matches "通过".
const VERDICT_RULES = [
  { re: /超出时间限制|Time Limit Exceeded/i, verdict: "TLE" },
  { re: /内存超出限制|Memory Limit Exceeded/i, verdict: "MLE" },
  { re: /编译错误|Compile Error/i, verdict: "CompileError" },
  { re: /运行时错误|Runtime Error/i, verdict: "RuntimeError" },
  { re: /解答错误|Wrong Answer/i, verdict: "WrongAnswer" },
  { re: /超出输出限制|Output Limit Exceeded/i, verdict: "OLE" },
  { re: /解答成功|通过|Accepted/i, verdict: "Accepted" },
];

function detectVerdict() {
  const scope = document.querySelector(
    '[data-e2e-locator="submission-result"], [class*="result"], [class*="submission"]'
  );
  const hay = scope ? txt(scope) : "";


  for (const rule of VERDICT_RULES) {
    if (hay && rule.re.test(hay)) return { verdict: rule.verdict, source: "result-node" };
  }
  return null;
}

let verdictTimer = null;

function watchForVerdict(onVerdict, timeoutMs = 45000) {
  if (verdictTimer) {
    clearInterval(verdictTimer);
    verdictTimer = null;
  }
  const started = Date.now();
  verdictTimer = setInterval(() => {
    const v = detectVerdict();
    if (v) {
      clearInterval(verdictTimer);
      verdictTimer = null;
      onVerdict(v);
      return;
    }
    if (Date.now() - started > timeoutMs) {
      clearInterval(verdictTimer);
      verdictTimer = null;
      onVerdict({ verdict: "Unknown", source: "timeout" });
    }
  }, 1200);
}

/* ------------------------------------------------------------------ relay */

let latestCode = null;

function sendToExtension(event) {
  try {
    chrome.runtime.sendMessage({ type: "lc-coach:event", event }, () => {
      // Reading lastError suppresses "Receiving end does not exist" when the
      // side panel happens to be closed. Not an error worth surfacing.
      void chrome.runtime.lastError;
    });
  } catch (_) {
    /* extension context invalidated; ignore */
  }
}

// Relay from the MAIN-world hook.
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== TAG) return;

  if (d.type === "ready") {
    sendToExtension({ kind: "hookReady", href: d.payload?.href });
    return;
  }

  if (d.type === "submit") {
    latestCode = d.payload;
    sendToExtension({ kind: "submitted", code: d.payload.code, lang: d.payload.lang });

    // Running examples is not a judged submission.
    if (d.payload.isRun) return;

    // A submission just went out — now watch briefly for the verdict.
    watchForVerdict((v) => {
      sendToExtension({
        kind: "verdict",
        verdict: v.verdict,
        source: v.source,
        code: latestCode?.code || "",
        lang: latestCode?.lang || "",
        problem: scrape(),
      });
    });
  }
});

// Inject the hook into the page's own JS context.
(function injectHook() {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/hook.js");
    s.async = false;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (err) {
    console.warn("[LC Coach] hook 注入失败:", err);
  }
})();

/* ------------------------------------------------------------------ messages */

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req?.type === "lc-coach:ping") {
    sendResponse({ ok: true, domain: location.hostname, slug: slugFromUrl() });
    return false;
  }

  if (req?.type === "lc-coach:scrape") {
    let result;
    try {
      result = scrape();
    } catch (err) {
      result = { error: String(err && err.stack ? err.stack : err) };
    }
    sendResponse(result);
    return false;
  }

  if (req?.type === "lc-coach:latestCode") {
    sendResponse({ code: latestCode?.code || "", lang: latestCode?.lang || "" });
    return false;
  }

  return false;
});
globalThis.__LC_COACH_CONTENT_READY__ = true;
})();
