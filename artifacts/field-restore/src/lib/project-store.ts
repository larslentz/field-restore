import type { EditModule } from './edit-chain';
import type { StoredProject } from './persistence';
import { normalizeTrackDescription, type TrackDescription } from './track-description';

/**
 * IndexedDB is deliberately used for project state only. Audio samples are
 * never copied into this record; the source is reopened through fileHandle.
 */
export interface ProjectSourceMetadata {
  name: string;
  sampleRate: number;
  duration?: number;
  channels?: number;
  [key: string]: unknown;
}

export interface ProjectRecord {
  id: string;
  title: string;
  notes: string;
  what3wordsAddress?: string;
  descriptiveWords?: string[];
  trackDescription?: TrackDescription;
  savedAt: string;
  modules: EditModule[];
  markers: StoredProject['markers'];
  regions: StoredProject['regions'];
  trim?: [number, number];
  source: ProjectSourceMetadata;
  /** Alias retained for callers that use the descriptive field name. */
  sourceMetadata?: ProjectSourceMetadata;
  fileHandle?: FileSystemFileHandle;
  analysis?: unknown;
  indexMetadata?: unknown;
  cachedAnalysis?: unknown;
  cachedIndexMetadata?: unknown;
}

export type ProjectInput = Omit<ProjectRecord, 'id' | 'savedAt'> & {
  id?: string;
  savedAt?: string;
};

export interface ProjectListItem {
  id: string;
  title: string;
  notes: string;
  savedAt: string;
  source: ProjectSourceMetadata;
  hasFileHandle: boolean;
}

export class ProjectStoreError extends Error {
  readonly operation: string;
  readonly cause?: unknown;

  constructor(operation: string, cause?: unknown) {
    super(`Unable to ${operation} project${cause instanceof Error && cause.message ? `: ${cause.message}` : '.'}`);
    this.name = 'ProjectStoreError';
    this.operation = operation;
    this.cause = cause;
  }
}

const DB_NAME = 'field-restore-projects';
const DB_VERSION = 1;
const STORE_NAME = 'projects';

function ensureIndexedDb(operation: string): IDBFactory {
  if (typeof indexedDB === 'undefined') {
    throw new ProjectStoreError(operation, new Error('IndexedDB is not available in this browser'));
  }
  return indexedDB;
}

function openDatabase(): Promise<IDBDatabase> {
  const factory = ensureIndexedDb('open');
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('another tab is blocking the project database upgrade'));
    } catch (error) {
      reject(error);
    }
  }).catch((error) => {
    throw new ProjectStoreError('open', error);
  });
}

function closeAfter<T>(database: IDBDatabase, operation: () => Promise<T>): Promise<T> {
  return operation().finally(() => database.close());
}

function withoutAudio(input: ProjectInput): ProjectRecord {
  const source = input.sourceMetadata ?? input.source ?? { name: '', sampleRate: 0 };
  return {
    id: input.id ?? makeId(),
    title: input.title ?? 'Untitled project',
    notes: input.notes ?? '',
    what3wordsAddress: input.what3wordsAddress ?? '',
    descriptiveWords: input.descriptiveWords ?? [],
    trackDescription: normalizeTrackDescription(input.trackDescription),
    savedAt: input.savedAt ?? new Date().toISOString(),
    modules: input.modules ?? [],
    markers: input.markers ?? [],
    regions: input.regions ?? [],
    trim: input.trim,
    source: { ...source },
    sourceMetadata: { ...source },
    fileHandle: input.fileHandle,
    analysis: input.analysis ?? input.cachedAnalysis,
    indexMetadata: input.indexMetadata ?? input.cachedIndexMetadata,
    cachedAnalysis: input.cachedAnalysis ?? input.analysis,
    cachedIndexMetadata: input.cachedIndexMetadata ?? input.indexMetadata,
  };
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function transaction<T>(database: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode);
    let request: IDBRequest<T>;
    try {
      request = action(tx.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction was aborted'));
    } catch (error) {
      reject(error);
    }
  });
}

/** Convert the old localStorage shape while intentionally dropping audio data. */
export function migrateStoredProject(input: StoredProject | ProjectInput, id?: string): ProjectInput {
  const value = input as StoredProject & Partial<ProjectInput>;
  return {
    id: id ?? value.id,
    title: value.title ?? 'Untitled project',
    notes: value.notes ?? '',
    what3wordsAddress: value.what3wordsAddress ?? '',
    descriptiveWords: value.descriptiveWords ?? [],
    trackDescription: normalizeTrackDescription(value.trackDescription),
    savedAt: value.savedAt,
    modules: value.modules ?? [],
    markers: value.markers ?? [],
    regions: value.regions ?? [],
    trim: value.trim,
    source: value.source ?? value.sourceMetadata ?? {
      name: value.sourceName ?? '',
      sampleRate: value.sampleRate ?? 0,
    },
    fileHandle: value.fileHandle,
    analysis: value.analysis ?? value.cachedAnalysis,
    indexMetadata: value.indexMetadata ?? value.cachedIndexMetadata,
    cachedAnalysis: value.cachedAnalysis ?? value.analysis,
    cachedIndexMetadata: value.cachedIndexMetadata ?? value.indexMetadata,
  };
}

export async function saveProject(input: ProjectInput | StoredProject): Promise<ProjectRecord> {
  const record = withoutAudio(migrateStoredProject(input));
  const database = await openDatabase();
  try {
    await closeAfter(database, () => transaction(database, 'readwrite', (store) => store.put(record)));
    return record;
  } catch (error) {
    database.close();
    throw new ProjectStoreError('save', error);
  }
}

export async function loadProject(id: string): Promise<ProjectRecord | null> {
  const database = await openDatabase();
  try {
    return await closeAfter(database, () => transaction<ProjectRecord | undefined>(database, 'readonly', (store) => store.get(id)))
      .then((record) => record ?? null);
  } catch (error) {
    database.close();
    throw new ProjectStoreError('load', error);
  }
}

export async function listProjects(): Promise<ProjectListItem[]> {
  const database = await openDatabase();
  try {
    const records = await closeAfter(database, () => transaction<ProjectRecord[]>(database, 'readonly', (store) => store.getAll()));
    return records
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .map(({ id, title, notes, savedAt, source, fileHandle }) => ({ id, title, notes, savedAt, source, hasFileHandle: Boolean(fileHandle) }));
  } catch (error) {
    database.close();
    throw new ProjectStoreError('list', error);
  }
}

export async function deleteProject(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    await closeAfter(database, () => transaction(database, 'readwrite', (store) => store.delete(id)));
  } catch (error) {
    database.close();
    throw new ProjectStoreError('delete', error);
  }
}

export async function queryFileHandlePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  try {
    // These methods are implemented by Chromium but are absent from some
    // versions of lib.dom.d.ts, so keep the public handle type portable.
    const permissionHandle = handle as FileSystemFileHandle & {
      queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
    };
    if (!permissionHandle.queryPermission) throw new Error('file permission queries are not supported');
    return await permissionHandle.queryPermission({ mode: 'read' });
  } catch (error) {
    throw new ProjectStoreError('query file permission', error);
  }
}

export async function requestFileHandlePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  try {
    const permissionHandle = handle as FileSystemFileHandle & {
      requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
    };
    if (!permissionHandle.requestPermission) throw new Error('file permission requests are not supported');
    return await permissionHandle.requestPermission({ mode: 'read' });
  } catch (error) {
    throw new ProjectStoreError('request file permission', error);
  }
}