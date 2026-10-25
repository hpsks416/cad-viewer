// 可动关节控制面板：读取 joints.json，为每个关节生成滑块，驱动 glTF 节点。
//
// 单自由度关节：
//   { "node":"sub-assembly","type":"revolute","axis":[0,0,1],
//     "pivot":[x,y,z],"min":-180,"max":180,"default":0 }
//   type: revolute(限位旋转) / continuous(连续旋转) / prismatic(平移)
//   axis 为节点局部坐标系下的单位向量；revolute 角度单位为度。
//   pivot 为节点局部坐标系下的旋转轴经过点（可选，缺省时绕节点自身原点旋转）。
//
// 多自由度关节（min/max/default 可为数组，逐自由度）：
//   ball        球铰，3 转动自由度，绕节点局部 X/Y/Z 轴
//               { "type":"ball","node":"...","pivot":[x,y,z],
//                 "default":[0,0,0],"min":[-45,-45,-45],"max":[45,45,45] }
//   universal   万向节，2 转动自由度，绕 axis1 / axis2
//               { "type":"universal","node":"...","pivot":[x,y,z],
//                 "axis1":[1,0,0],"axis2":[0,1,0],"min":[-30,-30],"max":[30,30] }
//   cylindrical 圆柱副，1 转动 + 1 平移，绕/沿 axis
//               { "type":"cylindrical","node":"...","axis":[0,0,1],"pivot":[x,y,z],
//                 "min":[-180,-0.05],"max":[180,0.05],"default":[0,0] }
//   多自由度轴的约定：均为节点局部坐标系下；旋转绕 pivot 点，平移沿轴。
//
// origin（可选）：关节坐标系位姿 {xyz, rpy}（节点局部空间，URDF 语义），给出时取代
//   axis+pivot 的简化描述：关节运动 = origin * 运动 * origin⁻¹（旋转绕关节轴、平移沿关节轴）。
//   即 URDF 的 <origin xyz=.. rpy=..> + <axis xyz=..> 的准确表达。
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
  ball: { min: -180, max: 180, default: 0 },
  universal: { min: -180, max: 180, default: 0 },
  cylindrical: { min: -180, max: 180, default: 0 },
};

export function initJoints(containerId) {
  panel = document.getElementById(containerId);
  if (!panel) return;
  body = panel.querySelector('.panel-body');
  if (!body) { body = panel; }
  body.innerHTML = '<ul id="jointList" class="joint-list"></ul><div id="jointWarnings" class="joint-warnings"></div>';
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
  const warnEl = document.getElementById('jointWarnings');
  if (warnEl) warnEl.innerHTML = '';
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

function toOrigin(v) {
  if (!v || typeof v !== 'object') return null;
  const xyz = Array.isArray(v.xyz) && v.xyz.length === 3 ? v.xyz : [0, 0, 0];
  const rpy = Array.isArray(v.rpy) && v.rpy.length === 3 ? v.rpy : [0, 0, 0];
  return {
    xyz: new THREE.Vector3(xyz[0], xyz[1], xyz[2]),
    rpy: new THREE.Vector3(rpy[0], rpy[1], rpy[2]),
  };
}

// 关节坐标系位姿矩阵 O：优先 origin(xyz+rpy)，其次 pivot（仅平移，向后兼容），无则 null（绕节点原点）。
function jointOriginMatrix(a) {
  if (a.origin) {
    const e = new THREE.Euler(a.origin.rpy.x, a.origin.rpy.y, a.origin.rpy.z, 'XYZ');
    return new THREE.Matrix4().compose(a.origin.xyz, new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(1, 1, 1));
  }
  if (a.pivot) {
    return new THREE.Matrix4().makeTranslation(a.pivot.x, a.pivot.y, a.pivot.z);
  }
  return null;
}

// restM * O * E * O⁻¹：在关节坐标系内施加运动 E（旋转/平移）。
function _composeJoint(restM, O, E) {
  const Oinv = new THREE.Matrix4().copy(O).invert();
  return restM.clone().multiply(O).multiply(E).multiply(Oinv);
}

function _decomposeToNode(node, M) {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  M.decompose(pos, quat, scl);
  node.position.copy(pos);
  node.quaternion.copy(quat);
  node.scale.copy(scl);
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

// ---- 多自由度关节：帮助函数 + 标记 ----

function isMulti(type) {
  return type === 'ball' || type === 'universal' || type === 'cylindrical';
}

function readDofCfg(j, n, defaults) {
  const min = Array.isArray(j.min) ? j.min : (typeof j.min === 'number' ? Array(n).fill(j.min) : []);
  const max = Array.isArray(j.max) ? j.max : (typeof j.max === 'number' ? Array(n).fill(j.max) : []);
  const def = Array.isArray(j.default) ? j.default : (typeof j.default === 'number' ? Array(n).fill(j.default) : []);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      min: typeof min[i] === 'number' ? min[i] : defaults[i].min,
      max: typeof max[i] === 'number' ? max[i] : defaults[i].max,
      def: typeof def[i] === 'number' ? def[i] : defaults[i].def,
    });
  }
  return out;
}

function buildDofs(a) {
  const j = a.joint || {};
  const t = a.type;
  if (t === 'ball') {
    const cfg = readDofCfg(j, 3, [
      { min: -180, max: 180, def: 0 }, { min: -180, max: 180, def: 0 }, { min: -180, max: 180, def: 0 },
    ]);
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const labels = ['绕X', '绕Y', '绕Z'];
    a.dofs = axes.map((ax, i) => Object.assign({ kind: 'rot', axis: ax, label: labels[i] }, cfg[i]));
  } else if (t === 'universal') {
    const ax1 = toAxis(j.axis1 || j.axis || [1, 0, 0]);
    const ax2 = toAxis(j.axis2 || [0, 1, 0]);
    a.axis1 = ax1;
    a.axis2 = ax2;
    const cfg = readDofCfg(j, 2, [{ min: -180, max: 180, def: 0 }, { min: -180, max: 180, def: 0 }]);
    a.dofs = [
      Object.assign({ kind: 'rot', axis: ax1, label: '轴1' }, cfg[0]),
      Object.assign({ kind: 'rot', axis: ax2, label: '轴2' }, cfg[1]),
    ];
  } else if (t === 'cylindrical') {
    const ax = a.axis;
    const cfg = readDofCfg(j, 2, [{ min: -180, max: 180, def: 0 }, { min: -1, max: 1, def: 0 }]);
    a.dofs = [
      Object.assign({ kind: 'rot', axis: ax, label: '旋转' }, cfg[0]),
      Object.assign({ kind: 'trans', axis: ax, label: '平移' }, cfg[1]),
    ];
  }
  a.values = a.dofs.map(d => d.def);
}

function rotMatrix(axis, deg, pivot) {
  const R = new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(deg));
  if (!pivot) return R;
  const T1 = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
  const T2 = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  return new THREE.Matrix4().multiplyMatrices(T1, R).multiply(T2);
}

function transMatrix(axis, d) {
  return new THREE.Matrix4().makeTranslation(axis.x * d, axis.y * d, axis.z * d);
}

function applyJointMulti(a) {
  const node = a.node;
  if (!node) return;
  const restM = new THREE.Matrix4().compose(a.restPos, a.restQuat, a.restScale);
  const O = jointOriginMatrix(a);
  const Oinv = O ? new THREE.Matrix4().copy(O).invert() : null;
  const M = restM.clone();
  for (let i = 0; i < a.dofs.length; i++) {
    const d = a.dofs[i];
    const E = (d.kind === 'rot') ? rotMatrix(d.axis, a.values[i], null) : transMatrix(d.axis, a.values[i]);
    if (O) { M.multiply(O).multiply(E).multiply(Oinv); }
    else { M.multiply(E); }
  }
  _decomposeToNode(node, M);
}

function fmtValue(d, v) {
  return d.kind === 'rot' ? `${Math.round(v)}°` : v.toFixed(3);
}

function worldPivot(a) {
  const node = a.node;
  node.updateWorldMatrix(true, false);
  const parentM = node.parent ? node.parent.matrixWorld : new THREE.Matrix4();
  const local = a.origin ? a.origin.xyz : (a.pivot || new THREE.Vector3());
  const pivotLocal = local.clone().applyMatrix4(new THREE.Matrix4().compose(a.restPos, a.restQuat, a.restScale));
  return pivotLocal.applyMatrix4(parentM);
}

function worldAxis(a, axisLocal) {
  const node = a.node;
  node.updateWorldMatrix(true, false);
  const parentM = node.parent ? node.parent.matrixWorld : new THREE.Matrix4();
  let ax = axisLocal.clone();
  if (a.origin) {
    ax.applyEuler(new THREE.Euler(a.origin.rpy.x, a.origin.rpy.y, a.origin.rpy.z, 'XYZ'));
  }
  return ax.applyQuaternion(a.restQuat).transformDirection(parentM).normalize();
}

function buildMultiMarker(a) {
  const node = a.node;
  if (!node || !node.parent) return;

  node.updateWorldMatrix(true, true);
  const bbox = new THREE.Box3().setFromObject(node);
  const parentInv = node.parent.matrixWorld.clone().invert();
  bbox.applyMatrix4(parentInv);
  const size = bbox.getSize(new THREE.Vector3());
  const S = Math.max(size.x, size.y, size.z);
  if (!isFinite(S) || S <= 0) return;

  const pivot = worldPivot(a);
  const sphereR = Math.max(S * 0.03, 1e-4);
  const ringR = S * 0.10;
  const ringTube = Math.max(S * 0.007, sphereR * 0.32);
  const shaftHalf = S * 0.34;
  const shaftR = Math.max(S * 0.006, sphereR * 0.35);

  const group = new THREE.Group();
  group.name = '__joint_marker__';
  const mat = (color, opacity) => new THREE.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false, transparent: true, opacity,
  });
  const sphereMat = mat(0xff5a5f, 1.0);

  const addRing = (axisWorld, color) => {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axisWorld);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(ringR, ringTube, 12, 72), mat(color, 0.5));
    ring.quaternion.copy(q);
    ring.position.copy(pivot);
    ring.renderOrder = 1000;
    group.add(ring);
  };
  const addShaft = (axisWorld) => {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisWorld);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftHalf * 2, 14), mat(0x5b8cff, 1.0));
    shaft.quaternion.copy(q);
    shaft.position.copy(pivot);
    shaft.renderOrder = 1001;
    group.add(shaft);
  };
  const addSphere = () => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(sphereR, 20, 16), sphereMat);
    s.position.copy(pivot);
    s.renderOrder = 1003;
    group.add(s);
  };

  if (a.type === 'ball') {
    addSphere();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(ringR, 16, 12), mat(0x2ec4f0, 0.18));
    shell.position.copy(pivot);
    shell.renderOrder = 999;
    group.add(shell);
  } else if (a.type === 'universal') {
    addRing(worldAxis(a, a.axis1), 0x2ec4f0);
    addRing(worldAxis(a, a.axis2), 0xffb02e);
    addSphere();
  } else if (a.type === 'cylindrical') {
    addRing(worldAxis(a, a.axis), 0x2ec4f0);
    addShaft(worldAxis(a, a.axis));
    addSphere();
  }

  node.parent.add(group);
  jointMarkers.push(group);
}

function applyJoint(a, value) {
  const node = a.node;
  if (!node) return;
  const restM = new THREE.Matrix4().compose(a.restPos, a.restQuat, a.restScale);
  const O = jointOriginMatrix(a);

  if (a.type === 'prismatic') {
    if (!O) {
      node.position.copy(a.restPos).addScaledVector(a.axis, value);
      node.quaternion.copy(a.restQuat);
      node.scale.copy(a.restScale);
      return;
    }
    const T = new THREE.Matrix4().makeTranslation(a.axis.x * value, a.axis.y * value, a.axis.z * value);
    _decomposeToNode(node, _composeJoint(restM, O, T));
    return;
  }

  const q = new THREE.Quaternion().setFromAxisAngle(a.axis, THREE.MathUtils.degToRad(value));
  if (!O) {
    // 绕节点自身原点、节点局部轴旋转（向后兼容）
    node.quaternion.copy(a.restQuat).multiply(q);
    node.position.copy(a.restPos);
    node.scale.copy(a.restScale);
    return;
  }
  const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
  _decomposeToNode(node, _composeJoint(restM, O, R));
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
  const pivot = worldPivot(a);
  const axis = worldAxis(a, a.axis);

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

function makeRowSingle(a) {
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

function makeRowMulti(a) {
  const li = document.createElement('li');
  const label = document.createElement('div');
  label.className = 'joint-label';
  label.textContent = a.joint.name || a.joint.node || a.joint.id || 'joint';
  li.appendChild(label);

  a.sliders = [];
  a.valueEls = [];

  a.dofs.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'joint-dof-row';
    const dl = document.createElement('span');
    dl.className = 'joint-dof-label';
    dl.textContent = d.label;
    const valueEl = document.createElement('span');
    valueEl.className = 'joint-value';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(d.min);
    slider.max = String(d.max);
    const isRot = d.kind === 'rot';
    slider.step = isRot ? '1' : String((d.max - d.min) / 200);
    slider.value = String(d.def);
    slider.className = 'joint-slider';

    a.sliders.push(slider);
    a.valueEls.push(valueEl);

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      a.values[i] = v;
      valueEl.textContent = fmtValue(d, v);
      applyJointMulti(a);
    });

    row.appendChild(dl);
    row.appendChild(slider);
    row.appendChild(valueEl);
    li.appendChild(row);
    valueEl.textContent = fmtValue(d, d.def);
  });

  return li;
}

function makeRow(a) {
  return isMulti(a.type) ? makeRowMulti(a) : makeRowSingle(a);
}

// 关节约束校验：节点引用、min/max 合法性、同一节点多关节（建议合并为多自由度关节）。
function validateJoints(root, spec) {
  const warnings = [];
  const joints = (spec && Array.isArray(spec.joints)) ? spec.joints : [];
  const seen = new Map();
  for (const j of joints) {
    const name = j.name || j.node || j.id || '关节';
    const nodeName = j.node || j.id;
    if (root && nodeName && !root.getObjectByName(nodeName)) {
      warnings.push(`${name}：未找到节点 "${nodeName}"`);
      continue;
    }
    if (nodeName) {
      if (seen.has(nodeName)) {
        warnings.push(`${name}：多个关节作用于同一节点 "${nodeName}"，考虑合并为 ball/universal 多自由度关节`);
      }
      seen.set(nodeName, true);
    }
    if (typeof j.min === 'number' && typeof j.max === 'number' && j.min > j.max) {
      warnings.push(`${name}：min(${j.min}) > max(${j.max})`);
    }
  }
  return warnings;
}

function renderWarnings(warnings) {
  const el = document.getElementById('jointWarnings');
  if (!el) return;
  el.innerHTML = '';
  if (!warnings.length) return;
  warnings.forEach((w) => {
    const d = document.createElement('div');
    d.className = 'joint-warning';
    d.textContent = '⚠ ' + w;
    el.appendChild(d);
  });
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
      origin: toOrigin(j.origin),
      restQuat: node.quaternion.clone(),
      restPos: node.position.clone(),
      restScale: node.scale.clone(),
    };
    if (isMulti(type)) buildDofs(a);
    active.push(a);
    if (isMulti(type)) buildMultiMarker(a);
    else buildJointMarker(a);
    if (listEl) listEl.appendChild(makeRow(a));
    shown = true;
  }
  if (shown) {
    setPanelVisible(true);
    setJointsVisible(!isCollapsed());
  }
  renderWarnings(validateJoints(root, spec));
}

export function clearJoints() {
  clearControls();
}
