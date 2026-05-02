const DB_NAME = "tunnet-save-viewer";
const DB_VERSION = 1;
const STORE = "snapshots";
const LAST_KEY = "lastPickedSave";

export type LastPickedSaveRecord = {
  jsonText: string;
  fileName: string;
  /** When the host exposes it (e.g. Electron `File.path`). */
  absolutePath?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = (): void => reject(req.error ?? new Error("indexedDB open failed"));
    req.onsuccess = (): void => resolve(req.result);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
}

export async function idbPutLastPickedSave(record: LastPickedSaveRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error("indexedDB write failed"));
    tx.objectStore(STORE).put(record, LAST_KEY);
  });
}

export async function idbGetLastPickedSave(): Promise<LastPickedSaveRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    tx.onerror = (): void => reject(tx.error ?? new Error("indexedDB read failed"));
    const req = tx.objectStore(STORE).get(LAST_KEY);
    req.onerror = (): void => reject(req.error ?? new Error("indexedDB get failed"));
    req.onsuccess = (): void => {
      const v = req.result as LastPickedSaveRecord | undefined;
      if (
        !v ||
        typeof v.jsonText !== "string" ||
        typeof v.fileName !== "string" ||
        v.jsonText.length === 0
      ) {
        resolve(null);
        return;
      }
      resolve(v as LastPickedSaveRecord);
    };
  });
}
