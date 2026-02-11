const DB = "goshare";
const STORE = "files";

export async function openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function putChunk(
  fileId: string,
  index: number,
  buf: ArrayBuffer,
) {
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(buf, `${fileId}_${index}`);
}

export async function getChunk(fileId: string, index: number) {
  const db = await openDB();
  return new Promise<ArrayBuffer | undefined>((res) => {
    const req = db
      .transaction(STORE)
      .objectStore(STORE)
      .get(`${fileId}_${index}`);
    req.onsuccess = () => res(req.result);
  });
}
