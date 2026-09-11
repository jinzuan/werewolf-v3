/**
 * Browser-local background image storage.
 *
 * Binary image data deliberately lives in IndexedDB rather than localStorage:
 * localStorage is synchronous, small, and would require an expensive base64 copy.
 * Every public operation degrades to a harmless result when IndexedDB is absent
 * or denied (for example in private browsing or a locked-down WebView).
 */

export const VISUAL_BACKGROUND_DATABASE_NAME = 'werewolf-v3-visual-backgrounds-v1';
export const VISUAL_BACKGROUND_DATABASE_VERSION = 1;
export const VISUAL_BACKGROUND_STORE_NAME = 'backgrounds';
export const MAX_VISUAL_BACKGROUND_BYTES = 12 * 1024 * 1024;

export const VISUAL_BACKGROUND_SLOTS = ['single', 'day', 'night'] as const;
export type VisualBackgroundSlot = (typeof VISUAL_BACKGROUND_SLOTS)[number];

export const VISUAL_BACKGROUND_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
] as const;
export type VisualBackgroundMimeType = (typeof VISUAL_BACKGROUND_MIME_TYPES)[number];

export interface VisualBackgroundMetadata {
  slot: VisualBackgroundSlot;
  fileName: string;
  mimeType: VisualBackgroundMimeType;
  size: number;
  lastModified: number | null;
  updatedAt: number;
}

export interface StoredVisualBackground {
  metadata: VisualBackgroundMetadata;
  blob: Blob;
}

export interface PutVisualBackgroundOptions {
  fileName?: string;
  lastModified?: number | null;
  /** Primarily useful for deterministic tests and import tooling. */
  updatedAt?: number;
}

export interface PutVisualBackgroundEntry {
  slot: VisualBackgroundSlot;
  blob: Blob;
  options?: PutVisualBackgroundOptions;
}

export type VisualBackgroundValidationCode =
  | 'ok'
  | 'empty'
  | 'too-large'
  | 'unsupported-type'
  | 'decode-failed'
  | 'decode-unavailable';

export interface VisualBackgroundValidationResult {
  valid: boolean;
  code: VisualBackgroundValidationCode;
}

export type VisualBackgroundBatchWriteResult =
  | { ok: true; metadata: VisualBackgroundMetadata[] }
  | {
      ok: false;
      code: Exclude<VisualBackgroundValidationCode, 'ok'> | 'storage-failed';
    };

export interface VisualBackgroundStore {
  get(slot: VisualBackgroundSlot): Promise<StoredVisualBackground | null>;
  put(
    slot: VisualBackgroundSlot,
    blob: Blob,
    options?: PutVisualBackgroundOptions,
  ): Promise<VisualBackgroundMetadata | null>;
  putMany(entries: PutVisualBackgroundEntry[]): Promise<VisualBackgroundBatchWriteResult>;
  delete(slot: VisualBackgroundSlot): Promise<boolean>;
  clear(): Promise<boolean>;
  metadata(): Promise<VisualBackgroundMetadata[]>;
}

interface StoredVisualBackgroundRecord extends VisualBackgroundMetadata {
  blob: Blob;
}

type ImageDecodeEnvironment = {
  createImageBitmap?: (image: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
  Image?: typeof Image;
  URL?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
};

const isSlot = (value: unknown): value is VisualBackgroundSlot =>
  typeof value === 'string' && (VISUAL_BACKGROUND_SLOTS as readonly string[]).includes(value);

const isMimeType = (value: unknown): value is VisualBackgroundMimeType =>
  typeof value === 'string' && (VISUAL_BACKGROUND_MIME_TYPES as readonly string[]).includes(value);

const isBlob = (value: unknown): value is Blob =>
  typeof globalThis.Blob === 'function' && value instanceof globalThis.Blob;

/** Fast checks that do not require image decoding or any browser globals. */
export const validateVisualBackgroundFileBasics = (
  file: Pick<Blob, 'size' | 'type'>,
): VisualBackgroundValidationResult => {
  if (!Number.isFinite(file.size) || file.size <= 0) return { valid: false, code: 'empty' };
  if (file.size > MAX_VISUAL_BACKGROUND_BYTES) return { valid: false, code: 'too-large' };
  if (!isMimeType(file.type.toLowerCase())) return { valid: false, code: 'unsupported-type' };
  return { valid: true, code: 'ok' };
};

const browserDecodeEnvironment = (): ImageDecodeEnvironment => ({
  createImageBitmap: typeof globalThis.createImageBitmap === 'function'
    ? globalThis.createImageBitmap.bind(globalThis)
    : undefined,
  Image: typeof globalThis.Image === 'function' ? globalThis.Image : undefined,
  URL: typeof globalThis.URL?.createObjectURL === 'function'
    && typeof globalThis.URL?.revokeObjectURL === 'function'
    ? globalThis.URL
    : undefined,
});

const decodeWithImageElement = (
  blob: Blob,
  ImageConstructor: typeof Image,
  urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>,
): Promise<boolean> => new Promise((resolve) => {
  let objectUrl: string;
  try {
    objectUrl = urlApi.createObjectURL(blob);
  } catch {
    resolve(false);
    return;
  }

  const image = new ImageConstructor();
  const finish = (valid: boolean): void => {
    try { urlApi.revokeObjectURL(objectUrl); } catch { /* best-effort cleanup */ }
    resolve(valid);
  };
  image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
  image.onerror = () => finish(false);
  image.src = objectUrl;
});

/**
 * Validate type, size, and whether the browser can decode the image.
 * The function never throws. A browser without a decoding API returns the
 * explicit `decode-unavailable` result so callers can disable upload safely.
 */
export const validateVisualBackgroundFile = async (
  blob: Blob,
  environment: ImageDecodeEnvironment = browserDecodeEnvironment(),
): Promise<VisualBackgroundValidationResult> => {
  const basics = validateVisualBackgroundFileBasics(blob);
  if (!basics.valid) return basics;

  if (environment.createImageBitmap) {
    try {
      const bitmap = await environment.createImageBitmap(blob);
      const valid = bitmap.width > 0 && bitmap.height > 0;
      try { bitmap.close?.(); } catch { /* best-effort cleanup */ }
      return valid ? { valid: true, code: 'ok' } : { valid: false, code: 'decode-failed' };
    } catch {
      return { valid: false, code: 'decode-failed' };
    }
  }

  if (environment.Image && environment.URL) {
    try {
      return await decodeWithImageElement(blob, environment.Image, environment.URL)
        ? { valid: true, code: 'ok' }
        : { valid: false, code: 'decode-failed' };
    } catch {
      return { valid: false, code: 'decode-failed' };
    }
  }

  return { valid: false, code: 'decode-unavailable' };
};

const browserIndexedDb = (): IDBFactory | null => {
  try {
    return typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB;
  } catch {
    return null;
  }
};

const requestError = (request: IDBRequest): Error => {
  try { return request.error ?? new Error('IndexedDB request failed'); }
  catch { return new Error('IndexedDB request failed'); }
};

const openDatabase = (factory: IDBFactory): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  let request: IDBOpenDBRequest;
  try {
    request = factory.open(VISUAL_BACKGROUND_DATABASE_NAME, VISUAL_BACKGROUND_DATABASE_VERSION);
  } catch (error) {
    reject(error);
    return;
  }

  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(VISUAL_BACKGROUND_STORE_NAME)) {
      database.createObjectStore(VISUAL_BACKGROUND_STORE_NAME, { keyPath: 'slot' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(requestError(request));
  request.onblocked = () => reject(new Error('IndexedDB open was blocked'));
});

const runRequest = async <T>(
  factory: IDBFactory | null,
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> => {
  if (!factory) return null;

  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase(factory);
    return await new Promise<T>((resolve, reject) => {
      let request: IDBRequest<T>;
      let result: T;
      let transaction: IDBTransaction;
      try {
        transaction = database!.transaction(VISUAL_BACKGROUND_STORE_NAME, mode);
        request = createRequest(transaction.objectStore(VISUAL_BACKGROUND_STORE_NAME));
      } catch (error) {
        reject(error);
        return;
      }

      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(requestError(request));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  } catch {
    return null;
  } finally {
    try { database?.close(); } catch { /* best-effort cleanup */ }
  }
};

const runPutMany = async (
  factory: IDBFactory | null,
  records: StoredVisualBackgroundRecord[],
): Promise<boolean> => {
  if (!factory) return false;
  let database: IDBDatabase | null = null;
  try {
    database = await openDatabase(factory);
    await new Promise<void>((resolve, reject) => {
      const transaction = database!.transaction(VISUAL_BACKGROUND_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(VISUAL_BACKGROUND_STORE_NAME);
      records.forEach((record) => store.put(record));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    return true;
  } catch {
    return false;
  } finally {
    try { database?.close(); } catch { /* best-effort cleanup */ }
  }
};

const toMetadata = (record: StoredVisualBackgroundRecord): VisualBackgroundMetadata => ({
  slot: record.slot,
  fileName: record.fileName,
  mimeType: record.mimeType,
  size: record.size,
  lastModified: record.lastModified,
  updatedAt: record.updatedAt,
});

const isStoredRecord = (value: unknown): value is StoredVisualBackgroundRecord => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredVisualBackgroundRecord>;
  return isSlot(record.slot)
    && typeof record.fileName === 'string'
    && isMimeType(record.mimeType)
    && typeof record.size === 'number'
    && (record.lastModified === null || typeof record.lastModified === 'number')
    && typeof record.updatedAt === 'number'
    && isBlob(record.blob);
};

const prepareRecord = async (
  slot: VisualBackgroundSlot,
  blob: Blob,
  options: PutVisualBackgroundOptions = {},
): Promise<
  | { ok: true; record: StoredVisualBackgroundRecord }
  | { ok: false; code: Exclude<VisualBackgroundValidationCode, 'ok'> }
> => {
  if (!isSlot(slot) || !isBlob(blob)) return { ok: false, code: 'unsupported-type' };
  const validation = await validateVisualBackgroundFile(blob);
  if (!validation.valid) {
    return {
      ok: false,
      code: validation.code === 'ok' ? 'decode-failed' : validation.code,
    };
  }
  if (!isMimeType(blob.type.toLowerCase())) return { ok: false, code: 'unsupported-type' };
  const metadata: VisualBackgroundMetadata = {
    slot,
    fileName: typeof options.fileName === 'string' && options.fileName.trim()
      ? options.fileName.trim().slice(0, 255)
      : `${slot}.${blob.type === 'image/jpeg' ? 'jpg' : blob.type.split('/')[1]}`,
    mimeType: blob.type.toLowerCase() as VisualBackgroundMimeType,
    size: blob.size,
    lastModified: typeof options.lastModified === 'number' && Number.isFinite(options.lastModified)
      ? options.lastModified
      : null,
    updatedAt: typeof options.updatedAt === 'number' && Number.isFinite(options.updatedAt)
      ? options.updatedAt
      : Date.now(),
  };
  return { ok: true, record: { ...metadata, blob } };
};

/** Create an isolated store. Pass `null` to explicitly select the safe no-op fallback. */
export const createVisualBackgroundStore = (
  factory: IDBFactory | null = browserIndexedDb(),
): VisualBackgroundStore => ({
  async get(slot) {
    if (!isSlot(slot)) return null;
    const record = await runRequest<StoredVisualBackgroundRecord | undefined>(
      factory,
      'readonly',
      (store) => store.get(slot),
    );
    if (!isStoredRecord(record)) return null;
    return { metadata: toMetadata(record), blob: record.blob };
  },

  async put(slot, blob, options = {}) {
    const prepared = await prepareRecord(slot, blob, options);
    if (prepared.ok === false) return null;
    const key = await runRequest<IDBValidKey>(factory, 'readwrite', (store) => store.put(prepared.record));
    return key === null ? null : toMetadata(prepared.record);
  },

  async putMany(entries) {
    if (entries.length === 0) return { ok: true, metadata: [] };

    // Decode sequentially to cap peak memory for two high-resolution day/night images.
    const records: StoredVisualBackgroundRecord[] = [];
    for (const { slot, blob, options } of entries) {
      const prepared = await prepareRecord(slot, blob, options);
      if (prepared.ok === false) return { ok: false, code: prepared.code };
      records.push(prepared.record);
    }

    return await runPutMany(factory, records)
      ? { ok: true, metadata: records.map(toMetadata) }
      : { ok: false, code: 'storage-failed' };
  },

  async delete(slot) {
    if (!isSlot(slot)) return false;
    const result = await runRequest<undefined>(factory, 'readwrite', (store) => store.delete(slot));
    return result !== null;
  },

  async clear() {
    const result = await runRequest<undefined>(factory, 'readwrite', (store) => store.clear());
    return result !== null;
  },

  async metadata() {
    const records = await runRequest<StoredVisualBackgroundRecord[]>(
      factory,
      'readonly',
      (store) => store.getAll(),
    );
    if (!Array.isArray(records)) return [];
    return records.filter(isStoredRecord).map(toMetadata).sort((a, b) => a.slot.localeCompare(b.slot));
  },
});

/** Default browser store used by application consumers. */
export const visualBackgroundStore = createVisualBackgroundStore();
