/**
 * popup.js - Popup controller for screen sharing, camera controls and diagnostics.
 */
(function () {
  'use strict';

  const tabList = document.getElementById('tabList');
  const emptyState = document.getElementById('emptyState');
  const hint = document.getElementById('hint');
  const btnRefresh = document.getElementById('btnRefresh');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const viewIdle = document.getElementById('viewIdle');
  const viewSharing = document.getElementById('viewSharing');
  const sharingInfo = document.getElementById('sharingInfo');
  const btnCamOn = document.getElementById('btnCamOn');
  const btnCamOff = document.getElementById('btnCamOff');
  const btnDiag = document.getElementById('btnDiag');
  const btnExportLog = document.getElementById('btnExportLog');
  const diagPanel = document.getElementById('diagPanel');
  const versionBadge = document.getElementById('versionBadge');
  const detectedCount = document.getElementById('detectedCount');
  const selectedCount = document.getElementById('selectedCount');
  const statusPill = document.getElementById('statusPill');
  const lastRefresh = document.getElementById('lastRefresh');
  const toast = document.getElementById('toast');

  let tabs = [];
  let sharing = false;
  let sharingCount = 0;
  let toastTimer = null;

  init();

  async function init() {
    versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;

    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
      if (!state) return;
      sharing = Boolean(state.sharing);
      sharingCount = 1 + (state.receiverTabs?.length || 0);
      showView();
    });

    await refreshTabs();

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type !== 'STATE_UPDATE') return;
      sharing = Boolean(msg.state.sharing);
      sharingCount = 1 + (msg.state.receiverTabs?.length || 0);
      showView();
    });
  }

  function showView() {
    if (sharing) {
      viewIdle.classList.remove('active');
      viewSharing.classList.add('active');
      statusPill.classList.add('sharing');
      statusPill.textContent = '● 共享中';
      sharingInfo.textContent = `正在同步到 ${sharingCount} 个通话窗口`;
      return;
    }

    viewSharing.classList.remove('active');
    viewIdle.classList.add('active');
    statusPill.classList.remove('sharing');
    statusPill.textContent = tabs.length ? '● 已就绪' : '● 待命中';
  }

  async function refreshTabs() {
    setButtonLoading(btnRefresh, true, '刷新中');
    lastRefresh.textContent = '正在扫描通话窗口...';

    try {
      const result = await chrome.runtime.sendMessage({ type: 'REFRESH_TABS' });
      tabs = result?.tabs || [];
      lastRefresh.textContent = tabs.length
        ? `刚刚刷新，发现 ${tabs.length} 个窗口`
        : '刚刚刷新，暂未发现通话';
    } catch (e) {
      tabs = [];
      lastRefresh.textContent = '刷新失败，请稍后重试';
      showToast(`刷新失败：${e.message || e}`);
    } finally {
      setButtonLoading(btnRefresh, false, '刷新');
      renderTabs();
      showView();
    }
  }

  function renderTabs() {
    tabList.innerHTML = '';
    detectedCount.textContent = String(tabs.length);

    if (tabs.length === 0) {
      emptyState.style.display = 'block';
      hint.style.display = 'none';
      btnStart.disabled = true;
      btnStart.textContent = '开始共享';
      selectedCount.textContent = '0';
      return;
    }

    emptyState.style.display = 'none';
    hint.style.display = '';

    tabs.forEach((tab, i) => {
      const li = document.createElement('li');
      li.className = 'tab-item selected';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = tab.id;
      cb.checked = true;
      cb.setAttribute('aria-label', `选择 ${cleanTitle(tab.title)}`);
      cb.addEventListener('change', () => {
        li.classList.toggle('selected', cb.checked);
        updateBtn();
      });

      const name = document.createElement('div');
      name.className = 'name';
      name.title = cleanTitle(tab.title);
      name.textContent = cleanTitle(tab.title);

      li.appendChild(cb);
      li.appendChild(name);

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = i === 0 ? '主窗口' : `#${i + 1}`;
      li.appendChild(badge);

      tabList.appendChild(li);
    });

    updateBtn();
  }

  function getSelected() {
    return Array.from(tabList.querySelectorAll('input:checked')).map((c) => Number(c.value));
  }

  function updateBtn() {
    const ids = getSelected();
    const n = ids.length;
    selectedCount.textContent = String(n);
    btnStart.disabled = n < 1;
    btnStart.textContent = n < 1 ? '请先选择通话' : `共享到 ${n} 个通话`;

    // Keep floating buttons and popup selection in sync.
    chrome.runtime.sendMessage({ type: 'UPDATE_SELECTION', tabIds: ids }).catch(() => {});
  }

  btnRefresh.addEventListener('click', refreshTabs);

  btnStart.addEventListener('click', () => {
    const ids = getSelected();
    if (ids.length < 1) return;

    setButtonLoading(btnStart, true, '启动共享中...');
    sharingCount = ids.length;

    chrome.runtime.sendMessage({ type: 'START_SHARING', tabIds: ids }, () => {
      setButtonLoading(btnStart, false, `共享到 ${ids.length} 个通话`);
      if (chrome.runtime.lastError) {
        showToast(`启动失败：${chrome.runtime.lastError.message}`);
        return;
      }

      sharing = true;
      showView();
      showToast('共享已开始，请在首个弹窗中选择要共享的画面');
      setTimeout(() => window.close(), 120);
    });
  });

  btnStop.addEventListener('click', () => {
    setButtonLoading(btnStop, true, '正在停止...');

    chrome.runtime.sendMessage({ type: 'STOP_SHARING' }, async () => {
      setButtonLoading(btnStop, false, '停止所有共享');
      if (chrome.runtime.lastError) {
        showToast(`停止失败：${chrome.runtime.lastError.message}`);
        return;
      }

      sharing = false;
      showView();
      showToast('已发送停止共享指令，正在刷新通话布局');
      await refreshTabs();
    });
  });

  btnCamOn.addEventListener('click', async () => {
    await runToolButton(btnCamOn, '开启中...', '全部开启', async () => {
      await chrome.runtime.sendMessage({
        type: 'TOGGLE_ALL_CAMERAS_FROM_POPUP',
        enable: true,
      });
      showToast('已发送全部开启摄像头指令');
    });
  });

  btnCamOff.addEventListener('click', async () => {
    await runToolButton(btnCamOff, '关闭中...', '全部关闭', async () => {
      await chrome.runtime.sendMessage({
        type: 'TOGGLE_ALL_CAMERAS_FROM_POPUP',
        enable: false,
      });
      showToast('已发送全部关闭摄像头指令');
    });
  });

  btnDiag.addEventListener('click', async () => {
    await runToolButton(btnDiag, '诊断中...', '一键诊断', async () => {
      diagPanel.classList.add('active');
      diagPanel.textContent = '正在读取当前通话状态...';
      try {
        const diagnostics = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' });
        renderDiagnostics(diagnostics);
        showToast('诊断完成');
      } catch (e) {
        diagPanel.innerHTML = `<div class="diag-bad">诊断失败：${escapeHtml(e.message || String(e))}</div>`;
        throw e;
      }
    });
  });

  btnExportLog.addEventListener('click', async () => {
    await runToolButton(btnExportLog, '导出中...', '导出日志', async () => {
      const diagnostics = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' });
      exportDiagnostics(diagnostics);
      showToast('诊断日志已导出');
    });
  });

  async function runToolButton(button, loadingText, idleText, task) {
    setButtonLoading(button, true, loadingText);
    try {
      await task();
    } catch (e) {
      showToast(`操作失败：${e.message || e}`);
    } finally {
      setButtonLoading(button, false, idleText);
    }
  }

  function setButtonLoading(button, isLoading, text) {
    button.disabled = isLoading;
    button.textContent = text;
  }

  function cleanTitle(title) {
    if (!title) return '(通话窗口)';
    return title
      .replace(/^\(\d+\)\s*/, '')
      .replace(/^Instagram\s*[-–—]\s*/i, '')
      .trim() || title;
  }

  function renderDiagnostics(data) {
    const diagnosticTabs = data?.tabs || [];
    const injectedCount = diagnosticTabs.filter((t) => t.injected).length;
    const errorCount = diagnosticTabs.filter((t) => t.error).length;
    const consumedCount = diagnosticTabs.filter((t) => t.consumed).length;
    const activeCount = data?.callTabCount || diagnosticTabs.length || 0;

    const rows = [
      pair('插件版本', data?.version || chrome.runtime.getManifest().version),
      pair('共享状态', data?.sharing ? '共享中' : '未共享', data?.sharing ? 'diag-ok' : 'diag-muted'),
      pair('检测通话', `${activeCount} 个`),
      pair('脚本响应', `${injectedCount}/${diagnosticTabs.length}`),
      pair('已消费共享流', `${consumedCount}/${diagnosticTabs.length}`),
      pair('异常窗口', `${errorCount} 个`, errorCount ? 'diag-bad' : 'diag-ok'),
      pair('源窗口', data?.sourceTabId || '-'),
      pair('上次开始', formatTime(data?.lastStartAt)),
      pair('上次停止', formatTime(data?.lastStopAt)),
    ];

    const tabRows = diagnosticTabs.map((tab) => {
      const state = tab.error
        ? `<span class="diag-bad">${escapeHtml(tab.error)}</span>`
        : tab.consumed
          ? '<span class="diag-ok">已共享</span>'
          : tab.injected
            ? '<span class="diag-ok">脚本正常</span>'
            : '<span class="diag-warn">未响应</span>';
      return `<div class="diag-line"><span>#${tab.tabId} ${escapeHtml(tab.role || '')}</span><span>${state}</span></div>`;
    });

    diagPanel.innerHTML = [
      '<div class="diag-title">总体状态</div>',
      ...rows,
      '<div class="diag-title">窗口明细</div>',
      ...(tabRows.length ? tabRows : ['<div class="diag-muted">暂无通话窗口</div>']),
    ].join('');
  }

  function pair(label, value, cls = '') {
    return `<div class="diag-line"><span class="diag-muted">${escapeHtml(label)}</span><span class="${cls}">${escapeHtml(value)}</span></div>`;
  }

  function exportDiagnostics(data) {
    const text = JSON.stringify(data || {}, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    a.href = url;
    a.download = `mms-diagnostics-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatTime(value) {
    if (!value) return '-';
    try {
      return new Date(value).toLocaleTimeString();
    } catch {
      return '-';
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('active');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('active');
    }, 2200);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();
