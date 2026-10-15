// MAIN-world network hook.
//
// Injected as a <script> tag by content.js so it runs in the page's own JS
// context and can wrap window.fetch / XMLHttpRequest.
//
// Why this exists: scraping Monaco's DOM only ever returns the lines Monaco has
// bothered to render (it virtualises), and leetcode.cn and leetcode.com do not
// share editor markup. But every submission necessarily carries the complete
// source in its request body. Capturing it is exact, on both sites, in every
// language, with no selector guessing.
//
// It also gives us a trustworthy "a submission just happened" signal, which
// turns verdict detection from a constant body-wide scan into a short, focused
// observation.

(function () {
  if (window.__LC_COACH_HOOKED__) return;
  window.__LC_COACH_HOOKED__ = true;

  const TAG = "lc-coach-hook";

  function post(type, payload) {
    try {
      window.postMessage({ source: TAG, type, payload }, window.location.origin);
    } catch (_) {
      /* ignore */
    }
  }

  const GRAPHQL_HINT = /\/graphql|submit|judge|run|interpret_solution/i;
  const CODE_KEYS = [
    "typedCode",
    "typed_code",
    "code",
    "source",
    "sourceCode",
    "source_code",
    "userCode",
    "userInput",
  ];

  /** Walk a parsed body for a plausible source-code string. */
  function harvestCode(body) {
    if (!body || typeof body !== "object") return null;
    const vars = body.variables || body;
    const stack = [vars];
    let guard = 0;
    let best = null;

    while (stack.length && guard++ < 500) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;

      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string") {
          if (CODE_KEYS.includes(k) && v.length >= 12 && v.length < 200000) {
            if (!best || v.length > best.length) best = v;
          }
        } else if (v && typeof v === "object") {
          stack.push(v);
        }
      }
    }
    return best;
  }

  function harvestMeta(body) {
    const vars = (body && (body.variables || body)) || {};
    const lang =
      vars.lang ||
      vars.langSlug ||
      vars.language ||
      vars.envType ||
      vars.env_type ||
      null;
    const slug = vars.titleSlug || vars.title_slug || vars.questionSlug || null;
    const op =
      (typeof body?.operationName === "string" && body.operationName) ||
      (typeof body?.query === "string" && /mutation\s+(\w+)/.exec(body.query)?.[1]) ||
      null;
    return { lang, slug, op };
  }

  function looksLikeSubmission(op) {
    if (!op) return false;
    return /submit|judge|run/i.test(op) && !/check|poll|details|list/i.test(op);
  }

  function handleBody(rawText, url) {
    if (typeof rawText !== "string" || rawText.length < 20) return;
    if (!GRAPHQL_HINT.test(url || "")) return;

    let body;
    try {
      body = JSON.parse(rawText);
    } catch (_) {
      return;
    }

    const code = harvestCode(body);
    const meta = harvestMeta(body);
    if (!code) return;
    // REST submissions do not have GraphQL operationName.
    let pathname;
    try { pathname = new URL(url, window.location.origin).pathname; } catch { return; }
    const restSubmit = /^\/problems\/[^/]+\/submit\/?$/.test(pathname);
    const restRun = /^\/problems\/[^/]+\/interpret_solution\/?$/.test(pathname);
    if (!looksLikeSubmission(meta.op) && !restSubmit && !restRun) return;
    meta.op ||= restSubmit ? "submit" : "run";

    post("submit", {
      code,
      lang: meta.lang,
      slug: meta.slug,
      op: meta.op,
      url: String(url || ""),
      isRun: /run|interpret/i.test(meta.op),
      at: Date.now(),
    });
  }

  /* ---------------- fetch ---------------- */
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      try {
        const b = init?.body;
        if (typeof b === "string") handleBody(b, url);
        else if (b && typeof b.toString === "function" && !(b instanceof FormData)) {
          const s = b.toString();
          if (s && s !== "[object Object]") handleBody(s, url);
        }
      } catch (_) {
        /* never break the page */
      }
      return origFetch.apply(this, arguments);
    };
  }

  /* ---------------- XHR ---------------- */
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lcCoachUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (typeof body === "string") handleBody(body, this.__lcCoachUrl);
    } catch (_) {
      /* ignore */
    }
    return origSend.apply(this, arguments);
  };

  post("ready", { href: window.location.href });
})();
