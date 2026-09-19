// 右侧子窗口（剖面 / 关节 / 材质）最小化与展开。
// 面板结构约定：.panel > .panel-head + .panel-body。
// 最小化只切换 body 显示，并收起面板宽度，不丢失面板内状态。
function bindPanel(panel) {
  if (!panel) return;
  const head = panel.querySelector('.panel-head');
  const btn = panel.querySelector('.panel-min');
  if (!head || !btn) return;
  btn.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    btn.textContent = panel.classList.contains('collapsed') ? '+' : '—';
    btn.title = panel.classList.contains('collapsed') ? '展开' : '最小化';
    panel.dispatchEvent(new CustomEvent('panel-toggle', { detail: { collapsed: panel.classList.contains('collapsed') } }));
  });
}

function bindSidebar() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('sideMin');
  if (!sidebar || !btn) return;
  btn.textContent = '−';
  btn.title = '最小化/展开';
  btn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    btn.textContent = sidebar.classList.contains('collapsed') ? '+' : '−';
    btn.title = sidebar.classList.contains('collapsed') ? '展开' : '最小化';
  });
}

function init() {
  document.querySelectorAll('#rightPanels .panel').forEach(bindPanel);
  bindSidebar();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
