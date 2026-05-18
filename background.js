/**
 * background.js - Service Worker
 * 源窗口放大1000x1000并置顶
 * 接收端：先尝试直接点击，找不到按钮再拉宽到800
 * WebRTC 流的等待交给 inject.js 的 getDisplayMedia 拦截处理
 */

// ---- 状态 ----
let sourceTabId = null;
const receiverTabs = new Set();
const receiverReadyWaiters = new Map();
const receiverConsumedWaiters = new Map();
const receiverReadyState = new Set();
const receiverConsumedState = new Set();
let sharing = false;
let stopping = false; // 防止 stopSharing 重入
let selectedTabIds = null; // 弹窗勾选的标签页 ID 列表（用于浮动按钮）
// windowId -> { width, height, left, top, refCount }
// refCount 记录有多少 tab 关联此窗口，直到最后一个 tab 恢复完才删除记录
const savedWindowSizes = new Map();
const LOG_LIMIT = 500;
const eventLog = [];
const tabDiagnostics = new Map();
let lastStartAt = null;
let lastStopAt = null;

// ---- 消息处理 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromTabId = sender.tab?.id;

  switch (msg.type) {
    case 'GET_STATE':
      sendResponse(getState());
      return true;

    case 'GET_DIAGNOSTICS':
      collectDiagnostics().then((diagnostics) => sendResponse(diagnostics));
      return true;

    case 'START_SHARING':
      startSharing(msg.tabIds).then(() => sendResponse({ ok: true }));
      return true;

    case 'STOP_SHARING':
      stopSharing().then(() => sendResponse({ ok: true }));
      return true;

    case 'UPDATE_SELECTION':
      selectedTabIds = msg.tabIds || null;
      log('弹窗勾选更新:', selectedTabIds);
      sendResponse({ ok: true });
      return true;

    case 'TOGGLE_SHARING':
      log('收到 TOGGLE_SHARING, fromTabId=', fromTabId);
      toggleSharing(fromTabId)
        .then((result) => {
          log('TOGGLE_SHARING 结果:', JSON.stringify(result));
          sendResponse(result);
        })
        .catch((e) => {
          log('TOGGLE_SHARING 异常:', e.message);
          sendResponse({ ok: false, error: e.message, sharing: false });
        });
      return true;

    case 'REFRESH_TABS':
      refreshCallTabs().then((tabs) => sendResponse({ tabs }));
      return true;

    case 'SOURCE_READY':
      log('源标签页已捕获屏幕，立即恢复源窗口');
      restoreWindow(sourceTabId);
      handleSourceReady();
      break;

    case 'SOURCE_ENDED':
      log('源流已结束, stopping=', stopping);
      if (!stopping) stopSharing();
      break;

    case 'RECEIVER_READY':
      log(`receiver ready: tab ${fromTabId}`);
      markTab(fromTabId, { streamReady: true, lastEvent: 'receiver-ready' });
      resolveReceiverEvent(receiverReadyWaiters, receiverReadyState, fromTabId, 'ready');
      break;

    case 'RECEIVER_SHARE_CONSUMED':
      log(`receiver consumed share: tab ${fromTabId}`);
      markTab(fromTabId, { consumed: true, lastEvent: 'receiver-consumed' });
      resolveReceiverEvent(receiverConsumedWaiters, receiverConsumedState, fromTabId, 'consumed');
      break;

    case 'RECEIVER_SHARE_TIMEOUT':
      log(`receiver share timeout event: tab ${fromTabId}`);
      markTab(fromTabId, { error: 'receiver share timeout', lastEvent: 'receiver-timeout' });
      rejectReceiverWaiter(receiverConsumedWaiters, fromTabId, 'receiver share timeout');
      break;

    case 'SIGNAL':
      relaySignal(fromTabId, msg.targetTabId, msg.signal);
      break;

    case 'CONNECTION_FAILED':
      log(`连接失败: tab ${msg.remoteTabId}`);
      markTab(msg.remoteTabId, { error: 'connection failed', lastEvent: 'connection-failed' });
      break;

    // ---- 摄像头批量控制 ----
    case 'TOGGLE_ALL_CAMERAS':
      toggleAllCameras(fromTabId, msg.enable).then(() => sendResponse({ ok: true }));
      return true;

    case 'TOGGLE_ALL_CAMERAS_FROM_POPUP':
      toggleAllCameras(null, msg.enable).then(() => sendResponse({ ok: true }));
      return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  receiverTabs.delete(tabId);
  if (tabId === sourceTabId) {
    log('源标签页已关闭');
    stopSharing();
  }
});

// ---- 核心逻辑 ----

async function toggleSharing(fromTabId) {
  log('toggleSharing called, sharing=', sharing, 'fromTabId=', fromTabId);

  if (sharing) {
    await stopSharing();
    return { ok: true, sharing: false };
  }

  // 自动发现所有 groupcall 标签页
  const callTabs = await refreshCallTabs();
  log('检测到通话标签页:', callTabs.length, callTabs.map(t => t.id));
  if (callTabs.length < 1) return { ok: false, error: '没有检测到通话窗口', sharing: false };

  let tabIds;
  if (selectedTabIds && selectedTabIds.length > 0) {
    // 使用弹窗勾选的标签页（尊重用户选择）
    const validIds = selectedTabIds.filter((id) => callTabs.some((t) => t.id === id));
    if (validIds.length > 0) {
      // 确保触发按钮的标签页在最前面（作为源）
      if (validIds.includes(fromTabId)) {
        tabIds = [fromTabId, ...validIds.filter((id) => id !== fromTabId)];
      } else {
        tabIds = [fromTabId, ...validIds.filter((id) => id !== fromTabId)];
      }
    } else {
      // 勾选的标签页都失效了，回退到全部
      tabIds = [fromTabId, ...callTabs.filter((t) => t.id !== fromTabId).map((t) => t.id)];
    }
  } else {
    // 没有弹窗勾选记录，使用全部标签页
    tabIds = [fromTabId, ...callTabs.filter((t) => t.id !== fromTabId).map((t) => t.id)];
  }

  log('开始共享, tabIds=', tabIds, '(弹窗勾选:', selectedTabIds, ')');
  await startSharing(tabIds);
  return { ok: true, sharing: true };
}

async function startSharing(tabIds) {
  if (!tabIds || tabIds.length < 1) return;

  sharing = true;
  lastStartAt = new Date().toISOString();
  sourceTabId = tabIds[0];
  receiverTabs.clear();
  tabIds.slice(1).forEach((id) => receiverTabs.add(id));
  tabIds.forEach((id) => markTab(id, {
    role: id === sourceTabId ? 'source' : 'receiver',
    injected: false,
    shareButtonFound: null,
    streamReady: false,
    consumed: false,
    error: null,
    lastEvent: 'start-sharing',
  }));

  log(`源: tab ${sourceTabId}, 接收端: [${[...receiverTabs].join(', ')}]`);

  // 确保所有标签页脚本已加载
  await ensureScripts(sourceTabId);
  for (const tabId of receiverTabs) {
    await ensureScripts(tabId);
  }

  // 放大源窗口到 1000x1000 并置顶
  await saveAndResize(sourceTabId, 1000, 1000);
  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    await chrome.windows.update(sourceTab.windowId, { focused: true });
  } catch (e) {
    log('置顶源窗口失败:', e.message);
  }
  await sleep(500);

  // 设置角色
  await safeSend(sourceTabId, { type: 'SET_ROLE', role: 'source' });
  for (const tabId of receiverTabs) {
    await safeSend(tabId, { type: 'SET_ROLE', role: 'receiver' });
  }
  await sleep(200);

  // 点击源标签页的共享按钮（用户选择窗口后触发 SOURCE_READY）
  await safeSend(sourceTabId, { type: 'CLICK_SHARE' });
  broadcastState();
}

/**
 * 源标签页已捕获屏幕后的处理
 * 关键改进：不再等 WebRTC 流，先发起连接，然后直接去点击按钮
 * inject.js 的 getDisplayMedia 拦截会自动等流到达
 */
async function handleSourceReady() {
  if (receiverTabs.size === 0) {
    log('没有接收端，恢复窗口');
    await restoreAllWindows();
    return;
  }

  // 防止 Service Worker 在长时间操作中被终止
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 4000);

  try {
    // 保存接收端列表快照（防止迭代中 Set 被修改）
    const receivers = [...receiverTabs];
    log(`source ready, begin receiver pipeline from source tab ${sourceTabId}`);
    log(`共 ${receivers.length} 个接收端: [${receivers.join(', ')}]`);

    // 1. 同时发起所有 WebRTC 连接（不等待）
    log('发起所有 WebRTC 连接...');
    for (const receiverTabId of receivers) {
      log(`send create_offer: source ${sourceTabId} -> receiver ${receiverTabId}`);
      safeSend(sourceTabId, {
        type: 'CREATE_OFFER',
        targetTabId: receiverTabId,
      });
    }

    // 给 WebRTC 信令一点时间开始交换
    await sleep(300);

    // 2. 逐个处理接收端：拉宽 → 点击 → 立即缩回
    for (let i = 0; i < receivers.length; i++) {
      const receiverTabId = receivers[i];
      log(`--- 处理接收端 ${i + 1}/${receivers.length}: tab ${receiverTabId} ---`);

      try {
        log(`wait receiver ready start: tab ${receiverTabId}`);
        await waitForReceiverReady(receiverTabId, 12000);
        log(`wait receiver ready done: tab ${receiverTabId}`);
        // 拉宽窗口到 800（高度不变）
        await saveAndResize(receiverTabId, 800, null);
        await sleep(500);

        // 点击共享按钮
        log(`click share request: tab ${receiverTabId}`);
        const result = await safeSend(receiverTabId, { type: 'CLICK_SHARE' });
        markTab(receiverTabId, {
          shareButtonFound: !!result?.found,
          lastEvent: result?.found ? 'click-share-found' : 'click-share-not-found',
          error: result?.found ? null : 'share button not found',
        });
        if (result?.found) {
          log(`wait receiver consumed start: tab ${receiverTabId}`);
          await waitForReceiverConsumed(receiverTabId, 12000);
          log(`wait receiver consumed done: tab ${receiverTabId}`);
        } else {
          log(`click share not found: tab ${receiverTabId}; skipped to avoid mis-clicking call controls`);
        }
        log(`tab ${receiverTabId} ${result?.found ? '✅ 点击成功' : '❌ 未找到按钮'}`);

        // 立即恢复这个窗口
        await sleep(300);
        await restoreWindow(receiverTabId);
      } catch (e) {
        log(`❌ 处理接收端 tab ${receiverTabId} 出错:`, e.message);
        // 继续处理下一个，不中断
      }
    }

    log('✅ 全部处理完成');
    broadcastState();
  } finally {
    clearInterval(keepAlive);
  }
}

/**
 * 保存窗口原始尺寸并调整大小
 */
async function saveAndResize(tabId, width, height) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);

    if (!savedWindowSizes.has(tab.windowId)) {
      savedWindowSizes.set(tab.windowId, {
        width: win.width, height: win.height,
        left: win.left, top: win.top,
        refCount: 1,
      });
    } else {
      savedWindowSizes.get(tab.windowId).refCount++;
    }

    // 智能决定扩展方向：找到窗口所在的显示器
    let screenLeft = 0, screenRight = 1920;
    try {
      const displays = await chrome.system.display.getInfo();
      for (const d of displays) {
        const dl = d.bounds.left;
        const dr = dl + d.bounds.width;
        const winCenter = win.left + win.width / 2;
        if (winCenter >= dl && winCenter < dr) {
          screenLeft = dl;
          screenRight = dr;
          break;
        }
      }
    } catch (e) {
      log('获取显示器信息失败，使用默认值');
    }

    let newLeft = win.left;
    if (win.left + width > screenRight) {
      // 右边没空间，向左扩展（保持右边缘不动）
      newLeft = Math.max(screenLeft, win.left + win.width - width);
    }
    const update = { width, left: newLeft };
    if (height !== null) update.height = height;

    log(`调整窗口 ${tab.windowId}: ${win.width}x${win.height} @ left=${win.left} → ${width}x${height || win.height} @ left=${newLeft}`);
    await chrome.windows.update(tab.windowId, update);
  } catch (e) {
    log('调整窗口失败:', e.message);
  }
}

async function restoreWindow(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const entry = savedWindowSizes.get(tab.windowId);
    if (entry) {
      entry.refCount--;
      if (entry.refCount <= 0) {
        // 最后一个关联 tab，恢复窗口并删除记录
        await chrome.windows.update(tab.windowId, {
          width: entry.width, height: entry.height,
          left: entry.left, top: entry.top,
        });
        savedWindowSizes.delete(tab.windowId);
        log(`恢复窗口 ${tab.windowId} (最后一个 tab)`);
      } else {
        log(`窗口 ${tab.windowId} 还有 ${entry.refCount} 个 tab 待恢复，暂不恢复尺寸`);
      }
    }
  } catch (e) {
    log('恢复窗口失败:', e.message);
  }
}

async function restoreAllWindows() {
  for (const [windowId, size] of savedWindowSizes) {
    try {
      await chrome.windows.update(windowId, {
        width: size.width, height: size.height,
        left: size.left, top: size.top,
      });
    } catch (e) {
      log('恢复窗口失败:', e.message);
    }
  }
  savedWindowSizes.clear();
}

function relaySignal(fromTabId, targetTabId, signal) {
  safeSend(targetTabId, { type: 'SIGNAL', fromTabId, signal });
}

async function stopSharing() {
  if (stopping) {
    log('stopSharing 正在执行中，跳过重复调用');
    return;
  }
  stopping = true;
  sharing = false;
  lastStopAt = new Date().toISOString();

  const trackedTabs = [sourceTabId, ...receiverTabs].filter(Boolean);
  trackedTabs.forEach((tabId) => {
    clearReceiverWaiter(receiverReadyWaiters, tabId);
    clearReceiverWaiter(receiverConsumedWaiters, tabId);
    receiverReadyState.delete(tabId);
    receiverConsumedState.delete(tabId);
  });
  // 先清空状态，防止 SOURCE_ENDED 回调再次触发
  sourceTabId = null;
  receiverTabs.clear();

  // 同时发现所有通话标签页（防止 Service Worker 重启后状态丢失，遗漏未跟踪的标签页）
  let allCallTabIds = [];
  try {
    allCallTabIds = (await refreshCallTabs()).map((t) => t.id);
  } catch (e) {}

  // 合并已跟踪 + 发现的标签页，去重
  const allTabs = [...new Set([...trackedTabs, ...allCallTabIds])];
  log(`stop sharing tabs detail: tracked=[${trackedTabs.join(', ')}], discovered=[${allCallTabIds.join(', ')}], all=[${allTabs.join(', ')}]`);
  log(`停止共享: ${allTabs.length} 个标签页 (跟踪=${trackedTabs.length}, 发现=${allCallTabIds.length})`);
  allTabs.forEach((tabId) => markTab(tabId, { lastEvent: 'stop-sharing' }));

  // 并行发送 STOP_SHARING 给所有标签页
  await Promise.all(allTabs.map((tabId) => safeSend(tabId, { type: 'STOP_SHARING' })));

  await sleep(500);
  await restoreAllWindows();
  await nudgeCallLayouts(allTabs, 'stop-sharing-after-restore');
  broadcastState();
  stopping = false;
  log('已停止所有共享');
}

async function refreshCallTabs() {
  const tabs = await chrome.tabs.query({
    url: ['https://www.instagram.com/*'],
  });
  return tabs
    .filter((t) => isInstagramCallUrl(t.url))
    .map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, inCall: true }));
}

function isInstagramCallUrl(url) {
  return typeof url === 'string' && /^https:\/\/www\.instagram\.com\/call\/?/i.test(url);
}

// ---- 工具函数 ----

async function ensureScripts(tabId) {
  const pong = await safeSend(tabId, { type: 'PING' });
  if (pong?.ok) {
    markTab(tabId, { injected: true, lastEvent: 'script-ping-ok' });
    return;
  }
  log(`tab ${tabId} 需要注入脚本`);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['inject.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    log(`已注入脚本到 tab ${tabId}`);
    markTab(tabId, { injected: true, lastEvent: 'script-injected', error: null });
  } catch (e) {
    log(`注入失败 tab ${tabId}:`, e.message);
    markTab(tabId, { injected: false, lastEvent: 'script-inject-failed', error: e.message });
  }
  await sleep(500);
}

function getState() {
  return { sharing, sourceTabId, receiverTabs: [...receiverTabs] };
}

async function broadcastState() {
  const state = getState();
  // 通知 popup
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
  // 只通知参与共享的标签页（不通知未选中的组）
  try {
    const sharingTabs = [sourceTabId, ...receiverTabs].filter(Boolean);
    if (state.sharing && sharingTabs.length > 0) {
      // 共享中：只通知参与的标签页
      for (const tabId of sharingTabs) {
        safeSend(tabId, { type: 'UPDATE_BUTTON', sharing: true });
      }
      // 其余标签页设为未共享
      const tabs = await chrome.tabs.query({
        url: ['https://www.instagram.com/*'],
      });
      for (const tab of tabs) {
        if (isInstagramCallUrl(tab.url) && !sharingTabs.includes(tab.id)) {
          safeSend(tab.id, { type: 'UPDATE_BUTTON', sharing: false });
        }
      }
    } else {
      // 未共享：通知所有标签页
      const tabs = await chrome.tabs.query({
        url: ['https://www.instagram.com/*'],
      });
      for (const tab of tabs) {
        if (isInstagramCallUrl(tab.url)) {
          safeSend(tab.id, { type: 'UPDATE_BUTTON', sharing: false });
        }
      }
    }
  } catch (e) {}
}

async function safeSend(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    log(`发送消息到 tab ${tabId} 失败:`, e.message);
    markTab(tabId, { error: e.message, lastEvent: `send-${msg?.type || 'message'}-failed` });
    return null;
  }
}

async function nudgeCallLayouts(tabIds, reason) {
  const uniqueTabIds = [...new Set(tabIds.filter(Boolean))];
  log(`nudge call layouts: ${reason}, tabs=[${uniqueTabIds.join(', ')}]`);
  await Promise.all(uniqueTabIds.map((tabId) => safeSend(tabId, { type: 'NUDGE_LAYOUT', reason })));
  await sleep(700);
  await Promise.all(uniqueTabIds.map((tabId) => safeSend(tabId, { type: 'NUDGE_LAYOUT', reason: `${reason}-late` })));
}

function waitForReceiverReady(tabId, timeoutMs) {
  return waitForReceiverEvent(receiverReadyWaiters, tabId, timeoutMs, 'receiver ready timeout');
}

function waitForReceiverConsumed(tabId, timeoutMs) {
  return waitForReceiverEvent(receiverConsumedWaiters, tabId, timeoutMs, 'receiver consume timeout');
}

function waitForReceiverEvent(store, tabId, timeoutMs, timeoutMessage) {
  const stateStore = store === receiverReadyWaiters ? receiverReadyState : receiverConsumedState;
  const phase = store === receiverReadyWaiters ? 'ready' : 'consumed';
  if (stateStore.has(tabId)) {
    log(`wait receiver ${phase} immediate hit: tab ${tabId}`);
    stateStore.delete(tabId);
    return Promise.resolve(true);
  }
  clearReceiverWaiter(store, tabId);
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      store.delete(tabId);
      log(`wait receiver ${phase} timeout: tab ${tabId}`);
      reject(new Error(`${timeoutMessage}: ${tabId}`));
    }, timeoutMs);
    log(`register receiver ${phase} waiter: tab ${tabId}, timeout=${timeoutMs}`);
    store.set(tabId, { resolve, reject, timeoutId });
  });
}

function resolveReceiverEvent(waiters, stateStore, tabId, value) {
  const phase = waiters === receiverReadyWaiters ? 'ready' : 'consumed';
  const waiter = waiters.get(tabId);
  if (!waiter) {
    log(`receiver ${phase} arrived before waiter: tab ${tabId}`);
    stateStore.add(tabId);
    return;
  }
  clearTimeout(waiter.timeoutId);
  waiters.delete(tabId);
  stateStore.delete(tabId);
  log(`resolve receiver ${phase} waiter: tab ${tabId}`);
  waiter.resolve(value);
}

function resolveReceiverWaiter(store, tabId, value) {
  const waiter = store.get(tabId);
  if (!waiter) return;
  clearTimeout(waiter.timeoutId);
  store.delete(tabId);
  waiter.resolve(value);
}

function rejectReceiverWaiter(store, tabId, message) {
  const waiter = store.get(tabId);
  const stateStore = store === receiverReadyWaiters ? receiverReadyState : receiverConsumedState;
  const phase = store === receiverReadyWaiters ? 'ready' : 'consumed';
  stateStore.delete(tabId);
  log(`reject receiver ${phase} waiter: tab ${tabId}, reason=${message}`);
  if (!waiter) return;
  clearTimeout(waiter.timeoutId);
  store.delete(tabId);
  waiter.reject(new Error(message));
}

function clearReceiverWaiter(store, tabId) {
  const waiter = store.get(tabId);
  if (!waiter) return;
  const phase = store === receiverReadyWaiters ? 'ready' : 'consumed';
  log(`clear receiver ${phase} waiter: tab ${tabId}`);
  clearTimeout(waiter.timeoutId);
  store.delete(tabId);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- 摄像头批量控制 ----

async function toggleAllCameras(senderTabId, enable) {
  const tabs = await chrome.tabs.query({
    url: ['https://www.instagram.com/*'],
  });
  const callTabs = tabs.filter(
    (t) => isInstagramCallUrl(t.url) && t.id !== senderTabId
  );
  log(`批量${enable ? '开启' : '关闭'}摄像头: ${callTabs.length} 个标签页`);

  for (const tab of callTabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (enable) => {
          const CAM_OFF_SVG = 'M4.366 29.135a1.25 1.25 0 0 1-.043-1.723';
          const CAM_ON_SVG = 'M9 9.5a4 4 0 0 0-4 4v9a4 4 0 0 0 4 4h10a4';
          function findBySvg(prefix) {
            const found = [];
            document.querySelectorAll('[role="button"]').forEach((btn) => {
              for (const p of btn.querySelectorAll('svg path')) {
                if ((p.getAttribute('d') || '').startsWith(prefix)) { found.push(btn); break; }
              }
            });
            return found;
          }
          if (enable) {
            let clicked = 0;
            findBySvg(CAM_OFF_SVG).forEach((btn) => {
              if (btn.offsetParent !== null) { btn.click(); clicked++; }
            });
            if (clicked === 0) {
              const kw = ['turn on video', 'turn on camera', '开启视讯', '開啟視訊', '开启摄像头'];
              document.querySelectorAll('[role="button"]').forEach((btn) => {
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (kw.some((k) => label.includes(k)) && btn.offsetParent !== null) btn.click();
              });
            }
          } else {
            let clicked = 0;
            findBySvg(CAM_ON_SVG).forEach((btn) => {
              if (btn.offsetParent !== null) { btn.click(); clicked++; }
            });
            if (clicked === 0) {
              const kw = ['turn off video', 'turn off camera', '关闭视讯', '關閉視訊', '关闭摄像头'];
              document.querySelectorAll('[role="button"]').forEach((btn) => {
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (kw.some((k) => label.includes(k)) && btn.offsetParent !== null) btn.click();
              });
            }
          }
        },
        args: [enable],
      });
    } catch (e) {
      log(`摄像头切换失败 tab ${tab.id}:`, e.message);
    }
  }
}

function log(...args) {
  const entry = {
    time: new Date().toISOString(),
    args: args.map(formatLogArg),
  };
  eventLog.push(entry);
  if (eventLog.length > LOG_LIMIT) eventLog.shift();
  console.log('[MMS-bg]', ...args);
}

function markTab(tabId, patch) {
  if (!tabId) return;
  const prev = tabDiagnostics.get(tabId) || {};
  tabDiagnostics.set(tabId, { ...prev, ...patch, tabId, updatedAt: new Date().toISOString() });
}

async function collectDiagnostics() {
  const callTabs = await refreshCallTabs().catch(() => []);
  const tabRows = [];
  for (const tab of callTabs) {
    const ping = await safeSend(tab.id, { type: 'PING' });
    const prev = tabDiagnostics.get(tab.id) || {};
    const injected = !!ping?.ok;
    markTab(tab.id, {
      title: tab.title,
      injected,
      inCall: true,
      lastEvent: injected ? (prev.lastEvent || 'diagnostic-ping-ok') : 'diagnostic-ping-failed',
    });
    const next = tabDiagnostics.get(tab.id) || {};
    tabRows.push({
      tabId: tab.id,
      title: tab.title || '(通话)',
      role: next.role || (tab.id === sourceTabId ? 'source' : receiverTabs.has(tab.id) ? 'receiver' : 'idle'),
      injected: next.injected === true,
      shareButtonFound: next.shareButtonFound,
      streamReady: next.streamReady === true,
      consumed: next.consumed === true,
      error: next.error || '',
      lastEvent: next.lastEvent || '',
      updatedAt: next.updatedAt || '',
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
    sharing,
    stopping,
    sourceTabId,
    receiverTabs: [...receiverTabs],
    selectedTabIds,
    lastStartAt,
    lastStopAt,
    callTabCount: callTabs.length,
    selectedCount: selectedTabIds?.length || 0,
    tabs: tabRows,
    logs: eventLog.slice(),
  };
}

function formatLogArg(arg) {
  if (typeof arg === 'string') return sanitizeText(arg);
  if (arg instanceof Error) return sanitizeText(arg.message);
  try {
    return sanitizeText(JSON.stringify(arg));
  } catch {
    return String(arg);
  }
}

function sanitizeText(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
}
