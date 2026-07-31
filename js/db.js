// db.js — IndexedDB-backed library storage for BeriBook.
// Stores parsed books (chapters + text) and per-book reading progress,
// plus a small key/value store for user settings. Everything lives on the
// device; nothing is uploaded anywhere.

const DB_NAME = 'beribook';
const DB_VERSION = 2;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        const s = db.createObjectStore('books', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      // Original file bytes, kept in a separate store so the library list
      // stays light (it never loads the raw files).
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode = 'readonly') {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const DB = {
  async saveBook(book) {
    const store = await tx('books', 'readwrite');
    await reqPromise(store.put(book));
    return book;
  },

  async getBook(id) {
    const store = await tx('books');
    return reqPromise(store.get(id));
  },

  async listBooks() {
    const store = await tx('books');
    const all = await reqPromise(store.getAll());
    // newest first
    return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },

  async deleteBook(id) {
    const store = await tx('books', 'readwrite');
    await reqPromise(store.delete(id));
    try { await this.deleteFile(id); } catch (_) { /* ignore */ }
  },

  // Original file bytes (for the "Original document" view).
  async saveFile(id, blob) {
    const store = await tx('files', 'readwrite');
    return reqPromise(store.put({ id, blob }));
  },
  async getFile(id) {
    const store = await tx('files');
    const row = await reqPromise(store.get(id));
    return row ? row.blob : null;
  },
  async deleteFile(id) {
    const store = await tx('files', 'readwrite');
    return reqPromise(store.delete(id));
  },

  // Progress is stored inline on the book for simplicity.
  async saveProgress(id, progress) {
    const book = await this.getBook(id);
    if (!book) return;
    book.progress = progress;
    book.lastOpenedAt = Date.now();
    await this.saveBook(book);
  },
  async saveDocProgress(id, sentenceIndex) {
    const book = await this.getBook(id);
    if (!book) return;
    book.docProgress = sentenceIndex;
    book.lastOpenedAt = Date.now();
    await this.saveBook(book);
  },

  async getSetting(key, fallback = null) {
    const store = await tx('settings');
    const row = await reqPromise(store.get(key));
    return row ? row.value : fallback;
  },

  async setSetting(key, value) {
    const store = await tx('settings', 'readwrite');
    return reqPromise(store.put({ key, value }));
  },
};
