const panel = document.getElementById('batchPanel');
const listEl = document.getElementById('batchList');
const statusEl = document.getElementById('batchStatus');
const summaryEl = document.getElementById('batchSummary');
const buildBtn = document.getElementById('batchBuild');
const batchFileInput = document.getElementById('batchFileInput');
const batchPickFiles = document.getElementById('batchPickFiles');

const modeSelect = document.getElementById('modeSelect');
const modeNew = document.getElementById('modeNew');
const modeEditor = document.getElementById('modeEditor');
const modeName = document.getElementById('modeName');
const modeAngular = document.getElementById('modeAngular');
const modeAngularVal = document.getElementById('modeAngularVal');
const modeRadiusAdaptive = document.getElementById('modeRadiusAdaptive');
const modeSizeAdaptive = document.getElementById('modeSizeAdaptive');
const modeDedup = document.getElementById('modeDedup');
const modeSave = document.getElementById('modeSave');
const modeDelete = document.getElementById('modeDelete');

let files = [];
const selected = new Set();

let presets = [];
let custom = [];
let currentId = 'meshopt';

function open() {
  panel.classList.add('show');
  loadFiles(true);
  loadModes();
  loadHistory();
}

function close() {
  panel.classList.remove('show');
}

async function loadFiles(autoSelect) {
  statusEl.textContent = '加载中…';
  try {
    const r = await fetch('/api/files', { cache: 'no-store' });
    const data = await r.json();
    files = data.files || [];
    if (autoSelect) {
      selected.clear();
      files.forEach((f) => { if (!f.has_glb) selected.add(f.filename); });
    }
    render();
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = '加载失败：' + e.message;
  }
}

function render() {
  listEl.innerHTML = '';
  if (!files.length) {
    listEl.innerHTML = '<li class="batch-empty">还没有可转换的文件。<br/>点上方「选择文件」加入 .stl / .step 工程，或手动放进 assets/export/。</li>';
    summaryEl.textContent = '0 个工程';
    buildBtn.disabled = true;
    return;
  }
  files.forEach((f) => {
    const li = document.createElement('li');
    li.className = 'batch-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(f.filename);
    cb.addEventListener('change', () => {
      cb.checked ? selected.add(f.filename) : selected.delete(f.filename);
      updateSummary();
    });
    li.appendChild(cb);

    if (f.preview) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = f.preview;
      img.alt = '';
      li.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'thumb';
      li.appendChild(ph);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const cn = document.createElement('div');
    cn.className = 'cn';
    cn.textContent = f.filename;
    const en = document.createElement('div');
    en.className = 'en';
    en.textContent = (f.slug ? (f.name || f.slug) : '（翻译未就绪）') + (f.type === 'step' ? ' · STEP' : ' · STL');
    meta.appendChild(cn);
    meta.appendChild(en);
    li.appendChild(meta);

    const badge = document.createElement('span');
    badge.className = 'badge';
    if (f.has_glb) {
      badge.textContent = '已转换';
      badge.classList.add('done');
    } else if (f.slug) {
      badge.textContent = '待转换';
      badge.classList.add('todo');
    } else {
      badge.textContent = '待翻译';
      badge.classList.add('err');
    }
    li.appendChild(badge);

    listEl.appendChild(li);
  });
  updateSummary();
}

function updateSummary() {
  const n = selected.size;
  summaryEl.textContent = `已选 ${n} / ${files.length} 个工程`;
  buildBtn.disabled = n === 0;
}

// ===== 转换模式（预设 + 自定义） =====

function currentMode() {
  return presets.concat(custom).find((m) => m.id === currentId) || null;
}

function modeIsCustom() {
  return custom.some((m) => m.id === currentId);
}

function collectEditorValues() {
  return {
    angular_deflection: parseFloat(modeAngular.value) || 0.5,
    radius_adaptive: modeRadiusAdaptive.checked,
    size_adaptive: modeSizeAdaptive.checked,
    dedup: modeDedup.checked,
    compression: (document.querySelector('input[name="modeCompression"]:checked') || {}).value || 'meshopt',
  };
}

function currentModeObject() {
  const m = currentMode();
  if (!m) return null;
  return Object.assign({ id: m.id, name: m.name }, collectEditorValues());
}

async function loadModes() {
  try {
    const r = await fetch('/api/convert-presets', { cache: 'no-store' });
    const data = await r.json();
    presets = data.presets || [];
    custom = data.custom || [];
    if (!presets.concat(custom).some((m) => m.id === currentId)) {
      currentId = (presets[0] || {}).id || 'meshopt';
    }
    renderModeSelect();
    syncEditorFromMode();
  } catch (e) {
    statusEl.textContent = '加载转换模式失败：' + e.message;
  }
}

function renderModeSelect() {
  modeSelect.innerHTML = '';
  const ogPreset = document.createElement('optgroup');
  ogPreset.label = '内置预设';
  presets.forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name;
    ogPreset.appendChild(o);
  });
  modeSelect.appendChild(ogPreset);
  if (custom.length) {
    const ogCustom = document.createElement('optgroup');
    ogCustom.label = '自定义';
    custom.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      ogCustom.appendChild(o);
    });
    modeSelect.appendChild(ogCustom);
  }
  modeSelect.value = currentId;
}

function setEditorEnabled(enabled) {
  [modeName, modeAngular].forEach((el) => { el.disabled = !enabled; });
  document.querySelectorAll('input[name="modeCompression"]').forEach((el) => { el.disabled = !enabled; });
  [modeRadiusAdaptive, modeSizeAdaptive, modeDedup].forEach((el) => { el.disabled = !enabled; });
  modeSave.style.display = enabled ? '' : 'none';
  modeDelete.style.display = enabled ? '' : 'none';
}

function syncEditorFromMode() {
  const m = currentMode();
  if (!m) return;
  const isCustom = modeIsCustom();
  modeName.value = m.name || '';
  const ang = Number(m.angular_deflection ?? 0.5);
  modeAngular.value = ang;
  modeAngularVal.textContent = ang.toFixed(2);
  modeRadiusAdaptive.checked = !!m.radius_adaptive;
  modeSizeAdaptive.checked = !!m.size_adaptive;
  modeDedup.checked = !!m.dedup;
  const comp = m.compression || 'meshopt';
  document.querySelectorAll('input[name="modeCompression"]').forEach((el) => {
    el.checked = el.value === comp;
  });
  setEditorEnabled(isCustom);
  modeEditor.style.display = 'flex';
}

async function persistModes() {
  const r = await fetch('/api/convert-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presets, custom }),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || '保存失败');
}

async function newCustomMode() {
  let k = custom.length + 1;
  let id = `custom-${k}`;
  while (presets.concat(custom).some((m) => m.id === id)) {
    k += 1;
    id = `custom-${k}`;
  }
  const name = `自定义 ${k}`;
  const mode = Object.assign({ id, name }, collectEditorValues());
  custom.push(mode);
  currentId = id;
  try {
    await persistModes();
  } catch (e) {
    custom.pop();
    statusEl.textContent = '新建失败：' + e.message;
    loadModes();
    return;
  }
  renderModeSelect();
  syncEditorFromMode();
  statusEl.textContent = '已新建自定义模式：' + name;
}

async function saveCustomMode() {
  if (!modeIsCustom()) return;
  const m = custom.find((x) => x.id === currentId);
  if (!m) return;
  Object.assign(m, collectEditorValues());
  m.name = modeName.value.trim() || m.name;
  try {
    await persistModes();
  } catch (e) {
    statusEl.textContent = '保存失败：' + e.message;
    return;
  }
  renderModeSelect();
  syncEditorFromMode();
  statusEl.textContent = '已保存模式：' + m.name;
}

async function deleteCustomMode() {
  if (!modeIsCustom()) return;
  const idx = custom.findIndex((x) => x.id === currentId);
  if (idx < 0) return;
  const name = custom[idx].name;
  custom.splice(idx, 1);
  currentId = (presets[0] || {}).id || 'meshopt';
  try {
    await persistModes();
  } catch (e) {
    statusEl.textContent = '删除失败：' + e.message;
    loadModes();
    return;
  }
  renderModeSelect();
  syncEditorFromMode();
  statusEl.textContent = '已删除模式：' + name;
}

// ===== 文件选择上传 =====

async function uploadPickedFiles(fileList) {
  const picked = [...fileList];
  if (!picked.length) return;
  const uploaded = [];
  let fail = 0;
  buildBtn.disabled = true;
  for (let i = 0; i < picked.length; i++) {
    const f = picked[i];
    statusEl.textContent = `上传中（${i + 1}/${picked.length}）：${f.name}`;
    try {
      const url = '/api/upload?filename=' + encodeURIComponent(f.name);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f,
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || '上传失败');
      uploaded.push(f.name);
    } catch (e) {
      fail++;
      statusEl.textContent = `上传失败：${f.name}（${e.message}）`;
    }
  }
  if (uploaded.length) {
    await loadFiles(false);
    uploaded.forEach((n) => selected.add(n));
    render();
    statusEl.textContent = `已加入 ${uploaded.length} 个文件` + (fail ? `，失败 ${fail} 个` : '');
  }
  batchFileInput.value = '';
  buildBtn.disabled = selected.size === 0;
}

// ===== 批量转换 =====

async function runBuild() {
  const names = [...selected];
  if (!names.length) return;
  buildBtn.disabled = true;
  statusEl.textContent = `转换中（${names.length} 个，可能较慢）…`;
  try {
    const r = await fetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: names, preview: true, mode: currentModeObject() }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || '转换失败');
    const okResults = (data.results || []).filter((x) => x.ok);
    statusEl.textContent = `完成：成功 ${okResults.length} / ${names.length}`;
    renderHistory(data.history || []);
    // 一键闭环：刷新模型列表并自动加载本次第一个转换成功的模型
    const firstOk = okResults[0];
    if (window.CADViewer && window.CADViewer.loadManifest) {
      window.CADViewer.loadManifest(firstOk ? firstOk.slug : undefined);
    }
    await loadFiles(true);
  } catch (e) {
    statusEl.textContent = '转换失败：' + e.message;
    buildBtn.disabled = selected.size === 0;
  }
}

// ===== 转换历史 =====

async function loadHistory() {
  try {
    const r = await fetch('/api/convert-history', { cache: 'no-store' });
    const data = await r.json();
    renderHistory(Array.isArray(data) ? data : []);
  } catch (e) {
    renderHistory([]);
  }
}

function renderHistory(entries) {
  const el = document.getElementById('historyList');
  if (!el) return;
  el.innerHTML = '';
  if (!entries || !entries.length) {
    el.innerHTML = '<div class="history-empty">暂无转换记录</div>';
    return;
  }
  entries.slice(0, 20).forEach((h) => {
    const row = document.createElement('div');
    row.className = 'history-row';

    const name = document.createElement('span');
    name.className = 'h-file';
    name.textContent = h.filename || h.slug || '';
    name.title = h.filename || '';

    const preset = document.createElement('span');
    preset.className = 'h-preset';
    preset.textContent = h.preset_name || h.preset || '';

    const stat = document.createElement('span');
    stat.className = 'h-ok' + (h.ok ? ' ok' : ' err');
    stat.textContent = h.ok ? '✓' : '✗';
    if (!h.ok && h.error) stat.title = h.error;

    const meta = document.createElement('span');
    meta.className = 'h-meta';
    const secs = (h.seconds != null) ? (h.seconds + 's') : '';
    const mb = (h.glb_size != null) ? ((h.glb_size / 1048576).toFixed(2) + 'MB') : '';
    meta.textContent = [secs, mb].filter(Boolean).join(' · ');

    row.appendChild(name);
    row.appendChild(preset);
    row.appendChild(stat);
    row.appendChild(meta);
    el.appendChild(row);
  });
}

document.getElementById('openBatch').addEventListener('click', open);
document.getElementById('batchClose').addEventListener('click', close);
document.getElementById('batchSelectAll').addEventListener('click', () => {
  files.forEach((f) => selected.add(f.filename));
  render();
});
document.getElementById('batchSelectNone').addEventListener('click', () => {
  selected.clear();
  render();
});
document.getElementById('batchRefresh').addEventListener('click', () => loadFiles(false));
document.getElementById('batchBuild').addEventListener('click', runBuild);

modeSelect.addEventListener('change', () => {
  currentId = modeSelect.value;
  syncEditorFromMode();
});
modeNew.addEventListener('click', newCustomMode);
modeSave.addEventListener('click', saveCustomMode);
modeDelete.addEventListener('click', deleteCustomMode);
modeAngular.addEventListener('input', () => {
  modeAngularVal.textContent = parseFloat(modeAngular.value).toFixed(2);
});
batchPickFiles.addEventListener('click', () => batchFileInput.click());
batchFileInput.addEventListener('change', (e) => uploadPickedFiles(e.target.files));
