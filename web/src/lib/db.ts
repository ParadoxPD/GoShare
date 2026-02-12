// ===================================
// INDEXEDDB UTILITIES
// Persist chunks to disk for resume capability
// ===================================

const DB_NAME = "goshare";
const STORE_NAME = "chunks";
const VERSION = 1;

let dbInstance: IDBDatabase | null = null;

/**
 * Open IndexedDB connection
 */
export async function openDB(): Promise<IDBDatabase> {
  if (dbInstance && dbInstance.version === VERSION) {
    return dbInstance;
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      // Create object store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(new Error(`IndexedDB error: ${request.error?.message}`));
    };
  });
}

/**
 * Store a chunk in IndexedDB
 * Key format: "fileId_chunkIndex"
 */
export async function putChunk(
  fileId: string,
  index: number,
  buffer: ArrayBuffer,
): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const key = `${fileId}_${index}`;

    const request = store.put(buffer, key);

    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new Error(`Failed to store chunk: ${request.error?.message}`));
  });
}

/**
 * Retrieve a chunk from IndexedDB
 */
export async function getChunk(
  fileId: string,
  index: number,
): Promise<ArrayBuffer | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const key = `${fileId}_${index}`;

    const request = store.get(key);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(new Error(`Failed to retrieve chunk: ${request.error?.message}`));
    };
  });
}

/**
 * Check which chunks exist for a file
 * Returns array of chunk indices
 */
export async function getExistingChunks(
  fileId: string,
  totalChunks: number,
): Promise<number[]> {
  const existing: number[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunk = await getChunk(fileId, i);
    if (chunk) {
      existing.push(i);
    }
  }

  return existing;
}

/**
 * Delete all chunks for a file
 */
export async function deleteFileChunks(fileId: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    // Get all keys and delete matching ones
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result;

      if (cursor) {
        const key = cursor.key as string;
        if (key.startsWith(`${fileId}_`)) {
          cursor.delete();
        }
        cursor.continue();
      } else {
        resolve();
      }
    };

    request.onerror = () => {
      reject(new Error(`Failed to delete chunks: ${request.error?.message}`));
    };
  });
}

/**
 * Clear all stored chunks
 */
export async function clearAllChunks(): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new Error(`Failed to clear chunks: ${request.error?.message}`));
  });
}

/**
 * Get total storage usage
 */
export async function getStorageSize(): Promise<number> {
  if (!navigator.storage || !navigator.storage.estimate) {
    return 0;
  }

  const estimate = await navigator.storage.estimate();
  return estimate.usage || 0;
}
