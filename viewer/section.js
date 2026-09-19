// 剖面图：默认 XZ 平面（Y-up 世界），可拖动位置、切换 XY/YZ、旋转为斜平面。
// 通过 per-material clippingPlanes 只裁剪模型，不裁剪地面/网格/坐标轴/背景。
import * as THREE from 'three';

let renderer = null;
let modelRoot = null;
let plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let enabled = false;
let mode = 'xz';
let center = new THREE.Vector3();
let halfRange = 1;
const modelMaterials = new Set();

let toggleEl, posSlider, posVal, oblWrap, ang1Slider, ang2Slider;
const modeEls = [];

export function initSection(rendererRef, containerId) {
  renderer = rendererRef;
  if (renderer) renderer.localClippingEnabled = true;
  const panel = document.getElementById(containerId);
  if (!panel) return;
  toggleEl = document.getElementById('sectionToggle');
  posSlider = document.getElementById('sectionPos');
  posVal = document.getElementById('sectionPosVal');
  oblWrap = document.getElementById('sectionOblique');
  ang1Slider = document.getElementById('sectionAng1');
  ang2Slider = document.getElementById('sectionAng2');
  document.querySelectorAll('[data-section-mode]').forEach(b => modeEls.push(b));

  modeEls.forEach(b => b.addEventListener('click', () => setMode(b.dataset.sectionMode)));
  if (toggleEl) toggleEl.addEventListener('change', () => setEnabled(toggleEl.checked));
  if (posSlider) posSlider.addEventListener('input', apply);
  if (ang1Slider) ang1Slider.addEventListener('input', apply);
  if (ang2Slider) ang2Slider.addEventListener('input', apply);
}

function setMode(m) {
  mode = m;
  modeEls.forEach(b => b.classList.toggle('active', b.dataset.sectionMode === m));
  if (oblWrap) oblWrap.style.display = (m === 'free') ? 'block' : 'none';
  if (posSlider) posSlider.value = '0';
  apply();
}

function setEnabled(on) {
  enabled = on;
  for (const mat of modelMaterials) {
    mat.clippingPlanes = on ? [plane] : [];
    mat.needsUpdate = true;
  }
  apply();
}

export function setModelSection(root) {
  modelRoot = root;
  modelMaterials.clear();
  root.traverse(o => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => { modelMaterials.add(m); });
    }
  });
  for (const m of modelMaterials) m.side = THREE.DoubleSide;

  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) { center.set(0, 0, 0); halfRange = 1; }
  else {
    box.getCenter(center);
    const s = box.getSize(new THREE.Vector3());
    halfRange = Math.max(s.x, s.y, s.z) * 0.7;
  }
  if (posSlider) {
    posSlider.min = String((-halfRange).toFixed(3));
    posSlider.max = String(halfRange.toFixed(3));
    posSlider.step = String((halfRange / 100).toFixed(4));
    posSlider.value = '0';
  }
  if (enabled) { for (const m of modelMaterials) m.clippingPlanes = [plane]; }
  apply();
}

export function clearSection() {
  modelMaterials.clear();
  modelRoot = null;
  if (toggleEl) toggleEl.checked = false;
  setEnabled(false);
}

function normalForMode() {
  if (mode === 'xz') return new THREE.Vector3(0, 1, 0);
  if (mode === 'xy') return new THREE.Vector3(0, 0, 1);
  if (mode === 'yz') return new THREE.Vector3(1, 0, 0);
  const n = new THREE.Vector3(0, 1, 0);
  const a1 = THREE.MathUtils.degToRad(parseFloat((ang1Slider && ang1Slider.value) || 0));
  const a2 = THREE.MathUtils.degToRad(parseFloat((ang2Slider && ang2Slider.value) || 0));
  n.applyAxisAngle(new THREE.Vector3(1, 0, 0), a1);
  n.applyAxisAngle(new THREE.Vector3(0, 0, 1), a2);
  return n.normalize();
}

function apply() {
  const n = normalForMode();
  const off = parseFloat((posSlider && posSlider.value) || 0);
  plane.set(n, -(n.dot(center) + off));
  for (const mat of modelMaterials) mat.needsUpdate = true;
  if (posVal) posVal.textContent = off.toFixed(2);
}
