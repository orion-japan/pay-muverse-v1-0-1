const DB_NAME = 'muverse-local-images';
const DB_VERSION = 1;
const STORE_NAME = 'screenshot_images';

type StoredScreenshotImage = {
  id: string;
  dataUrl: string;
  createdAt: number;
  expiresAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('indexeddb_unavailable'));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb_open_failed'));
  });
}

export async function saveScreenshotImageLocal(
  id: string,
  dataUrl: string,
  ttlMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<void> {
  if (!id || !dataUrl.startsWith('data:image/')) return;

  const db = await openDb();
  const now = Date.now();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const item: StoredScreenshotImage = {
      id,
      dataUrl,
      createdAt: now,
      expiresAt: now + ttlMs,
    };

    store.put(item);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('indexeddb_save_failed'));
  });

  db.close();
}

export async function loadScreenshotImageLocal(id: string): Promise<string | null> {
  if (!id) return null;

  const db = await openDb();

  const item = await new Promise<StoredScreenshotImage | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => resolve(req.result as StoredScreenshotImage | undefined);
    req.onerror = () => reject(req.error || new Error('indexeddb_load_failed'));
  });

  db.close();

  if (!item) return null;

  if (item.expiresAt && item.expiresAt < Date.now()) {
    await deleteScreenshotImageLocal(id).catch(() => {});
    return null;
  }

  return item.dataUrl || null;
}

export async function deleteScreenshotImageLocal(id: string): Promise<void> {
  if (!id) return;

  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('indexeddb_delete_failed'));
  });

  db.close();
}

export async function pruneExpiredScreenshotImagesLocal(): Promise<void> {
  const db = await openDb();
  const now = Date.now();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;

      const value = cursor.value as StoredScreenshotImage;
      if (value?.expiresAt && value.expiresAt < now) {
        cursor.delete();
      }

      cursor.continue();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('indexeddb_prune_failed'));
  });

  db.close();
}
