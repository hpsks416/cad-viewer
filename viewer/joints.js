// 可动关节控制面板：读取 joints.json，为每个关节生成滑块，驱动 glTF 节点。
// 关节描述格式：
//   { "joints": [ {"node":"sub-assembly","type":"revolute","axis":[0,0,1],
//                  "pivot":[x,y,z],"min":-180,"max":180,"default":0} ] }
// type: revolute(限位旋转) / continuous(连续旋转) / prismatic(平移)
// axis 为节点局部坐标系下的单位向量；revolute 角度单位为度。
// pivot 为节点局部坐标系下的旋转轴经过点（可选，缺省时绕节点自身原点旋转）。
//        用于解决子装配体原点不在真实关节轴上的情况。
import * as THREE from 'three';

let panel = null;      // 面板外层（含固定头部）
let body = null;       // 面板内容容器（动态列表写到这里）
let listEl = null;
let currentRoot = null;
let currentSpec = null;
const active = [];          // {joint, node, restQuat, restPos, restScale, axis, pivot}
const jointMarkers = [];    // 关节转轴可视化标记
const dragHandles = new Map(); // Mesh -> active 对象（用于在转轴处直接拖动）
let jointsVisible = true;

const DEFAULTS = {
  revolute: { min: -180, max: 180, default: 0 },
  continuous: { min: -Infinity, max: Infinity, default: 0 },
  prismatic: { min: -1, max: 1, default: 0 },
};

export function initJoints(containerId) {
  panel = document.getElementById(containerId);
  if (!panel) return;
  body = panel.querySelector('.panel-body');
  if (!body) { body = panel; }
  body.innerHTML = '<ul id="jointList" class="joint-list"></ul>';
  listEl = body.querySelector('#jointList');
  if (!listEl) listEl = document.getElementById('jointList');
  panel.addEventListener('panel-toggle', (e) => {
    setJointsVisible(!(e.detail && e.detail.collapsed));
  });
}

function isCollapsed() {
  return !!(panel && panel.classList.contains('collapsed'));
}

export function setJointsVisible(on) {
  jointsVisible = !!on;
  for (const m of jointMarkers) m.visible = jointsVisible;
}

function setPanelVisible(on) {
  if (!panel) return;
  // 用 flex 覆盖 CSS 里的 #jointPanel{display:none}，避免内联空值被样式表压回。
  panel.style.display = on ? 'flex' : 'none';
}

function clearControls() {
  for (const a of active) {
    if (a.node) {
      a.node.quaternion.copy(a.restQuat);
      a.node.position.copy(a.restPos);
      a.node.scale.copy(a.restScale);
    }
  }
  active.length = 0;
  clearMarkers();
  dragHandles.clear();
  if (listEl) listEl.innerHTML = '';
  setPanelVisible(false);
}

function toAxis(v) {
  const a = new THREE.Vector3(0, 0, 1);
  if (Array.isArray(v) && v.length === 3) a.set(v[0], v[1], v[2]);
  if (a.lengthSq() < 1e-9) a.set(0, 0, 1);
  return a.normalize();
}

function toPivot(v) {
  if (Array.isArray(v) && v.length === 3) return new THREE.Vector3(v[0], v[1], v[2]);
  return null;
}

function clearMarkers() {
  for (const m of jointMarkers) {
    if (m.parent) m.parent.remove(m);
    m.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  jointMarkers.length = 0;
}

// Joint-axis gizmo: pivot sphere + rotation ring + axis arrow + sweep arc.
// Anchored to the node's parent, so it follows the parent joint but is not
// rotated by the node's own joint motion (it marks the true stationary axis).
function buildJointMarker(a) {
  const node = a.node;
  if (!node || !node.parent || !a.pivot) return;

  node.updateWorldMatrix(true, true);
  const bbox = new THREE.Box3().setFromObject(node);
  const parentInv = node.parent.matrixWorld.clone().invert();
  bbox.applyMatrix4(parentInv);
  const size = bbox.getSize(new THREE.Vector3());
  const S = Math.max(size.x, size.y, size.z);
  if (!isFinite(S) || S <= 0) return;

  const restM = new THREE.Matrix4().compose(a.restPos, a.restQuat, a.restScale);
  const pivot = a.pivot.clone().applyMatrix4(restM);
  const axis = a.axis.clone().applyQuaternion(a.restQuat).normalize();

  // Gizmo sizing, proportional to the part's overall bounding box.
  const sphereR = Math.max(S * 0.025, 1e-4);
  const ringR = S * 0.10;
  const ringTube = Math.max(S * 0.007, sphereR * 0.32);
  const shaftHalf = S * 0.34;
  const shaftR = Math.max(S * 0.006, sphereR * 0.35);
  const headLen = S * 0.045;
  const headR = S * 0.018;

  const group = new THREE.Group();
  group.name = '__joint_marker__';

  const mat = (color, opacity) => new THREE.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false, transparent: true, opacity,
  });
  const ringMat = mat(0x2ec4f0, 0.45);
  const axisMat = mat(0x5b8cff, 1.0);
  const sphereMat = mat(0xff5a5f, 1.0);
  const arcMat = new THREE.LineBasicMaterial({
    color: 0xffb02e, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95,
  });

  const qAxis = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  const qRing = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);

  // Rotation ring (its hole axis is the joint axis; lies in the rotation plane).
  const ring = new THREE.Mesh(new THREE.TorusGeometry(ringR, ringTube, 12, 72), ringMat);
  ring.quaternion.copy(qRing);
  ring.position.copy(pivot);
  ring.renderOrder = 1000;
  group.add(ring);

  // Axis shaft + double arrowheads.
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftHalf * 2, 14), axisMat);
  shaft.quaternion.copy(qAxis);
  shaft.position.copy(pivot);
  shaft.renderOrder = 1001;
  group.add(shaft);

  for (const dir of [1, -1]) {
    const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headLen, 18), axisMat);
    head.quaternion.copy(qAxis);
    if (dir < 0) head.rotateX(Math.PI);
    head.position.copy(pivot).addScaledVector(axis, dir * (shaftHalf + headLen * 0.45));
    head.renderOrder = 1001;
    group.add(head);
  }

  // Sweep arc for limited revolute joints: shows min..max angular range.
  const type = a.type || 'revolute';
  if (type === 'revolute') {
    const min = typeof a.joint.min === 'number' ? a.joint.min : -180;
    const max = typeof a.joint.max === 'number' ? a.joint.max : 180;
    const span = Math.abs(max - min);
    if (isFinite(span) && span > 0.01 && span < 360) {
      const axisLocal = a.axis.clone().normalize();
      const ref = new THREE.Vector3(1, 0, 0);
      if (Math.abs(axisLocal.dot(ref)) > 0.9) ref.set(0, 0, 1);
      const u = new THREE.Vector3().crossVectors(axisLocal, ref).normalize().applyQuaternion(a.restQuat);
      const v = new THREE.Vector3().crossVectors(axis, u).normalize();

      const arcR = ringR * 1.45;
      const steps = Math.max(24, Math.ceil(span));
      const pts = [];
      for (let s = 0; s <= steps; s++) {
        const ang = THREE.MathUtils.degToRad(min + (max - min) * (s / steps));
        pts.push(pivot.clone().addScaledVector(u, Math.cos(ang) * arcR).addScaledVector(v, Math.sin(ang) * arcR));
      }
      const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), arcMat);
      arc.renderOrder = 1002;
      group.add(arc);
    }
  }

  // Pivot sphere (drawn last, on top).
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(sphereR, 20, 16), sphereMat);
  sphere.position.copy(pivot);
  sphere.renderOrder = 1003;
  group.add(sphere);

  // Draggable grab ring: a wider translucent torus in the rotation plane.
  // Kept raycastable (visible, transparent) so the user can grab and rotate the
  // joint directly, like rotation gizmos in other 3D tools.
  if (type !== 'prismatic') {
    const grabR = S * 0.22;
    const grabTube = S * 0.032;
    const handle = new THREE.Mesh(
      new THREE.TorusGeometry(grabR, grabTube, 16, 96),
      new THREE.MeshBasicMaterial({
        color: 0x7fd8ff, transparent: true, opacity: 0.2,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    handle.quaternion.copy(qRing);
    handle.position.copy(pivot);
    handle.renderOrder = 1004;
    handle.userData.jointHandle = true;
    group.add(handle);
    a.handle = handle;
    dragHandles.set(handle, a);
  }

  node.parent.add(group);
  jointMarkers.push(group);
}

function applyJoint(a, value) {
  const node = a.node;
  if (!node) return;
  if (a.type === 'prismatic') {
    node.position.copy(a.restPos).addScaledVector(a.axis, value);
    return;
  }
  const q = new THREE.Quaternion().setFromAxisAngle(a.axis, THREE.MathUtils.degToRad(value));

  if (!a.pivot) {
    // 绕节点自身原点、节点局部轴旋转（向后兼容）
    node.quaternion.copy(a.restQuat).multiply(q);
    node.position.copy(a.restPos);
    return;
  }

  // 绕节点局部 pivot 点、节点局部轴旋转：
  //   新局部矩阵 = restM * ( T(pivot) * R(axis,θ) * T(-pivot) )
  // pivot 位于旋转轴上，因此轴上的点保持不动，只旋转轴外内容。
  const restM = new THREE.Matrix4().compose(a.restPos, a.restQuat, a.restScale);
  const T1 = new THREE.Matrix4().makeTranslation(a.pivot.x, a.pivot.y, a.pivot.z);
  const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const T2 = new THREE.Matrix4().makeTranslation(-a.pivot.x, -a.pivot.y, -a.pivot.z);
  const P = new THREE.Matrix4().multiplyMatrices(T1, R).multiply(T2);
  const M = new THREE.Matrix4().multiplyMatrices(restM, P);

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  M.decompose(pos, quat, scl);
  node.position.copy(pos);
  node.quaternion.copy(quat);
  node.scale.copy(scl);
}

// 应用关节角度并同步滑块显示（拖动与滑块共用同一入口）。
export function applyJointValue(a, value) {
  const type = a.type;
  let v = value;
  if (type !== 'continuous') {
    const min = typeof a.joint.min === 'number' ? a.joint.min : (type === 'prismatic' ? -1 : -180);
    const max = typeof a.joint.max === 'number' ? a.joint.max : (type === 'prismatic' ? 1 : 180);
    v = Math.min(max, Math.max(min, v));
  }
  if (a.slider) a.slider.value = String(v);
  if (a.valueEl) a.valueEl.textContent = (type !== 'prismatic') ? `${Math.round(v)}°` : v.toFixed(3);
  applyJoint(a, v);
}

// 返回当前关节的世界转轴信息：pivot、axis、旋转平面内互相垂直的 u/v 基向量。
export function getJointWorld(a) {
  const node = a.node;
  if (!node) return null;
  node.updateWorldMatrix(true, false);
  const parent = node.parent;
  const parentM = parent ? parent.matrixWorld : new THREE.Matrix4().identity();
  const axis = a.axis.clone().applyQuaternion(a.restQuat).transformDirection(parentM).normalize();
  const pivotLocal = a.pivot
    ? a.pivot.clone().applyMatrix4(new THREE.Matrix4().compose(a.restPos, a.restQuat, a.restScale))
    : new THREE.Vector3();
  const pivot = pivotLocal.applyMatrix4(parentM);

  const ref = new THREE.Vector3(1, 0, 0);
  if (Math.abs(axis.dot(ref)) > 0.9) ref.set(0, 0, 1);
  const u = new THREE.Vector3().crossVectors(axis, ref).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  return { pivot, axis, u, v };
}

export function getJointDragHandles() {
  if (!jointsVisible) return [];
  return Array.from(dragHandles.keys());
}

export function findJointByHandle(handle) {
  return dragHandles.get(handle) || null;
}

export function setJointHandleHover(handle, on) {
  if (handle && handle.material) {
    handle.material.opacity = on ? 0.55 : 0.2;
    handle.material.needsUpdate = true;
  }
}

function makeRow(a) {
  const li = document.createElement('li');
  const label = document.createElement('div');
  label.className = 'joint-label';
  label.textContent = a.joint.name || a.joint.node || a.joint.id || 'joint';

  const valueEl = document.createElement('span');
  valueEl.className = 'joint-value';

  const type = a.type;
  const cfg = Object.assign({}, DEFAULTS[type] || DEFAULTS.revolute, a.joint);
  let min = cfg.min, max = cfg.max, def = cfg.default;
  if (type === 'continuous') { min = -180; max = 180; }
  const step = type === 'prismatic' ? ((max - min) / 200) : 1;
  const isRotate = type !== 'prismatic';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(def);
  slider.className = 'joint-slider';

  a.slider = slider;
  a.valueEl = valueEl;

  function refresh() {
    const v = parseFloat(slider.value);
    valueEl.textContent = isRotate ? `${v}°` : v.toFixed(3);
    applyJoint(a, v);
  }
  slider.addEventListener('input', refresh);
  refresh();

  li.appendChild(label);
  li.appendChild(slider);
  li.appendChild(valueEl);
  return li;
}

export function updateJoints(root, spec) {
  currentRoot = root;
  currentSpec = spec;
  clearControls();
  const joints = (spec && Array.isArray(spec.joints)) ? spec.joints : [];
  if (!root || !joints.length) return;

  let shown = false;
  for (const j of joints) {
    const nodeName = j.node || j.id;
    const node = root.getObjectByName(nodeName);
    if (!node) continue;
    const type = j.type || 'revolute';
    const a = {
      joint: j,
      node,
      type,
      axis: toAxis(j.axis),
      pivot: toPivot(j.pivot),
      restQuat: node.quaternion.clone(),
      restPos: node.position.clone(),
      restScale: node.scale.clone(),
    };
    active.push(a);
    buildJointMarker(a);
    if (listEl) listEl.appendChild(makeRow(a));
    shown = true;
  }
  if (shown) {
    setPanelVisible(true);
    setJointsVisible(!isCollapsed());
  }
}

export function clearJoints() {
  clearControls();
}
