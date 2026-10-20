import { noteStorageKey } from "./manual-notes.js";
import { manualNoteTarget, NOTE_SYNC_STATE } from "./note-sync.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const key = params.get("key");
const title = params.get("title") || key || "手记";
let revision = 0;
let storedNote;
let settings;
let syncState;

function status(message, error = false) {
  $("note-status").textContent = message;
  $("note-status").classList.toggle("error", error);
}
function showSavedStatus() {
  if (!storedNote || storedNote.text !== $("note-text").value) return;
  const target = manualNoteTarget(settings);
  if (target && storedNote.revision && storedNote.syncedRevision === storedNote.revision && storedNote.syncedTarget === target) {
    status("已写入 leetcode hot 100.md");
  } else {
    status("已保存本机，文件待同步" + (syncState?.error ? "：" + syncState.error : "…"));
  }
}
async function save() {
  const current = ++revision;
  status("正在保存…");
  try {
    // Each keystroke is handed to the worker immediately; no close-time debounce.
    const result = await chrome.runtime.sendMessage({ type: "lc-coach:save-note", key,
      note: { title, text: $("note-text").value } });
    if (!result?.ok) throw new Error(result?.error || "保存失败");
    if (current === revision) { storedNote = result.note; showSavedStatus(); }
  } catch (error) {
    if (current === revision) status("未保存：" + error.message + "。请保留窗口，点击「保存」重试。", true);
  }
}
async function init() {
  const storageKey = noteStorageKey(key);
  const data = await chrome.storage.local.get([storageKey, "settings", NOTE_SYNC_STATE]);
  const saved = data[storageKey];
  storedNote = saved; settings = data.settings; syncState = data[NOTE_SYNC_STATE];
  document.title = title + " · 手记";
  $("note-title").textContent = title;
  $("note-text").value = saved?.text || "";
  for (const id of ["note-text", "note-save", "note-copy"]) $(id).disabled = false;
  status(saved ? "已恢复本机手记" : "尚未填写 · 输入后自动保存");
  showSavedStatus();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[storageKey]) storedNote = changes[storageKey].newValue;
    if (changes.settings) settings = changes.settings.newValue;
    if (changes[NOTE_SYNC_STATE]) syncState = changes[NOTE_SYNC_STATE].newValue;
    showSavedStatus();
  });
  $("note-text").addEventListener("input", () => void save());
  $("note-save").addEventListener("click", () => void save());
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
  });
  $("note-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("note-text").value); status("已复制手记"); }
    catch (error) { status("复制失败：" + error.message, true); }
  });
  void chrome.runtime.sendMessage({ type: "lc-coach:sync-notes" }).catch(() => {});
}
init().catch(error => status("无法读取手记：" + error.message, true));
