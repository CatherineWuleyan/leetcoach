// Hand notes go straight to the file bridge; no model sees or rewrites them.
export const NOTE_SYNC_STATE = "manual-note-sync";
export function manualNoteTarget(settings) {
  const url = settings?.bridge?.url?.replace(/\/+$/, "");
  const path = settings?.obsidian?.path;
  return url && path ? JSON.stringify([url, path]) : "";
}
function noteEntries(data) {
  return Object.entries(data).filter(([key, note]) => key.startsWith("manual-note:")
    && typeof note?.text === "string" && (note.text || note.revision));
}
function pendingCount(data, target) {
  return noteEntries(data).filter(([, note]) => !note.revision || note.syncedRevision !== note.revision || note.syncedTarget !== target).length;
}
export function createNoteSynchronizer(storage, writer, fetcher = fetch) {
  let running;
  return function syncNotes() {
    if (running) return running;
    running = (async () => {
      const data = await storage.get(null);
      const settings = data.settings;
      const target = manualNoteTarget(settings);
      let error = "";
      try {
        if (pendingCount(data, target) && (!target || !settings?.bridge?.token)) throw new Error("请在插件设置中连接本地归档桥。");
        for (const [storageKey] of noteEntries(data)) {
          const key = storageKey.slice("manual-note:".length);
          const note = await writer.read(key);
          if (!note || (note.syncedRevision === note.revision && note.syncedTarget === target)) continue;
          const response = await fetcher(settings.bridge.url.replace(/\/+$/, "") + "/obsidian/manual-note", {
            method: "POST", signal: AbortSignal.timeout(8000),
            headers: { "Content-Type": "application/json", "X-LC-Coach-Token": settings.bridge.token },
            body: JSON.stringify({ path: settings.obsidian.path, note: { key, title: note.title || key, text: note.text } }),
          });
          if (response.status === 404) throw new Error("归档桥需更新，请重启本地桥后重试。");
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
          // The mark shares the writer's queue and cannot overwrite a newer edit.
          await writer.markSynced(key, note.revision, target);
        }
      } catch (err) { error = err.message || "本地桥连接失败"; }
      const latest = await storage.get(null);
      const result = { pending: pendingCount(latest, manualNoteTarget(latest.settings)), error };
      await storage.set({ [NOTE_SYNC_STATE]: result });
      return result;
    })().finally(() => { running = null; });
    return running;
  };
}
