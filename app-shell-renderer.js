/* global window */

const panels = {
  chat: document.getElementById('chatPanel'),
  shell: document.getElementById('shellPanel'),
  runtime: document.getElementById('runtimePanel'),
};

const navButtons = [...document.querySelectorAll('[data-panel]')];
const chatView = document.getElementById('chatView');
const sidepanelView = document.getElementById('sidepanelView');
const backgroundView = document.getElementById('backgroundView');
const sidepanelPanel = document.getElementById('sidepanelPanel');
const appLayout = document.getElementById('appLayout');
const shellMeta = document.getElementById('shellMeta');
const shellOutput = document.getElementById('shellOutput');
const shellCommandInput = document.getElementById('shellCommandInput');
const shellCwdInput = document.getElementById('shellCwdInput');
const shellHint = document.getElementById('shellHint');
const runtimeStatusGrid = document.getElementById('runtimeStatusGrid');
const runtimeLog = document.getElementById('runtimeLog');

let isSidepanelOpen = false;
let extensionFilePort = 0;
let messageBridgeInitialized = false;
let sidepanelLoadUrl = '';
let sidepanelReady = false;
let sidepanelReloadTimer = null;
let sidepanelProbeTimer = null;
let sidepanelLoadAttempts = 0;
let sidepanelLastReloadTime = 0;
const SIDEPANEL_RELOAD_COOLDOWN = 3000;
let currentConversationMode = null;

function bindClick(id, handler) {
  const element = document.getElementById(id);
  if (element) {
    element.addEventListener('click', handler);
  }
}

function setActivePanel(panelName) {
  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = name !== panelName;
    panel.classList.toggle('active', name === panelName);
  }
  for (const button of navButtons) {
    button.classList.toggle('active', button.dataset.panel === panelName);
  }
}

for (const button of navButtons) {
  button.addEventListener('click', () => setActivePanel(button.dataset.panel));
}

function getSidepanelUrl() {
  if (extensionFilePort <= 0) return '';
  return `http://127.0.0.1:${extensionFilePort}/sidepanel.html`;
}

function clearSidepanelReloadTimer() {
  if (sidepanelReloadTimer) {
    clearTimeout(sidepanelReloadTimer);
    sidepanelReloadTimer = null;
  }
}

function clearSidepanelProbeTimer() {
  if (sidepanelProbeTimer) {
    clearTimeout(sidepanelProbeTimer);
    sidepanelProbeTimer = null;
  }
}

function resetSidepanelLoadState() {
  sidepanelReady = false;
  clearSidepanelReloadTimer();
  clearSidepanelProbeTimer();
}

function reloadSidepanel(reason) {
  if (!isSidepanelOpen || !sidepanelLoadUrl) return;
  if (sidepanelLoadAttempts >= 3) {
    console.warn('[app-shell] Sidepanel reload limit reached:', reason);
    return;
  }

  var now = Date.now();
  if (sidepanelLastReloadTime && (now - sidepanelLastReloadTime) < SIDEPANEL_RELOAD_COOLDOWN) {
    return;
  }
  sidepanelLastReloadTime = now;

  sidepanelLoadAttempts += 1;
  resetSidepanelLoadState();
  console.warn('[app-shell] Reloading sidepanel:', reason, 'attempt=', sidepanelLoadAttempts);
  sidepanelView.src = 'about:blank';
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      if (!isSidepanelOpen) return;
      sidepanelView.src = sidepanelLoadUrl;
      scheduleSidepanelReload();
    });
  });
}

function scheduleSidepanelProbe() {
  clearSidepanelProbeTimer();
  sidepanelProbeTimer = setTimeout(async function() {
    if (!isSidepanelOpen || !sidepanelReady || !sidepanelLoadUrl) return;

    try {
      const snapshot = await sidepanelView.executeJavaScript(`(() => {
        const body = document.body;
        const text = body ? (body.innerText || '').trim() : '';
        return {
          href: location.href,
          readyState: document.readyState,
          textLength: text.length,
          childCount: body ? body.childElementCount : 0,
          hasRoot: !!document.querySelector('#root, [data-reactroot]')
        };
      })()`);

      const wrongPage = !snapshot || snapshot.href !== sidepanelLoadUrl;
      const looksBlank = !snapshot || (snapshot.textLength === 0 && snapshot.childCount === 0);
      if (wrongPage || looksBlank) {
        reloadSidepanel(wrongPage ? 'wrong-url' : 'blank-dom');
      }
    } catch (error) {
      reloadSidepanel(`probe-failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }, 2000);
}

function scheduleSidepanelReload() {
  clearSidepanelReloadTimer();
  sidepanelReloadTimer = setTimeout(function() {
    if (!isSidepanelOpen || sidepanelReady || !sidepanelLoadUrl) return;
    reloadSidepanel('dom-ready-timeout');
  }, 1200);
}

function loadSidepanelWhenVisible() {
  const nextUrl = getSidepanelUrl();
  if (!nextUrl) return;

  sidepanelLoadUrl = nextUrl;
  resetSidepanelLoadState();
  sidepanelLoadAttempts = 0;
  sidepanelLastReloadTime = 0;

  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      if (!isSidepanelOpen) return;
      if (sidepanelView.src !== sidepanelLoadUrl) {
        sidepanelView.src = sidepanelLoadUrl;
      }
      scheduleSidepanelReload();
    });
  });
}

// ============================================================
// 扩展侧边栏
// ============================================================
function openSidepanel() {
  if (isSidepanelOpen) return;
  isSidepanelOpen = true;
  sidepanelPanel.classList.add('open');
  appLayout.classList.add('sidepanel-open');

  if (extensionFilePort > 0) {
    loadSidepanelWhenVisible();
  } else {
    window.deepseekClient.getExtensionFilePort().then(function(port) {
      extensionFilePort = port;
      loadSidepanelWhenVisible();
    });
  }
}
function closeSidepanel() {
  if (!isSidepanelOpen) return;
  isSidepanelOpen = false;
  resetSidepanelLoadState();
  sidepanelPanel.classList.remove('open');
  appLayout.classList.remove('sidepanel-open');
}

function toggleSidepanel() {
  if (isSidepanelOpen) {
    closeSidepanel();
  } else {
    openSidepanel();
  }
}

bindClick('toggleSidepanelBtn', toggleSidepanel);
bindClick('closeSidepanelBtn', closeSidepanel);

// 监听来自 main process 的 sidepanel open 请求
window.deepseekClient.onSidepanelOpen(() => {
  openSidepanel();
});

// ============================================================
// Shell 面板
// ============================================================
function renderShellMeta(meta) {
  shellMeta.innerHTML = '';
  const rows = [
    ['状态', meta?.ok ? 'ready' : 'error'],
    ['平台', meta?.platform || '-'],
    ['Shell', meta?.shell || '-'],
    ['默认目录', meta?.cwd || '-'],
    ['Node', meta?.node || '-'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'meta-row';
    row.innerHTML = `<strong>${label}</strong><span>${value}</span>`;
    shellMeta.appendChild(row);
  }
}

async function refreshShellStatus() {
  try {
    const status = await window.deepseekClient.getShellStatus();
    renderShellMeta(status);
    shellHint.textContent = '内置 shell 已就绪。';
    shellHint.className = 'status-ok';
  } catch (error) {
    shellHint.textContent = `读取 shell 状态失败: ${error instanceof Error ? error.message : String(error)}`;
    shellHint.className = 'status-danger';
  }
}

async function runShellCommand() {
  const command = shellCommandInput.value.trim();
  if (!command) {
    shellOutput.textContent = '请输入命令。';
    return;
  }
  shellOutput.textContent = '执行中...';
  try {
    const result = await window.deepseekClient.execShell(command, shellCwdInput.value.trim() || null);
    const pieces = [
      `$ ${command}`,
      result.stdout ? `\n[stdout]\n${result.stdout}` : '',
      result.stderr ? `\n[stderr]\n${result.stderr}` : '',
      `\n[exit] ${result.exitCode}`,
    ].filter(Boolean);
    shellOutput.textContent = pieces.join('\n');
  } catch (error) {
    shellOutput.textContent = `执行失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ============================================================
// Runtime 面板
// ============================================================
function renderRuntimeStatus(status) {
  runtimeStatusGrid.innerHTML = '';
  const cards = [
    ['项目内置浏览器', status.projectBrowserExists ? '<span class="status-ok">已安装</span>' : '<span class="status-warn">未安装</span>', status.projectBrowserBinary || status.projectRuntimeDir],
    ['浏览器', status.browserFound ? `<span class="status-ok">${status.usingProjectBrowser ? '项目内置' : '系统'}</span>` : '<span class="status-danger">未检测到</span>', status.browserBinary || '-'],
    ['Shell Native Host', status.shellHostReady ? '<span class="status-ok">已就绪</span>' : '<span class="status-danger">未就绪</span>', status.shellManifestPath || '-'],
    ['扩展目录', status.extensionExists ? '<span class="status-ok">可用</span>' : '<span class="status-warn">缺失</span>', status.extensionPath || '-'],
    ['构建产物', status.sourceDistExists ? '<span class="status-ok">存在</span>' : '<span class="status-danger">缺失</span>', status.sourceDist || '-'],
    ['目标地址', '<span class="status-ok">聊天入口</span>', status.targetUrl || '-'],
  ];
  for (const [title, value, detail] of cards) {
    const card = document.createElement('article');
    card.className = 'card status-grid';
    card.innerHTML = `<h3>${title}</h3><strong>状态</strong><span>${value}</span><strong style="margin-top:10px">详情</strong><span>${detail}</span>`;
    runtimeStatusGrid.appendChild(card);
  }
}

function setRuntimeLog(message, level = 'normal') {
  runtimeLog.textContent = message;
  runtimeLog.style.color = level === 'error' ? '#b91c1c' : level === 'ok' ? '#0f766e' : '#5f7186';
}

async function refreshRuntimeStatus() {
  try {
    const status = await window.deepseekClient.getStatus();
    renderRuntimeStatus(status);
    return status;
  } catch (error) {
    setRuntimeLog(`读取运行时状态失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
    return null;
  }
}

async function withRuntimeAction(message, action, successMessage) {
  setRuntimeLog(message);
  try {
    const result = await action();
    if (result?.status) {
      renderRuntimeStatus(result.status);
    } else if (result) {
      renderRuntimeStatus(result);
    }
    setRuntimeLog(successMessage, 'ok');
  } catch (error) {
    setRuntimeLog(error instanceof Error ? error.message : String(error), 'error');
  }
}

// ============================================================
// 初始化 webview preload (需要 file:// 绝对路径)
// ============================================================
async function setWebviewPreloads() {
  try {
    const chatPreloadPath = await window.deepseekClient.getWebviewPreloadPath();
    const bgPreloadPath = await window.deepseekClient.getBackgroundPreloadPath();
    const sidepanelPreloadPath = await window.deepseekClient.getSidepanelPreloadPath();
    extensionFilePort = await window.deepseekClient.getExtensionFilePort();

    chatView.setAttribute('preload', chatPreloadPath);
    sidepanelView.setAttribute('preload', sidepanelPreloadPath);

    console.log('[app-shell] Preload paths set, extension file port:', extensionFilePort);

    if (backgroundView) {
      backgroundView.setAttribute('preload', bgPreloadPath);
      backgroundView.src = 'about:blank';
    }

    if (chatView.src === 'about:blank') {
      chatView.src = 'https://chat.deepseek.com/';
    }
  } catch (err) {
    console.error('[app-shell] Failed to init preloads:', err);
    chatView.src = 'https://chat.deepseek.com/';
  }
}

function setupMessageBridge() {
  if (messageBridgeInitialized) return;
  messageBridgeInitialized = true;

  // 主进程广播 → chat webview content script
  window.deepseekClient.onBroadcastToContent((message) => {
    if (chatView && typeof chatView.send === 'function') {
      chatView.send('chrome:broadcast:toContent', message);
    }
  });

  window.deepseekClient.onBroadcastToSidepanel((message) => {
    if (sidepanelView && typeof sidepanelView.send === 'function') {
      sidepanelView.send('chrome:broadcast:toSidepanel', message);
    }
  });

  // Sidepanel postMessage 桥接 → 转发到 chat webview 的 background.js
  sidepanelView.addEventListener('ipc-message', (event) => {
    // 来自 sidepanel 的 chrome.runtime.sendMessage
    if (event.channel === 'sp-bridge' && event.args && event.args[0]) {
      var msg = event.args[0];
      // 转发到 chat webview 的 background (通过 content broadcast)
      if (chatView && typeof chatView.send === 'function') {
        chatView.send('chrome:broadcast:toContent', msg);
      }
      // 也尝试直接通过主进程路由
      window.deepseekClient.sendSidepanelToWebview(msg);
    }
  });

  console.log('[app-shell] Message bridge initialized');
}

// 节流：避免高频 SPA 路由事件造成过多 IPC 调用
let lastNavigateCheckTime = 0;
let navigateCheckTimer = null;
const NAVIGATE_CHECK_INTERVAL = 500;

function sendNavigateCheck(url) {
  var now = Date.now();
  if (now - lastNavigateCheckTime < NAVIGATE_CHECK_INTERVAL) {
    if (navigateCheckTimer) clearTimeout(navigateCheckTimer);
    navigateCheckTimer = setTimeout(function() {
      lastNavigateCheckTime = Date.now();
      navigateCheckTimer = null;
      chatView.send('check-deepseek-url', url);
    }, NAVIGATE_CHECK_INTERVAL - (now - lastNavigateCheckTime));
    return;
  }
  if (navigateCheckTimer) {
    clearTimeout(navigateCheckTimer);
    navigateCheckTimer = null;
  }
  lastNavigateCheckTime = now;
  chatView.send('check-deepseek-url', url);
}

// 节流：避免频繁 console 消息造成 IPC 风暴
let consoleLogTimer = null;
let pendingConsoleLogs = [];

function flushConsoleLogs() {
  consoleLogTimer = null;
  var batch = pendingConsoleLogs.join('\n');
  pendingConsoleLogs = [];
  window.deepseekClient.diagnosticLog(batch);
}

function throttledConsoleLog(msg) {
  pendingConsoleLogs.push(msg);
  if (!consoleLogTimer) {
    consoleLogTimer = setTimeout(flushConsoleLogs, 500);
  }
}

// ============================================================
// Webview 导航 → 触发 content script 注入检查
// ============================================================
chatView.addEventListener('did-navigate', (event) => {
  console.log('[app-shell] Chat webview navigated to:', event.url);
  if (event.url.indexOf('chat.deepseek.com') >= 0 && typeof chatView.send === 'function') {
    sendNavigateCheck(event.url);
  }
});

chatView.addEventListener('did-navigate-in-page', (event) => {
  if (event.url.indexOf('chat.deepseek.com') >= 0 && typeof chatView.send === 'function') {
    sendNavigateCheck(event.url);
  }
});

// ============================================================
// Webview dom-ready 时初始化
// ============================================================
chatView.addEventListener('dom-ready', () => {
  setupMessageBridge();
  console.log('[app-shell] Chat webview dom-ready, sending URL check');
  if (typeof chatView.send === 'function') {
    sendNavigateCheck(chatView.src || 'https://chat.deepseek.com/');
  }
});

// 捕获 chat webview 错误日志
chatView.addEventListener('console-message', (e) => {
  if (e.level >= 2) {
    throttledConsoleLog('CH[' + e.level + '] ' + e.message.slice(0, 300));
  }
});

chatView.addEventListener('did-fail-load', (e) => {
  console.error('[app-shell] Chat load FAILED:', e.errorCode, e.errorDescription);
});

// Sidepanel webview 就绪时恢复监听
sidepanelView.addEventListener('dom-ready', function onReady() {
  sidepanelReady = true;
  clearSidepanelReloadTimer();
  scheduleSidepanelProbe();
  // sidepanel 加载时，通过其 preload 桥接发送测试消息
  setTimeout(function() {
    if (chatView && typeof chatView.send === 'function') {
      chatView.send('check-deepseek-url', 'https://chat.deepseek.com/');
    }
  }, 2000);
});
sidepanelView.addEventListener('did-fail-load', (e) => {
  resetSidepanelLoadState();
  console.error('[app-shell] Sidepanel load FAILED:', e.errorCode, e.errorDescription);
  reloadSidepanel('did-fail-load');
});
sidepanelView.addEventListener('console-message', (e) => {
  if (e.level >= 2) {
    throttledConsoleLog('SP[' + e.level + '] ' + e.message.slice(0, 300));
  }
});
sidepanelView.addEventListener('crashed', () => {
  resetSidepanelLoadState();
  console.error('[app-shell] Sidepanel crashed, reloading...');
  setTimeout(function() {
    if (isSidepanelOpen) {
      reloadSidepanel('crashed');
    }
  }, 1000);
});
if (backgroundView) {
  backgroundView.addEventListener('console-message', (e) => {
    console.log('[bg-console]', '[' + (e.level === 3 ? 'ERROR' : e.level === 2 ? 'WARN' : 'LOG') + ']', e.message);
  });
  backgroundView.addEventListener('did-fail-load', (e) => {
    console.error('[app-shell] Background load FAILED:', e.errorCode, e.errorDescription);
  });
}

// ============================================================
// 事件绑定
// ============================================================
bindClick('reloadChatBtn', () => chatView.reload());
bindClick('openDeepSeekBtn', () => window.deepseekClient.openUrl('https://chat.deepseek.com/'));
bindClick('chatBackBtn', () => { if (chatView.canGoBack()) chatView.goBack(); });
bindClick('chatForwardBtn', () => { if (chatView.canGoForward()) chatView.goForward(); });
bindClick('chatHomeBtn', () => { chatView.src = 'https://chat.deepseek.com/'; });
bindClick('shellRefreshBtn', refreshShellStatus);
bindClick('shellRunBtn', runShellCommand);
bindClick('shellClearBtn', () => { shellOutput.textContent = '输出已清空。'; });
bindClick('runtimeRefreshBtn', refreshRuntimeStatus);
bindClick('runtimeFixBtn', () => withRuntimeAction('正在执行一键修复...', () => window.deepseekClient.autoFix(), '一键修复完成。'));
bindClick('runtimeInstallBrowserBtn', () => withRuntimeAction('正在安装项目浏览器...', () => window.deepseekClient.installProjectBrowser(), '项目浏览器安装完成。'));
bindClick('runtimeInstallShellBtn', () => withRuntimeAction('正在安装 Shell Native Host...', () => window.deepseekClient.installShellHost(), 'Shell Native Host 安装完成。'));
bindClick('runtimeSyncBtn', () => withRuntimeAction('正在同步扩展...', () => window.deepseekClient.prepareExtension(), '扩展同步完成。'));
bindClick('runtimeLaunchBtn', () => withRuntimeAction('正在启动兼容模式...', () => window.deepseekClient.launchFull(), '兼容模式已启动。'));
bindClick('runtimeOpenExtBtn', async () => {
  const result = await window.deepseekClient.openExtensionDir();
  if (!result.ok) setRuntimeLog(`打开扩展目录失败: ${result.error || 'unknown'}`, 'error');
});
bindClick('runtimeOpenProfileBtn', async () => {
  const result = await window.deepseekClient.openProfileDir();
  if (!result.ok) setRuntimeLog(`打开配置目录失败: ${result.error || 'unknown'}`, 'error');
});

// ============================================================
// 状态监听
// ============================================================
window.deepseekClient.onStatusUpdated((status) => {
  renderRuntimeStatus(status);
});

window.deepseekClient.onNavigateChat((payload) => {
  const url = payload && typeof payload.url === 'string' ? payload.url : '';
  if (!url) return;
  setActivePanel('chat');
  chatView.src = url;
});

async function syncConversationModeFromChatView() {
  if (!chatView || typeof chatView.executeJavaScript !== 'function') return;
  try {
    const state = await chatView.executeJavaScript(`(() => {
      const bodyText = (document.body && document.body.innerText) || '';
      const isExpert = bodyText.indexOf('专家模式') >= 0 || bodyText.indexOf('Expert Mode') >= 0;
      const isQuick = bodyText.indexOf('快速模式') >= 0 || bodyText.indexOf('Quick Mode') >= 0;
      return {
        quickMode: isQuick && !isExpert,
        expertMode: isExpert,
      };
    })()`);
    if (!state || typeof state !== 'object') return;
    const prevMode = currentConversationMode;
    if (prevMode && prevMode.quickMode === state.quickMode && prevMode.expertMode === state.expertMode) return;
    currentConversationMode = state;
    await window.deepseekClient.setRuntimeConversationMode(state);
  } catch (_) {
    // ignore
  }
}

// ============================================================
// 微信机器人
// ============================================================
const wechatOverlay = document.getElementById('wechatOverlay');
const wechatStatusEl = document.getElementById('wechatStatus');
const wechatQrImg = document.getElementById('wechatQrImg');
const wechatError = document.getElementById('wechatError');
const wechatStartBtn = document.getElementById('wechatStartBtn');
const wechatStopBtn = document.getElementById('wechatStopBtn');
const wechatCloseBtn = document.getElementById('wechatCloseBtn');

async function refreshWechatStatus() {
  try {
    var s = await window.deepseekClient.wechatStatus();
  } catch (_) {
    wechatStatusEl.textContent = '状态获取失败';
    return;
  }
  if (!s) return;
  if (s.status === 'scanning' && s.qrCodeDataUrl) {
    wechatStatusEl.textContent = '请用微信扫码登录';
    wechatQrImg.src = s.qrCodeDataUrl;
    wechatQrImg.style.display = 'block';
  } else {
    wechatQrImg.style.display = 'none';
  }
  if (s.status === 'running') {
    wechatStatusEl.textContent = '已连接，等待消息...';
    wechatStartBtn.style.display = 'none';
    wechatStopBtn.style.display = 'inline-block';
  } else if (s.status === 'scanning') {
    wechatStartBtn.style.display = 'none';
    wechatStopBtn.style.display = 'inline-block';
  } else {
    wechatStartBtn.style.display = 'inline-block';
    wechatStopBtn.style.display = 'none';
  }
  if (s.error) {
    wechatError.textContent = s.error;
  } else {
    wechatError.textContent = '';
  }
  if (s.status === 'stopped' && !s.error) {
    wechatStatusEl.textContent = '未启动';
  }
  if (s.status === 'error') {
    wechatStatusEl.textContent = '启动失败';
  }
}

bindClick('wechatBotBtn', async () => {
  wechatOverlay.classList.add('open');
  await refreshWechatStatus();
});

wechatCloseBtn.addEventListener('click', () => {
  wechatOverlay.classList.remove('open');
});

wechatStartBtn.addEventListener('click', async () => {
  wechatStatusEl.textContent = '正在启动...';
  wechatError.textContent = '';
  try {
    await window.deepseekClient.wechatStart();
  } catch (err) {
    wechatError.textContent = err.message || '启动失败';
  }
  await refreshWechatStatus();
});

wechatStopBtn.addEventListener('click', async () => {
  try {
    await window.deepseekClient.wechatStop();
  } catch (err) {
    wechatError.textContent = err.message || '停止失败';
  }
  await refreshWechatStatus();
});

// 轮询二维码状态
setInterval(function() {
  if (wechatOverlay.classList.contains('open')) {
    refreshWechatStatus();
  }
}, 3000);

// ============================================================
// 初始化
// ============================================================
setWebviewPreloads().finally(() => {
  openSidepanel();
});
refreshShellStatus();
refreshRuntimeStatus();
setInterval(syncConversationModeFromChatView, 3000);
