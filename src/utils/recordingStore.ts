/**
 * Keeps a recording on disk while it is being captured, so closing the tab, a
 * refresh or a crash cannot take a whole session with it. The recording is
 * otherwise held only in memory, and a session cannot be redone.
 *
 * Every call here is best effort. Storage failing must never be able to break
 * a live recording, so callers ignore the errors.
 */

const DB_NAME = 'json-extractor-recordings';
const DB_VERSION = 1;
const CHUNKS = 'chunks';
const META = 'meta';
const CURRENT = 'current';

export interface StoredRecording {
  file: File;
  savedAt: number;
}

interface Meta {
  name: string;
  mimeType: string;
  savedAt: number;
}

let handle: Promise<IDBDatabase> | null = null;

/** When a recovered take began. Its rebuilt file is dated when it was recovered,
 *  not when recording stopped, so the start it was saved with is kept here. */
const startedAtByFile = new WeakMap<File, number>();

/** The known start of a recording, in ms since the epoch, when the app has one. */
export function recordingStartOf(file: File): number | undefined {
  return startedAtByFile.get(file);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { autoIncrement: true });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** One connection for the page: chunks arrive every second while recording. */
function database(): Promise<IDBDatabase> {
  handle ??= openDatabase();
  return handle;
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Starts a new take, dropping whatever was held before it. */
export async function beginStoredRecording(name: string, mimeType: string): Promise<void> {
  const db = await database();
  const tx = db.transaction([CHUNKS, META], 'readwrite');
  tx.objectStore(CHUNKS).clear();
  tx.objectStore(META).put({ name, mimeType, savedAt: Date.now() } satisfies Meta, CURRENT);
  await settled(tx);
}

export async function appendChunk(chunk: Blob): Promise<void> {
  const db = await database();
  const tx = db.transaction(CHUNKS, 'readwrite');
  tx.objectStore(CHUNKS).add(chunk);
  await settled(tx);
}

export async function loadStoredRecording(): Promise<StoredRecording | null> {
  const db = await database();
  const tx = db.transaction([CHUNKS, META], 'readonly');
  const meta = tx.objectStore(META).get(CURRENT);
  const chunks = tx.objectStore(CHUNKS).getAll();
  await settled(tx);

  const stored = meta.result as Meta | undefined;
  const parts = (chunks.result ?? []) as Blob[];
  if (!stored || parts.length === 0) return null;

  const file = new File(parts, stored.name, { type: stored.mimeType });
  startedAtByFile.set(file, stored.savedAt);
  return { file, savedAt: stored.savedAt };
}

export async function clearStoredRecording(): Promise<void> {
  const db = await database();
  const tx = db.transaction([CHUNKS, META], 'readwrite');
  tx.objectStore(CHUNKS).clear();
  tx.objectStore(META).delete(CURRENT);
  await settled(tx);
}
