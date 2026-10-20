import { problemKey } from "./archive.js";

export function noteStorageKey(key) {
  if (typeof key !== "string" || !key.trim() || key.length > 256 || /[\r\n<>]/.test(key)) throw new Error("手记题目无效。");
  return "manual-note:" + key;
}

// A separate key for each problem keeps session/archive writes away from hand notes.
// Run this queue in the worker so closing the editor does not discard pending writes.
export function createNoteWriter(storage) {
  const pending = new Map();
  function enqueue(key, operation) {
    const storageKey = noteStorageKey(key);
    const write = (pending.get(storageKey) || Promise.resolve()).catch(() => {})
      .then(() => operation(storageKey));
    pending.set(storageKey, write);
    const cleanup = () => { if (pending.get(storageKey) === write) pending.delete(storageKey); };
    write.then(cleanup, cleanup);
    return write;
  }
  function saveNote(key, note) {
    if (typeof note?.text !== "string" || typeof note?.title !== "string") throw new Error("手记内容无效。");
    const snapshot = { text: note.text, title: note.title, updatedAt: Date.now(), revision: crypto.randomUUID() };
    return enqueue(key, async storageKey => { await storage.set({ [storageKey]: snapshot }); return snapshot; });
  }
  saveNote.read = key => enqueue(key, async storageKey => {
    let note = (await storage.get([storageKey]))[storageKey];
    if (typeof note?.text !== "string" || (!note.text && !note.revision)) return null;
    if (!note.revision) {
      note = { ...note, revision: crypto.randomUUID() };
      await storage.set({ [storageKey]: note });
    }
    return note;
  });
  saveNote.markSynced = (key, revision, target) => enqueue(key, async storageKey => {
    const note = (await storage.get([storageKey]))[storageKey];
    if (!note || note.revision !== revision) return false;
    await storage.set({ [storageKey]: { ...note, syncedRevision: revision, syncedTarget: target } });
    return true;
  });
  return saveNote;
}

export async function openManualNotes(api, problem) {
  const key = problemKey(problem);
  noteStorageKey(key);
  const base = api.runtime.getURL("src/notes.html");
  const windows = await api.windows.getAll({ populate: true, windowTypes: ["popup"] });
  const existing = windows.find(window => window.tabs?.some(tab => {
    if (!tab.url?.startsWith(base + "?")) return false;
    return new URL(tab.url).searchParams.get("key") === key;
  }));
  if (existing) return api.windows.update(existing.id, { focused: true });
  const title = (problem.number ? `LC ${problem.number} · ` : "") + (problem.title || problem.slug).replace(/^\d+\s*[.、]\s*/, "");
  const url = base + "?" + new URLSearchParams({ key, title });
  return api.windows.create({ url, type: "popup", width: 600, height: 700, focused: true });
}
