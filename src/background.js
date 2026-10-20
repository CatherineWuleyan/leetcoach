// Service worker: deliberately tiny.
//
// Coaching and archives run in the side panel. The worker opens that panel and
// persists hand notes independently so closing a note window does not drop writes.

import { DEFAULT_SETTINGS } from "./config.js";
import { createNoteWriter } from "./manual-notes.js";
import { createNoteSynchronizer } from "./note-sync.js";

const saveNote = createNoteWriter(chrome.storage.local);
const flushNotes = createNoteSynchronizer(chrome.storage.local, saveNote);
const NOTE_ALARM = "lc-coach:sync-notes";
let syncTimer;
function scheduleNotes() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void runNoteSync(), 600);
  void chrome.alarms.create(NOTE_ALARM, { delayInMinutes: 1 });
}
async function runNoteSync() {
  try {
    const result = await flushNotes();
    if (result.pending) {
      void chrome.alarms.create(NOTE_ALARM, { delayInMinutes: 1 });
      if (!result.error) scheduleNotes();
    } else await chrome.alarms.clear(NOTE_ALARM);
  } catch (error) {
    console.warn("手记同步暂未完成：", error.message);
    void chrome.alarms.create(NOTE_ALARM, { delayInMinutes: 1 });
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!["lc-coach:save-note", "lc-coach:sync-notes"].includes(message?.type)) return;
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === "lc-coach:sync-notes") { void runNoteSync(); respond({ ok: true }); return; }
  Promise.resolve().then(() => saveNote(message.key, message.note))
    .then(note => { scheduleNotes(); respond({ ok: true, note }); }, error => respond({ ok: false, error: error.message }));
  return true; // Keep the worker alive while the write is pending.
});

function setupPanel() {
  // Without this the toolbar click does nothing at all.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("setPanelBehavior failed:", e));
}

chrome.runtime.onInstalled.addListener(async (details) => {
  setupPanel();

  // Seed defaults once; never overwrite settings the user already changed.
  const existing = await chrome.storage.local.get(["settings"]);
  if (!existing.settings) {
    await chrome.storage.local.set({
      settings: { ...DEFAULT_SETTINGS },
      notes: [],
    });
  }
  if (details.reason === "install") {
    console.info("LC Coach 已安装。点工具栏图标打开侧边栏。");
  }
});

chrome.runtime.onStartup.addListener(setupPanel);
chrome.runtime.onStartup.addListener(() => void runNoteSync());
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === NOTE_ALARM) void runNoteSync(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) scheduleNotes();
});
setupPanel();
void runNoteSync(); // Includes existing hand notes saved before file sync was added.
