import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { initJoints, updateJoints, clearJoints, getJointDragHandles, findJointByHandle, getJointWorld, applyJointValue, setJointHandleHover } from './viewer/joints.js';
import { initSceneTree, renderSceneTree, clearSceneTree, selectByObject } from './viewer/scene-tree.js';
import { initSection, setModelSection, clearSection } from './viewer/section.js';
import { initExplode, setModelExplode, clearExplode } from './viewer/explode.js';
import { initFpv, setModelFpv, clearFpv, getEyeWorld, getDirection, getYawPitch, setYawPitch, updateGizmo } from './viewer/fpv.js';
import { initMaterials, setCurrentModelId, selectModelPart, selectPart, applyOverrides } from './viewer/materials.js';
import { loadState, getInitialPlacement, setInitialPlacement, clearInitialPlacement } from './viewer/state.js';
import { importStepFile, importStepUrl } from './viewer/step-import.js';
import { initMeasure, isMeasureEnabled, addMeasurePoint, clearMeasure } from './viewer/measure.js';

// 固定背景场景（仅渲染，不参与拾取 / 剖切 / 场景树 / 关节）。
const BACKGROUND = {
  glb: 'models/rmuc2026-arena.glb',
  meta: 'models/rmuc2026-arena.meta.json',
  // 世界单位：1 单位 = 1 米。GLB 归一化后最大尺寸为 2 单位，因此 scale = max_dim(mm) / 2000。
  toMeters: (maxDimMm) => (maxDimMm || 20000) / 2000,
};

// 默认落点（世界坐标，米；Y 自动贴合该处场地表面），仅在没有“已保存位置”时使用。
const DEFAULT_PLACEMENT = { x: -12.5, z: 6.0 };

// WASD 驾驶参数（世界单位 = 米）。
const WALK_SPEED = 2.5;
const JUMP_SPEED = 4.0;
const GRAVITY = 9.8;

// 驾驶手感 / 第三人称跟随相机参数
const DRIVE_ACCEL = 8.0;
const DRIVE_DECEL = 6.0;
const CAM_FOLLOW_SPEED = 8.0;
const ORBIT_SENS = 0.004;
const FOLLOW_PITCH_MIN = 0.06;
const FOLLOW_PITCH_MAX = 1.45;
const FOLLOW_DIST_MIN = 0.8;
const FOLLOW_DIST_MAX = 40.0;

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
gltfLoader.setMeshoptDecoder(MeshoptDecoder); // 支持 EXT_meshopt_compression 压缩的 GLB
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('lib/libs/draco/');
gltfLoader.setDRACOLoader(dracoLoader); // 支持 KHR_draco_mesh_compression 压缩的 GLB
const stlLoader = new STLLoader();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// 关节拖动状态：在转轴处按住高亮环即可绕轴旋转。
let dragJoint = null;    // { joint, pivot, axis, u, v, startAngle, startValue }
let hoveredHandle = null;

// WASD 驾驶模式（可选操作模式）：碰撞体积 + 场地空气墙 + 键盘位移。
let driveMode = false;
let driveKeys = Object.create(null);
let driveVy = 0;              // 垂直速度（跳跃 / 重力）
let driveGrounded = true;
let modelLocalBottom = 0;     // 模型原点到底面的世界高度偏移
let modelHalfExtents = null;  // 缓存的模型 AABB 半尺寸（米）
let lastDriveSave = 0;
let driveVel = new THREE.Vector3();   // 平滑后的水平速度
let driveOrbiting = false;            // 驾驶模式下鼠标环绕中
let followYaw = 0, followPitch = 0.6, followDist = 6;
const followCamPos = new THREE.Vector3();
let fpvMode = false;
let fpvLooking = false;

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
  if (dragJoint || placeMode || bgMatMode || driveMode) return;
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
  clearMeasure();
  root.name = '__loaded__';
  scene.add(root);
  modelHalfExtents = null;
  modelLocalBottom = 0;
  modelBottomY = null;
  driveVy = 0;
  driveGrounded = true;
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
  clearExplode();
  clearFpv();
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
  clearExplode();
  clearFpv();
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
    setModelExplode(group);
    setModelFpv(group);
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

// 浏览器内直接解析 STEP/STP（occt-import-js WASM），无需 Blender / OCP 服务端。
// src 可为 File（本地拖拽/选择）或 URL 字符串（如 GitHub Pages 演示 ?step=）。
async function loadStep(src, id) {
  setLoading(true);
  clearJoints();
  clearSceneTree();
  clearSection();
  clearExplode();
  clearFpv();
  try {
    const { group, parts } = (typeof src === 'string')
      ? await importStepUrl(src)
      : await importStepFile(src);
    replaceLoaded(group);
    currentMeta = null;
    frameObject(group);
    setModelSection(group);
    setModelExplode(group);
    setModelFpv(group);
    renderSceneTree(group, parts);
    setCurrentModelId(id);
    applyOverrides(group, 'model:' + (id || 'local'));
  } catch (err) {
    console.error(err);
    alert('STEP 加载失败：' + ((err && err.message) ? err.message : err));
  } finally {
    setLoading(false);
  }
}

function loadLocalFile(f) {
  const ext = extOf(f.name);
  if (ext === 'step' || ext === 'stp') loadStep(f, f.name);
  else loadFile(URL.createObjectURL(f), f.name);
}

// 点击场地放置机器人（背景仅作一次性射线取点，不改动其余功能语义）。
let placeMode = false;
let bgMatMode = false;
let arenaParts = {};
const placeBtn = document.getElementById('placeBtn');
const bgMatBtn = document.getElementById('bgMatBtn');
const driveBtn = document.getElementById('driveBtn');
const fpvBtn = document.getElementById('fpvBtn');
if (placeBtn) placeBtn.addEventListener('click', () => { placeMode = !placeMode; if (placeMode) { bgMatMode = false; if (driveMode) { driveMode = false; exitDrive(); } if (fpvMode) { fpvMode = false; exitFpv(); } } syncModeButtons(); });
if (bgMatBtn) bgMatBtn.addEventListener('click', () => { bgMatMode = !bgMatMode; if (bgMatMode) { placeMode = false; if (driveMode) { driveMode = false; exitDrive(); } if (fpvMode) { fpvMode = false; exitFpv(); } } syncModeButtons(); });
if (driveBtn) driveBtn.addEventListener('click', () => {
  driveMode = !driveMode;
  driveKeys = Object.create(null);
  driveVy = 0; driveGrounded = true;
  if (driveMode) { placeMode = false; bgMatMode = false; if (fpvMode) { fpvMode = false; exitFpv(); } enterDrive(); }
  else { exitDrive(); }
  const m = scene.getObjectByName('__loaded__');
  if (m) savePlacement(m.position.x, m.position.z);
  syncModeButtons();
});
if (fpvBtn) fpvBtn.addEventListener('click', () => {
  fpvMode = !fpvMode;
  driveKeys = Object.create(null);
  driveVy = 0; driveGrounded = true;
  if (fpvMode) { placeMode = false; bgMatMode = false; if (driveMode) { driveMode = false; exitDrive(); } enterFpv(); }
  else { exitFpv(); }
  const m = scene.getObjectByName('__loaded__');
  if (m) savePlacement(m.position.x, m.position.z);
  syncModeButtons();
});
function syncModeButtons() {
  if (placeBtn) { placeBtn.classList.toggle('active', placeMode); placeBtn.textContent = placeMode ? '点击场地放置机器人（激活）' : '点击场地放置机器人'; }
  if (bgMatBtn) { bgMatBtn.classList.toggle('active', bgMatMode); bgMatBtn.textContent = bgMatMode ? '编辑场地材质（激活）' : '编辑场地材质'; }
  if (driveBtn) { driveBtn.classList.toggle('active', driveMode); driveBtn.textContent = driveMode ? '驾驶模式（激活）' : '驾驶模式（WASD）'; }
  if (fpvBtn) { fpvBtn.classList.toggle('active', fpvMode); fpvBtn.textContent = fpvMode ? '第一人称（激活）' : '第一人称（FPV）'; }
  const driveHint = document.getElementById('driveHint');
  if (driveHint) driveHint.style.display = driveMode ? 'block' : 'none';
  const fpvHint = document.getElementById('fpvHint');
  if (fpvHint) fpvHint.style.display = fpvMode ? 'block' : 'none';
  if (!bgMatMode) clearBgSelection();
  renderer.domElement.style.cursor = (driveMode || fpvMode) ? 'move' : ((placeMode || bgMatMode || isMeasureEnabled()) ? 'crosshair' : '');
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
      modelLocalBottom = localBottom;
      const size = mbox.getSize(new THREE.Vector3());
      modelHalfExtents = { x: size.x / 2, y: size.y / 2, z: size.z / 2 };
      model.position.set(x, surfaceY - localBottom, z);
    }
  }
  setModelSection(model);
  setModelExplode(model);
  setModelFpv(model);
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
  setModelExplode(model);
  setModelFpv(model);
}

// ---- WASD 驾驶模式：碰撞体积 + 场地空气墙 + 键盘位移 ----
function getModelRoot() { return scene.getObjectByName('__loaded__'); }

function getModelHalfExtents() {
  if (!modelHalfExtents) {
    const model = getModelRoot();
    if (model) {
      const box = new THREE.Box3().setFromObject(model);
      if (!box.isEmpty()) {
        const s = box.getSize(new THREE.Vector3());
        modelHalfExtents = { x: s.x / 2, y: s.y / 2, z: s.z / 2 };
      }
    }
  }
  return modelHalfExtents;
}

function getArenaBounds() {
  const box = getBackgroundBox();
  if (!box) return null;
  return { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };
}

// 用碰撞体积（AABB 半宽）把机器人中心夹在场地空气墙内。
function clampToArena(x, z) {
  const b = getArenaBounds();
  const half = getModelHalfExtents();
  if (!b || !half) return { x, z };
  const loX = b.minX + half.x, hiX = b.maxX - half.x;
  const loZ = b.minZ + half.z, hiZ = b.maxZ - half.z;
  return {
    x: (hiX >= loX) ? Math.min(hiX, Math.max(loX, x)) : b.minX,
    z: (hiZ >= loZ) ? Math.min(hiZ, Math.max(loZ, z)) : b.minZ,
  };
}

// 驱动时的地面采样：节流到约 30Hz，避免对超大场地逐帧多次射线。
let groundCache = { x: null, z: null, y: null, t: 0 };
function driveGroundY(x, z) {
  const now = performance.now();
  const moved = groundCache.y === null || Math.hypot(x - groundCache.x, z - groundCache.z) > 0.15;
  if (!moved && now - groundCache.t < 33) return groundCache.y;
  const y = surfaceYAt(x, z);
  groundCache.x = x; groundCache.z = z; groundCache.t = now;
  if (y !== null) groundCache.y = y;
  return groundCache.y;
}

function enterDrive() {
  controls.enabled = false;
  driveOrbiting = false;
  driveVel.set(0, 0, 0);
  const model = getModelRoot();
  const target = model ? model.position : new THREE.Vector3();
  const off = camera.position.clone().sub(target);
  const d = Math.max(off.length(), FOLLOW_DIST_MIN);
  followDist = Math.min(d, FOLLOW_DIST_MAX);
  followYaw = Math.atan2(off.x, off.z);
  followPitch = Math.asin(THREE.MathUtils.clamp(off.y / followDist, -1, 1));
  followPitch = Math.min(FOLLOW_PITCH_MAX, Math.max(FOLLOW_PITCH_MIN, followPitch));
  followCamPos.copy(camera.position);
}

function exitDrive() {
  driveOrbiting = false;
  controls.enabled = true;
  const model = getModelRoot();
  if (model) controls.target.copy(model.position);
  controls.update();
}

function updateFollowCamera(dt) {
  const model = getModelRoot();
  if (!model) return;
  const target = model.position;
  const half = getModelHalfExtents();
  const lookY = target.y + modelLocalBottom + (half ? half.y : 0.25);
  const desired = new THREE.Vector3(
    target.x + followDist * Math.cos(followPitch) * Math.sin(followYaw),
    target.y + followDist * Math.sin(followPitch),
    target.z + followDist * Math.cos(followPitch) * Math.cos(followYaw),
  );
  if (desired.y < target.y + 0.12) desired.y = target.y + 0.12;
  followCamPos.lerp(desired, 1 - Math.exp(-CAM_FOLLOW_SPEED * dt));
  camera.position.copy(followCamPos);
  camera.lookAt(target.x, lookY, target.z);
}

function updateMovement(dt) {
  const model = getModelRoot();
  if (!model || !backgroundGroup) return false;

  // 相机朝向投影到 XZ 平面，W/S 前进后退，A/D 左右平移。
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

  const ix = (driveKeys['KeyD'] || driveKeys['ArrowRight'] ? 1 : 0) - (driveKeys['KeyA'] || driveKeys['ArrowLeft'] ? 1 : 0);
  const iz = (driveKeys['KeyW'] || driveKeys['ArrowUp'] ? 1 : 0) - (driveKeys['KeyS'] || driveKeys['ArrowDown'] ? 1 : 0);
  const move = new THREE.Vector3().addScaledVector(fwd, iz).addScaledVector(right, ix);
  if (move.lengthSq() > 1e-6) move.normalize();

  // 平滑加减速，避免瞬间全速 / 急停。
  const targetVel = move.clone().multiplyScalar(WALK_SPEED);
  const accel = (move.lengthSq() > 1e-6) ? DRIVE_ACCEL : DRIVE_DECEL;
  driveVel.lerp(targetVel, 1 - Math.exp(-accel * dt));

  const clamp = clampToArena(model.position.x + driveVel.x * dt, model.position.z + driveVel.z * dt);
  const groundY = driveGroundY(clamp.x, clamp.z);
  if (groundY === null) return false;
  const bottomTarget = groundY - modelLocalBottom;

  let ny = model.position.y;
  if (driveKeys['Space'] && driveGrounded) { driveVy = JUMP_SPEED; driveGrounded = false; }
  if (!driveGrounded) {
    driveVy -= GRAVITY * dt;
    ny += driveVy * dt;
    if (ny <= bottomTarget) { ny = bottomTarget; driveVy = 0; driveGrounded = true; }
  } else {
    ny = bottomTarget;
  }

  model.position.set(clamp.x, ny, clamp.z);
  modelBottomY = ny + modelLocalBottom;

  const speedEl = document.getElementById('driveSpeed');
  if (speedEl) speedEl.textContent = driveVel.length().toFixed(1);
  const fpvSpeedEl = document.getElementById('fpvSpeed');
  if (fpvSpeedEl) fpvSpeedEl.textContent = driveVel.length().toFixed(1);

  const now = performance.now();
  if (now - lastDriveSave > 300) {
    lastDriveSave = now;
    savePlacement(clamp.x, clamp.z);
  }
  return true;
}

function updateDrive(dt) {
  if (!driveMode) return;
  if (!updateMovement(dt)) return;
  updateFollowCamera(dt);
}

function enterFpv() {
  controls.enabled = false;
  fpvLooking = false;
  driveVel.set(0, 0, 0);
  updateFpvCamera();
}

function exitFpv() {
  fpvLooking = false;
  controls.enabled = true;
  const model = getModelRoot();
  if (model) controls.target.copy(model.position);
  controls.update();
}

function updateFpvCamera() {
  if (!getModelRoot()) return;
  const eye = getEyeWorld(new THREE.Vector3());
  const fwd = getDirection(new THREE.Vector3());
  camera.position.copy(eye);
  camera.lookAt(eye.x + fwd.x, eye.y + fwd.y, eye.z + fwd.z);
}

function updateFpv(dt) {
  if (!fpvMode) return;
  updateMovement(dt);
  updateFpvCamera();
}

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if (!driveMode || isTyping()) return;
  const codes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  if (codes.includes(e.code)) {
    driveKeys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => { driveKeys[e.code] = false; });
window.addEventListener('blur', () => { driveKeys = Object.create(null); });
renderer.domElement.addEventListener('wheel', (e) => {
  if (!driveMode) return;
  e.preventDefault();
  followDist = Math.min(FOLLOW_DIST_MAX, Math.max(FOLLOW_DIST_MIN, followDist * (1 + e.deltaY * 0.001)));
}, { passive: false });

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

async function loadManifest(selectId) {
  try {
    const r = await fetch('models/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const models = data.models || [];
    renderModelList(models);
    if (models.length) {
      const target = selectId ? models.find((m) => m.id === selectId) : null;
      selectModel(target || models[0]);
    }
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

// LOD：模型导出后若存在 <slug>.lod.json（tools/lod.mjs 产出），提供细节级别切换。
let lodModel = null; // { base, joints, parts, meta, id, levels }

function lodManifestUrl(glbUrl) {
  return glbUrl.replace(/\.glb$/i, '') + '.lod.json';
}

async function checkLod(m) {
  const sel = document.getElementById('lodSelect');
  const row = document.getElementById('lodRow');
  if (!sel || !row) return;
  lodModel = null;
  row.style.display = 'none';
  sel.innerHTML = '';
  try {
    const r = await fetch(lodManifestUrl(m.glb), { cache: 'no-store' });
    if (!r.ok) return;
    const manifest = await r.json();
    const levels = (manifest && manifest.levels) || [];
    if (!levels.length) return;
    lodModel = { base: m.glb, joints: m.joints, parts: m.parts, meta: m.meta, id: m.id, levels };
    const opt0 = document.createElement('option');
    opt0.value = 'base';
    opt0.textContent = 'LOD0（原始）';
    sel.appendChild(opt0);
    levels.forEach(lv => {
      const o = document.createElement('option');
      o.value = lv.name;
      o.textContent = lv.name.toUpperCase() + '（' + Math.round(lv.ratio * 100) + '% 面数）';
      sel.appendChild(o);
    });
    row.style.display = 'block';
  } catch (e) { /* 无 LOD manifest，静默 */ }
}

function onLodChange() {
  if (!lodModel) return;
  const v = document.getElementById('lodSelect').value;
  const target = v === 'base'
    ? lodModel.base
    : lodModel.base.replace(/\.glb$/i, '') + '.' + v + '.glb';
  loadGltf(target, lodModel.joints, lodModel.parts, lodModel.meta, lodModel.id);
}

function selectModel(m) {
  if (activeBtn) activeBtn.classList.remove('active');
  const btn = modelList.querySelector('button[data-id="' + m.id + '"]');
  if (btn) { btn.classList.add('active'); activeBtn = btn; }
  loadGltf(m.glb, m.joints, m.parts, m.meta, m.id);
  checkLod(m);
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
  if (f) loadLocalFile(f);
});

window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadLocalFile(f);
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
let fpvLastX = 0, fpvLastY = 0;   // FPV 环绕的增量基准，与「点击/拖拽判定」的 downX/downY 分离
// capture=true：在 OrbitControls 之前先判断是否命中关节拖动环，
// 命中就临时关闭 OrbitControls，避免它抢占同一段拖拽。
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (driveMode) { driveOrbiting = true; downX = e.clientX; downY = e.clientY; return; }
  if (fpvMode) { fpvLooking = true; downX = e.clientX; downY = e.clientY; fpvLastX = e.clientX; fpvLastY = e.clientY; return; }
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
  if (driveMode && driveOrbiting) {
    const dx = e.clientX - downX, dy = e.clientY - downY;
    followYaw -= dx * ORBIT_SENS;
    followPitch += dy * ORBIT_SENS;
    followPitch = Math.min(FOLLOW_PITCH_MAX, Math.max(FOLLOW_PITCH_MIN, followPitch));
    downX = e.clientX; downY = e.clientY;
    return;
  }
  if (fpvMode && fpvLooking) {
    const dx = e.clientX - fpvLastX, dy = e.clientY - fpvLastY;
    const cur = getYawPitch();
    setYawPitch(cur.yaw - dx * ORBIT_SENS, cur.pitch + dy * ORBIT_SENS);
    fpvLastX = e.clientX; fpvLastY = e.clientY;
    return;
  }
  if (dragJoint) { updateJointDrag(e); }
  else if (e.target === renderer.domElement) { updateJointHover(e); }
});
window.addEventListener('pointerup', () => {
  if (driveOrbiting) driveOrbiting = false;
  if (fpvLooking) fpvLooking = false;
  endJointDrag();
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  if (dragJoint) { endJointDrag(); return; }
  if (driveMode) return;
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

  // 测量模式：点选模型表面记录测距点（优先级在零件选中之前）。
  if (isMeasureEnabled()) {
    const mroot = scene.getObjectByName('__loaded__');
    if (mroot) {
      const mlist = [];
      mroot.traverse(o => { if (o.isMesh && !isBackground(o)) mlist.push(o); });
      const mhits = raycaster.intersectObjects(mlist, false);
      if (mhits.length) addMeasurePoint(mhits[0].point);
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
initExplode('explodePanel');
initFpv('fpvPanel', scene);
initMaterials('materialPanel');
initMeasure(scene, 'measurePanel', () => syncModeButtons());
const lodSel = document.getElementById('lodSelect');
if (lodSel) lodSel.addEventListener('change', onLodChange);

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
  if (driveMode) { updateDrive(dt); }
  else if (fpvMode) { updateFpv(dt); }
  else { controls.update(); }
  updateGizmo(!driveMode && !fpvMode);
  renderer.render(scene, camera);
}
animate();
loadState().then(() => {
  loadBackground();
  // 支持 ?step=<url> 在启动时直接加载 STEP（GitHub Pages 在线演示用）；
  // 无参数时回落到 models/manifest.json 常规清单。
  const stepParam = new URLSearchParams(location.search).get('step');
  if (stepParam) loadStep(stepParam, stepParam);
  else loadManifest();
});

window.CADViewer = { loadManifest };
