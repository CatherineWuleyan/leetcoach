// Service worker: deliberately tiny.
//
// All real work (scraping, model calls, note storage) happens in the side panel,
// which is a normal extension page with full host permissions and no service
// worker lifetime problem. The worker exists only to make the toolbar icon open
// the side panel.

import { DEFAULT_SETTINGS } from "./config.js";

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
