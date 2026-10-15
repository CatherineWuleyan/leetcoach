// Logic tests for LC Coach. Runs in Node with no browser: stubs fetch and the
// handful of globals the modules touch.

import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2];
const SRC = path.join(ROOT, "src");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${String(err.message).split("\n").slice(0, 6).join("\n     ")}`);
    failed++;
  }
}

const { DEFAULT_COACH_PROMPT, buildMessages } = await import(
  "file://" + path.join(SRC, "prompts.js")
);
const { renderMarkdown, escapeHtml } = await import("file://" + path.join(SRC, "markdown.js"));
const { PROVIDERS, PROVIDER_ORDER, MODES, MODE_ORDER, DEFAULT_SETTINGS, KINDS } = await import(
  "file://" + path.join(SRC, "config.js")
);
const { callModel, listModels } = await import("file://" + path.join(SRC, "providers.js"));
const BRIDGE = await import("file://" + path.join(ROOT, "bridge", "lib.mjs"));
const ARCHIVE = await import("file://" + path.join(SRC, "archive.js"));

const PROBLEM = {
  title: "两数之和",
  number: "1",
  difficulty: "简单",
  description: "给定一个整数数组 nums 和一个目标值 target。",
  examples: ["示例 1：\nnums = [2,7,11,15], target = 9"],
  constraints: ["2 <= nums.length <= 10^4"],
  topics: ["数组", "哈希表"],
  language: "C++",
  url: "https://leetcode.cn/problems/two-sum/",
};

console.log("\n=== 1. buildMessages ===");

await test("首轮带上下文且只发送一次问题", () => {
  const { messages } = buildMessages({problem:PROBLEM,code:"int x;",language:"C++",mode:"ladder",userText:"我的想法是暴力"});
  const body=messages.map(m=>m.content).join("\n");
  assert.ok(body.includes("两数之和"));
  assert.equal(body.split("我的想法是暴力").length-1,1);
});
await test("追问不重复发送用户输入，当前任务放在历史之后", () => {
  const {messages}=buildMessages({problem:PROBLEM,mode:"detail",history:[{role:"user",content:"原问题"},{role:"assistant",content:"提示"}],userText:"用哈希表？"});
  assert.equal(messages.at(-1).role,"user");
  assert.ok(messages.at(-1).content.includes("问细节"));
  assert.equal(messages.map(m=>m.content).join("\n").split("用哈希表？").length-1,1);
});
await test("后台总结覆盖题型、解法、变式与有证据语法，禁止复制题目", () => {
  const {system,messages}=buildMessages({problem:PROBLEM,mode:"archive",previousSummary:"已有总结"});
  assert.ok(system.includes("学习记录整理员"));
  for(const field of ["题型总结","基本解法","变式","提问依据","不要复制题目"]) assert.ok(messages[0].content.includes(field));
  assert.ok(messages[0].content.includes("已有总结"));
});
await test("超长上下文被截断", () => {
  const {messages}=buildMessages({problem:{...PROBLEM,description:"x".repeat(50000)},code:"y".repeat(50000)});
  assert.ok(messages[0].content.length<20000);
  assert.ok(messages[0].content.includes("已截断"));
});
await test("只保留递进、细节和后台总结三类任务", () => {
  assert.deepEqual(MODE_ORDER,["ladder","detail","archive"]);
  for(const mode of MODE_ORDER) assert.ok(buildMessages({problem:PROBLEM,mode}).messages.length);
});

console.log("\n=== 2. Markdown 渲染 / XSS ===");

await test("script 标签被转义，不会变成真标签", () => {
  const html = renderMarkdown('前 <script>alert("xss")</script> 后');
  assert.ok(!html.includes("<script>"), "不能产出真的 <script> 标签");
  assert.ok(html.includes("&lt;script&gt;"), "应被转义");
});

await test("img onerror 注入被转义", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!/<img/i.test(html), "不能产出真的 img 标签");
  assert.ok(html.includes("&lt;img"), "应被转义");
});

await test("围栏代码块内的 HTML 也保持转义", () => {
  const html = renderMarkdown("```html\n<b>bold</b>\n```");
  assert.ok(html.includes("<pre><code"), "应渲染成 pre/code");
  assert.ok(html.includes("&lt;b&gt;"), "代码内容应转义");
  assert.ok(!html.includes("<b>bold</b>"), "不能出现未转义的标签");
});

await test("围栏代码块内的 markdown 不被解析", () => {
  const html = renderMarkdown("```\n# 这不是标题\n**不是粗体**\n```");
  assert.ok(!html.includes("<h1>"), "代码块内不应产生标题");
  assert.ok(!html.includes("<strong>"), "代码块内不应产生粗体");
});

await test("正常 markdown 结构渲染正确", () => {
  const html = renderMarkdown(
    "## 标题\n\n- 项目一\n- 项目二\n\n1. 有序\n\n**粗体** 和 `行内代码`\n\n> 引用"
  );
  assert.ok(html.includes("<h2>标题</h2>"));
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<ol>"));
  assert.ok(html.includes("<strong>粗体</strong>"));
  assert.ok(html.includes("<code>行内代码</code>"));
  assert.ok(html.includes("<blockquote>引用</blockquote>"));
});

await test("代码块里的反引号不会破坏解析", () => {
  const html = renderMarkdown("用 `a` 然后：\n\n```py\nprint('hi')\n```\n\n结束");
  assert.ok(html.includes("<pre><code"));
  assert.ok(html.includes("print(&#39;hi&#39;)") || html.includes("print('hi')"));
});

await test("escapeHtml 覆盖五个危险字符", () => {
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

console.log("\n=== 3. config 一致性 ===");

await test("每个 provider 都有完整字段，kind 合法", () => {
  const kinds = new Set(Object.values(KINDS));
  for (const key of PROVIDER_ORDER) {
    const p = PROVIDERS[key];
    assert.ok(p, `PROVIDER_ORDER 里的 ${key} 在 PROVIDERS 中不存在`);
    assert.ok(kinds.has(p.kind), `${key} 的 kind 非法: ${p.kind}`);
    assert.ok(typeof p.label === "string" && p.label, `${key} 缺 label`);
  }
});

await test("PROVIDER_ORDER 与 PROVIDERS 完全对应", () => {
  assert.deepEqual([...PROVIDER_ORDER].sort(), Object.keys(PROVIDERS).sort());
});

await test("每个模式都定义了 label 和 instruction", () => {
  for (const key of MODE_ORDER) {
    assert.ok(MODES[key], `MODE_ORDER 里的 ${key} 在 MODES 中不存在`);
    assert.ok(MODES[key].label, `${key} 缺 label`);
    assert.ok(MODES[key].instruction, `${key} 缺 instruction`);
  }
  assert.deepEqual([...MODE_ORDER].sort(), Object.keys(MODES).sort());
});

await test("默认设置自洽且指向真实 provider", () => {
  assert.ok(DEFAULT_SETTINGS.provider);
  assert.ok(DEFAULT_SETTINGS.model, "默认模型名不能为空");
  assert.ok(
    /^https:\/\//.test(DEFAULT_SETTINGS.baseUrl) ||
      /^http:\/\/127\.0\.0\.1/.test(DEFAULT_SETTINGS.baseUrl),
    `默认 Base URL 不合法: ${DEFAULT_SETTINGS.baseUrl}`
  );
  assert.ok(PROVIDERS[DEFAULT_SETTINGS.provider], "默认 provider 必须在 PROVIDERS 里存在");
});

console.log("\n=== 4. provider 请求格式 ===");

function stubFetch(responder) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responder(url, init, calls.length);
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
  return calls;
}

await test("OpenAI 兼容: URL / header / system 首条", async () => {
  const calls = stubFetch(() => ({ body: { choices: [{ message: { content: "ok" } }] } }));
  const out = await callModel({
    kind: KINDS.OPENAI,
    baseUrl: "https://api.deepseek.com/v1/",
    model: "deepseek-chat",
    apiKey: "sk-test",
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.text, "ok");
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/chat/completions", "末尾斜杠应被规整");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[0].content, "SYS");
  assert.ok(!("temperature" in sent), "不应发送 temperature（推理模型会拒绝）");
});

await test("max_tokens 被拒时自动改用 max_completion_tokens 重试", async () => {
  const calls = stubFetch((url, init, n) => {
    const sent = JSON.parse(init.body);
    if (n === 1) {
      assert.ok("max_tokens" in sent);
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        },
      };
    }
    return { body: { choices: [{ message: { content: "retried" } }] } };
  });
  const out = await callModel({
    kind: KINDS.OPENAI,
    baseUrl: "https://api.openai.com/v1",
    model: "o-series",
    apiKey: "k",
    system: "S",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(out.text, "retried");
  assert.equal(calls.length, 2, "应该重试一次");
  assert.ok("max_completion_tokens" in JSON.parse(calls[1].init.body));
});

await test("Anthropic: 必要 header 与 content 数组提取", async () => {
  const calls = stubFetch(() => ({
    body: { content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] },
  }));
  const out = await callModel({
    kind: KINDS.ANTHROPIC,
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-x",
    apiKey: "sk-ant",
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.text, "第一段\n第二段");
  const h = calls[0].init.headers;
  assert.equal(h["x-api-key"], "sk-ant");
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(
    h["anthropic-dangerous-direct-browser-access"],
    "true",
    "浏览器直连必须带这个 header"
  );
  assert.equal(JSON.parse(calls[0].init.body).system, "SYS");
});

await test("Gemini: 路径 / header / assistant→model 映射", async () => {
  const calls = stubFetch(() => ({
    body: { candidates: [{ content: { parts: [{ text: "gemini 回答" }] } }] },
  }));
  const out = await callModel({
    kind: KINDS.GEMINI,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "models/gemini-flash",
    apiKey: "g-key",
    system: "SYS",
    messages: [
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ],
  });
  assert.equal(out.text, "gemini 回答");
  assert.ok(
    calls[0].url.includes("/models/gemini-flash:generateContent"),
    `URL 应去掉 models/ 前缀，实际 ${calls[0].url}`
  );
  assert.ok(!calls[0].url.includes("models/models/"), "不应出现双重 models/ 前缀");
  assert.equal(calls[0].init.headers["x-goog-api-key"], "g-key");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.contents[1].role, "model", "assistant 必须映射成 model");
  assert.equal(sent.systemInstruction.parts[0].text, "SYS");
});

await test("缺少 apiKey / model 时给出可读错误，且不发请求", async () => {
  const calls = stubFetch(() => ({ body: {} }));
  await assert.rejects(
    () =>
      callModel({
        kind: KINDS.OPENAI,
        baseUrl: "https://x/v1",
        model: "m",
        apiKey: "",
        system: "s",
        messages: [{ role: "user", content: "x" }],
      }),
    /API Key/
  );
  await assert.rejects(
    () =>
      callModel({
        kind: KINDS.OPENAI,
        baseUrl: "https://x/v1",
        model: "",
        apiKey: "k",
        system: "s",
        messages: [{ role: "user", content: "x" }],
      }),
    /模型名/
  );
  assert.equal(calls.length, 0, "校验失败时不应发出网络请求");
});

await test("provider 错误原文被透传（便于排错）", async () => {
  stubFetch(() => ({
    ok: false,
    status: 401,
    body: { error: { message: "Invalid API key provided" } },
  }));
  await assert.rejects(
    () =>
      callModel({
        kind: KINDS.OPENAI,
        baseUrl: "https://api.openai.com/v1",
        model: "m",
        apiKey: "bad",
        system: "s",
        messages: [{ role: "user", content: "x" }],
      }),
    /Invalid API key provided/
  );
});

await test("listModels 解析出模型 id 并排序", async () => {
  stubFetch(() => ({ body: { data: [{ id: "gpt-b" }, { id: "gpt-a" }] } }));
  const list = await listModels({ kind: KINDS.OPENAI, baseUrl: "https://x/v1", apiKey: "k" });
  assert.deepEqual(list.map((m) => m.id), ["gpt-a", "gpt-b"]);
});

console.log("\n=== 5. 提交拦截（hook.js）逻辑 ===");

function runHook() {
  const code = fs.readFileSync(path.join(SRC, "hook.js"), "utf8");
  const messages = [];
  const sandbox = {
    console,
    window: {
      __LC_COACH_HOOKED__: false,
      location: { origin: "https://leetcode.cn", href: "https://leetcode.cn/problems/x/" },
      postMessage: (m) => messages.push(m),
      fetch: async () => ({ ok: true }),
    },
    URL,
    FormData: class FormData {},
    XMLHttpRequest: function () {},
  };
  sandbox.XMLHttpRequest.prototype = {
    open() {},
    send() {},
  };
  sandbox.window.XMLHttpRequest = sandbox.XMLHttpRequest;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, messages };
}

await test("从 submit 请求体里抓到完整代码", async () => {
  const { sandbox, messages } = runHook();
  const body = JSON.stringify({
    operationName: "submit",
    variables: { lang: "cpp", titleSlug: "two-sum", typedCode: "class Solution { };//x" },
  });
  await sandbox.window.fetch("https://leetcode.cn/graphql/", { method: "POST", body });

  const submit = messages.find((m) => m.type === "submit");
  assert.ok(submit, "应发出 submit 事件");
  assert.equal(submit.payload.code, "class Solution { }; //x".replace(" //x", "//x"));
  assert.equal(submit.payload.lang, "cpp");
  assert.equal(submit.payload.slug, "two-sum");
});

await test("REST submit 没有 operationName 也能抓到完整代码", async () => {
  const { sandbox, messages } = runHook();
  await sandbox.window.fetch("/problems/two-sum/submit/", {
    method: "POST", body: JSON.stringify({ lang: "python3", typed_code: "class Solution: pass" }),
  });
  const submit = messages.find(m => m.type === "submit");
  assert.equal(submit?.payload.code, "class Solution: pass");
  assert.equal(submit?.payload.isRun, false);
});

await test("运行示例单独标记，不会冒充正式提交", async () => {
  const { sandbox, messages } = runHook();
  await sandbox.window.fetch("/problems/two-sum/interpret_solution/", {
    method: "POST", body: JSON.stringify({ lang: "python3", typed_code: "class Solution: pass" }),
  });
  assert.equal(messages.find(m => m.type === "submit")?.payload.isRun, true);
});

await test("非提交类请求（查询/轮询）不误报", async () => {
  const { sandbox, messages } = runHook();
  const bodies = [
    JSON.stringify({ operationName: "checkSubmission", variables: { typedCode: "AAAA1234567890" } }),
    JSON.stringify({ operationName: "questionData", variables: { titleSlug: "two-sum" } }),
    JSON.stringify({ operationName: "submissionList", variables: { typedCode: "BBBB1234567890" } }),
  ];
  for (const b of bodies) {
    await sandbox.window.fetch("https://leetcode.cn/graphql/", { method: "POST", body: b });
  }
  const submits = messages.filter((m) => m.type === "submit");
  assert.equal(submits.length, 0, `不应误报，实际报了 ${submits.length} 次`);
});

await test("畸形 JSON 不会抛错，也不会误报", async () => {
  const { sandbox, messages } = runHook();
  await sandbox.window.fetch("https://leetcode.cn/graphql/", { method: "POST", body: "{不是合法json" });
  await sandbox.window.fetch("https://leetcode.cn/graphql/", { method: "POST", body: "null" });
  assert.equal(messages.filter((m) => m.type === "submit").length, 0);
});

await test("过短的疑似代码被忽略（避免抓垃圾串）", async () => {
  const { sandbox, messages } = runHook();
  await sandbox.window.fetch("https://leetcode.cn/graphql/", {
    method: "POST",
    body: JSON.stringify({ operationName: "submit", variables: { typedCode: "abc" } }),
  });
  assert.equal(messages.filter((m) => m.type === "submit").length, 0);
});

await test("重复注入被 __LC_COACH_HOOKED__ 挡住", async () => {
  const { sandbox, messages } = runHook();
  const code = fs.readFileSync(path.join(SRC, "hook.js"), "utf8");
  vm.runInContext(code, sandbox);
  const ready = messages.filter((m) => m.type === "ready");
  assert.equal(ready.length, 1, `ready 事件应只发一次，实际 ${ready.length} 次`);
});

await test("原 fetch 的返回值被透传（不能弄坏页面）", async () => {
  const { sandbox } = runHook();
  const res = await sandbox.window.fetch("https://leetcode.cn/graphql/", { method: "POST", body: "{}" });
  assert.ok(res && res.ok, "包装后的 fetch 必须把原结果还给页面");
});

console.log("\n=== 6. 本地桥 lib（Codex 输出解析）===");

await test("extractAnswer 优先用 stdout", () => {
  assert.equal(BRIDGE.extractAnswer("PONG\n", "noise\ncodex\nWRONG\n"), "PONG");
});

await test("stdout 为空时从 stderr 抽答案，并切掉 token 页脚", () => {
  const stderr = [
    "approval: never",
    "sandbox: read-only",
    "--------",
    "user",
    "Reply PONG",
    "codex",
    "PONG",
    "tokens used",
    "6,343",
  ].join("\n");
  assert.equal(BRIDGE.extractAnswer("", stderr), "PONG");
});

await test("codex 标记出现多次时取最后一次", () => {
  const stderr = "codex\n旧的\nuser\n新问题\ncodex\n新答案\ntokens used\n10";
  assert.equal(BRIDGE.extractAnswer("   ", stderr), "新答案");
});

await test("两路都空时返回空串而不是崩", () => {
  assert.equal(BRIDGE.extractAnswer("", ""), "");
  assert.equal(BRIDGE.extractAnswer(undefined, undefined), "");
});

await test("parseUsage 解析带千分位的 token 数", () => {
  assert.equal(BRIDGE.parseUsage("tokens used\n6,343\n"), 6343);
  assert.equal(BRIDGE.parseUsage("tokens used\n122\n"), 122);
  assert.equal(BRIDGE.parseUsage("没有这一行"), null);
});

await test("ANSI 颜色码被清掉", () => {
  assert.equal(BRIDGE.stripAnsi("\u001b[31m红\u001b[0m"), "红");
  assert.equal(BRIDGE.extractAnswer("\u001b[32mPONG\u001b[0m", ""), "PONG");
});

await test("识别未登录与超额度两类错误", () => {
  assert.match(BRIDGE.detectAuthError("Error: not logged in"), /codex login/);
  assert.match(BRIDGE.detectAuthError("HTTP 429 rate limit exceeded"), /额度/);
  assert.equal(BRIDGE.detectAuthError("everything is fine"), null);
});

await test("flattenToPrompt 含工具禁令 / 人格 / 上下文 / 对话，且人格在前", () => {
  const p = BRIDGE.flattenToPrompt({
    system: "你是量化面试教练",
    messages: [
      { role: "user", content: "题目：两数之和" },
      { role: "assistant", content: "你的思路呢？" },
      { role: "user", content: "用哈希表" },
    ],
  });
  assert.ok(p.includes("禁止读取任何文件"), "必须有工具禁令");
  assert.ok(p.includes("你是量化面试教练"), "必须含人格");
  assert.ok(p.includes("题目：两数之和"), "必须含上下文");
  assert.ok(p.includes("你的思路呢？"), "必须含历史回复");
  assert.ok(p.includes("用哈希表"), "必须含后续输入");
  assert.ok(
    p.indexOf("你是量化面试教练") < p.indexOf("题目：两数之和"),
    "人格必须排在题目之前"
  );
});

await test("flattenToPrompt 容忍字段缺失", () => {
  assert.doesNotThrow(() => BRIDGE.flattenToPrompt({}));
  assert.doesNotThrow(() => BRIDGE.flattenToPrompt({ system: null, messages: null }));
});

console.log("\n=== 7. bridge provider ===");

await test("callBridge 打到 /chat 并带令牌 header", async () => {
  const calls = stubFetch(() => ({
    body: { text: "教练回复", usage: { totalTokens: 6343 } },
  }));
  const out = await callModel({
    kind: KINDS.BRIDGE,
    baseUrl: "http://127.0.0.1:8788",
    model: "default",
    apiKey: "tok-123",
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.text, "教练回复");
  assert.equal(calls[0].url, "http://127.0.0.1:8788/chat");
  assert.equal(calls[0].init.headers["X-LC-Coach-Token"], "tok-123");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.system, "SYS");
  assert.equal(sent.model, "default");
});

await test("callBridge 缺令牌时给出桥专用提示，且不发请求", async () => {
  const calls = stubFetch(() => ({ body: {} }));
  await assert.rejects(
    () =>
      callModel({
        kind: KINDS.BRIDGE,
        baseUrl: "http://127.0.0.1:8788",
        model: "default",
        apiKey: "",
        system: "s",
        messages: [{ role: "user", content: "x" }],
      }),
    /本地桥令牌/
  );
  assert.equal(calls.length, 0);
});

await test("callBridge 允许空模型名（交给桥决定）", async () => {
  stubFetch(() => ({ body: { text: "ok" } }));
  const out = await callModel({
    kind: KINDS.BRIDGE,
    baseUrl: "http://127.0.0.1:8788",
    model: "",
    apiKey: "t",
    system: "s",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(out.text, "ok");
});

await test("桥没启动时给出可操作的报错", async () => {
  global.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    () =>
      callModel({
        kind: KINDS.BRIDGE,
        baseUrl: "http://127.0.0.1:8788",
        model: "default",
        apiKey: "t",
        system: "s",
        messages: [{ role: "user", content: "x" }],
      }),
    /连不上本地桥/
  );
});

await test("桥返回 401 时透传令牌错误原文", async () => {
  stubFetch(() => ({
    ok: false,
    status: 401,
    body: { error: "令牌不对。把启动时终端打印的那串令牌粘到扩展设置里。" },
  }));
  await assert.rejects(
    () =>
      callModel({
        kind: KINDS.BRIDGE,
        baseUrl: "http://127.0.0.1:8788",
        model: "default",
        apiKey: "bad",
        system: "s",
        messages: [{ role: "user", content: "x" }],
      }),
    /令牌不对/
  );
});

await test("listModels 走桥的 /models 并带令牌", async () => {
  const calls = stubFetch(() => ({
    body: { data: [{ id: "default", label: "Codex 默认模型" }] },
  }));
  const list = await listModels({
    kind: KINDS.BRIDGE,
    baseUrl: "http://127.0.0.1:8788",
    apiKey: "t",
  });
  assert.equal(calls[0].url, "http://127.0.0.1:8788/models");
  assert.equal(calls[0].init.headers["X-LC-Coach-Token"], "t");
  assert.deepEqual(list.map((m) => m.id), ["default"]);
});

await test("DeepSeek 预设带的模型名来自实测", () => {
  assert.ok(PROVIDER_ORDER.includes("deepseek"), "应提供 deepseek");
  assert.ok(PROVIDERS.deepseek, "应有 deepseek 预设");
  assert.equal(PROVIDERS.deepseek.baseUrl, "https://api.deepseek.com/v1");
  assert.ok(PROVIDERS.deepseek.model, "默认模型名不能为空");
});

await test("默认是 DeepSeek，Codex 本地桥仍然可选", () => {
  assert.equal(DEFAULT_SETTINGS.provider, "deepseek");
  assert.ok(PROVIDERS.codex, "Codex 桥不应被删掉");
  assert.equal(PROVIDERS.codex.kind, KINDS.BRIDGE);
  assert.ok(PROVIDERS.codex.tokenLabel, "桥的密钥字段应有专用标签");
});

console.log("\n=== 8. 三层阶梯 ===");

const ladderMsg = (step) =>
  buildMessages({
    systemPrompt: "S",
    problem: PROBLEM,
    code: "int x;",
    language: "C++",
    mode: "ladder",
    ladderStep: step,
    fullSolution: step === 3,
    history: [],
    userText: "",
  }).messages[0].content;

await test("第 1 层禁止说出模式名，且禁止给代码", () => {
  const b = ladderMsg(1);
  assert.ok(b.includes("绝对不要说出算法模式的名字"), "第1层必须禁止点破模式");
  assert.ok(b.includes("绝对不要给代码"), "第1层必须禁止给代码");
  assert.ok(!b.includes("这一层才允许说出来"), "第1层不该混入第2层内容");
  assert.ok(!b.includes("完整可提交的代码"), "第1层不该混入第3层内容");
});

await test("第 2 层才允许说模式名，仍禁止代码与伪代码", () => {
  const b = ladderMsg(2);
  assert.ok(b.includes("这一层才允许说出来"));
  assert.ok(b.includes("不要给任何代码"));
  assert.ok(b.includes("也不要给伪代码"));
  assert.ok(!b.includes("完整可提交的代码"), "第2层不该混入第3层内容");
});

await test("第 3 层才给完整可提交代码", () => {
  const b = ladderMsg(3);
  assert.ok(b.includes("完整可提交的代码"));
  assert.ok(b.includes("边界情况"));
});

await test("阶梯越界值被夹紧而不是崩掉", () => {
  for (const s of [0, -5, 99, null, undefined, "x", NaN]) {
    const b = ladderMsg(s);
    assert.ok(b.length > 100, `ladderStep=${s} 时应仍有合法指令`);
  }
});

await test("detail 模式不许扩展到我未问的部分", () => {
  const b = buildMessages({
    systemPrompt: "S",
    problem: PROBLEM,
    code: "int x;",
    language: "C++",
    mode: "detail",
    ladderStep: 1,
    history: [],
    userText: "为什么这里是 n-1？",
  }).messages.at(-1).content;
  assert.ok(b.includes("不扩张到我没问的部分"));
  assert.ok(b.includes("为什么这里是 n-1？"));
});

await test("archive 模式注入了全部三个分隔符", () => {
  const b = buildMessages({
    systemPrompt: "S",
    problem: PROBLEM,
    code: "int x;",
    language: "C++",
    mode: "archive",
    ladderStep: 1,
    history: [],
    userText: "",
  }).messages[0].content;
  assert.ok(b.includes("@@PROBLEM@@"));
  assert.ok(b.includes("@@SYNTAX@@"));
  assert.ok(b.includes("@@ENTRY:"));
  assert.ok(b.includes("只收录有真实提问证据的语法点"), "必须禁止编造语法条目");
});

console.log("\n=== 9. 归档输出解析 ===");

const SAMPLE_ARCHIVE = `@@PROBLEM@@
### LC 3 · 无重复字符的最长子串
- **题型**：滑动窗口
- **触发信号**：连续子串 + 最长
@@SYNTAX@@
@@ENTRY:cpp-unordered_map-iteration@@
### 语法 · unordered_map 遍历
- **易忘点**：迭代器写法
- **正确写法**：
\`\`\`cpp
for (auto& [k, v] : m) {}
\`\`\`
@@ENTRY:python-defaultdict-init@@
### 语法 · defaultdict 初始化
- **易忘点**：忘了传工厂函数`;

await test("拆出题目与多个语法条目", () => {
  const r = ARCHIVE.parseArchive(SAMPLE_ARCHIVE);
  assert.ok(r.ok);
  assert.equal(r.problem.title, "LC 3 · 无重复字符的最长子串");
  assert.ok(r.problem.markdown.includes("滑动窗口"));
  assert.equal(r.syntax.length, 2);
  // normalizeKey folds underscores into dashes, so keys stay stable no matter
  // which separator the model happens to emit.
  assert.equal(r.syntax[0].key, "cpp-unordered-map-iteration");
  assert.equal(r.syntax[1].key, "python-defaultdict-init");
  assert.equal(r.syntax[0].title, "unordered_map 遍历");
  assert.ok(r.syntax[0].markdown.includes("for (auto& [k, v] : m)"), "代码块要保留");
});

await test("忽略前言和整体包裹的代码围栏", () => {
  const wrapped =
    "好的，这是归档条目：\n```markdown\n@@PROBLEM@@\n### LC 1 · 两数之和\n- **题型**：哈希表\n@@SYNTAX@@\n```";
  const r = ARCHIVE.parseArchive(wrapped);
  assert.ok(r.ok);
  assert.equal(r.problem.title, "LC 1 · 两数之和");
  assert.ok(!r.problem.markdown.includes("```"), "结尾围栏应被剥掉");
  assert.ok(!r.problem.markdown.includes("好的"), "前言不该进正文");
  assert.equal(r.syntax.length, 0);
});

await test("语法区为空时返回空数组，不编造", () => {
  const r = ARCHIVE.parseArchive("@@PROBLEM@@\n### LC 5 · x\n- a\n@@SYNTAX@@\n");
  assert.ok(r.ok);
  assert.equal(r.syntax.length, 0);
});

await test("完全没有标记时 ok=false，避免静默归档空内容", () => {
  const r = ARCHIVE.parseArchive("这是一段普通回复，没有标记。");
  assert.equal(r.ok, false);
  assert.equal(r.problem, null);
  assert.deepEqual(r.syntax, []);
});

await test("代码里出现类似标记的注释不会破坏解析", () => {
  const text = [
    "@@PROBLEM@@",
    "### LC 9 · x",
    "```cpp",
    "// @@SYNTAX@@ 出现在注释里",
    "int a;",
    "```",
    "@@SYNTAX@@",
    "@@ENTRY:k@@",
    "### 语法 · y",
    "- z",
  ].join("\n");
  const r = ARCHIVE.parseArchive(text);
  assert.ok(r.ok);
  assert.ok(r.problem.markdown.includes("int a;"));
  assert.equal(r.syntax.length, 1);
  assert.equal(r.syntax[0].key, "k");
});

await test("畸形输入不抛异常", () => {
  for (const bad of ["", null, undefined, "@@PROBLEM@@", "@@SYNTAX@@", "@@ENTRY:x@@", "@@SYNTAX@@\n@@ENTRY:@@\n"]) {
    assert.doesNotThrow(() => ARCHIVE.parseArchive(bad), `输入 ${JSON.stringify(bad)} 时崩了`);
  }
});

await test("key 归一化：大写/空格/符号都变成合法短横线 key", () => {
  assert.equal(ARCHIVE.normalizeKey("C++ Vector Init"), "c-vector-init");
  assert.equal(ARCHIVE.normalizeKey("  Python__Dict  "), "python-dict");
  assert.equal(ARCHIVE.normalizeKey("@@@"), "");
});

await test("problemKey 优先用题号，退化为 slug", () => {
  assert.equal(ARCHIVE.problemKey({ number: "3", slug: "x", title: "y" }), "LC 3");
  assert.equal(ARCHIVE.problemKey({ slug: "two-sum" }), "lc-two-sum");
  assert.equal(ARCHIVE.problemKey({}), "unknown");
});

console.log("\n" + "=".repeat(50));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log("=".repeat(50));
process.exit(failed ? 1 : 0);
