// 爆炸视图：把装配体的序列号节点（A###/P###）沿径向或 X/Y/Z 轴向外展开，
// 强度滑块控制展开距离；关闭或加载新模型时还原所有节点位置。
// 与剖面图一致，只作用于模型本体（__loaded__），不动背景 / 地面 / 坐标轴。
//
// 实现说明：
// - 每个序列号节点记录其「装配态」局部位置 restPos，以及展开方向 dir（父级局部空间单位向量）。
// - 方向在模型加载/放置后、矩阵确定时计算（世界包围盒中心相对装配体中心的偏移），
//   再通过 parent.matrixWorld 的逆变换转回父级局部空间，因此对嵌套子装配体也正确。
// - 与「可动关节」互不影响：关节在 updateJoints 时缓存 restPos/restQuat 并从装配态推导，
//   爆炸只位移节点位置；若两者同时作用同一节点，以关节为优先（边角情形，可先关掉爆炸再调关节）。
import * as THREE from 'three';

let root = null;
let enabled = false;
let strength = 0.5;       // 0..1，展开系数
let direction = 'radial'; // radial | x | y | z
const entries = [];       // { node, restPos, dir }
let scale = 1;            // 展开基准距离 ≈ 装配体最大尺寸 * 0.35

let toggleEl, sliderEl, sliderVal, dirButtons = [];

export function initExplode(containerId) {
  const panel = document.getElementById(containerId);
  if (!panel) return;
  toggleEl = document.getElementById('explodeToggle');
  sliderEl = document.getElementById('explodeStrength');
  sliderVal = document.getElementById('explodeStrengthVal');
  dirButtons = Array.from(document.querySelectorAll('[data-explode-dir]'));

  if (toggleEl) toggleEl.addEventListener('change', () => { enabled = toggleEl.checked; apply(); });
  if (sliderEl) sliderEl.addEventListener('input', () => { strength = parseFloat(sliderEl.value); updateVal(); apply(); });
  dirButtons.forEach(b => b.addEventListener('click', () => setDirection(b.dataset.explodeDir)));
  setDirection(direction);
}

function updateVal() {
  if (sliderVal) sliderVal.textContent = (strength * 100).toFixed(0) + '%';
}

function setDirection(d) {
  direction = d;
  dirButtons.forEach(b => b.classList.toggle('active', b.dataset.explodeDir === d));
  apply();
}

// 先还原旧的展开位移，再按当前装配态重新采集，避免重复放置/重算时把爆炸位移「固化」成 restPos。
function restoreAll() {
  for (const e of entries) {
    if (e.node && e.node.parent) e.node.position.copy(e.restPos);
  }
}

export function setModelExplode(newRoot) {
  restoreAll();
  entries.length = 0;
  root = newRoot;
  scale = 1;
  if (!root) return;

  root.updateWorldMatrix(true, true);
  const assemblyBox = new THREE.Box3().setFromObject(root);
  if (assemblyBox.isEmpty()) return;
  const assemblyCenter = assemblyBox.getCenter(new THREE.Vector3());
  const size = assemblyBox.getSize(new THREE.Vector3());
  scale = Math.max(size.x, size.y, size.z) * 0.35;
  if (!isFinite(scale) || scale <= 0) scale = 1;

  root.traverse(o => {
    if (!/^[AP]\d{3}$/.test(o.name || '')) return;
    const box = new THREE.Box3().setFromObject(o);
    if (box.isEmpty()) return;
    const worldCenter = box.getCenter(new THREE.Vector3());
    const parent = o.parent || root;
    parent.updateWorldMatrix(true, true);
    const parentInv = parent.matrixWorld.clone().invert();

    let dir;
    if (direction === 'radial') {
      dir = worldCenter.clone().sub(assemblyCenter);
      if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0); // 恰在中心的零件：向上
      dir.normalize();
    } else {
      const axis = direction === 'x' ? new THREE.Vector3(1, 0, 0)
        : direction === 'y' ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
      const delta = worldCenter.clone().sub(assemblyCenter);
      const s = delta.dot(axis);
      dir = axis.clone().multiplyScalar(s >= 0 ? 1 : -1);
    }
    dir.transformDirection(parentInv).normalize();

    entries.push({ node: o, restPos: o.position.clone(), dir });
  });

  apply();
}

function apply() {
  for (const e of entries) {
    if (!e.node || !e.node.parent) continue;
    if (enabled) {
      e.node.position.copy(e.restPos).addScaledVector(e.dir, strength * scale);
    } else {
      e.node.position.copy(e.restPos);
    }
  }
}

export function clearExplode() {
  restoreAll();
  entries.length = 0;
  root = null;
  if (toggleEl) toggleEl.checked = false;
  enabled = false;
}
