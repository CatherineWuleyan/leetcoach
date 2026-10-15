// Model provider adapters.
//
// Two lessons from auditing the extension this replaces:
//  1. A hardcoded model name becomes a hard API error once the provider retires
//     it. The model here is always caller-supplied.
//  2. Reasoning-style models reject `temperature`, and some reject `max_tokens`
//     in favour of `max_completion_tokens`. So we send neither temperature nor
//     any sampling parameter, and retry once on the max_tokens rejection.

import { KINDS } from "./config.js";

const TIMEOUT_MS = 120000;

function trimSlash(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

/** Pull a human-readable error out of whatever shape the provider returned. */
function extractError(data, status) {
  if (!data) return `HTTP ${status}`;
  if (typeof data === "string") return `HTTP ${status}: ${data.slice(0, 300)}`;
  return (
    data?.error?.message ||
    data?.error?.type ||
    data?.message ||
    data?.detail ||
    (typeof data.error === "string" ? data.error : null) ||
    `HTTP ${status}`
  );
}

async function doFetch(url, init, timeoutMs = TIMEOUT_MS, consume = res => res) {
  const ctrl = new AbortController();
  const parent = init.signal;
  const abort = () => ctrl.abort();
  if (parent?.aborted) ctrl.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let received = false;
  try {
    const response = await fetch(url, { ...init, signal: ctrl.signal });
    received = true;
    // Keep the timeout active until the entire response body is consumed.
    return await consume(response);
  } catch (e) {
    if (parent?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (e.name === "AbortError") throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）。模型或网络尚未返回完整响应。`);
    if (received) throw e;
    throw new Error(`网络请求失败：${e.message}。如果这是自定义端点，可能是该域名没有授权。`);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

/* ------------------------------------------------------------------ OpenAI-compatible */

async function consumeChatStream(response, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "", usage = null, done = false;
  function event(frame) {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n").trim();
    if (!payload) return;
    if (payload === "[DONE]") { done = true; return; }
    let data;
    try { data = JSON.parse(payload); }
    catch { throw new Error("模型返回了无效的流式数据。"); }
    if (data.error) throw new Error(extractError(data,response.status));
    if (data.usage) usage = data.usage;
    // Render only the answer. Never expose reasoning_content as the reply.
    const delta = data.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) { text += delta; onText(text); }
  }
  function flush(final = false) {
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) { event(frame); if (done) return; }
    if (final && buffer.trim()) { event(buffer); buffer = ""; }
  }
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) { buffer += decoder.decode(); flush(true); break; }
      buffer += decoder.decode(chunk.value,{stream:true});
      flush();
    }
    if (!text) throw new Error("模型没有返回答复文本，请重试。");
    return {text,usage};
  } finally {
    // Cancelling releases a connection if [DONE] precedes the HTTP EOF.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function callOpenAICompatible({ baseUrl, model, apiKey, system, messages, maxTokens, onText, signal, timeoutMs, thinking }) {
  const url = `${trimSlash(baseUrl)}/chat/completions`;
  const base = { model, messages: [{ role: "system", content: system }, ...messages] };
  // Preserve the user-requested deep reasoning for coaching. Summaries may
  // explicitly choose non-thinking mode; never send vendor options elsewhere.
  if (new URL(baseUrl).hostname === "api.deepseek.com" && model === "deepseek-flash") {
    base.thinking = { type: thinking };
    if (thinking === "enabled") {
      base.reasoning_effort = "high";
      // DeepSeek counts reasoning and visible answer against the same cap.
      maxTokens = Math.max(maxTokens,8192);
    }
  }
  const streaming = typeof onText === "function";
  if (streaming) base.stream = true;
  async function request(tokenField) {
    return doFetch(url, {
      method:"POST", signal,
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({...base,[tokenField]:maxTokens}),
    }, timeoutMs, async response => {
      if (response.ok && streaming && response.body?.getReader &&
          !response.headers?.get("content-type")?.includes("application/json")) {
        return {result:await consumeChatStream(response,onText),ok:true};
      }
      const data = await response.json().catch(error => {
        if (error.name === "AbortError") throw error;
        return null;
      });
      return {data,ok:response.ok,status:response.status};
    });
  }
  let reply = await request("max_tokens");
  const message = String(reply.data?.error?.message || "");
  if (!reply.ok && /max_completion_tokens|max_tokens/i.test(message) && /not supported|unsupported|use /i.test(message)) {
    reply = await request("max_completion_tokens");
  }
  if (!reply.ok) throw new Error(extractError(reply.data,reply.status));
  if (reply.result) return reply.result;
  const choice = reply.data?.choices?.[0];
  const text = choice?.message?.content ?? choice?.text ?? "";
  if (!text) throw new Error("模型返回了空内容，可能仅产生了思考内容或触及输出上限。请重试。");
  if (streaming) onText(text);
  return {text,usage:reply.data?.usage || null};
}

/* ------------------------------------------------------------------ Anthropic */

async function callAnthropic({ baseUrl, model, apiKey, system, messages, maxTokens }) {
  const res = await doFetch(`${trimSlash(baseUrl)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for calls made directly from a browser context.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(extractError(data, res.status));

  const text = (data?.content || [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!text) throw new Error("Anthropic 返回了空内容。");
  return { text, usage: data?.usage || null };
}

/* ------------------------------------------------------------------ Gemini */

async function callGemini({ baseUrl, model, apiKey, system, messages, maxTokens }) {
  const cleanModel = String(model).replace(/^models\//, "");
  const url = `${trimSlash(baseUrl)}/models/${encodeURIComponent(cleanModel)}:generateContent`;

  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(extractError(data, res.status));

  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p?.text || "").join("");
  if (!text) {
    const reason = cand?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(
      reason ? `Gemini 没有返回文本（原因：${reason}）。` : "Gemini 返回了空内容。"
    );
  }
  return { text, usage: data?.usageMetadata || null };
}

/* ------------------------------------------------------------------ local bridge (Codex) */

// The bridge drives the official Codex CLI, so a reply takes far longer than a
// chat completion would. Codex's own overhead alone ran ~6.3k tokens on a
// one-word prompt in testing, and wall time is routinely 10-40s.
const BRIDGE_TIMEOUT_MS = 200000;

async function callBridge({ baseUrl, apiKey, model, system, messages }) {
  const url = `${trimSlash(baseUrl)}/chat`;

  let res;
  try {
    res = await doFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LC-Coach-Token": apiKey,
        },
        body: JSON.stringify({
          system,
          messages,
          model,
          timeoutMs: BRIDGE_TIMEOUT_MS - 20000,
        }),
      },
      BRIDGE_TIMEOUT_MS
    );
  } catch (e) {
    throw new Error(
      `连不上本地桥（${url}）。确认运行桥的那个终端还开着。原始错误：${e.message}`
    );
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(extractError(data, res.status));
  if (!data?.text) {
    throw new Error("本地桥返回了空内容。去看运行桥的终端有没有报错。");
  }
  return { text: data.text, usage: data.usage || null };
}

/* ------------------------------------------------------------------ public API */

/**
 * @param {object} cfg
 * @param {string} cfg.kind      KINDS.*
 * @param {string} cfg.baseUrl
 * @param {string} cfg.model
 * @param {string} cfg.apiKey
 * @param {string} cfg.system
 * @param {Array<{role:string,content:string}>} cfg.messages
 * @param {number} [cfg.maxTokens]
 */
export async function callModel(cfg) {
  const {
    kind = KINDS.OPENAI,
    baseUrl,
    model,
    apiKey,
    system,
    messages,
    maxTokens = 2048,
    onText, signal, timeoutMs = TIMEOUT_MS, thinking = "enabled",
  } = cfg;

  if (kind === KINDS.BRIDGE) {
    if (!apiKey) {
      throw new Error("还没填本地桥令牌。看运行桥的终端打印的那一串。");
    }
  } else if (!apiKey) {
    throw new Error("还没填 API Key。点右上角 ⚙ 打开设置。");
  }

  // The bridge decides the model itself, so an empty value is fine there.
  if (!model && kind !== KINDS.BRIDGE) {
    throw new Error("还没填模型名。在设置里点「拉取模型」选一个，或手填。");
  }
  if (!baseUrl) throw new Error("还没填 Base URL。");
  if (!messages?.length) throw new Error("没有要发送的内容。");

  if (kind === KINDS.BRIDGE) {
    return callBridge({ baseUrl, apiKey, model, system, messages });
  }

  const args = { baseUrl, model, apiKey, system, messages, maxTokens, onText, signal, timeoutMs, thinking };
  if (kind === KINDS.ANTHROPIC) return callAnthropic(args);
  if (kind === KINDS.GEMINI) return callGemini(args);
  return callOpenAICompatible(args);
}

/**
 * Fetch the provider's live model list so the user never has to guess a name.
 * Returns [{ id, label }] sorted, or throws with a readable message.
 */
export async function listModels({ kind, baseUrl, apiKey }) {
  if (kind === KINDS.BRIDGE) {
    if (!apiKey) throw new Error("先填本地桥令牌。");
    const res = await doFetch(
      `${trimSlash(baseUrl)}/models`,
      { headers: { "X-LC-Coach-Token": apiKey } },
      15000
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(extractError(data, res.status));
    return (data?.data || []).map((m) => ({ id: m.id, label: m.label || m.id }));
  }

  if (!apiKey) throw new Error("先填 API Key 才能拉取模型列表。");
  if (!baseUrl) throw new Error("先填 Base URL。");

  if (kind === KINDS.GEMINI) {
    const res = await doFetch(`${trimSlash(baseUrl)}/models`, {
      headers: { "x-goog-api-key": apiKey },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(extractError(data, res.status));
    return (data?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => ({
        id: String(m.name || "").replace(/^models\//, ""),
        label: m.displayName || m.name,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  const headers =
    kind === KINDS.ANTHROPIC
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }
      : { Authorization: `Bearer ${apiKey}` };

  const res = await doFetch(`${trimSlash(baseUrl)}/models`, { headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(extractError(data, res.status));

  const rows = data?.data || data?.models || [];
  return rows
    .map((m) => ({ id: m.id || m.name, label: m.id || m.name }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}
