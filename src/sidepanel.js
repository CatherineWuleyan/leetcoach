import { PROVIDERS, PROVIDER_ORDER, DEFAULT_SETTINGS, LANGUAGES, KINDS, LADDER_STEPS } from "./config.js";
import { DEFAULT_COACH_PROMPT, buildMessages } from "./prompts.js";
import { callModel, listModels } from "./providers.js";
import { PROBE_EDITOR } from "./probe.js";
import { renderMarkdown } from "./markdown.js";
import { problemKey, prepareArchive } from "./archive.js";
import { openManualNotes } from "./manual-notes.js";

const $ = id => document.getElementById(id);
const SETTINGS_PAGE = location.hash === "#settings";
const state = {
  settings: structuredClone(DEFAULT_SETTINGS), sessions: {}, syntaxMemory: {},
  problem: null, currentTabId: null, busy: false, syncing: false,
  archiveError: "", refreshId: 0, archiveController: null,
};
let storageTail = Promise.resolve();
let retryTimer;
let toastTimer;
let openingNotes = false;
const clone = value => structuredClone(value);
function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").classList.toggle("err", error);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}
function saveData() {
  const snapshot = clone({ sessions: state.sessions, syntaxMemory: state.syntaxMemory });
  // Preserve ordering when a new question arrives during an archive write.
  storageTail = storageTail.catch(() => {}).then(() => chrome.storage.local.set(snapshot));
  return storageTail;
}
function saveSettings() { return chrome.storage.local.set({settings: state.settings}); }
async function loadStorage() {
  const data = await chrome.storage.local.get(["settings", "sessions", "syntaxMemory"]);
  const saved = data.settings || {};
  state.settings = { ...DEFAULT_SETTINGS, ...saved,
    bridge: {...DEFAULT_SETTINGS.bridge, ...saved.bridge},
    obsidian: {...DEFAULT_SETTINGS.obsidian, ...saved.obsidian} };
  // This is the user-requested prompt migration; never touch the provider key.
  let settingsChanged = false;
  if (saved.uiVersion !== 2 || saved.coachPromptVersion !== 1) {
    state.settings.uiVersion = 2;
    state.settings.coachPromptVersion = 1;
    state.settings.coachPrompt = DEFAULT_COACH_PROMPT;
    settingsChanged = true;
  }
  // The reviewed summary format is now the default; retire the temporary pause.
  if ("archivePaused" in state.settings) { delete state.settings.archivePaused; settingsChanged = true; }
  if (settingsChanged) await saveSettings();
  state.sessions = data.sessions || {};
  state.syntaxMemory = data.syntaxMemory || {};
}
function currentSession() {
  return state.problem ? state.sessions[problemKey(state.problem)] || null : null;
}
function ensureSession(problem) {
  const key = problemKey(problem);
  let session = state.sessions[key];
  if (!session) session = state.sessions[key] = {
    problem: clone(problem), code: "", language: "auto", stage: 0, history: [],
    lastOutput: "", fullArchive: false, revision: 0, archivedRevision: 0, summary: "", updatedAt: Date.now(),
  };
  session.problem = clone(problem);
  return session;
}
function pendingSessions() {
  return Object.values(state.sessions).filter(s => s.revision > (s.archivedRevision || 0));
}
function renderArchiveStatus() {
  const pending = pendingSessions().length;
  const asked = Object.values(state.sessions).filter(s => s.history.length).length;
  $("archive-status").textContent = state.syncing ? `正在总结并同步 · ${pending} 题待更新`
    : state.archiveError ? `已保留 ${pending} 题待同步。${state.archiveError}`
    : pending ? `${pending} 题待同步；问答已保存在浏览器。`
    : asked ? `已同步 ${asked} 道问过的题目。` : "问过的题会自动总结归档，无需提交通过。";
}
function render() {
  const p = state.problem;
  const session = currentSession();
  $("problem-title").textContent = p ? (p.number ? `LC ${p.number} · ` : "") + (p.title || p.slug).replace(/^\d+\s*[.、]\s*/, "") : "请先打开一道力扣题目";
  $("problem-meta").textContent = p ? [p.difficulty,p.domain].filter(Boolean).join(" · ") : "支持 leetcode.cn / leetcode.com";
  $("step-hint-text").textContent = state.busy ? "思考中…" : "Alt/⌥ + 1/2/3 选深度 · Shift + Enter 问细节";
  ["btn-hint","btn-approach","btn-code"].forEach(id => {
    $(id).disabled = state.busy || !session;
  });
  $("btn-detail").disabled = state.busy || !session;
  $("btn-notes").disabled = !p || openingNotes;
  $("full-archive").disabled = !session;
  $("full-archive").checked = !!session?.fullArchive;
  $("status-dot").className = "dot" + (p ? " ok" : "");
  renderArchiveStatus();
}
function showSession() {
  const session = currentSession();
  $("ask").value = "";
  $("output").innerHTML = session?.lastOutput ? renderMarkdown(session.lastOutput) : '<p class="muted">选择 hint、算法思路或完整代码。问细节只回答当前疑问。</p>';
  render();
}
function sendTab(tabId, message) {
  return new Promise((resolve,reject) => chrome.tabs.sendMessage(tabId,message,response => {
    const err = chrome.runtime.lastError;
    if (err) reject(new Error(err.message)); else resolve(response);
  }));
}
function activeTab() {
  return new Promise(resolve => chrome.tabs.query({active:true,currentWindow:true},tabs => resolve(tabs?.[0])));
}
const isLeetCode = url => /^https:\/\/leetcode\.(cn|com)\/problems\//.test(String(url || ""));
async function scrapeTab(tabId) {
  try { return await sendTab(tabId, {type:"lc-coach:scrape"}); }
  catch (error) {
    if (!/receiving end does not exist|could not establish connection/i.test(error.message)) throw error;
    // Reloading an unpacked extension disconnects existing content scripts.
    // Reconnect in place, preserving the code currently being edited.
    await chrome.scripting.executeScript({target:{tabId},files:["src/content.js"]});
    return sendTab(tabId, {type:"lc-coach:scrape"});
  }
}
async function refreshProblem() {
  const refreshId = ++state.refreshId;
  const tab = await activeTab();
  if (refreshId !== state.refreshId) return;
  state.currentTabId = tab?.id ?? null;
  if (!isLeetCode(tab?.url)) { state.problem = null; showSession(); return; }
  try {
    const problem = await scrapeTab(tab.id);
    if (refreshId !== state.refreshId) return;
    if (!problem?.slug || problem.error || !problem.description) throw new Error("题面尚未加载，请稍后重新读取。");
    const previousKey = state.problem ? problemKey(state.problem) : "";
    state.problem = problem;
    ensureSession(problem);
    await saveData();
    if (previousKey !== problemKey(problem)) showSession(); else render();
  } catch (error) {
    if (refreshId !== state.refreshId) return;
    state.problem = null;
    showSession();
    toast("题目读取失败，请刷新力扣页面后重试：" + error.message,true);
  }
}
async function readCode(tabId) {
  try {
    const results = await chrome.scripting.executeScript({target:{tabId},world:"MAIN",func:PROBE_EDITOR});
    if (results?.[0]?.result?.ok) return results[0].result.code;
    return (await sendTab(tabId,{type:"lc-coach:latestCode"}))?.code || "";
  } catch { return ""; }
}
function modelConfig() {
  const s = state.settings;
  return {kind:(PROVIDERS[s.provider] || PROVIDERS.custom).kind,baseUrl:s.baseUrl,apiKey:s.apiKey,model:s.model};
}
async function ensureHostPermission(baseUrl) {
  const u = new URL(baseUrl);
  const origins = [`${u.protocol}//${u.hostname}/*`];
  return (await chrome.permissions.contains({origins})) || chrome.permissions.request({origins});
}
/** Direct depth selections authorize only that request; generic Enter shortcuts cannot authorize code. */
async function runQuestion(mode = "ladder", { fullSolution = false, ladderStep } = {}) {
  if (state.busy) return;
  const session = currentSession();
  const tabId = state.currentTabId;
  if (!session || !tabId) return toast("先打开一道力扣题目。",true);
  const ask = $("ask").value.trim();
  if (mode === "detail" && !ask) return toast("先输入你想追问的细节。",true);
  const step = ladderStep ?? Math.min(3,session.stage + 1);
  if (![1,2,3].includes(step)) return;
  if (mode === "ladder" && step === 3 && !fullSolution) return toast("需要完整解法时，请点击「完整代码」。");
  state.busy = true;
  state.archiveController?.abort();
  clearTimeout(retryTimer);
  render();
  const historyBefore = clone(session.history);
  const userText = ask || (mode === "detail" ? "" : `[${LADDER_STEPS[step-1].label}]`);
  // Persist the actual question before attempting the network call.
  session.history.push({role:"user",content:userText});
  session.revision++;
  session.updatedAt = Date.now();
  try {
    await saveData();
    const code = await readCode(tabId);
    session.code = code;
    session.language = state.settings.language === "auto" ? session.problem.language || "auto" : state.settings.language;
    const cfg = modelConfig();
    if (!(await ensureHostPermission(cfg.baseUrl))) throw new Error("未获得模型接口域名权限。");
    const request = buildMessages({systemPrompt:state.settings.coachPrompt,problem:session.problem,code,
      language:session.language,mode,ladderStep:mode === "detail" ? Math.max(1,session.stage) : step,
      history:historyBefore.slice(-12),userText:ask,fullSolution});
    if (currentSession() === session) $("output").textContent = "正在思考…";
    const startedAt = Date.now();
    let firstTextAt = null;
    let lastRenderAt = 0;
    const {text} = await callModel({...cfg,...request,onText:partial => {
      firstTextAt ??= Date.now();
      if (currentSession() === session && Date.now() - lastRenderAt >= 60) {
        $("output").innerHTML = renderMarkdown(partial);
        lastRenderAt = Date.now();
      }
    }});
    session.responseTiming = {
      model:cfg.model, firstTextMs:firstTextAt === null ? null : firstTextAt - startedAt,
      totalMs:Date.now() - startedAt,
    };
    session.history.push({role:"assistant",content:text});
    session.lastOutput = text;
    if (mode === "ladder") session.stage = step;
    session.revision++;
    await saveData();
    if (currentSession() === session) {
      $("output").innerHTML = renderMarkdown(text);
      if ($("ask").value.trim() === ask) $("ask").value = "";
    }
    return text;
  } catch (error) {
    if (currentSession() === session) $("output").textContent = "请求失败：" + error.message;
    toast(error.message,true);
  } finally {
    state.busy = false;
    render();
    // Archive uses an independent lock and durable snapshots, so changing the
    // problem or asking another detail never throws away an earlier question.
    scheduleRetry(15000);
  }
}

async function bridgeFetch(pathname, { method = "GET", body } = {}) {
  const bridge = state.settings.bridge;
  const base = bridge.url.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),15000);
  try {
    const response = await fetch(base + pathname,{method,signal:controller.signal,
      headers:{"Content-Type":"application/json","X-LC-Coach-Token":bridge.token || ""},
      body:body ? JSON.stringify(body) : undefined});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}
function scheduleRetry(delayMs = 60000) {
  clearTimeout(retryTimer);
  if (pendingSessions().length) retryTimer = setTimeout(() => void syncArchives(),delayMs);
}
async function syncArchives() {
  if (SETTINGS_PAGE) return;
  if (state.syncing) return;
  if (state.busy) { scheduleRetry(15000); return; }
  clearTimeout(retryTimer);
  if (!pendingSessions().length) { renderArchiveStatus(); return; }
  state.syncing = true;
  const archiveController = state.archiveController = new AbortController();
  state.archiveError = "";
  renderArchiveStatus();
  try {
    if (!state.settings.bridge.token) throw new Error("请在设置中连接本地归档桥。");
    // Confirm the bridge before spending a model call on a summary.
    await bridgeFetch("/models");
    while (pendingSessions().length && !state.busy && !archiveController.signal.aborted) {
      const session = pendingSessions().sort((a,b) => a.updatedAt - b.updatedAt)[0];
      const snapshot = clone(session);
      const cfg = modelConfig();
      if (!(await ensureHostPermission(cfg.baseUrl))) throw new Error("模型接口尚未授权，点击保存设置后重试。");
      const request = buildMessages({systemPrompt:state.settings.coachPrompt,problem:snapshot.problem,
        code:snapshot.code,language:snapshot.language,mode:"archive",history:snapshot.history,
        previousSummary:snapshot.summary});
      const {text} = await callModel({...cfg,...request,maxTokens:2600,thinking:"disabled",signal:archiveController.signal});
      if (archiveController.signal.aborted) break;
      // Revoking overall archiving during generation must take effect before
      // any full text is written to disk.
      if (session.fullArchive !== snapshot.fullArchive) continue;
      const prepared = prepareArchive(snapshot,text,state.syntaxMemory);
      await bridgeFetch("/obsidian/upsert",{method:"POST",body:{path:state.settings.obsidian.path,
        problem:prepared.problem,syntax:prepared.syntax}});
      state.syntaxMemory = prepared.memory;
      session.summary = text;
      session.archivedRevision = snapshot.revision;
      await saveData();
      renderArchiveStatus();
    }
  } catch (error) {
    if (!archiveController.signal.aborted) state.archiveError = /fetch|network|abort/i.test(error.message) ? "本地桥离线或请求超时，将在连接恢复后重试。" : error.message;
  } finally {
    state.archiveController = null;
    state.syncing = false;
    renderArchiveStatus();
    scheduleRetry();
  }
}

function fillSelect(id, items, value) {
  const select = $(id);
  select.innerHTML = "";
  for (const [key,label] of items) {
    const option = document.createElement("option");
    option.value = key; option.textContent = label; select.appendChild(option);
  }
  select.value = value;
}
function fillSettingsForm() {
  const s = state.settings;
  const provider = PROVIDERS[s.provider] || PROVIDERS.custom;
  fillSelect("provider",PROVIDER_ORDER.map(key => [key,PROVIDERS[key].label]),s.provider);
  fillSelect("language",LANGUAGES.map(lang => [lang,lang === "auto" ? "自动" : lang]),s.language);
  $("provider-note").textContent = provider.kind === KINDS.BRIDGE ? "先连接本地桥。" : "填写 Key 后拉取账号可用模型，再保存。";
  $("base-url").value = s.baseUrl || "";
  $("model").value = s.model || "";
  $("api-key").value = s.apiKey || "";
  $("api-key-label").textContent = provider.tokenLabel || "API Key";
  $("bridge-url").value = s.bridge.url;
  $("bridge-token").value = s.bridge.token;
  $("obsidian-path").value = s.obsidian.path;
  $("coach-prompt").value = s.coachPrompt || DEFAULT_COACH_PROMPT;
}
function showTab(name) {
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active",tab.dataset.tab === name));
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active",panel.id === "panel-" + name));
}
function bindEvents() {
  document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click",() => showTab(tab.dataset.tab)));
  $("btn-refresh").addEventListener("click",refreshProblem);
  $("btn-notes").addEventListener("click", async () => {
    if (!state.problem || openingNotes) return;
    openingNotes = true;
    render();
    try { await openManualNotes(chrome, state.problem); }
    catch (error) { toast("无法打开手记：" + error.message, true); }
    finally { openingNotes = false; render(); }
  });
  $("btn-hint").addEventListener("click",() => runQuestion("ladder",{ladderStep:1}));
  $("btn-approach").addEventListener("click",() => runQuestion("ladder",{ladderStep:2}));
  $("btn-code").addEventListener("click",() => runQuestion("ladder",{ladderStep:3,fullSolution:true}));
  $("btn-detail").addEventListener("click",() => runQuestion("detail"));
  $("ask").addEventListener("keydown",event => {
    if (event.isComposing || event.keyCode === 229) return;
    // Use physical digit codes: Option + digit produces symbols on macOS.
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && /^Digit[123]$/.test(event.code)) {
      event.preventDefault();
      if (!event.repeat) {
        const ladderStep = Number(event.code.slice(-1));
        void runQuestion("ladder",{ladderStep,fullSolution:ladderStep === 3});
      }
      return;
    }
    if (event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      // Generic send shortcuts must not accidentally consent to a full solution.
      if (!event.repeat) void runQuestion(event.shiftKey ? "detail" : "ladder");
    }
  });
  $("btn-copy").addEventListener("click",async() => {
    const text = currentSession()?.lastOutput;
    if (text) { await navigator.clipboard.writeText(text); toast("已复制"); }
  });
  $("full-archive").addEventListener("change",async event => {
    const session = currentSession();
    if (!session) return;
    session.fullArchive = event.target.checked;
    if (session.history.length) session.revision++;
    await saveData();
    render();
    void syncArchives();
  });
  $("provider").addEventListener("change",event => {
    const preset = PROVIDERS[event.target.value];
    state.settings.provider = event.target.value;
    state.settings.baseUrl = preset.baseUrl;
    state.settings.model = preset.model;
    state.settings.apiKey = "";
    fillSettingsForm();
  });
  $("btn-fetch-models").addEventListener("click",async() => {
    $("btn-fetch-models").disabled = true;
    try {
      const baseUrl = $("base-url").value.trim();
      if (!(await ensureHostPermission(baseUrl))) throw new Error("接口域名未授权。");
      const models = await listModels({kind:PROVIDERS[$("provider").value].kind,baseUrl,apiKey:$("api-key").value.trim()});
      $("model-list").innerHTML = "";
      for (const model of models) {
        const option = document.createElement("option");option.value = model.id;option.label = model.label;$("model-list").appendChild(option);
      }
      if (models.length && !models.some(m => m.id === $("model").value)) $("model").value = models[0].id;
      toast(`已获取 ${models.length} 个模型，选定后保存。`);
    } catch (error) { toast(error.message,true); }
    finally { $("btn-fetch-models").disabled = false; }
  });
  $("btn-save-settings").addEventListener("click",async() => {
    try {
      state.settings = {...state.settings,provider:$("provider").value,baseUrl:$("base-url").value.trim(),
        apiKey:$("api-key").value.trim(),model:$("model").value.trim(),language:$("language").value,
        coachPrompt:$("coach-prompt").value,
        bridge:{url:$("bridge-url").value.trim(),token:$("bridge-token").value.trim()},
        obsidian:{path:$("obsidian-path").value.trim()}};
      await saveSettings();
      $("save-state").textContent = "设置已保存";
      toast("设置已保存");
      void syncArchives();
    } catch (error) { toast(error.message,true); }
  });
  $("btn-bridge-status").addEventListener("click",async() => {
    try {
      // Test unsaved form values without accidentally replacing saved keys.
      const response = await fetch($("bridge-url").value.replace(/\/+$/, "") + "/models",{
        headers:{"X-LC-Coach-Token":$("bridge-token").value},signal:AbortSignal.timeout(8000)});
      if (!response.ok) throw new Error("桥令牌无效，或桥未启动。");
      toast("本地归档桥已连接，保存设置后开始同步。");
    } catch (error) { toast(error.message,true); }
  });
  $("btn-reset-prompt").addEventListener("click",() => { $("coach-prompt").value = DEFAULT_COACH_PROMPT; toast("已恢复，请保存设置。"); });
  if (SETTINGS_PAGE) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings?.newValue) {
      state.settings = changes.settings.newValue;
      renderArchiveStatus();
      void syncArchives();
    }
  });
  chrome.tabs.onActivated.addListener(() => void refreshProblem());
  chrome.tabs.onUpdated.addListener((id,info,tab) => {
    if (tab.active && (info.url || info.status === "complete")) void refreshProblem();
  });
  chrome.runtime.onMessage.addListener((message,sender) => {
    if (sender?.tab?.id !== state.currentTabId || message?.type !== "lc-coach:event") return;
    if (message.event?.kind === "submitted") {
      const session = currentSession();
      if (session && message.event.code) { session.code = message.event.code; void saveData(); }
    }
  });
}
async function init() {
  await loadStorage();
  fillSettingsForm();
  bindEvents();
  if (SETTINGS_PAGE) { showTab("settings"); return; }
  await refreshProblem();
  void syncArchives();
}
init().catch(error => toast("初始化失败：" + error.message,true));
