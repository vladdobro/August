const DB_NAME = 'august-recording-recovery';
const DB_VERSION = 1;
const STORE_NAME = 'chunks';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveRecordingProgress(
  micChunks: Blob[],
  systemChunks: Blob[] | null,
  mimeType: string,
  language: string,
  dualTrack: boolean,
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(new Blob(micChunks, { type: mimeType }), 'mic');
    store.put(mimeType, 'mimeType');
    store.put(language, 'language');
    store.put(dualTrack, 'dualTrack');
    if (systemChunks && dualTrack) {
      store.put(new Blob(systemChunks, { type: mimeType }), 'system');
    }
    store.put(Date.now(), 'savedAt');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // IndexedDB unavailable — silent fail
  }
}

export interface RecoveredRecording {
  micBlob: Blob;
  systemBlob: Blob | null;
  mimeType: string;
  language: string;
  dualTrack: boolean;
  savedAt: number;
}

export async function getRecoveredRecording(): Promise<RecoveredRecording | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const get = (key: string): Promise<any> =>
      new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const micBlob = await get('mic');
    if (!micBlob || !(micBlob instanceof Blob) || micBlob.size === 0) {
      db.close();
      return null;
    }
    const systemBlob = await get('system');
    const mimeType = ((await get('mimeType')) as string) || 'audio/webm';
    const language = ((await get('language')) as string) || 'ru';
    const dualTrack = ((await get('dualTrack')) as boolean) || false;
    const savedAt = ((await get('savedAt')) as number) || 0;
    db.close();
    return {
      micBlob,
      systemBlob: systemBlob instanceof Blob ? systemBlob : null,
      mimeType,
      language,
      dualTrack,
      savedAt,
    };
  } catch {
    return null;
  }
}

export async function clearRecoveredRecording(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // silent
  }
}
