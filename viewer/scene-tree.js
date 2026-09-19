// 场景树：装配体层级 + 点击高亮 + 序列号/中文名显示。
// 依赖 glTF 节点名 = 序列号（如 A001 / P042），parts.json 提供 {name_en,name_zh,kind}。
import * as THREE from 'three';

let listEl = null;
let partsMap = {};
let modelRoot = null;
const rowBySerial = new Map();
const highlightRecs = new Map(); // mesh -> original material
let activeSerial = null;
let onSelect = null;

const SERIAL_RE = /^[AP]\d{3}$/;

export function initSceneTree(containerId, selectCb) {
  const c = document.getElementById(containerId);
  if (!c) return;
  onSelect = selectCb || null;
  c.innerHTML = '';
  listEl = document.createElement('ul');
  listEl.className = 'tree';
  c.appendChild(listEl);
}

export function clearSceneTree() {
  partsMap = {};
  modelRoot = null;
  rowBySerial.clear();
  clearHighlight();
  if (listEl) listEl.innerHTML = '';
}

function isSerial(o) {
  return typeof o.name === 'string' && SERIAL_RE.test(o.name);
}

export function renderSceneTree(gltfScene, parts) {
  partsMap = parts || {};
  modelRoot = gltfScene;
  // 记录每个网格的原始材质（供材质覆盖与“恢复默认”使用），必须在任何高亮克隆之前完成。
  gltfScene.traverse(o => { if (o.isMesh && o.userData.__origMaterial === undefined) o.userData.__origMaterial = o.material; });
  rowBySerial.clear();
  clearHighlight();
  if (!listEl) return;
  listEl.innerHTML = '';

  const addChildren = (parentEl, node, depth) => {
    node.children.forEach(child => {
      if (isSerial(child)) {
        parentEl.appendChild(buildRow(child, depth));
      } else {
        // 顶层包裹空物体等非序列号节点：下钻但不显示
        addChildren(parentEl, child, depth);
      }
    });
  };
  addChildren(listEl, gltfScene, 0);
}

function infoFor(name) {
  return partsMap[name] || {};
}

function buildRow(obj, depth) {
  const info = infoFor(obj.name);
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = (depth * 14 + 6) + 'px';

  const hasKids = obj.children.some(c => isSerial(c));
  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle' + (hasKids ? ' has' : '');
  toggle.textContent = hasKids ? (depth === 0 ? '\u25BE' : '\u25B8') : '\u00B7';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const kids = li.querySelector(':scope > ul');
    if (!kids) return;
    const closed = kids.style.display === 'none';
    kids.style.display = closed ? '' : 'none';
    toggle.textContent = closed ? '\u25BE' : '\u25B8';
  });
  row.appendChild(toggle);

  const kind = info.kind || (obj.isMesh ? 'part' : 'assembly');
  const zh = info.name_zh || '';
  const en = info.name_en || '';
  const label = document.createElement('span');
  label.className = 'tree-label';
  const titleText = zh || en || obj.name;
  label.textContent = obj.name + '  ' + titleText;
  label.title = obj.name + '  ' + (zh ? zh + ' / ' : '') + (en || '');
  row.appendChild(label);

  const badge = document.createElement('span');
  badge.className = 'tree-kind';
  badge.textContent = kind === 'assembly' ? '组' : '件';
  row.appendChild(badge);

  row.addEventListener('click', () => selectSerial(obj));
  li.appendChild(row);

  if (hasKids) {
    const ul = document.createElement('ul');
    ul.className = 'tree-children';
    ul.style.display = (depth === 0) ? '' : 'none';
    obj.children.forEach(c => { if (isSerial(c)) ul.appendChild(buildRow(c, depth + 1)); });
    li.appendChild(ul);
  }
  rowBySerial.set(obj.name, row);
  return li;
}

function serialAncestor(obj) {
  let o = obj;
  while (o && !isSerial(o)) o = o.parent;
  return o;
}

function collectMeshes(obj, out) {
  obj.traverse(o => { if (o.isMesh) out.push(o); });
}

function highlightMesh(mesh, on) {
  if (on) {
    if (!highlightRecs.has(mesh)) {
      const orig = mesh.material;
      if (!orig) return;
      const cloned = orig.clone();
      highlightRecs.set(mesh, orig);
      mesh.material = cloned;
    }
    const mat = mesh.material;
    if (mat && mat.emissive) {
      mat.emissive.setHex(0x3b6eff);
      mat.emissiveIntensity = 0.55;
      mat.needsUpdate = true;
    }
  } else {
    const orig = highlightRecs.get(mesh);
    if (orig) { mesh.material = orig; highlightRecs.delete(mesh); }
  }
}

function clearHighlight() {
  highlightRecs.forEach((orig, mesh) => { mesh.material = orig; });
  highlightRecs.clear();
  if (activeSerial && rowBySerial.has(activeSerial)) {
    rowBySerial.get(activeSerial).classList.remove('selected');
  }
  activeSerial = null;
}

function selectSerial(obj) {
  clearHighlight();
  if (!obj) { if (onSelect) onSelect(null); return; }
  activeSerial = obj.name;
  const meshes = [];
  collectMeshes(obj, meshes);
  meshes.forEach(m => highlightMesh(m, true));
  const row = rowBySerial.get(obj.name);
  if (row) {
    row.classList.add('selected');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  if (onSelect) onSelect(obj.name, obj);
}

// 供 main.js 射线拾取：传入命中的 mesh，自动定位到其序列号祖先。
export function selectByObject(obj) {
  const anc = obj ? serialAncestor(obj) : null;
  selectSerial(anc);
}

export function getModelRoot() { return modelRoot; }

export function getActiveSerial() { return activeSerial; }
export function getPartInfo(serial) { return partsMap[serial] || {}; }
export function getMeshesForSerial(serial) {
  if (!modelRoot) return [];
  let obj = null;
  modelRoot.traverse(o => { if (!obj && o.name === serial) obj = o; });
  if (!obj) return [];
  const out = [];
  obj.traverse(o => { if (o.isMesh) out.push(o); });
  return out;
}
export function clearActiveSelection() { clearHighlight(); }
export function selectSerialByName(serial) {
  if (!serial || !modelRoot) return;
  let obj = null;
  modelRoot.traverse(o => { if (!obj && o.name === serial) obj = o; });
  if (obj) selectSerial(obj);
}

// 重新高亮指定序列号的网格：丢弃旧恢复目标，改用“当前材质”重新克隆高亮。
// 用于材质覆盖后，让高亮叠加在新材质之上，取消高亮时恢复到新材质而非旧材质。
export function refreshHighlight(serial) {
  if (!serial || !modelRoot) return;
  let obj = null;
  modelRoot.traverse(o => { if (!obj && o.name === serial) obj = o; });
  if (!obj) return;
  const meshes = [];
  obj.traverse(o => { if (o.isMesh) meshes.push(o); });
  meshes.forEach(m => {
    highlightRecs.delete(m);
    highlightMesh(m, true);
  });
}
