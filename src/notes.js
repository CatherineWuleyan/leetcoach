import { noteStorageKey } from "./manual-notes.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const key = params.get("key");
const title = params.get("title") || key || "手记";
let revision = 0;

function status(message, error = false) {
  $("note-status").textContent = message;
  $("note-status").classList.toggle("error", error);
}
async function save() {
  const current = ++revision;
  status("正在保存…");
  try {
    // Each keystroke is handed to the worker immediately; no close-time debounce.
    const result = await chrome.runtime.sendMessage({ type: "lc-coach:save-note", key,
      note: { title, text: $("note-text").value } });
    if (!result?.ok) throw new Error(result?.error || "保存失败");
    if (current === revision) status("已保存到本机");
  } catch (error) {
    if (current === revision) status("未保存：" + error.message + "。请保留窗口，点击「保存」重试。", true);
  }
}
async function init() {
  const storageKey = noteStorageKey(key);
  const saved = (await chrome.storage.local.get([storageKey]))[storageKey];
  document.title = title + " · 手记";
  $("note-title").textContent = title;
  $("note-text").value = saved?.text || "";
  for (const id of ["note-text", "note-save", "note-copy"]) $(id).disabled = false;
  status(saved ? "已恢复本机手记" : "尚未填写 · 输入后自动保存");
  $("note-text").addEventListener("input", () => void save());
  $("note-save").addEventListener("click", () => void save());
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
  });
  $("note-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("note-text").value); status("已复制手记"); }
    catch (error) { status("复制失败：" + error.message, true); }
  });
}
init().catch(error => status("无法读取手记：" + error.message, true));
