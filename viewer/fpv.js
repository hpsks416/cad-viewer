// FPV 相机配置：选中机器人上的零件作为第一人称相机锚点，并细调位置与方向。
// 工作流：第三人称下选零件设锚点 → 细调位置/方向（有 gizmo 可视化）→ 切「第一人称」验证 → 不合适切回再调。
//
// 坐标约定：
// - 锚点 anchorLocal 存「模型局部空间」，随机器人移动/缩放（用 root.matrixWorld 换算）。
// - 偏移 offsetWorld 存「世界空间」（米），便于直观细调；eye = localToWorld(anchorLocal) + offsetWorld。
// - 方向为世界系偏航 yaw / 俯仰 pitch（弧度），yaw=0 朝 +Z。
import * as THREE from 'three';
import { getActiveSerial } from './scene-tree.js';

const PITCH_LIMIT = THREE.MathUtils.degToRad(89); // 俯仰角上限（±89°）
const DEFAULT_EYE_FRAC = 0.72;                    // 默认眼位 = 模型底面起 72% 高度

let root = null;
let scene = null;

const anchorLocal = new THREE.Vector3();
const offsetWorld = new THREE.Vector3();
let yaw = 0, pitch = 0;

const defaultAnchorLocal = new THREE.Vector3();
let worldSize = 1;   // 模型世界包围盒最大边长，用于滑块范围与 gizmo 尺寸

// gizmo（第三人称下的锚点 + 朝向可视化）
let gizmoGroup = null;
let gizmoSphere = null;
let gizmoArrow = null;

// DOM
let setAnchorBtn, resetBtn;
let posXEl, posYEl, posZEl, yawEl, pitchEl;
let posXVal, posYVal, posZVal, yawVal, pitchVal;

export function initFpv(containerId, sceneRef) {
  scene = sceneRef;
  const panel = document.getElementById(containerId);
  if (!panel) return;

  setAnchorBtn = document.getElementById('fpvSetAnchor');
  resetBtn = document.getElementById('fpvReset');
  posXEl = document.getElementById('fpvPosX');
  posYEl = document.getElementById('fpvPosY');
  posZEl = document.getElementById('fpvPosZ');
  yawEl = document.getElementById('fpvDirYaw');
  pitchEl = document.getElementById('fpvDirPitch');
  posXVal = document.getElementById('fpvPosXVal');
  posYVal = document.getElementById('fpvPosYVal');
  posZVal = document.getElementById('fpvPosZVal');
  yawVal = document.getElementById('fpvDirYawVal');
  pitchVal = document.getElementById('fpvDirPitchVal');

  if (setAnchorBtn) setAnchorBtn.addEventListener('click', setAnchorToActive);
  if (resetBtn) resetBtn.addEventListener('click', resetConfig);

  const bindOffset = (el, axis) => {
    if (!el) return;
    el.addEventListener('input', () => { offsetWorld[axis] = parseFloat(el.value); syncOffsetDisplay(); });
  };
  bindOffset(posXEl, 'x');
  bindOffset(posYEl, 'y');
  bindOffset(posZEl, 'z');

  if (yawEl) yawEl.addEventListener('input', () => { yaw = THREE.MathUtils.degToRad(parseFloat(yawEl.value)); syncDirDisplay(); });
  if (pitchEl) pitchEl.addEventListener('input', () => { pitch = THREE.MathUtils.degToRad(parseFloat(pitchEl.value)); syncDirDisplay(); });

  buildGizmo();
}

function buildGizmo() {
  if (!scene) return;
  gizmoGroup = new THREE.Group();
  gizmoGroup.name = '__fpv_gizmo__';
  gizmoSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9, depthTest: false })
  );
  gizmoSphere.renderOrder = 999;
  gizmoArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0xffd166, 0.1, 0.05);
  if (gizmoArrow.line && gizmoArrow.line.material) { gizmoArrow.line.material.depthTest = false; gizmoArrow.line.renderOrder = 999; }
  if (gizmoArrow.cone && gizmoArrow.cone.material) { gizmoArrow.cone.material.depthTest = false; gizmoArrow.cone.renderOrder = 999; }
  gizmoGroup.add(gizmoSphere);
  gizmoGroup.add(gizmoArrow);
  gizmoGroup.visible = false;
  scene.add(gizmoGroup);
}

export function setModelFpv(newRoot) {
  const isNew = (root !== newRoot);   // 同一模型重放置不重置配置
  root = newRoot;
  if (!root) return;

  root.updateWorldMatrix(true, true);
  const worldBox = new THREE.Box3().setFromObject(root);
  if (worldBox.isEmpty()) { defaultAnchorLocal.set(0, 0.4, 0); worldSize = 1; if (isNew) resetConfig(); return; }

  const inv = root.matrixWorld.clone().invert();
  const localBox = worldBox.clone().applyMatrix4(inv);
  const c = localBox.getCenter(new THREE.Vector3());
  const size = localBox.getSize(new THREE.Vector3());
  defaultAnchorLocal.set(c.x, localBox.min.y + size.y * DEFAULT_EYE_FRAC, c.z);

  const ws = worldBox.getSize(new THREE.Vector3());
  worldSize = Math.max(ws.x, ws.y, ws.z) || 1;

  if (isNew) resetConfig();
}

function resetConfig() {
  anchorLocal.copy(defaultAnchorLocal);
  offsetWorld.set(0, 0, 0);
  yaw = 0;
  pitch = 0;
  syncControls();
}

function syncControls() {
  const r = Math.max(worldSize, 0.01);
  const half = r * 0.5;
  const step = (r / 100).toFixed(4);
  [posXEl, posYEl, posZEl].forEach(el => {
    if (!el) return;
    el.min = (-half).toFixed(3);
    el.max = half.toFixed(3);
    el.step = step;
  });
  if (posXEl) posXEl.value = offsetWorld.x.toFixed(3);
  if (posYEl) posYEl.value = offsetWorld.y.toFixed(3);
  if (posZEl) posZEl.value = offsetWorld.z.toFixed(3);
  if (yawEl) yawEl.value = String(Math.round(THREE.MathUtils.radToDeg(yaw)));
  if (pitchEl) pitchEl.value = String(Math.round(THREE.MathUtils.radToDeg(pitch)));
  syncOffsetDisplay();
  syncDirDisplay();
}

function syncOffsetDisplay() {
  if (posXVal) posXVal.textContent = offsetWorld.x.toFixed(2);
  if (posYVal) posYVal.textContent = offsetWorld.y.toFixed(2);
  if (posZVal) posZVal.textContent = offsetWorld.z.toFixed(2);
}

function syncDirDisplay() {
  const yawDeg = THREE.MathUtils.radToDeg(yaw);
  const pitchDeg = THREE.MathUtils.radToDeg(pitch);
  const yawNorm = ((Math.round(yawDeg) % 360) + 360) % 360;
  if (yawEl) yawEl.value = String(yawNorm);
  if (pitchEl) pitchEl.value = String(Math.round(pitchDeg));
  if (yawVal) yawVal.textContent = yawNorm + '°';
  if (pitchVal) pitchVal.textContent = Math.round(pitchDeg) + '°';
}

// 把锚点设为当前选中零件的几何中心（世界中心 → 模型局部空间）。
function setAnchorToActive() {
  if (!root) return;
  const serial = getActiveSerial();
  if (!serial) return;
  let node = null;
  root.traverse(o => { if (!node && o.name === serial) node = o; });
  if (!node) return;
  const box = new THREE.Box3().setFromObject(node);
  if (box.isEmpty()) return;
  const worldCenter = box.getCenter(new THREE.Vector3());
  root.updateWorldMatrix(true, true);
  anchorLocal.copy(worldCenter).applyMatrix4(root.matrixWorld.clone().invert());
}

export function getEyeWorld(out) {
  if (!root) { out.set(0, 0, 0); return out; }
  root.updateWorldMatrix(true, true);
  out.copy(anchorLocal).applyMatrix4(root.matrixWorld);
  out.add(offsetWorld);
  return out;
}

export function getDirection(out) {
  out.set(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  );
  return out;
}

export function getYawPitch() { return { yaw, pitch }; }

export function setYawPitch(yawRad, pitchRad) {
  yaw = yawRad;
  pitch = THREE.MathUtils.clamp(pitchRad, -PITCH_LIMIT, PITCH_LIMIT);
  syncDirDisplay();
}

// 每帧更新 gizmo（第三人称下显示锚点球 + 朝向箭头）。
export function updateGizmo(visible) {
  if (!gizmoGroup) return;
  const show = !!visible && !!root && !!root.parent;
  gizmoGroup.visible = show;
  if (!show) return;

  const eye = getEyeWorld(new THREE.Vector3());
  const dir = getDirection(new THREE.Vector3());
  gizmoSphere.scale.setScalar(Math.max(worldSize * 0.02, 0.02));
  gizmoGroup.position.copy(eye);
  gizmoArrow.setDirection(dir);
  gizmoArrow.setLength(
    Math.max(worldSize * 0.15, 0.15),
    Math.max(worldSize * 0.05, 0.05),
    Math.max(worldSize * 0.025, 0.025),
  );
}

export function clearFpv() {
  root = null;
  if (gizmoGroup) gizmoGroup.visible = false;
}
