// 材质面板：颜色 / 金属度 / 粗糙度三者解耦，可自由组合；
// 材质库支持法线贴图 + 粗糙度贴图（无 UV 的 STEP/STL 网格走 triplanar 采样）；
// Material overrides persist to server-side user_state.json (shared across browsers).
import * as THREE from 'three';
import { getModelRoot, getPartInfo, clearActiveSelection, selectSerialByName, refreshHighlight } from './scene-tree.js';
import { loadState, getMaterialOverrides, setMaterialOverrides, clearMaterialOverrides, getTextures, addTexture, removeTexture } from './state.js';

const LIB_URL = 'assets/materials/library.json';
const TEX_BASE = 'assets/materials/';

const DEFAULT_STATE = { color: '#888888', metalness: 0.3, roughness: 0.5, normalMap: null, roughnessMap: null, scale: 0.05 };

let panelEl = null;
let selEl = null;
let colorInput = null;
let colorHexEl = null;
let colorsEl = null;
let metalSlider = null, metalVal = null;
let roughSlider = null, roughVal = null;
let scaleSlider = null, scaleVal = null;
let normalGrid = null, roughGrid = null;
let presetGrid = null;
let autoSaveEl = null;

let library = { colors: [], textures: { normal: [], roughness: [] }, presets: [] };
let libReady = Promise.resolve();

const texLoader = new THREE.TextureLoader();
const texCache = new Map();   // file -> Promise<Texture|null> while loading, then Texture
const matCache = new Map();   // storageId + "::" + stateKey -> MeshStandardMaterial (隔离模型/场地，避免共享材质实例)

let currentModelId = 'local';
let active = null;            // { serial, root, label, storageId }
let overrides = {};           // serial -> state
let autoSave = true;
let applying = false;         // 防止控件回填时触发 apply

export function initMaterials(containerId) {
  const wrapper = document.getElementById(containerId);
  panelEl = wrapper ? wrapper.querySelector('.panel-body') : null;
  if (!panelEl) { if (wrapper) panelEl = wrapper; else return; }
  panelEl.innerHTML = `
    <div class="mat-sel">未选中零件</div>

    <div class="mat-sub">颜色</div>
    <div class="mat-color-row">
      <input type="color" class="mat-color" value="#888888">
      <span class="mat-color-hex">#888888</span>
    </div>
    <div class="mat-colors"></div>

    <div class="mat-sub">金属度 <span class="mat-val mat-metal-val">0.30</span></div>
    <input type="range" class="mat-slider mat-metal" min="0" max="1" step="0.01" value="0.3">

    <div class="mat-sub">粗糙度 <span class="mat-val mat-rough-val">0.50</span></div>
    <input type="range" class="mat-slider mat-rough" min="0" max="1" step="0.01" value="0.5">

    <div class="mat-sub">法线贴图</div>
    <div class="mat-texgrid mat-normal"></div>

    <div class="mat-sub">粗糙度贴图</div>
    <div class="mat-texgrid mat-roughness"></div>

    <div class="mat-sub">贴图缩放 <span class="mat-val mat-scale-val">0.050</span></div>
    <input type="range" class="mat-slider mat-scale" min="0.005" max="0.5" step="0.005" value="0.05">

    <div class="mat-sub">快捷材质</div>
    <div class="mat-grid mat-presets"></div>

    <div class="mat-save">
      <label class="mat-autosave-label"><input type="checkbox" class="mat-autosave" checked> 保存到本地</label>
    </div>
    <div class="mat-actions">
      <button class="mat-reset" type="button">恢复默认</button>
      <button class="mat-clear" type="button">清除本地保存</button>
    </div>`;

  selEl = panelEl.querySelector('.mat-sel');
  colorInput = panelEl.querySelector('.mat-color');
  colorHexEl = panelEl.querySelector('.mat-color-hex');
  colorsEl = panelEl.querySelector('.mat-colors');
  metalSlider = panelEl.querySelector('.mat-metal');
  metalVal = panelEl.querySelector('.mat-metal-val');
  roughSlider = panelEl.querySelector('.mat-rough');
  roughVal = panelEl.querySelector('.mat-rough-val');
  scaleSlider = panelEl.querySelector('.mat-scale');
  scaleVal = panelEl.querySelector('.mat-scale-val');
  normalGrid = panelEl.querySelector('.mat-normal');
  roughGrid = panelEl.querySelector('.mat-roughness');
  presetGrid = panelEl.querySelector('.mat-presets');
  autoSaveEl = panelEl.querySelector('.mat-autosave');
  panelEl.querySelector('.mat-reset').addEventListener('click', () =>
    confirmAction('恢复默认', '确定要将当前选中零件恢复为默认材质吗？', resetSelection));
  panelEl.querySelector('.mat-clear').addEventListener('click', () =>
    confirmAction('清除本地保存', '确定要清除所有本地保存的材质设置吗？此操作不可撤销。', clearLocal));

  colorInput.addEventListener('input', () => {
    colorHexEl.textContent = colorInput.value;
    if (!applying) applyCurrent();
  });
  metalSlider.addEventListener('input', () => {
    metalVal.textContent = Number(metalSlider.value).toFixed(2);
    if (!applying) applyCurrent();
  });
  roughSlider.addEventListener('input', () => {
    roughVal.textContent = Number(roughSlider.value).toFixed(2);
    if (!applying) applyCurrent();
  });
  scaleSlider.addEventListener('input', () => {
    scaleVal.textContent = Number(scaleSlider.value).toFixed(3);
    if (!applying) applyCurrent();
  });
  autoSaveEl.addEventListener('change', () => {
    autoSave = autoSaveEl.checked;
    if (autoSave) saveOverrides();
  });

  loadLibrary();
}

function texUrl(file) {
  if (!file) return '';
  return /^(data:|blob:|https?:)/.test(file) ? file : (TEX_BASE + file);
}

function makeTexButton(type, t) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mat-tex';
  b.dataset.id = t.id;
  b.title = t.name_zh || t.name_en || t.id;
  const img = document.createElement('img');
  img.src = texUrl(t.file);
  img.alt = '';
  b.appendChild(img);
  const span = document.createElement('span');
  span.textContent = t.name_zh || t.name_en || t.id;
  b.appendChild(span);
  b.addEventListener('click', () => {
    if (!applying) { setStateField(type === 'normal' ? 'normalMap' : 'roughnessMap', t.id); applyCurrent(); }
  });
  return b;
}

function importTexture(type) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.style.display = 'none';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      const id = 'local-' + type + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
      const name = f.name ? (f.name.split('.').slice(0, -1).join('.') || f.name) : 'texture';
      const entry = { id, name_zh: name, file: dataUrl, local: true };
      library.textures[type].push(entry);
      addTexture({ id, type, name, dataUrl });
      renderTextureGrids();
      if (active) {
        setStateField(type === 'normal' ? 'normalMap' : 'roughnessMap', id);
        applyCurrent();
      }
      loadTexture(dataUrl);
    };
    reader.onerror = () => {};
    reader.readAsDataURL(f);
    inp.remove();
  });
  document.body.appendChild(inp);
  inp.click();
}

async function loadLibrary() {
  libReady = (async () => {
    try {
      const r = await fetch(LIB_URL, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      library = {
        colors: (data && data.colors) || [],
        textures: {
          normal: ((data && data.textures && data.textures.normal)) || [],
          roughness: ((data && data.textures && data.textures.roughness)) || [],
        },
        presets: (data && data.presets) || [],
      };
    } catch (e) {
      console.warn('材质库加载失败：', e);
      library = { colors: [], textures: { normal: [], roughness: [] }, presets: [] };
    }
    await loadState();
    const imported = getTextures();
    const imNormal = imported.filter(r => r.type === 'normal');
    const imRough = imported.filter(r => r.type === 'roughness');
    imNormal.forEach(r => library.textures.normal.push({ id: r.id, name_zh: r.name, file: r.dataUrl, local: true }));
    imRough.forEach(r => library.textures.roughness.push({ id: r.id, name_zh: r.name, file: r.dataUrl, local: true }));
    renderColorSwatches();
    renderTextureGrids();
    renderPresetGrid();
    // 预加载全部贴图，后续赋材质同步完成
    const files = new Set();
    library.textures.normal.forEach(t => files.add(t.file));
    library.textures.roughness.forEach(t => files.add(t.file));
    await Promise.all([...files].map(f => loadTexture(f)));
  })();
  return libReady;
}

function loadTexture(src) {
  if (!src) return Promise.resolve(null);
  if (!texCache.has(src)) {
    texCache.set(src, new Promise((resolve) => {
      texLoader.load(texUrl(src), (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.NoColorSpace;
        texCache.set(src, t);
        resolve(t);
      }, undefined, () => {
        texCache.delete(src);
        resolve(null);
      });
    }));
  }
  return texCache.get(src);
}

function textureFile(type, id) {
  const list = library.textures[type] || [];
  const item = list.find(t => t.id === id);
  return item ? item.file : null;
}

function loadedTexture(type, id) {
  const file = textureFile(type, id);
  if (!file) return null;
  const p = texCache.get(file);
  if (p && p instanceof THREE.Texture) return p;
  return null;
}

function stateKey(s) {
  return [
    s.color,
    (+s.metalness).toFixed(3),
    (+s.roughness).toFixed(3),
    s.normalMap || '',
    s.roughnessMap || '',
    (+s.scale).toFixed(4),
  ].join('|');
}

function buildMaterial(state) {
  const normalTex = loadedTexture('normal', state.normalMap);
  const roughTex = loadedTexture('roughness', state.roughnessMap);

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(state.color),
    metalness: state.metalness,
    roughness: state.roughness,
  });

  if (!normalTex && !roughTex) return mat;

  mat.onBeforeCompile = (shader) => {
    if (normalTex) shader.uniforms.uTriNormalMap = { value: normalTex };
    if (roughTex) shader.uniforms.uTriRoughnessMap = { value: roughTex };
    shader.uniforms.uTriScale = { value: state.scale || 0.05 };
    shader.uniforms.uTriNormalStrength = { value: 1.0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriObjPos;\nvarying vec3 vTriObjNormal;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n\tvTriObjPos = transformed;\n\tvTriObjNormal = normalize( objectNormal );');

    let decl = 'varying vec3 vTriObjPos;\nvarying vec3 vTriObjNormal;\nuniform float uTriScale;\nuniform float uTriNormalStrength;';
    if (normalTex) decl += '\nuniform sampler2D uTriNormalMap;';
    if (roughTex) decl += '\nuniform sampler2D uTriRoughnessMap;';
    decl += '\nuniform mat3 normalMatrix;';
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + decl);

    if (roughTex) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        {
          vec3 tn = normalize( vTriObjNormal );
          vec3 tb = abs( tn ); tb = max( tb, vec3( 1e-5 ) ); tb /= ( tb.x + tb.y + tb.z );
          vec3 tp = vTriObjPos * uTriScale;
          float rs = dot( tb, vec3(
            texture2D( uTriRoughnessMap, tp.yz ).r,
            texture2D( uTriRoughnessMap, tp.xz ).r,
            texture2D( uTriRoughnessMap, tp.xy ).r
          ) );
          roughnessFactor *= rs;
        }`);
    }

    if (normalTex) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 tn = normalize( vTriObjNormal );
          vec3 tb = abs( tn ); tb = max( tb, vec3( 1e-5 ) ); tb /= ( tb.x + tb.y + tb.z );
          vec3 tp = vTriObjPos * uTriScale;
          vec3 nX = texture2D( uTriNormalMap, tp.yz ).xyz * 2.0 - 1.0;
          vec3 nY = texture2D( uTriNormalMap, tp.xz ).xyz * 2.0 - 1.0;
          vec3 nZ = texture2D( uTriNormalMap, tp.xy ).xyz * 2.0 - 1.0;
          vec3 mapN = normalize( nX * tb.x + nY * tb.y + nZ * tb.z );
          mapN.xy *= uTriNormalStrength;
          mapN = normalize( mapN );
          vec3 helper = abs( tn.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
          vec3 T = normalize( cross( helper, tn ) );
          vec3 B = cross( tn, T );
          mat3 TBN = mat3( T, B, tn );
          normal = normalize( normalMatrix * ( TBN * mapN ) );
        }`);
    }
  };

  return mat;
}

function getMaterial(state, storageId) {
  const key = (storageId || 'shared') + '::' + stateKey(state);
  if (!matCache.has(key)) matCache.set(key, buildMaterial(state));
  return matCache.get(key);
}

function renderColorSwatches() {
  if (!colorsEl) return;
  colorsEl.innerHTML = '';
  library.colors.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mat-color-swatch';
    b.style.background = c.value;
    b.title = c.name_zh || c.id;
    b.addEventListener('click', () => {
      colorInput.value = c.value;
      colorHexEl.textContent = c.value;
      applyCurrent();
    });
    colorsEl.appendChild(b);
  });
}

function texGrid(type, gridEl) {
  gridEl.innerHTML = '';
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'mat-tex';
  none.dataset.id = '';
  none.innerHTML = '<span>无</span>';
  none.addEventListener('click', () => {
    if (!applying) { setStateField(type === 'normal' ? 'normalMap' : 'roughnessMap', null); applyCurrent(); }
  });
  gridEl.appendChild(none);

  (library.textures[type] || []).forEach(t => {
    const b = makeTexButton(type, t);
    if (t.local) {
      const wrap = document.createElement('div');
      wrap.className = 'mat-tex-local';
      wrap.appendChild(b);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mat-tex-del';
      del.title = '删除该导入贴图';
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTexture(t.id);
        library.textures[type] = library.textures[type].filter(x => x.id !== t.id);
        const cached = texCache.get(t.file);
        if (cached && cached instanceof THREE.Texture) cached.dispose();
        texCache.delete(t.file);
        if (active && overrides[active.serial]) {
          const field = type === 'normal' ? 'normalMap' : 'roughnessMap';
          if (overrides[active.serial][field] === t.id) overrides[active.serial][field] = null;
        }
        renderTextureGrids();
        if (active) applyCurrent();
      });
      wrap.appendChild(del);
      gridEl.appendChild(wrap);
    } else {
      gridEl.appendChild(b);
    }
  });

  const imp = document.createElement('button');
  imp.type = 'button';
  imp.className = 'mat-import';
  imp.textContent = '+ 导入';
  imp.title = '导入本地' + (type === 'normal' ? '法线' : '粗糙度') + '贴图';
  imp.addEventListener('click', () => importTexture(type));
  gridEl.appendChild(imp);
}

function renderTextureGrids() {
  texGrid('normal', normalGrid);
  texGrid('roughness', roughGrid);
  markActiveMaps();
}

function renderPresetGrid() {
  if (!presetGrid) return;
  presetGrid.innerHTML = '';
  library.presets.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mat-swatch';
    b.style.background = p.color || '#888';
    b.dataset.id = p.id;
    b.title = (p.name_zh || p.name_en || p.id) + (p.name_en ? ' / ' + p.name_en : '');
    const label = document.createElement('span');
    label.textContent = p.name_zh || p.name_en || p.id;
    b.appendChild(label);
    b.addEventListener('click', () => applyPreset(p.id));
    presetGrid.appendChild(b);
  });
}

function setStateField(field, value) {
  if (!active) return;
  if (!overrides[active.serial]) overrides[active.serial] = { ...DEFAULT_STATE };
  overrides[active.serial][field] = value;
}

function currentState() {
  const st = { ...DEFAULT_STATE };
  st.color = colorInput.value || '#888888';
  st.metalness = Number(metalSlider.value);
  st.roughness = Number(roughSlider.value);
  st.scale = Number(scaleSlider.value);
  st.normalMap = overrides[active.serial] ? overrides[active.serial].normalMap : null;
  st.roughnessMap = overrides[active.serial] ? overrides[active.serial].roughnessMap : null;
  return st;
}

function applyPreset(id) {
  const p = library.presets.find(x => x.id === id);
  if (!p) return;
  if (!active) { setSel('先在模型或场地上点选一个零件'); return; }
  applying = true;
  colorInput.value = p.color || '#888888';
  colorHexEl.textContent = colorInput.value;
  metalSlider.value = String(typeof p.metalness === 'number' ? p.metalness : 0.3);
  roughSlider.value = String(typeof p.roughness === 'number' ? p.roughness : 0.5);
  scaleSlider.value = String(typeof p.scale === 'number' ? p.scale : DEFAULT_STATE.scale);
  metalVal.textContent = Number(metalSlider.value).toFixed(2);
  roughVal.textContent = Number(roughSlider.value).toFixed(2);
  scaleVal.textContent = Number(scaleSlider.value).toFixed(3);
  applying = false;

  overrides[active.serial] = {
    color: colorInput.value,
    metalness: Number(metalSlider.value),
    roughness: Number(roughSlider.value),
    normalMap: p.normalMap || null,
    roughnessMap: p.roughnessMap || null,
    scale: Number(scaleSlider.value),
  };
  markActiveMaps();
  applyCurrent();
}

function meshesForSerial(root, serial) {
  if (!root || !serial) return [];
  let obj = null;
  root.traverse(o => { if (!obj && o.name === serial) obj = o; });
  if (!obj) return [];
  const out = [];
  obj.traverse(o => { if (o.isMesh) out.push(o); });
  return out;
}

function origMaterial(mesh) {
  if (mesh.userData.__origMaterial) return mesh.userData.__origMaterial;
  return mesh.material;
}

function applyState(mesh, state, storageId) {
  const orig = origMaterial(mesh);
  if (mesh.userData.__origMaterial === undefined) mesh.userData.__origMaterial = orig;
  mesh.material = getMaterial(state, storageId);
}

function applyCurrent() {
  if (!active || applying) return;
  const state = currentState();
  overrides[active.serial] = state;
  const isModel = active.root === getModelRoot();
  const meshes = meshesForSerial(active.root, active.serial);
  meshes.forEach(m => applyState(m, state, active.storageId));
  if (isModel) refreshHighlight(active.serial);
  markActiveMaps();
  updatePanel();
  if (autoSave) saveOverrides();
}

function setActive(a) {
  active = a;
  overrides = a ? (loadAllOverrides()[a.storageId] || {}) : {};
  if (a) populateControlsFromActive();
  else updatePanel();
}

function populateControlsFromActive() {
  if (!active) return;
  applying = true;
  let st = overrides[active.serial];
  if (!st) {
    const meshes = meshesForSerial(active.root, active.serial);
    const orig = meshes.length ? origMaterial(meshes[0]) : null;
    st = { ...DEFAULT_STATE };
    if (orig && orig.color) st.color = '#' + orig.color.getHexString();
    if (orig && typeof orig.metalness === 'number') st.metalness = orig.metalness;
    if (orig && typeof orig.roughness === 'number') st.roughness = orig.roughness;
  }
  colorInput.value = st.color || DEFAULT_STATE.color;
  colorHexEl.textContent = colorInput.value;
  metalSlider.value = String(typeof st.metalness === 'number' ? st.metalness : DEFAULT_STATE.metalness);
  roughSlider.value = String(typeof st.roughness === 'number' ? st.roughness : DEFAULT_STATE.roughness);
  scaleSlider.value = String(typeof st.scale === 'number' ? st.scale : DEFAULT_STATE.scale);
  metalVal.textContent = Number(metalSlider.value).toFixed(2);
  roughVal.textContent = Number(roughSlider.value).toFixed(2);
  scaleVal.textContent = Number(scaleSlider.value).toFixed(3);
  applying = false;
  markActiveMaps();
  updatePanel();
}

function markActiveMaps() {
  if (!normalGrid || !roughGrid) return;
  const st = active ? (overrides[active.serial] || {}) : {};
  normalGrid.querySelectorAll('.mat-tex').forEach(b => b.classList.toggle('active', b.dataset.id === (st.normalMap || '')));
  roughGrid.querySelectorAll('.mat-tex').forEach(b => b.classList.toggle('active', b.dataset.id === (st.roughnessMap || '')));
}

function setSel(text) { if (selEl) selEl.textContent = text; }

function updatePanel() {
  if (!active) { setSel('未选中零件'); return; }
  const hasOverride = !!overrides[active.serial];
  setSel(active.serial + ' ' + (active.label || '') + (hasOverride ? ' · 已自定义' : ' · 默认'));
}

export function setCurrentModelId(id) { currentModelId = id || 'local'; }

export function selectModelPart(serial) {
  if (!serial) { setActive(null); return; }
  const root = getModelRoot();
  const info = getPartInfo(serial) || {};
  const label = info.name_zh || info.name_en || serial;
  setActive({ serial, root, label, storageId: 'model:' + currentModelId });
}

export function selectPart(serial, root, label, storageId) {
  if (!serial || !root) { setActive(null); return; }
  setActive({ serial, root, label, storageId });
}

const appliedRoots = new Map();

export async function applyOverrides(root, storageId) {
  await libReady;
  appliedRoots.set(storageId, root);
  const ov = loadAllOverrides()[storageId] || {};
  for (const serial of Object.keys(ov)) {
    const state = ov[serial];
    const meshes = meshesForSerial(root, serial);
    if (!meshes.length) continue;
    meshes.forEach(m => applyState(m, normalizeState(state), storageId));
  }
}

function normalizeState(state) {
  const s = { ...DEFAULT_STATE, ...(state || {}) };
  s.metalness = typeof s.metalness === 'number' ? s.metalness : DEFAULT_STATE.metalness;
  s.roughness = typeof s.roughness === 'number' ? s.roughness : DEFAULT_STATE.roughness;
  s.scale = typeof s.scale === 'number' ? s.scale : DEFAULT_STATE.scale;
  s.color = s.color || DEFAULT_STATE.color;
  s.normalMap = s.normalMap || null;
  s.roughnessMap = s.roughnessMap || null;
  return s;
}

// 二次确认弹窗：防止“恢复默认 / 清除本地保存”被误触。
function confirmAction(title, message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-card">
      <div class="confirm-title"></div>
      <div class="confirm-msg"></div>
      <div class="confirm-actions">
        <button class="confirm-cancel" type="button"></button>
        <button class="confirm-ok" type="button"></button>
      </div>
    </div>`;
  overlay.querySelector('.confirm-title').textContent = title;
  overlay.querySelector('.confirm-msg').textContent = message;
  overlay.querySelector('.confirm-cancel').textContent = '取消';
  overlay.querySelector('.confirm-ok').textContent = '确定';
  document.body.appendChild(overlay);

  const ok = overlay.querySelector('.confirm-ok');
  const cancel = overlay.querySelector('.confirm-cancel');
  const close = () => overlay.remove();
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  ok.addEventListener('click', () => { close(); onConfirm(); });
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  requestAnimationFrame(() => ok.focus());
}

function resetSelection() {
  if (!active) return;
  const isModel = active.root === getModelRoot();
  if (isModel) clearActiveSelection();
  const meshes = meshesForSerial(active.root, active.serial);
  meshes.forEach(m => {
    if (m.userData.__origMaterial) { m.material = m.userData.__origMaterial; delete m.userData.__origMaterial; }
  });
  delete overrides[active.serial];
  saveOverrides();
  if (isModel) selectSerialByName(active.serial);
  populateControlsFromActive();
  updatePanel();
}

function clearLocal() {
  clearMaterialOverrides();
  for (const [storageId, root] of appliedRoots) {
    if (!root) continue;
    root.traverse(o => {
      if (o.isMesh && o.userData.__origMaterial) { o.material = o.userData.__origMaterial; delete o.userData.__origMaterial; }
    });
  }
  overrides = {};
  markActiveMaps();
  if (active) populateControlsFromActive();
  updatePanel();
}

function loadAllOverrides() {
  return getMaterialOverrides();
}

function saveOverrides() {
  if (!active || !autoSave) return;
  setMaterialOverrides(active.storageId, overrides);
}
