// Provider presets, default settings, and mode definitions.
//
// DESIGN NOTE (why this file exists instead of hardcoded values):
// The extension this replaces hardcoded `model: "gpt-4-turbo"` inside the fetch
// call and shipped a config.js that nothing ever imported. Model names go stale
// fast and a stale name is a hard API error. So here the model is ALWAYS
// user-editable, and the UI can pull the live model list from the provider.

/** Transport kinds. `openai` covers every OpenAI-compatible endpoint. */
export const KINDS = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  GEMINI: "gemini",
  // Talks to bridge/server.mjs, which drives the official Codex CLI so a
  // ChatGPT subscription can be used without an API key.
  BRIDGE: "bridge",
};

/**
 * Provider presets. `baseUrl` is the part BEFORE the request path.
 * `model` is only a suggestion — the user can always overwrite it, and the
 * "拉取模型" button replaces it with what the provider actually serves.
 */
export const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    kind: KINDS.OPENAI,
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    note:
      "支持深度思考和流式回复。请拉取账号当前可用的模型列表。",
  },
  codex: {
    label: "Codex（本地桥）",
    kind: KINDS.BRIDGE,
    baseUrl: "http://127.0.0.1:8788",
    model: "default",
    keyUrl: "",
    tokenLabel: "本地桥令牌",
    note:
      "用你的 ChatGPT 订阅，不需要 API key、不需要额外付费。先在终端运行 node bridge/server.mjs，" +
      "再把终端打印的令牌填到下面。注意：Codex 是 agent，每次回复约 10–40 秒。",
  },
  openai: {
    label: "OpenAI",
    kind: KINDS.OPENAI,
    baseUrl: "https://api.openai.com/v1",
    model: "",
    keyUrl: "https://platform.openai.com/api-keys",
    note: "需要海外网络环境。模型名请点“拉取模型”确认。",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    kind: KINDS.ANTHROPIC,
    baseUrl: "https://api.anthropic.com/v1",
    model: "",
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "浏览器直连需要特殊 header，本扩展已自动处理。",
  },
  gemini: {
    label: "Google Gemini",
    kind: KINDS.GEMINI,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "",
    keyUrl: "https://aistudio.google.com/app/apikey",
    note: "有免费额度。模型名请点“拉取模型”确认。",
  },
  openrouter: {
    label: "OpenRouter",
    kind: KINDS.OPENAI,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "",
    keyUrl: "https://openrouter.ai/keys",
    note: "一个 key 转发多家模型，方便对比。",
  },
  custom: {
    label: "自定义 / 本地",
    kind: KINDS.OPENAI,
    baseUrl: "",
    model: "",
    keyUrl: "",
    note: "任何 OpenAI 兼容端点（Ollama、vLLM、公司网关等）。首次调用会请求该域名权限。",
  },
};

export const PROVIDER_ORDER = [
  "deepseek",
  "codex",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "custom",
];

/** The only teaching flow exposed in the panel. */
export const LADDER_STEPS = [
  { step: 1, label: "获取 hint", blurb: "只指方向，让你先说自己的思路。" },
  { step: 2, label: "算法思路", blurb: "模式、触发信号、步骤、复杂度；不给代码。" },
  { step: 3, label: "完整代码", blurb: "点击表示明确选择完整解法。" },
];
export const LADDER_MAX_STEP = 3;
export const MODES = {
  ladder: { label: "递进学习", instruction: "只回答当前这一层。", ladder: true },
  detail: { label: "问细节", instruction: "只回答我问的这一点，不重述，不扩张，不推进层级。如果问题有概念错误，第一句纠正。" },
  archive: { label: "总结归档", instruction: "为复习总结已有问答，不直接复制题面或完整代码。", archiveMode: true },
};
export const MODE_ORDER = ["ladder", "detail", "archive"];
export const DEFAULT_SETTINGS = {
  provider: "deepseek",
  baseUrl: PROVIDERS.deepseek.baseUrl,
  model: PROVIDERS.deepseek.model,
  apiKey: "",
  language: "auto",
  uiVersion: 2,
  coachPromptVersion: 1,
  bridge: { url: "http://127.0.0.1:8788", token: "" },
  obsidian: {
    path: "", // Copy archivePath from the local bridge configuration.
  },
  coachPrompt: null,
};

/** Languages offered in the UI, mapped to the prompt wording. */
export const LANGUAGES = [
  "auto",
  "Python3",
  "C++",
  "Java",
  "JavaScript",
  "TypeScript",
  "Go",
  "Rust",
  "C",
  "C#",
  "Kotlin",
  "Swift",
  "Ruby",
  "Scala",
  "PHP",
  "SQL",
];
