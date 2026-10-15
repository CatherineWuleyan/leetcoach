// Service worker: deliberately tiny.
//
// Coaching and archives run in the side panel. The worker opens that panel and
// persists hand notes independently so closing a note window does not drop writes.

import { DEFAULT_SETTINGS } from "./config.js";
import { createNoteWriter } from "./manual-notes.js";

const saveNote = createNoteWriter(chrome.storage.local);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "lc-coach:save-note") return;
  if (sender.id !== chrome.runtime.id) return;
  Promise.resolve().then(() => saveNote(message.key, message.note))
    .then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
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
setupPanel();
