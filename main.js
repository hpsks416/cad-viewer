import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { initJoints, updateJoints, clearJoints, getJointDragHandles, findJointByHandle, getJointWorld, applyJointValue, setJointHandleHover } from './viewer/joints.js';
import { initSceneTree, renderSceneTree, clearSceneTree, selectByObject } from './viewer/scene-tree.js';
import { initSection, setModelSection, clearSection } from './viewer/section.js';
import { initMaterials, setCurrentModelId, selectModelPart, selectPart, applyOverrides } from './viewer/materials.js';
import { loadState, getInitialPlacement, setInitialPlacement, clearInitialPlacement } from './viewer/state.js';

// 固定背景场景（仅渲染，不参与拾取 / 剖切 / 场景树 / 关节）。
const BACKGROUND = {
  glb: 'models/rmuc2026-arena.glb',
  meta: 'models/rmuc2026-arena.meta.json',
  // 世界单位：1 单位 = 1 米。GLB 归一化后最大尺寸为 2 单位，因此 scale = max_dim(mm) / 2000。
  toMeters: (maxDimMm) => (maxDimMm || 20000) / 2000,
};

// 默认落点（世界坐标，米；Y 自动贴合该处场地表面），仅在没有“已保存位置”时使用。
const DEFAULT_PLACEMENT = { x: -12.5, z: 6.0 };

function loadSavedPlacement() {
  const v = getInitialPlacement();
  if (v && typeof v.x === 'number' && typeof v.z === 'number') return { x: v.x, z: v.z };
  return null;
}
function savePlacement(x, z) {
  try { setInitialPlacement(x, z); } catch (e) {}
}
function clearSavedPlacement() {
  try { clearInitialPlacement(); } catch (e) {}
}

const app = document.getElementById('app');
const loading = document.getElementById('loading');
const modelList = document.getElementById('modelList');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.localClippingEnabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242c);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

// 标准 Y-up 世界（与 glTF / three.js 默认一致）。
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.005, 1000);
camera.position.set(0.8, 0.6, 1.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.minDistance = 0;
controls.maxDistance = Infinity;
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI;
controls.update();

// 光照：半球环境光 + 主光 + 冷色补光 + 轮廓光，让大场地更明亮、更有层次。
const hemi = new THREE.HemisphereLight(0xd8e6ff, 0x565666, 1.05);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xffffff, 2.8);
key.position.set(8, 14, 6);
scene.add(key);

const fill = new THREE.DirectionalLight(0xa8c4ff, 0.85);
fill.position.set(-7, 5, -5);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffffff, 1.6);
rim.position.set(0, 5, -11);
scene.add(rim);

// 地面 + 网格（无背景场景时作为占位；加载背景后隐藏）。
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x1b1b20, metalness: 0.25, roughness: 0.55 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.0;
ground.name = '__fallback_ground__';
scene.add(ground);

const grid = new THREE.GridHelper(12, 24, 0x3a3a44, 0x24242b);
grid.position.y = -0.99;
grid.name = '__fallback_grid__';
scene.add(grid);

scene.add(new THREE.AxesHelper(0.35));

const gltfLoader = new GLTFLoader();
const stlLoader = new STLLoader();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// 关节拖动状态：在转轴处按住高亮环即可绕轴旋转。
let dragJoint = null;    // { joint, pivot, axis, u, v, startAngle, startValue }
let hoveredHandle = null;

function setPointerFromEvent(e) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

function raycastJointHandle(e) {
  setPointerFromEvent(e);
  const handles = getJointDragHandles();
  if (!handles.length) return null;
  const hits = raycaster.intersectObjects(handles, false);
  return hits.length ? hits[0].object : null;
}

function beginJointDrag(handle) {
  const joint = findJointByHandle(handle);
  if (!joint) return false;
  const w = getJointWorld(joint);
  if (!w) return false;
  const startValue = joint.type === 'continuous'
    ? 0
    : (joint.slider ? parseFloat(joint.slider.value) : (joint.joint.default || 0));
  dragJoint = {
    joint,
    pivot: w.pivot,
    axis: w.axis,
    u: w.u,
    v: w.v,
    startAngle: 0,
    startValue,
    hasAngle: false,
  };
  controls.enabled = false;
  renderer.domElement.style.cursor = 'grabbing';
  return true;
}

function updateJointDrag(e) {
  if (!dragJoint) return false;
  setPointerFromEvent(e);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dragJoint.axis, dragJoint.pivot);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return true;
  const du = hit.clone().sub(dragJoint.pivot).dot(dragJoint.u);
  const dv = hit.clone().sub(dragJoint.pivot).dot(dragJoint.v);
  const angle = Math.atan2(dv, du);
  if (!dragJoint.hasAngle) {
    dragJoint.startAngle = angle;
    dragJoint.hasAngle = true;
  }
  let delta = angle - dragJoint.startAngle;
  // 处理从 -π 到 π 的跨越，保持连续增量。
  if (delta > Math.PI) delta -= Math.PI * 2;
  else if (delta < -Math.PI) delta += Math.PI * 2;
  applyJointValue(dragJoint.joint, dragJoint.startValue + THREE.MathUtils.radToDeg(delta));
  return true;
}

function endJointDrag() {
  if (!dragJoint) return;
  dragJoint = null;
  controls.enabled = true;
  renderer.domElement.style.cursor = '';
}

function updateJointHover(e) {
  if (dragJoint || placeMode || bgMatMode) return;
  const handle = raycastJointHandle(e);
  if (handle !== hoveredHandle) {
    if (hoveredHandle) setJointHandleHover(hoveredHandle, false);
    hoveredHandle = handle;
    if (handle) setJointHandleHover(handle, true);
  }
  renderer.domElement.style.cursor = hoveredHandle ? 'grab' : '';
}


let currentMeta = null;
let backgroundGroup = null;

function setLoading(on) { loading.style.display = on ? 'grid' : 'none'; }

function isBackground(obj) {
  let o = obj;
  while (o) {
    if (o.userData && o.userData.isBackground) return true;
    o = o.parent;
  }
  return false;
}

function frameObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const dir = new THREE.Vector3(1, 0.55, 0.8).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(dist * 1.35));
  controls.target.copy(center);
  controls.update();
}

function applyMeters(root, maxDimMm) {
  root.scale.setScalar(BACKGROUND.toMeters(maxDimMm));
}

function replaceLoaded(root) {
  const prev = scene.getObjectByName('__loaded__');
  if (prev) scene.remove(prev);
  root.name = '__loaded__';
  scene.add(root);
}

// Single-part models (a lone STL/GLB mesh) have no A/P serial nodes; name the mesh P001
// so it can be picked in the viewport, listed in the scene tree, and edited in the material panel.
function ensureSelectable(root) {
  let hasSerial = false;
  root.traverse(o => { if (/^[AP]\d{3}$/.test(o.name || '')) hasSerial = true; });
  if (hasSerial) return;
  let mesh = null;
  root.traverse(o => { if (!mesh && o.isMesh) mesh = o; });
  if (mesh) mesh.name = 'P001';
}

async function loadJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function loadJoints(root, url) {
  loadJson(url).then(spec => updateJoints(root, spec)).catch(() => clearJoints());
}

function loadGltf(url, jointsUrl, partsUrl, meta, modelId) {
  setLoading(true);
  clearJoints();
  clearSceneTree();
  clearSection();
  gltfLoader.load(url, (gltf) => {
    const root = gltf.scene;
    if (meta && meta.max_dim) applyMeters(root, meta.max_dim);
    replaceLoaded(root);
    ensureSelectable(root);
    currentMeta = meta || null;
    placeModelOnFloor();
    const finalizeParts = (parts) => {
      renderSceneTree(root, parts);
      setCurrentModelId(modelId);
      applyOverrides(root, 'model:' + (modelId || 'local'));
    };
    if (partsUrl) {
      loadJson(partsUrl).then(finalizeParts).catch(() => finalizeParts({}));
    } else {
      finalizeParts({});
    }
    if (jointsUrl) loadJoints(root, jointsUrl);
    setLoading(false);
  }, undefined, (err) => {
    console.error(err);
    setLoading(false);
    alert('加载失败：' + ((err && err.message) ? err.message : err));
  });
}

function loadStl(url, modelId) {
  setLoading(true);
  clearJoints();
  clearSceneTree();
  clearSection();
  stlLoader.load(url, (geometry) => {
    geometry.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.4 });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = 'P001';
    const group = new THREE.Group();
    group.add(mesh);
    replaceLoaded(group);
    currentMeta = null;
    frameObject(group);
    setModelSection(group);
    const parts = { P001: { name_en: modelId, name_zh: modelId, kind: 'part' } };
    renderSceneTree(group, parts);
    setCurrentModelId(modelId);
    applyOverrides(group, 'model:' + (modelId || 'local'));
    setLoading(false);
  }, undefined, (err) => {
    console.error(err);
    setLoading(false);
    alert('加载失败：' + ((err && err.message) ? err.message : err));
  });
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function loadFile(url, filename) {
  if (extOf(filename) === 'stl') loadStl(url, filename);
  else loadGltf(url, undefined, undefined, undefined, filename);
}

// 点击场地放置机器人（背景仅作一次性射线取点，不改动其余功能语义）。
let placeMode = false;
let bgMatMode = false;
let arenaParts = {};
const placeBtn = document.getElementById('placeBtn');
const bgMatBtn = document.getElementById('bgMatBtn');
if (placeBtn) placeBtn.addEventListener('click', () => { placeMode = !placeMode; if (placeMode) bgMatMode = false; syncModeButtons(); });
if (bgMatBtn) bgMatBtn.addEventListener('click', () => { bgMatMode = !bgMatMode; if (bgMatMode) placeMode = false; syncModeButtons(); });
function syncModeButtons() {
  if (placeBtn) { placeBtn.classList.toggle('active', placeMode); placeBtn.textContent = placeMode ? '点击场地放置机器人（激活）' : '点击场地放置机器人'; }
  if (bgMatBtn) { bgMatBtn.classList.toggle('active', bgMatMode); bgMatBtn.textContent = bgMatMode ? '编辑场地材质（激活）' : '编辑场地材质'; }
  if (!bgMatMode) clearBgSelection();
  renderer.domElement.style.cursor = (placeMode || bgMatMode) ? 'crosshair' : '';
}
const resetPlaceBtn = document.getElementById('resetPlaceBtn');
if (resetPlaceBtn) {
  resetPlaceBtn.addEventListener('click', () => {
    clearSavedPlacement();
    placeModelOnFloor();
  });
}

let backgroundMeshes = null;
let backgroundBox = null;
function getBackgroundMeshes() {
  if (!backgroundGroup) return [];
  if (!backgroundMeshes) {
    backgroundMeshes = [];
    backgroundGroup.traverse(o => { if (o.isMesh) backgroundMeshes.push(o); });
  }
  return backgroundMeshes;
}
function getBackgroundBox() {
  if (!backgroundGroup) return null;
  if (!backgroundBox) backgroundBox = new THREE.Box3().setFromObject(backgroundGroup);
  return backgroundBox;
}

// 在 (x,z) 正上方垂直向下做射线，返回场地真实表面高度（世界 Y）；未命中返回 null。
function surfaceYAt(x, z) {
  const meshes = getBackgroundMeshes();
  const abox = getBackgroundBox();
  if (!meshes.length || !abox) return null;
  const top = abox.max.y + 10;
  raycaster.set(new THREE.Vector3(x, top, z), new THREE.Vector3(0, -1, 0));
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length ? hits[0].point.y : null;
}

// 把当前模型水平移动到 (x,z)，底面贴合该处场地表面；不改变相机视角。
function placeModelAt(x, z) {
  const model = scene.getObjectByName('__loaded__');
  if (!model) return;
  if (backgroundGroup) {
    const abox = getBackgroundBox();
    const mbox = new THREE.Box3().setFromObject(model);
    if (abox && !abox.isEmpty() && !mbox.isEmpty()) {
      const surfaceY = surfaceYAt(x, z);
      if (surfaceY === null) return;
      modelBottomY = surfaceY;
      // 局部底面偏移 = 世界包围盒底 - 当前原点位置，避免重复放置时叠加旧位移。
      const localBottom = mbox.min.y - model.position.y;
      model.position.set(x, surfaceY - localBottom, z);
    }
  }
  setModelSection(model);
}

// 采样中心及周围若干点，取表面最低者作为“场地地面”默认落点，避开中央高台等凸起结构。
function findFloorDefault() {
  const abox = getBackgroundBox();
  if (!abox) return null;
  const c = abox.getCenter(new THREE.Vector3());
  const probes = [[0, 0]];
  for (let r = 1; r <= 3; r++) {
    const d = 3 * r;
    probes.push([d, 0], [-d, 0], [0, d], [0, -d]);
  }
  let best = null;
  let bestY = Infinity;
  for (const [dx, dz] of probes) {
    const y = surfaceYAt(c.x + dx, c.z + dz);
    if (y !== null && y < bestY) { bestY = y; best = [c.x + dx, c.z + dz]; }
  }
  return best || [c.x, c.z];
}

function placeModelOnFloor() {
  const model = scene.getObjectByName('__loaded__');
  if (!model) return;
  if (backgroundGroup) {
    const saved = loadSavedPlacement();
    const p = saved
      ? [saved.x, saved.z]
      : (DEFAULT_PLACEMENT ? [DEFAULT_PLACEMENT.x, DEFAULT_PLACEMENT.z] : findFloorDefault());
    if (p) {
      placeModelAt(p[0], p[1]);
      frameObject(model);
      return;
    }
  }
  frameObject(model);
  setModelSection(model);
}

async function loadBackground() {
  try {
    const meta = await loadJson(BACKGROUND.meta).catch(() => null);
    gltfLoader.load(BACKGROUND.glb, (gltf) => {
      const root = gltf.scene;
      root.name = '__background__';
      root.traverse(o => { if (o.isMesh) o.userData.isBackground = true; });
      applyMeters(root, (meta && meta.max_dim) || 20000);
      scene.add(root);
      backgroundGroup = root;
      loadJson('models/rmuc2026-arena.parts.json').then(p => { arenaParts = p || {}; }).catch(() => {});
      applyOverrides(root, 'arena');
      const fg = scene.getObjectByName('__fallback_ground__');
      const fg2 = scene.getObjectByName('__fallback_grid__');
      if (fg) fg.visible = false;
      if (fg2) fg2.visible = false;
      placeModelOnFloor();
    }, undefined, (err) => {
      console.warn('背景场景加载失败：', err);
    });
  } catch (e) {
    console.warn('背景场景不可用：', e);
  }
}

async function loadManifest() {
  try {
    const r = await fetch('models/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const models = data.models || [];
    renderModelList(models);
    if (models.length) selectModel(models[0]);
  } catch (e) {
    modelList.innerHTML = '<li class="empty">未找到 models/manifest.json<br/>请先运行 python run.py --build</li>';
  }
}

function renderModelList(models) {
  modelList.innerHTML = '';
  models.forEach((m) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.id = m.id;
    if (m.preview) {
      const img = document.createElement('img');
      img.src = m.preview;
      img.alt = '';
      img.loading = 'lazy';
      btn.appendChild(img);
    }
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = m.name || m.id;
    btn.appendChild(nm);
    btn.addEventListener('click', () => selectModel(m));
    li.appendChild(btn);
    modelList.appendChild(li);
  });
}

let activeBtn = null;
function selectModel(m) {
  if (activeBtn) activeBtn.classList.remove('active');
  const btn = modelList.querySelector('button[data-id="' + m.id + '"]');
  if (btn) { btn.classList.add('active'); activeBtn = btn; }
  loadGltf(m.glb, m.joints, m.parts, m.meta, m.id);
}

document.getElementById('openFile').addEventListener('click', () => fileInput.click());
document.getElementById('resetView').addEventListener('click', () => {
  const loaded = scene.getObjectByName('__loaded__');
  if (loaded) frameObject(loaded);
  else { camera.position.set(0.8, 0.6, 1.0); controls.target.set(0, 0, 0); controls.update(); }
});

const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (f) loadFile(URL.createObjectURL(f), f.name);
});

window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(URL.createObjectURL(f), f.name);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 在 root 下找到 mesh 最近的序列号祖先（如 A039 / P597）。
function serialAncestor(root, mesh) {
  let o = mesh;
  while (o && o !== root) {
    if (/^[AP]\d{3}$/.test(o.name || '')) return o;
    o = o.parent;
  }
  return null;
}

let bgSelHelper = null;
function showBgSelection(obj) {
  clearBgSelection();
  if (!obj) return;
  const box = new THREE.Box3().setFromObject(obj);
  bgSelHelper = new THREE.Box3Helper(box, 0x4d7cff);
  scene.add(bgSelHelper);
}
function clearBgSelection() {
  if (bgSelHelper) { scene.remove(bgSelHelper); bgSelHelper = null; }
}

// 射线拾取：左键点击（非拖拽）选中零件并高亮；背景场景不参与拾取。
let downX = 0, downY = 0;
// capture=true：在 OrbitControls 之前先判断是否命中关节拖动环，
// 命中就临时关闭 OrbitControls，避免它抢占同一段拖拽。
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // 放置 / 场地材质模式下不抢占关节拖拽。
  if (!placeMode && !bgMatMode) {
    const handle = raycastJointHandle(e);
    if (handle) {
      if (beginJointDrag(handle)) e.stopPropagation();
      return;
    }
  }
  downX = e.clientX;
  downY = e.clientY;
}, true);
window.addEventListener('pointermove', (e) => {
  if (dragJoint) { updateJointDrag(e); }
  else if (e.target === renderer.domElement) { updateJointHover(e); }
});
window.addEventListener('pointerup', () => {
  endJointDrag();
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  if (dragJoint) { endJointDrag(); return; }
  const dx = e.clientX - downX, dy = e.clientY - downY;
  if (Math.sqrt(dx * dx + dy * dy) > 5) return;
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  // 放置模式：对场地做射线检测，把机器人移到点击处表面。
  if (placeMode) {
    const bgMeshes = getBackgroundMeshes();
    if (bgMeshes.length) {
      const hits = raycaster.intersectObjects(bgMeshes, false);
      if (hits.length) {
        const p = hits[0].point;
        placeModelAt(p.x, p.z);
        savePlacement(p.x, p.z);
      }
    }
    return;
  }

  // 编辑场地材质模式：点选场地零件，供右侧材质面板赋材质。
  if (bgMatMode) {
    const bgMeshes = getBackgroundMeshes();
    if (bgMeshes.length) {
      const hits = raycaster.intersectObjects(bgMeshes, false);
      if (hits.length) {
        const anc = serialAncestor(backgroundGroup, hits[0].object);
        if (anc) {
          const info = arenaParts[anc.name] || {};
          selectPart(anc.name, backgroundGroup, info.name_zh || info.name_en || anc.name, 'arena');
          showBgSelection(anc);
        }
      }
    }
    return;
  }

  const loaded = scene.getObjectByName('__loaded__');
  if (!loaded) return;
  const meshes = [];
  loaded.traverse(o => { if (o.isMesh && !isBackground(o)) meshes.push(o); });
  const hits = raycaster.intersectObjects(meshes, false);
  selectByObject(hits.length ? hits[0].object : null);
  clearBgSelection();
});

initJoints('jointPanel');
initSceneTree('sceneTree', (serial) => selectModelPart(serial));
initSection(renderer, 'sectionPanel');
initMaterials('materialPanel');

// Arena occlusion fade: when the camera dips below the model's floor level,
// fade the arena so the model stays visible (common 3D viewer behavior).
const clock = new THREE.Clock();
const ARENA_FADE_MIN = 0.18;
const ARENA_FADE_SPEED = 6.0;
const ARENA_FADE_MARGIN = 0.3;
let arenaFadeCurrent = 1.0;
let arenaFadeTransparent = false;
let modelBottomY = null;

function collectArenaMaterials() {
  if (!backgroundGroup) return [];
  const set = new Set();
  backgroundGroup.traverse(o => {
    if (o.isMesh && o.userData.isBackground) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach(m => { if (m && m.isMaterial) set.add(m); });
    }
  });
  return Array.from(set);
}

function updateArenaFade(dt) {
  if (!backgroundGroup) return;
  const mats = collectArenaMaterials();

  const occluded = (modelBottomY !== null && camera.position.y < modelBottomY + ARENA_FADE_MARGIN);
  const target = occluded ? ARENA_FADE_MIN : 1.0;
  const k = 1 - Math.exp(-ARENA_FADE_SPEED * dt);
  arenaFadeCurrent += (target - arenaFadeCurrent) * k;
  if (arenaFadeCurrent >= 1.0) arenaFadeCurrent = 1.0;

  const transparent = arenaFadeCurrent < 0.999;
  for (const m of mats) {
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.depthWrite = !transparent;
      m.needsUpdate = true;
    }
    if (transparent && m.opacity !== arenaFadeCurrent) m.opacity = arenaFadeCurrent;
  }
  arenaFadeTransparent = transparent;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  updateArenaFade(dt);
  controls.update();
  renderer.render(scene, camera);
}
animate();
loadState().then(() => {
  loadBackground();
  loadManifest();
});

window.CADViewer = { loadManifest };
