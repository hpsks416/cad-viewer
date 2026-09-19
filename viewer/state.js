// Unified user-state persistence: saved to server-side user_state.json so every
// browser (Edge / Codex in-app browser / Chrome) reads the same settings.
const STATE_URL = '/api/state';

let state = { materialOverrides: {}, initialPlacement: null, textures: [] };
let readyPromise = null;
let persistTimer = null;

function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    fetch(STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => {});
  }, 120);
}

function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    fetch(STATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
      keepalive: true,
    });
  } catch (e) {}
}

// One-time migration from the old per-browser storage (localStorage / IndexedDB).
function migrateMaterials() {
  if (Object.keys(state.materialOverrides).length) return false;
  try {
    const raw = localStorage.getItem('cadViewer.materialOverrides');
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') {
        state.materialOverrides = v;
        localStorage.removeItem('cadViewer.materialOverrides');
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function migratePlacement() {
  if (state.initialPlacement) return false;
  try {
    const raw = localStorage.getItem('cadViewer.initialPlacement');
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v.x === 'number' && typeof v.z === 'number') {
        state.initialPlacement = { x: v.x, z: v.z };
        localStorage.removeItem('cadViewer.initialPlacement');
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open('cadViewerMaterials', 1);
      req.onupgradeneeded = () => {};
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function migrateTextures() {
  if (state.textures.length) return false;
  let db = null;
  try {
    db = await idbOpen();
    if (!db.objectStoreNames.contains('textures')) return false;
    const all = await idbRequest(db.transaction('textures', 'readonly').objectStore('textures').getAll());
    if (Array.isArray(all) && all.length) {
      state.textures = all.map(r => ({ id: r.id, type: r.type, name: r.name, dataUrl: r.dataUrl }));
      try {
        await idbRequest(db.transaction('textures', 'readwrite').objectStore('textures').clear());
      } catch (e) {}
      return true;
    }
  } catch (e) {}
  finally {
    if (db) { try { db.close(); } catch (e) {} }
  }
  return false;
}

export function loadState() {
  if (!readyPromise) {
    readyPromise = (async () => {
      try {
        const r = await fetch(STATE_URL, { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          if (d && typeof d === 'object') {
            state.materialOverrides = d.materialOverrides || {};
            state.initialPlacement = (d.initialPlacement && typeof d.initialPlacement === 'object') ? d.initialPlacement : null;
            state.textures = Array.isArray(d.textures) ? d.textures : [];
          }
        }
      } catch (e) {}

      let changed = false;
      changed = migrateMaterials() || changed;
      changed = migratePlacement() || changed;
      changed = (await migrateTextures()) || changed;
      if (changed) persist();
    })();
  }
  return readyPromise;
}

export function getMaterialOverrides() { return state.materialOverrides; }
export function setMaterialOverrides(storageId, overrides) {
  state.materialOverrides[storageId] = overrides;
  persist();
}
export function clearMaterialOverrides() { state.materialOverrides = {}; persist(); }

export function getInitialPlacement() { return state.initialPlacement; }
export function setInitialPlacement(x, z) { state.initialPlacement = { x, z }; persist(); }
export function clearInitialPlacement() { state.initialPlacement = null; persist(); }

export function getTextures() { return state.textures; }
export function addTexture(rec) { state.textures.push(rec); persist(); }
export function removeTexture(id) { state.textures = state.textures.filter(t => t.id !== id); persist(); }

window.addEventListener('pagehide', flush);
