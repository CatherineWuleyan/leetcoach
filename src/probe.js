// Editor probe — injected into the page's MAIN world on demand.
//
// MUST stay fully self-contained: Chrome stringifies this function and injects
// it into the page, so it cannot reference anything from the extension scope.
//
// Strategy ladder (first success wins):
//   1. window.monaco          — global Monaco registry
//   2. CodeMirror 5           — element.CodeMirror.getValue()
//   3. Ace                    — element.env.editor.getValue()
//   4. React fiber walk       — reach the Monaco instance via its DOM node
//   5. Virtual-scroll DOM     — scroll the editor and stitch rendered lines
//
// Step 5 matters: Monaco only renders the visible viewport, so a naive DOM read
// silently truncates any solution longer than the editor height. Scrolling and
// deduplicating by each line's `top` offset recovers the whole buffer.

export async function PROBE_EDITOR() {
  const result = {
    ok: false,
    code: "",
    strategy: "",
    tried: [],
    lineCount: 0,
    error: null,
  };

  const note = (s) => result.tried.push(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function accept(code, strategy) {
    const clean = String(code || "").replace(/\r/g, "");
    if (clean.trim().length < 4) return false;
    result.ok = true;
    result.code = clean;
    result.strategy = strategy;
    result.lineCount = clean.split("\n").length;
    return true;
  }

  try {
    /* ---------- 1. global Monaco ---------- */
    note("试 window.monaco");
    const M = window.monaco;
    if (M?.editor?.getModels) {
      const models = M.editor.getModels().filter((m) => m?.getValue);
      let best = "";
      for (const m of models) {
        try {
          const v = m.getValue();
          if (v && v.length > best.length) best = v;
        } catch (_) {}
      }
      if (best && accept(best, "window.monaco")) return result;
      note("window.monaco 存在但没有可用 model");
    }

    /* ---------- 2. CodeMirror 5 ---------- */
    note("试 CodeMirror5");
    const cm5 = document.querySelector(".CodeMirror");
    if (cm5?.CodeMirror?.getValue) {
      if (accept(cm5.CodeMirror.getValue(), "codemirror5")) return result;
    }

    /* ---------- 3. Ace ---------- */
    note("试 Ace");
    const aceEl = document.querySelector(".ace_editor");
    if (aceEl?.env?.editor?.getValue) {
      if (accept(aceEl.env.editor.getValue(), "ace")) return result;
    }

    /* ---------- 4. React fiber walk ---------- */
    note("试 React fiber");
    const editorRoot =
      document.querySelector(".monaco-editor") ||
      document.querySelector('[class*="monaco"]') ||
      document.querySelector('[class*="codemirror"]') ||
      document.querySelector('[class*="CodeMirror"]');

    if (editorRoot) {
      const fiberKey = Object.keys(editorRoot).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (fiberKey) {
        const seen = new Set();
        const stack = [editorRoot[fiberKey]];
        let steps = 0;

        const looksLikeEditor = (o) =>
          o &&
          typeof o === "object" &&
          typeof o.getValue === "function" &&
          typeof o.getModel === "function";

        while (stack.length && steps++ < 4000) {
          const f = stack.pop();
          if (!f || seen.has(f)) continue;
          seen.add(f);

          const candidates = [f.stateNode, f.memoizedProps, f.memoizedState, f.ref];
          for (const c of candidates) {
            if (!c || typeof c !== "object") continue;

            if (looksLikeEditor(c)) {
              try {
                if (accept(c.getValue(), "react-fiber(editor)")) return result;
              } catch (_) {}
            }
            if (typeof c.getModel === "function") {
              try {
                const m = c.getModel();
                if (m?.getValue && accept(m.getValue(), "react-fiber(model)")) return result;
              } catch (_) {}
            }
            // props sometimes carry the editor one level down
            for (const key of ["editor", "instance", "codeEditor", "monacoEditor"]) {
              const inner = c[key];
              if (looksLikeEditor(inner)) {
                try {
                  if (accept(inner.getValue(), "react-fiber(props)")) return result;
                } catch (_) {}
              }
            }
          }

          if (f.child) stack.push(f.child);
          if (f.sibling) stack.push(f.sibling);
        }
        note("React fiber 遍历未找到 editor 实例");
      } else {
        note("DOM 上没有 React fiber key");
      }
    } else {
      note("没找到编辑器容器");
    }

    /* ---------- 5. Virtual-scroll DOM stitch ---------- */
    note("试虚拟滚动 DOM 拼接");
    const scrollEl =
      document.querySelector(".monaco-scrollable-element") ||
      document.querySelector(".monaco-editor .overflow-guard") ||
      document.querySelector(".monaco-editor");
    const linesRoot =
      document.querySelector(".monaco-editor .view-lines") ||
      document.querySelector(".cm-content") ||
      document.querySelector(".CodeMirror-code");

    if (linesRoot) {
      const lineSel = linesRoot.classList.contains("view-lines")
        ? ".view-line"
        : linesRoot.classList.contains("cm-content")
          ? ".cm-line"
          : ".CodeMirror-line";

      const collected = new Map();
      const prevTop = scrollEl ? scrollEl.scrollTop : 0;

      const harvest = () => {
        const nodes = linesRoot.querySelectorAll(lineSel);
        nodes.forEach((n, idx) => {
          const t = n.textContent ?? "";
          // Monaco positions each line with `top: Npx`; that offset is the
          // stable identity of a line across scroll positions.
          const topStyle = n.style?.top || "";
          const top = parseFloat(topStyle);
          const key = Number.isFinite(top) ? `t${top}` : `i${idx}:${t}`;
          if (!collected.has(key) || (t || "").length > (collected.get(key) || "").length) {
            collected.set(key, t);
          }
        });
      };

      harvest();

      if (scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight + 4) {
        const step = Math.max(40, Math.floor(scrollEl.clientHeight * 0.7));
        const max = scrollEl.scrollHeight;
        for (let y = 0; y <= max && y < 200000; y += step) {
          scrollEl.scrollTop = y;
          await sleep(16);
          harvest();
        }
        if (scrollEl.scrollTop !== prevTop) scrollEl.scrollTop = prevTop;
      }

      let lines;
      const allNumeric = [...collected.keys()].every((k) => k.startsWith("t"));
      if (allNumeric) {
        lines = [...collected.entries()]
          .sort((a, b) => parseFloat(a[0].slice(1)) - parseFloat(b[0].slice(1)))
          .map(([, v]) => v);
      } else {
        lines = [...collected.values()];
      }

      const joined = lines.join("\n");
      if (accept(joined, `dom-stitch(${lineSel})`)) return result;
      note(`DOM 拼接只得到 ${joined.trim().length} 字符`);
    }

    /* ---------- 6. plain textarea ---------- */
    note("试 textarea");
    for (const ta of document.querySelectorAll("textarea")) {
      const v = ta.value || "";
      if (v.trim().length > 40 && !/^\s*$/.test(v)) {
        if (accept(v, "textarea")) return result;
      }
    }
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
  }

  return result;
}
