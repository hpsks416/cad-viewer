// 测量：在模型表面点两点，画线段 + 显示距离（世界 1 单位 = 1 米，显示为毫米）。
// 点选由 main.js 的射线拾取完成，本模块只负责状态、绘制与读数。
import * as THREE from 'three';

let scene = null;
let panelEl = null;
let toggleEl = null;
let clearEl = null;
let readoutEl = null;
let onChange = null;
let enabled = false;
let currentPoints = [];
let markers = [];
let measurements = [];

export function initMeasure(sceneRef, containerId, onChangeCb) {
  scene = sceneRef;
  onChange = onChangeCb || null;
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  panelEl = wrap.querySelector('.panel-body') || wrap;
  panelEl.innerHTML = `
    <label class="section-toggle"><input type="checkbox" class="measure-toggle"> 启用测量</label>
    <div class="measure-readout measure-hint"></div>
    <button class="measure-clear" type="button">清除所有测量</button>`;
  toggleEl = panelEl.querySelector('.measure-toggle');
  clearEl = panelEl.querySelector('.measure-clear');
  readoutEl = panelEl.querySelector('.measure-readout');
  toggleEl.addEventListener('change', () => setMeasureEnabled(toggleEl.checked));
  clearEl.addEventListener('click', () => { clearMeasure(); renderReadout(); });
  renderReadout();
}

export function isMeasureEnabled() { return enabled; }

export function setMeasureEnabled(on) {
  enabled = !!on;
  if (!enabled) clearMeasure();
  if (toggleEl) toggleEl.checked = enabled;
  renderReadout();
  if (onChange) onChange();
}

export function addMeasurePoint(world) {
  if (!enabled || !scene) return;
  currentPoints.push(world.clone());

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.02, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffcc00 })
  );
  marker.position.copy(world);
  scene.add(marker);
  markers.push(marker);

  if (currentPoints.length === 2) {
    const a = currentPoints[0];
    const b = currentPoints[1];
    const mm = a.distanceTo(b) * 1000; // 米 -> 毫米
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xffcc00 })
    );
    scene.add(line);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const label = makeLabel(mm.toFixed(1) + ' mm');
    label.position.copy(mid);
    scene.add(label);
    measurements.push({ line, label, mm });
    currentPoints = [];
  }
  renderReadout();
}

export function clearMeasure() {
  if (!scene) return;
  currentPoints = [];
  markers.forEach(m => scene.remove(m));
  measurements.forEach(x => { scene.remove(x.line); scene.remove(x.label); });
  markers = [];
  measurements = [];
}

function makeLabel(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(18,20,26,0.88)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 30px sans-serif';
  ctx.fillStyle = '#ffd34d';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(0.9, 0.225, 1);
  return sprite;
}

function renderReadout() {
  if (!readoutEl) return;
  let html = enabled
    ? (currentPoints.length === 0 ? '测量中：请在模型上点第 1 个点' : '测量中：请点第 2 个点')
    : '勾选「启用测量」后，在模型上点两点测距';
  if (measurements.length) {
    html += '<ul class="measure-list">';
    measurements.forEach((x, i) => {
      html += '<li>#' + (i + 1) + '　' + x.mm.toFixed(1) + ' mm</li>';
    });
    html += '</ul>';
  }
  readoutEl.innerHTML = html;
}
