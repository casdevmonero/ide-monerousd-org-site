/* IndexedDB project store. Persists project metadata + file contents per
 * browser-origin (IDE-3: never auto-uploaded; export = manual user action).
 *
 * Schema:
 *   db: 'monerousd-ide' v1
 *     stores:
 *       'projects' (key: id) — {id, name, kind, createdAt, updatedAt, openFiles, activeFile, settings}
 *       'files'    (key: [projectId, path]) — {projectId, path, content, mtime}
 *   localStorage:
 *       'monerousd-ide.currentProjectId'
 *       'monerousd-ide.openFiles'
 *
 * IDE-10 path-traversal guard: every path must match /^[\w\-./]+$/ and contain
 * no '..' segment, no leading '/'. JS-side is belt-and-braces (server-side
 * Sovereign Hosting publisher.js does final verification).
 */

const DB_NAME = 'monerousd-ide';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_FILES    = 'files';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const fs = db.createObjectStore(STORE_FILES, { keyPath: ['projectId', 'path'] });
        fs.createIndex('byProject', 'projectId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked — close other tabs of the IDE.'));
  });
  return dbPromise;
}

function tx(stores, mode = 'readonly') {
  return open().then(db => {
    const t = db.transaction(stores, mode);
    return { tx: t, stores: stores.reduce((m, s) => (m[s] = t.objectStore(s), m), {}) };
  });
}

function p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export function isValidPath(path) {
  if (typeof path !== 'string' || !path.length) return false;
  if (path.length > 200) return false;
  if (path.startsWith('/')) return false;
  if (path.split('/').some(seg => seg === '..' || seg === '.' || seg === '')) return false;
  return /^[\w\-./@]+$/.test(path);
}

function assertPath(path) {
  if (!isValidPath(path)) {
    throw new Error(`Invalid file path: "${path}"`);
  }
}

/** Generate UUIDv4. crypto.randomUUID is available in all modern browsers. */
export function newProjectId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback: 16 random bytes formatted as UUIDv4.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

/* ───────────── Projects CRUD ───────────── */

export async function listProjects() {
  const { stores } = await tx([STORE_PROJECTS]);
  return await p(stores[STORE_PROJECTS].getAll());
}

export async function getProject(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid project id');
  const { stores } = await tx([STORE_PROJECTS]);
  return await p(stores[STORE_PROJECTS].get(id));
}

export async function createProject({ name, kind = 'contract', files = [] } = {}) {
  const id = newProjectId();
  const now = Date.now();
  const project = {
    id,
    name: name || 'Untitled project',
    kind,
    createdAt: now,
    updatedAt: now,
    openFiles: [],
    activeFile: files[0]?.path ?? null,
    settings: { autoCompile: true },
  };
  const { tx: t, stores } = await tx([STORE_PROJECTS, STORE_FILES], 'readwrite');
  stores[STORE_PROJECTS].put(project);
  for (const f of files) {
    assertPath(f.path);
    stores[STORE_FILES].put({
      projectId: id,
      path: f.path,
      content: f.content || '',
      mtime: now,
    });
  }
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  if (files[0]) {
    project.openFiles = [files[0].path];
  }
  return project;
}

export async function updateProject(id, patch) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid project id');
  const { tx: t, stores } = await tx([STORE_PROJECTS], 'readwrite');
  const cur = await p(stores[STORE_PROJECTS].get(id));
  if (!cur) throw new Error(`Project not found: ${id}`);
  const next = { ...cur, ...patch, id, updatedAt: Date.now() };
  stores[STORE_PROJECTS].put(next);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  return next;
}

export async function deleteProject(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid project id');
  const { tx: t, stores } = await tx([STORE_PROJECTS, STORE_FILES], 'readwrite');
  stores[STORE_PROJECTS].delete(id);
  // Delete all files for this project via the byProject index.
  const idx = stores[STORE_FILES].index('byProject');
  const cursorReq = idx.openCursor(IDBKeyRange.only(id));
  await new Promise((res, rej) => {
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur) { cur.delete(); cur.continue(); } else res();
    };
    cursorReq.onerror = () => rej(cursorReq.error);
  });
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

/* ───────────── Files CRUD ───────────── */

export async function listFiles(projectId) {
  if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error('Invalid project id');
  const { stores } = await tx([STORE_FILES]);
  const idx = stores[STORE_FILES].index('byProject');
  return await p(idx.getAll(IDBKeyRange.only(projectId)));
}

export async function readFile(projectId, path) {
  assertPath(path);
  const { stores } = await tx([STORE_FILES]);
  return await p(stores[STORE_FILES].get([projectId, path]));
}

export async function writeFile(projectId, path, content) {
  assertPath(path);
  const { tx: t, stores } = await tx([STORE_FILES, STORE_PROJECTS], 'readwrite');
  stores[STORE_FILES].put({
    projectId,
    path,
    content,
    mtime: Date.now(),
  });
  // Bump project mtime.
  const proj = await p(stores[STORE_PROJECTS].get(projectId));
  if (proj) {
    proj.updatedAt = Date.now();
    stores[STORE_PROJECTS].put(proj);
  }
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

export async function deleteFile(projectId, path) {
  assertPath(path);
  const { tx: t, stores } = await tx([STORE_FILES], 'readwrite');
  stores[STORE_FILES].delete([projectId, path]);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

export async function renameFile(projectId, oldPath, newPath) {
  assertPath(oldPath);
  assertPath(newPath);
  const { tx: t, stores } = await tx([STORE_FILES], 'readwrite');
  const cur = await p(stores[STORE_FILES].get([projectId, oldPath]));
  if (!cur) throw new Error(`File not found: ${oldPath}`);
  stores[STORE_FILES].delete([projectId, oldPath]);
  stores[STORE_FILES].put({ ...cur, path: newPath, mtime: Date.now() });
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

/* ───────────── Current-project pointer (localStorage) ───────────── */

export function getCurrentProjectId() {
  try { return localStorage.getItem('monerousd-ide.currentProjectId') || null; }
  catch { return null; }
}

export function setCurrentProjectId(id) {
  try {
    if (id) localStorage.setItem('monerousd-ide.currentProjectId', id);
    else    localStorage.removeItem('monerousd-ide.currentProjectId');
  } catch { /* private mode ignored */ }
}

/* ───────────── Persistent storage hint ───────────── */

/** Ask the browser to mark our origin as persistent. Browser may decline. */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    if (navigator.storage?.persist)   return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch { /* ignore */ }
  return null;
}
