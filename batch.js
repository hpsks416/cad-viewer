const panel = document.getElementById('batchPanel');
const listEl = document.getElementById('batchList');
const statusEl = document.getElementById('batchStatus');
const summaryEl = document.getElementById('batchSummary');
const buildBtn = document.getElementById('batchBuild');

let files = [];
const selected = new Set();

function open() {
  panel.classList.add('show');
  loadFiles(true);
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
    listEl.innerHTML = '<li class="batch-empty">assets/export/ 里没有 .stl / .step 文件。<br/>请先用 SolidWorks 把工程导出为 STL（或 STEP AP214）放进该目录。</li>';
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

async function runBuild() {
  const names = [...selected];
  if (!names.length) return;
  buildBtn.disabled = true;
  statusEl.textContent = `转换中（${names.length} 个，可能较慢）…`;
  try {
    const r = await fetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: names, preview: true }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || '转换失败');
    const okCount = (data.results || []).filter((x) => x.ok).length;
    statusEl.textContent = `完成：成功 ${okCount} / ${names.length}`;
    if (window.CADViewer && window.CADViewer.loadManifest) {
      window.CADViewer.loadManifest();
    }
    await loadFiles(true);
  } catch (e) {
    statusEl.textContent = '转换失败：' + e.message;
    buildBtn.disabled = selected.size === 0;
  }
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