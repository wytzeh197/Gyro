import type { FileBuffer } from "./types";
let opening: Promise<IDBDatabase> | undefined;
const saved = new Map<string, Record<string, FileBuffer>>();
const writes = new Map<string, Promise<boolean>>();
function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  const request = indexedDB.open("gyro.remote.buffers", 1);
  let abandoned = false;
  const forget = () => {
    if (opening === pending) {
      opening = undefined;
      // Object identity proves persistence only for the connection that read
      // or wrote it. A replacement database may no longer contain these rows.
      saved.clear();
    }
  };
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => request.result.createObjectStore("buffers");
    request.onerror = () => {
      abandoned = true;
      forget();
      reject(request.error);
    };
    request.onblocked = () => {
      abandoned = true;
      forget();
      reject(new Error("Remote draft storage is blocked"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
  });
  opening = pending;
  return pending;
}
export async function readBuffers(
  host: string,
): Promise<Record<string, FileBuffer>> {
  const connection = database();
  const db = await connection;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("buffers", "readonly");
    const result: Record<string, FileBuffer> = {};
    const request = transaction
      .objectStore("buffers")
      .openCursor(IDBKeyRange.bound([host], [host, []]));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const id = (cursor.key as string[])[1];
      const buffer = cursor.value as FileBuffer;
      if (
        id &&
        buffer &&
        typeof buffer.text === "string" &&
        typeof buffer.file?.content === "string" &&
        typeof buffer.file.path === "string" &&
        typeof buffer.file.contentHash === "string"
      )
        result[id] = buffer;
      cursor.continue();
    };
    transaction.oncomplete = () => {
      if (opening !== connection) {
        reject(new Error("Remote draft storage changed while reading; retry"));
        return;
      }
      saved.set(host, result);
      resolve(result);
    };
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}
/** Structured-clone only changed buffers; commits for one host stay in order. */
export function writeBuffers(
  host: string,
  buffers: Record<string, FileBuffer>,
): Promise<boolean> {
  const result = (writes.get(host) ?? Promise.resolve(true)).then(async () => {
    try {
      const connection = database();
      const db = await connection;
      // After reopening, discover the persisted keys before applying a full
      // host snapshot; otherwise deletions could resurrect on the next load.
      const previous = saved.get(host) ?? (await readBuffers(host));
      if (opening !== connection) return false;
      const changed = Object.entries(buffers).filter(
        ([id, buffer]) => previous[id] !== buffer,
      );
      const deleted = Object.keys(previous).filter((id) => !(id in buffers));
      if (!changed.length && !deleted.length) return true;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("buffers", "readwrite");
        const store = transaction.objectStore("buffers");
        for (const [id, buffer] of changed) store.put(buffer, [host, id]);
        for (const id of deleted) store.delete([host, id]);
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () =>
          reject(transaction.error);
      });
      if (opening !== connection) return false;
      saved.set(host, buffers);
      return true;
    } catch {
      return false;
    }
  });
  writes.set(host, result);
  void result.finally(() => {
    if (writes.get(host) === result) writes.delete(host);
  });
  return result;
}
