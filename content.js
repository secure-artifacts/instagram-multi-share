/**
 * content.js - 运行在 ISOLATED world
 * 功能：DOM 操作（查找/点击共享按钮）+ 消息桥梁（inject.js <-> background.js）
 */
(function () {
  'use strict';

  const PREFIX = 'MMS_';
  const log = (...args) => console.log('[MMS-content]', ...args);
  let lastShareButton = null;

  // ---- 消息桥梁：inject.js -> background.js ----
  function safeSendBg(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* extension reloaded */ }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.type?.startsWith(PREFIX)) return;
    const type = e.data.type.slice(PREFIX.length);
    const data = e.data.data || {};

    switch (type) {
      case 'SOURCE_STREAM_READY':
        safeSendBg({ type: 'SOURCE_READY' });
        break;
      case 'SOURCE_STREAM_ENDED':
        safeSendBg({ type: 'SOURCE_ENDED' });
        break;
      case 'RECEIVER_STREAM_READY':
        safeSendBg({ type: 'RECEIVER_READY' });
        break;
      case 'RECEIVER_SHARE_CONSUMED':
        safeSendBg({ type: 'RECEIVER_SHARE_CONSUMED' });
        break;
      case 'RECEIVER_SHARE_TIMEOUT':
        safeSendBg({ type: 'RECEIVER_SHARE_TIMEOUT' });
        break;
      case 'SOURCE_SHARE_CONSUMED':
        safeSendBg({ type: 'SOURCE_SHARE_CONSUMED' });
        break;
      case 'SIGNAL_OUT':
        safeSendBg({ type: 'SIGNAL', targetTabId: data.targetTabId, signal: data.signal });
        break;
      case 'CONNECTION_FAILED':
        safeSendBg({ type: 'CONNECTION_FAILED', remoteTabId: data.remoteTabId });
        break;
    }
  });

  // ---- background.js -> inject.js / DOM 操作 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'SET_ROLE':
        toInject('SET_ROLE', { role: msg.role });
        sendResponse({ ok: true });
        break;
      case 'CREATE_OFFER':
        toInject('CREATE_OFFER', { targetTabId: msg.targetTabId });
        sendResponse({ ok: true });
        break;
      case 'SIGNAL':
        toInject('HANDLE_SIGNAL', { fromTabId: msg.fromTabId, signal: msg.signal });
        sendResponse({ ok: true });
        break;
      case 'CLICK_SHARE': {
        const btn = findShareButton();
        if (btn) {
          log('✅ 点击共享按钮:', btn.getAttribute('aria-label'));
          lastShareButton = btn;
          log('remember share button label:', btn.getAttribute('aria-label') || '(no aria-label)');
          btn.click();
          sendResponse({ ok: true, found: true });
        } else {
          log('未找到共享按钮');
          sendResponse({ ok: true, found: false });
        }
        break;
      }
      // CLICK_STOP_SHARE 已移除 — 停止共享通过 inject.js 直接停止 stream tracks
      case 'STOP_SHARING':
        log('receive STOP_SHARING command');
        if (!clickNativeStopShareOnce('initial')) {
          setTimeout(() => clickNativeStopShareOnce('retry'), 700);
        }
        // 兜底：延迟点击 Messenger 原生停止共享按钮，防止个别组流未结束
        setTimeout(() => {
          log('cleanup streams after native stop grace period');
          toInject('STOP_SHARING', {});
          nudgeMessengerLayout('stop-sharing-cleanup');
          return;
          const stopBtn = null;
          if (stopBtn) {
            log('兜底点击 Messenger 停止共享按钮');
            log('stop share click label:', stopBtn.getAttribute('aria-label') || '(no aria-label)');
            realClick(stopBtn);
          }
          log('cleanup streams after native stop grace period');
          toInject('STOP_SHARING', {});
        }, 1600);
        sendResponse({ ok: true });
        break;
      case 'UPDATE_BUTTON':
        updateButton(msg.sharing);
        sendResponse({ ok: true });
        break;
      case 'NUDGE_LAYOUT':
        nudgeMessengerLayout(msg.reason || 'message');
        sendResponse({ ok: true });
        break;
      case 'PING':
        sendResponse({ ok: true, inCall: isGroupCall() });
        break;
    }
  });

  // ---- URL 检测 ----
  function isGroupCall() {
    return /^https:\/\/www\.instagram\.com\/call\/?/i.test(window.location.href);
  }

  // ---- 查找共享屏幕按钮 ----

  /**
   * 策略 1：多语言 aria-label 匹配（最准确）
   */
  function findByLabel() {
    const keywordPairs = [
      ['share', 'screen'], ['present', 'screen'],
      ['共享', '屏幕'], ['分享', '屏幕'],
      ['分享', '畫面'], ['共享', '螢幕'], ['分享', '螢幕'],
      ['compartir', 'pantalla'],
      ['partager', 'écran'], ['partager', 'ecran'],
      ['bildschirm', 'teilen'],
      ['compartilhar', 'tela'],
      ['画面', '共有'],
      ['화면', '공유'],
      ['condividi', 'schermo'],
      ['демонстрация', 'экран'], ['поделиться', 'экран'],
      ['chia', 'hình'],
      ['แชร์', 'หน้าจอ'],
      ['bagikan', 'layar'], ['berbagi', 'layar'],
      ['ekran', 'paylaş'],
      ['scherm', 'delen'],
      ['dela', 'skärm'],
      ['udostępnij', 'ekran'],
      ['مشاركة', 'الشاشة'],
    ];

    const allBtns = document.querySelectorAll('[role="button"][aria-label], button[aria-label]');
    for (const btn of allBtns) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      for (const [a, b] of keywordPairs) {
        if (label.includes(a.toLowerCase()) && label.includes(b.toLowerCase())) {
          return btn;
        }
      }
    }
    return null;
  }

  // ---- 摄像头 SVG 常量（提前声明，供 KNOWN_NON_SHARE_SVG 引用）----
  const CAM_OFF_SVG = 'M4.366 29.135a1.25 1.25 0 0 1-.043-1.723';
  const CAM_ON_SVG = 'M9 9.5a4 4 0 0 0-4 4v9a4 4 0 0 0 4 4h10a4';

  /**
   * 策略 2：SVG path 特征匹配（比位置检测更可靠）
   * Messenger 的屏幕共享按钮图标有特定 SVG path 前缀
   * 保留多组候选以应对不同 UI 版本/实验
   */
  const SHARE_SCREEN_SVG_PREFIXES = [
    // Messenger desktop call UI - monitor/screen icon variants
    'M8.75 25.25C8.75 26.216 9.534 27',
    'M29.043 11./0 6a1.25 1.25',
    'M6 9.5a2.5 2.5 0 0 1 2.5-2.5h19a2.5',
    'M4.5 7.5A2.5 2.5 0 0 1 7 5h22a2.5',
    // Share/present screen generic patterns
    'M6.5 7A2.5 2.5 0 0 1 9 4.5h18',
    'M5 6a3 3 0 0 1 3-3h20',
  ];

  // 已知的麦克风/摄像头/挂断 SVG 前缀（排除用）
  const KNOWN_NON_SHARE_SVG = [
    CAM_OFF_SVG,
    CAM_ON_SVG,
    'M26 16c0 4.079-2.46 7.586-5.981 9.128', // mic on
    'M4.366 29.135',                            // mic off / cam off
    'M16 5.2a10.8 10.8 0 1 0 0 21.6',          // hangup circle
    'M15.9 1.2C7.8 1.2 1.2 7.8',               // hangup variant
  ];

  function findBySvgShare() {
    const candidates = [];
    document.querySelectorAll('[role="button"]').forEach((btn) => {
      if (btn.offsetParent === null) return; // 不可见
      for (const p of btn.querySelectorAll('svg path')) {
        const d = p.getAttribute('d') || '';
        // 排除已知非分享按钮
        if (KNOWN_NON_SHARE_SVG.some((prefix) => d.startsWith(prefix))) break;
        // 匹配分享图标
        if (SHARE_SCREEN_SVG_PREFIXES.some((prefix) => d.startsWith(prefix))) {
          candidates.push(btn);
          break;
        }
      }
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * 策略 3：位置检测（兜底，增加约束减少误点）
   * 约束：必须在视口底部 25%，排除已知麦克风/摄像头图标
   */
  function findByPosition() {
    const allBtns = Array.from(
      document.querySelectorAll('[role="button"][aria-label], button[aria-label]')
    );
    if (allBtns.length === 0) return null;

    const viewH = window.innerHeight;
    const visible = allBtns.filter((btn) => {
      const r = btn.getBoundingClientRect();
      // 必须可见且在底部 25%
      return r.width > 0 && r.height > 0 && r.top > viewH * 0.75;
    });
    if (visible.length < 3) return null;

    // 排除已知麦克风/摄像头按钮
    const filtered = visible.filter((btn) => {
      for (const p of btn.querySelectorAll('svg path')) {
        const d = p.getAttribute('d') || '';
        if (KNOWN_NON_SHARE_SVG.some((prefix) => d.startsWith(prefix))) return false;
      }
      return true;
    });

    const btnInfos = filtered.map((btn) => {
      const r = btn.getBoundingClientRect();
      return { btn, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (btnInfos.length === 0) return null;

    // 按 Y 分组（容差 30px），取最底部一组
    const sorted = [...btnInfos].sort((a, b) => a.y - b.y);
    const groups = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].y - cur[0].y) < 30) {
        cur.push(sorted[i]);
      } else {
        if (cur.length >= 2) groups.push(cur);
        cur = [sorted[i]];
      }
    }
    if (cur.length >= 2) groups.push(cur);
    if (groups.length === 0) return null;

    const bottom = groups.reduce((a, b) => (a[0].y > b[0].y ? a : b));
    bottom.sort((a, b) => a.x - b.x);

    // 跳过第一个（地球/表情按钮），返回第二个
    if (bottom.length >= 2) return bottom[1].btn;
    return null; // 不够确定就不猜
  }

  /**
   * 综合查找：aria-label → SVG path → 位置推断
   */
  function findShareButton() {
    const byLabel = findByLabel();
    if (byLabel) {
      log('findShareButton matched by label:', byLabel.getAttribute('aria-label'));
      return byLabel;
    }

    const bySvg = findBySvgShare();
    if (bySvg) {
      log('findShareButton matched by svg share icon');
      return bySvg;
    }

    log('findShareButton did not find a safe share button; skip position fallback');
    return null;
  }

  /**
   * 停止共享专用：只用 label 匹配，不用位置检测
   * 防止误点麦克风/摄像头按钮
   */
  function findStopShareButton() {
    // 先找 stop/停止 相关的按钮
    const stopKeywords = [
      ['stop', 'shar'], ['stop', 'present'],
      ['停止', '共享'], ['停止', '分享'], ['停止', '畫面'], ['停止', '螢幕'],
      ['dejar', 'compartir'], ['detener', 'compartir'],
      ['arrêter', 'partag'],
      ['freigabe', 'beenden'], ['teilen', 'beenden'],
      ['parar', 'compartilh'], ['interromper', 'compartilh'],
      ['共有', '停止'], ['共有', '終了'],
      ['공유', '중지'], ['공유', '중단'],
      ['interrompi', 'condivisi'],
      ['остановить', 'демонстрац'], ['прекратить', 'демонстрац'],
      ['dừng', 'chia'],
      ['หยุด', 'แชร์'],
      ['berhenti', 'berbagi'], ['hentikan', 'berbagi'],
      ['paylaşım', 'durdur'],
      ['delen', 'stoppen'],
      ['sluta', 'dela'],
      ['zatrzymaj', 'udostępni'],
      ['إيقاف', 'مشاركة'],
    ];

    const allBtns = document.querySelectorAll('[role="button"][aria-label], button[aria-label]');
    for (const btn of allBtns) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      for (const [a, b] of stopKeywords) {
        if (label.includes(a.toLowerCase()) && label.includes(b.toLowerCase())) {
          return btn;
        }
      }
    }
    // 如果没找到 stop 按钮，用普通 label 匹配（但绝不用位置检测）
    return null;
  }

  // ---- 工具函数 ----
  function clickNativeStopShareOnce(reason) {
    const btn = findStopShareButton();
    if (!btn) {
      log('no explicit native stop share button found:', reason);
      return false;
    }
    log('click explicit native stop share:', reason, btn.getAttribute('aria-label') || '(no aria-label)');
    realClick(btn);
    return true;
  }

  function triggerNativeStopShare() {
    const delays = [0, 250, 700, 1400];
    log('triggerNativeStopShare start');
    delays.forEach((delay) => {
      setTimeout(() => {
        const btn = findStopShareButton();
        if (!btn) return;
        log('trigger native stop share, delay=', delay, 'label=', btn.getAttribute('aria-label'));
        realClick(btn);
      }, delay);
    });
  }

  function realClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      try {
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
        }));
      } catch (e) {}
    });
    try { el.click(); } catch (e) {}
  }

  function getLastShareButton() {
    if (!lastShareButton) return null;
    if (!lastShareButton.isConnected) return null;
    if (lastShareButton.offsetParent === null) return null;
    log('use lastShareButton fallback:', lastShareButton.getAttribute('aria-label') || '(no aria-label)');
    return lastShareButton;
  }

  function nudgeMessengerLayout(reason) {
    log('nudge Messenger layout:', reason);
    [0, 120, 400, 900].forEach((delay) => {
      setTimeout(() => {
        const x = Math.max(1, Math.floor(window.innerWidth / 2));
        const y = Math.max(1, Math.floor(window.innerHeight / 2));
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('scroll'));

        const target = document.elementFromPoint(x, y) || document.body || document.documentElement;
        ['mousemove', 'mouseover'].forEach((type) => {
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
          }));
        });

        const root = document.documentElement;
        const previous = root.style.transform;
        root.style.transform = 'translateZ(0)';
        requestAnimationFrame(() => { root.style.transform = previous; });
      }, delay);
    });
  }

  function toInject(type, data) {
    window.postMessage({ type: PREFIX + type, data }, '*');
  }

  // ---- 摄像头检测 ----
  function findBySvg(prefix) {
    const found = [];
    document.querySelectorAll('[role="button"]').forEach((btn) => {
      for (const p of btn.querySelectorAll('svg path')) {
        if ((p.getAttribute('d') || '').startsWith(prefix)) { found.push(btn); break; }
      }
    });
    return found;
  }

  function isCameraOn() {
    return findBySvg(CAM_ON_SVG).some((b) => b.offsetParent !== null);
  }

  function enableCamera() {
    let clicked = 0;
    findBySvg(CAM_OFF_SVG).forEach((btn) => {
      if (btn.offsetParent !== null) { btn.click(); clicked++; }
    });
    if (clicked === 0) {
      const kw = ['turn on video', 'turn on camera', '开启视讯', '開啟視訊', '开启摄像头'];
      document.querySelectorAll('[role="button"]').forEach((btn) => {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (kw.some((k) => label.includes(k)) && btn.offsetParent !== null) { btn.click(); clicked++; }
      });
    }
    return clicked;
  }

  function disableCamera() {
    let clicked = 0;
    findBySvg(CAM_ON_SVG).forEach((btn) => {
      if (btn.offsetParent !== null) { btn.click(); clicked++; }
    });
    if (clicked === 0) {
      const kw = ['turn off video', 'turn off camera', '关闭视讯', '關閉視訊', '关闭摄像头'];
      document.querySelectorAll('[role="button"]').forEach((btn) => {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (kw.some((k) => label.includes(k)) && btn.offsetParent !== null) { btn.click(); clicked++; }
      });
    }
    return clicked;
  }

  // ---- 嵌入浮动按钮面板 ----
  const DOCK_POS_KEY = 'MMS_FLOATING_DOCK_POS_V6';
  const DOCK_MARGIN = 4;
  const DOCK_TOP_MARGIN = 62;
  const DOCK_FALLBACK_WIDTH = 36;
  const DOCK_FALLBACK_HEIGHT = 72;
  let hostEl = null;
  let panel = null;
  let shareBtn = null;
  let camBtn = null;
  let isSharing = false;

  function createPanel() {
    if (panel || !isGroupCall()) return;

    // 用 Shadow DOM 隔离，防止影响 Messenger 页面布局
    const host = document.createElement('div');
    hostEl = host;
    host.id = 'mms-host';
    host.style.cssText = getSavedDockStyle();
    const shadow = host.attachShadow({ mode: 'closed' });

    // 容器 - 竖向排列（在"分线"旁边）
    panel = document.createElement('div');
    panel.style.cssText = [
      'display:grid',
      'justify-items:center',
      'gap:4px',
      'padding:4px 5px',
      'border-radius:999px',
      'background:rgba(14,23,38,0.52)',
      'border:1px solid rgba(255,255,255,0.22)',
      'box-shadow:0 10px 26px rgba(0,0,0,0.32)',
      'backdrop-filter:blur(10px)',
      'user-select:none',
      'cursor:grab',
      'opacity:0.52',
      'transition:opacity .16s ease, transform .16s ease',
    ].join(';');
    panel.addEventListener('mouseenter', () => {
      panel.style.opacity = '1';
      panel.style.transform = 'translateY(-1px)';
    });
    panel.addEventListener('mouseleave', () => {
      panel.style.opacity = '0.52';
      panel.style.transform = 'translateY(0)';
    });

    const handle = document.createElement('div');
    handle.title = '拖动移动按钮位置';
    handle.textContent = '⋮';
    handle.style.cssText = [
      'width:24px',
      'height:10px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'border-radius:999px',
      'color:rgba(255,255,255,0.86)',
      'font-size:13px',
      'font-weight:900',
      'cursor:grab',
      'touch-action:none',
    ].join(';');
    handle.style.transform = 'rotate(90deg)';
    enableDockDrag(host, panel);

    // 共享按钮
    shareBtn = makeIconBtn(shadow, '📺', '#0084ff', 'IG通话共享', 24, 12);
    shareBtn.addEventListener('click', async () => {
      log('共享按钮被点击, isSharing=', isSharing);
      shareBtn.style.opacity = '0.5';
      shareBtn.style.pointerEvents = 'none';
      try {
        if (!chrome.runtime?.id) {
          log('扩展已失效，请刷新页面');
          alert('扩展已更新，请刷新此页面后重试');
          return;
        }
        // 先发一个 PING 唤醒 Service Worker，避免第一次点击没反应
        await chrome.runtime.sendMessage({ type: 'PING' }).catch(() => {});
        if (isSharing) {
          // 停止：直接发 STOP_SHARING，避免 Service Worker 重启后状态丢失导致误启动
          await chrome.runtime.sendMessage({ type: 'STOP_SHARING' });
          updateShareBtn(false);
        } else {
          const result = await chrome.runtime.sendMessage({ type: 'TOGGLE_SHARING' });
          log('TOGGLE_SHARING 返回:', JSON.stringify(result));
          if (result?.sharing !== undefined) updateShareBtn(result.sharing);
        }
      } catch (e) {
        log('切换共享失败:', e.message);
        alert('操作失败: ' + e.message + '\n请刷新页面后重试');
      } finally {
        shareBtn.style.opacity = '1';
        shareBtn.style.pointerEvents = 'auto';
      }
    });

    // 摄像头按钮
    camBtn = makeIconBtn(shadow, '📷', '#27ae60', '批量开摄像头', 20, 10);
    camBtn.addEventListener('click', () => {
      const enable = !isCameraOn();
      if (enable) enableCamera(); else disableCamera();
      try { safeSendBg({ type: 'TOGGLE_ALL_CAMERAS', enable }); } catch (e) {}
      setTimeout(syncCamBtn, 500);
    });

    panel.appendChild(handle);
    panel.appendChild(shareBtn);
    panel.appendChild(camBtn);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
    clampDockIntoViewport();
    log('已嵌入控制面板 (Shadow DOM)');

    syncCamBtn();
    // 获取共享状态
    try {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
        if (state) updateShareBtn(state.sharing);
      });
    } catch (e) {}
  }

  function makeIconBtn(shadow, icon, bg, title, size = 24, fontSize = 12) {
    const btn = document.createElement('div');
    btn.textContent = icon;
    btn.title = title;
    Object.assign(btn.style, {
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: `${fontSize}px`,
      cursor: 'pointer',
      background: bg,
      color: '#fff',
      boxShadow: '0 2px 8px rgba(0,0,0,0.26)',
      transition: 'opacity 0.2s, transform 0.15s',
    });
    btn.addEventListener('mouseenter', () => (btn.style.transform = 'scale(1.15)'));
    btn.addEventListener('mouseleave', () => (btn.style.transform = 'scale(1)'));
    return btn;
  }

  function getSavedDockStyle() {
    const base = [
      'position:fixed',
      'z-index:999999',
      'left:auto',
      'bottom:115px',
      'right:55px',
      'top:auto',
    ];

    try {
      const saved = JSON.parse(localStorage.getItem(DOCK_POS_KEY) || 'null');
      const pos = getDockPositionFromSaved(saved);
      if (pos) {
        base[2] = `left:${pos.left}px`;
        base[3] = `top:${pos.top}px`;
        base[4] = 'right:auto';
        base[5] = 'bottom:auto';
      }
    } catch (e) {}

    return base.join(';') + ';';
  }

  function getDockPositionFromSaved(saved) {
    if (!saved) return null;

    const dockWidth = hostEl?.offsetWidth || DOCK_FALLBACK_WIDTH;
    const dockHeight = hostEl?.offsetHeight || DOCK_FALLBACK_HEIGHT;
    const maxLeft = Math.max(DOCK_MARGIN, window.innerWidth - dockWidth - DOCK_MARGIN);
    const maxTop = Math.max(DOCK_TOP_MARGIN, window.innerHeight - dockHeight - DOCK_MARGIN);

    if (Number.isFinite(saved.xRatio) && Number.isFinite(saved.yRatio)) {
      return {
        left: clamp(Math.round(saved.xRatio * window.innerWidth), DOCK_MARGIN, maxLeft),
        top: clamp(Math.round(saved.yRatio * window.innerHeight), DOCK_TOP_MARGIN, maxTop),
      };
    }

    if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      return {
        left: clamp(saved.left, DOCK_MARGIN, maxLeft),
        top: clamp(saved.top, DOCK_TOP_MARGIN, maxTop),
      };
    }

    if (Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) {
      return {
        left: clamp(window.innerWidth - saved.right - dockWidth, DOCK_MARGIN, maxLeft),
        top: clamp(window.innerHeight - saved.bottom - dockHeight, DOCK_TOP_MARGIN, maxTop),
      };
    }

    return null;
  }

  function saveDockPosition(host) {
    const rect = host.getBoundingClientRect();
    try {
      localStorage.setItem(DOCK_POS_KEY, JSON.stringify({
        mode: 'relative-point',
        xRatio: clamp(rect.left / Math.max(1, window.innerWidth), 0, 1),
        yRatio: clamp(rect.top / Math.max(1, window.innerHeight), 0, 1),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      }));
    } catch (e) {}
  }

  function clampDockIntoViewport() {
    if (!hostEl) return;
    const rect = hostEl.getBoundingClientRect();
    const nextLeft = clamp(rect.left, DOCK_MARGIN, Math.max(DOCK_MARGIN, window.innerWidth - hostEl.offsetWidth - DOCK_MARGIN));
    const nextTop = clamp(rect.top, DOCK_TOP_MARGIN, Math.max(DOCK_TOP_MARGIN, window.innerHeight - hostEl.offsetHeight - DOCK_MARGIN));
    hostEl.style.left = `${nextLeft}px`;
    hostEl.style.top = `${nextTop}px`;
    hostEl.style.right = 'auto';
    hostEl.style.bottom = 'auto';
  }

  function restoreDockPosition() {
    if (!hostEl) return;
    try {
      const saved = JSON.parse(localStorage.getItem(DOCK_POS_KEY) || 'null');
      const pos = getDockPositionFromSaved(saved);
      if (pos) {
        hostEl.style.left = `${pos.left}px`;
        hostEl.style.top = `${pos.top}px`;
        hostEl.style.right = 'auto';
        hostEl.style.bottom = 'auto';
        return;
      }
    } catch (e) {}
    clampDockIntoViewport();
  }

  function enableDockDrag(host, handle) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (event.target === shareBtn || event.target === camBtn) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      moved = false;
      const rect = host.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      handle.style.cursor = 'grabbing';
      try { handle.setPointerCapture(event.pointerId); } catch (e) {}
      event.preventDefault();
      event.stopPropagation();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const nextLeft = clamp(startLeft + event.clientX - startX, DOCK_MARGIN, window.innerWidth - host.offsetWidth - DOCK_MARGIN);
      const nextTop = clamp(startTop + event.clientY - startY, DOCK_TOP_MARGIN, window.innerHeight - host.offsetHeight - DOCK_MARGIN);
      if (Math.abs(event.clientX - startX) > 3 || Math.abs(event.clientY - startY) > 3) moved = true;
      host.style.left = `${nextLeft}px`;
      host.style.top = `${nextTop}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      event.preventDefault();
      event.stopPropagation();
    });

    const finish = () => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = 'grab';
      saveDockPosition(host);
    };

    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('click', (event) => {
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    }, true);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  let dockResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(dockResizeTimer);
    dockResizeTimer = setTimeout(restoreDockPosition, 80);
  });

  function updateShareBtn(sharing) {
    isSharing = sharing;
    if (!shareBtn) return;
    if (sharing) {
      shareBtn.textContent = '⏹';
      shareBtn.title = '停止共享';
      shareBtn.style.background = '#e74c3c';
    } else {
      shareBtn.textContent = '📺';
      shareBtn.title = 'IG通话共享';
      shareBtn.style.background = '#0084ff';
    }
  }

  function updateButton(sharing) { updateShareBtn(sharing); }

  function syncCamBtn() {
    if (!camBtn) return;
    if (isCameraOn()) {
      camBtn.title = '批量关摄像头';
      camBtn.style.background = '#e74c3c';
    } else {
      camBtn.title = '批量开摄像头';
      camBtn.style.background = '#27ae60';
    }
  }

  // 定时刷新摄像头状态
  setInterval(() => {
    if (isGroupCall()) {
      createPanel();
      syncCamBtn();
    }
  }, 2000);

  // 等页面加载完再插入
  if (document.readyState === 'complete') {
    createPanel();
  } else {
    window.addEventListener('load', createPanel);
  }

  log('已加载, URL:', window.location.href, 'instagram-call:', isGroupCall());
})();
