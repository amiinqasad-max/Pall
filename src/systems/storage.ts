/**
 * Durable key/value storage.
 *
 * IndexedDB is the primary store: it survives more aggressively than
 * localStorage on mobile Safari and Android WebView, and it does not block the
 * main thread while the game is running. localStorage is the fallback for
 * private-mode browsers where IDB is unavailable, and an in-memory map is the
 * last resort so the game still *runs* (just without persistence) rather than
 * crashing on boot.
 */

const DB_NAME = 'tartan';
const DB_VERSION = 1;
const STORE = 'kv';

type Backend = {
  name: 'idb' | 'local' | 'memory';
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

let backendPromise: Promise<Backend> | null = null;

function memoryBackend(): Backend {
  const map = new Map<string, unknown>();
  return {
    name: 'memory',
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return Array.from(map.keys());
    },
  };
}

function localBackend(): Backend {
  const prefix = 'tartan:';
  return {
    name: 'local',
    async get<T>(key: string) {
      const raw = localStorage.getItem(prefix + key);
      if (raw == null) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value));
      } catch {
        // Quota exceeded — drop the write rather than take the tab down.
      }
    },
    async remove(key) {
      localStorage.removeItem(prefix + key);
    },
    async keys() {
      return Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('idb blocked'));
  });
}

function idbBackend(db: IDBDatabase): Backend {
  const run = <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });

  return {
    name: 'idb',
    get: <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key)),
    set: (key, value) => run<void>('readwrite', (s) => s.put(value, key)),
    remove: (key) => run<void>('readwrite', (s) => s.delete(key)),
    keys: () => run<string[]>('readonly', (s) => s.getAllKeys() as IDBRequest<string[]>),
  };
}

async function resolveBackend(): Promise<Backend> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openDb();
      const backend = idbBackend(db);
      // Prove the store actually accepts writes; some private modes expose the
      // API but reject every transaction.
      await backend.set('__probe', 1);
      await backend.remove('__probe');
      return backend;
    } catch {
      /* fall through */
    }
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('tartan:__probe', '1');
      localStorage.removeItem('tartan:__probe');
      return localBackend();
    }
  } catch {
    /* fall through */
  }
  return memoryBackend();
}

function backend(): Promise<Backend> {
  if (!backendPromise) backendPromise = resolveBackend();
  return backendPromise;
}

export const storage = {
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return await (await backend()).get<T>(key);
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      await (await backend()).set(key, value);
    } catch {
      /* persistence is best-effort; never break gameplay over it */
    }
  },
  async remove(key: string): Promise<void> {
    try {
      await (await backend()).remove(key);
    } catch {
      /* ignore */
    }
  },
  async keys(): Promise<string[]> {
    try {
      return await (await backend()).keys();
    } catch {
      return [];
    }
  },
  async driver(): Promise<Backend['name']> {
    return (await backend()).name;
  },
};

/**
 * Asks the browser to make our storage bucket persistent so the OS does not
 * evict a player's progress under storage pressure. Silently no-ops where the
 * API is missing (most of iOS today).
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return false;
}
