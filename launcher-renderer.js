/* global window */

const ui = {
  projectBrowserStatus: document.getElementById('projectBrowserStatus'),
  projectBrowserPath: document.getElementById('projectBrowserPath'),
  browserStatus: document.getElementById('browserStatus'),
  browserPath: document.getElementById('browserPath'),
  extensionStatus: document.getElementById('extensionStatus'),
  extensionPath: document.getElementById('extensionPath'),
  shellStatus: document.getElementById('shellStatus'),
  shellPath: document.getElementById('shellPath'),
  sourceStatus: document.getElementById('sourceStatus'),
  sourceDist: document.getElementById('sourceDist'),
  profilePath: document.getElementById('profilePath'),
  targetUrl: document.getElementById('targetUrl'),
  log: document.getElementById('log'),
  refreshBtn: document.getElementById('refreshBtn'),
  checkBtn: document.getElementById('checkBtn'),
  fixBtn: document.getElementById('fixBtn'),
  installBrowserBtn: document.getElementById('installBrowserBtn'),
  installShellBtn: document.getElementById('installShellBtn'),
  syncBtn: document.getElementById('syncBtn'),
  launchBtn: document.getElementById('launchBtn'),
  openExtBtn: document.getElementById('openExtBtn'),
  openRuntimeBtn: document.getElementById('openRuntimeBtn'),
  openProfileBtn: document.getElementById('openProfileBtn'),
  openRepoBtn: document.getElementById('openRepoBtn'),
  resetIdBtn: document.getElementById('resetIdBtn'),
  checkSummary: document.getElementById('checkSummary'),
  checkList: document.getElementById('checkList'),
};

function setLog(message, level = 'normal') {
  ui.log.textContent = message;
  if (level === 'error') {
    ui.log.style.color = '#b91c1c';
    return;
  }
  if (level === 'ok') {
    ui.log.style.color = '#0f766e';
    return;
  }
  ui.log.style.color = '#6b7280';
}

function renderStatus(status) {
  ui.projectBrowserStatus.innerHTML = status.projectBrowserExists
    ? '<span class="status-ok">项目内置浏览器已安装</span>'
    : '<span class="status-warn">项目内置浏览器未安装</span>';
  ui.projectBrowserPath.textContent = status.projectBrowserBinary || status.projectRuntimeDir;

  ui.browserStatus.innerHTML = status.browserFound
    ? `<span class="status-ok">已检测到浏览器${status.usingProjectBrowser ? '（项目内置）' : '（系统）'}</span>`
    : '<span class="status-danger">未检测到浏览器</span>';
  ui.browserPath.textContent = status.browserBinary || '未找到，请配置 DEEPSEEK_CHROME_BIN';

  ui.extensionStatus.innerHTML = status.extensionExists
    ? '<span class="status-ok">扩展目录可用</span>'
    : '<span class="status-warn">扩展目录不存在（需先同步）</span>';
  ui.extensionPath.textContent = status.extensionPath;

  ui.shellStatus.innerHTML = status.shellHostReady
    ? '<span class="status-ok">Shell Native Host 已就绪</span>'
    : '<span class="status-warn">Shell Native Host 未就绪</span>';
  ui.shellPath.textContent = status.shellHostReady
    ? `${status.shellManifestPath} (id: ${status.extensionId}, source: ${status.extensionIdSource || 'unknown'}${status.fixedExtensionId ? `, 已保存: ${status.fixedExtensionId}` : ''})`
    : (
        status.shellManifestExists
          ? `${status.shellManifestPath} (绑定: ${status.shellManifestBoundExtensionId || 'unknown'}，期望: ${status.extensionId}, source: ${status.extensionIdSource || 'unknown'}${status.fixedExtensionId ? `, 已保存: ${status.fixedExtensionId}` : ''})`
          : `${status.shellManifestPath} (未安装，期望: ${status.extensionId}, source: ${status.extensionIdSource || 'unknown'}${status.fixedExtensionId ? `, 已保存: ${status.fixedExtensionId}` : ''})`
      );

  ui.sourceStatus.innerHTML = status.sourceDistExists
    ? '<span class="status-ok">源码构建产物存在</span>'
    : '<span class="status-danger">未找到源码构建产物</span>';
  ui.sourceDist.textContent = status.sourceDist;

  ui.profilePath.textContent = status.profileDir;
  ui.targetUrl.textContent = status.targetUrl;
}

function renderSelfCheck(selfCheck) {
  if (!selfCheck) {
    return;
  }

  ui.checkSummary.innerHTML = selfCheck.ready
    ? '<span class="status-ok">环境检查通过，可以直接启动全功能模式。</span>'
    : `<span class="status-warn">${selfCheck.nextAction}</span>`;

  ui.checkList.innerHTML = '';
  for (const check of selfCheck.checks) {
    const item = document.createElement('li');
    item.className = 'check-item';

    const title = document.createElement('strong');
    title.innerHTML = check.ok
      ? `<span class="status-ok">[通过] ${check.title}</span>`
      : `<span class="status-danger">[未通过] ${check.title}</span>`;

    const detail = document.createElement('span');
    detail.textContent = check.detail || '-';

    item.appendChild(title);
    item.appendChild(detail);
    ui.checkList.appendChild(item);
  }
}

async function refreshStatus() {
  try {
    const status = await window.deepseekClient.getStatus();
    renderStatus(status);
    return status;
  } catch (error) {
    setLog(`状态读取失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
    return null;
  }
}

async function refreshSelfCheck() {
  try {
    const selfCheck = await window.deepseekClient.getSelfCheck();
    renderSelfCheck(selfCheck);
    return selfCheck;
  } catch (error) {
    setLog(`自检读取失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
    return null;
  }
}

const busyButtons = [
  ui.refreshBtn,
  ui.checkBtn,
  ui.fixBtn,
  ui.installBrowserBtn,
  ui.installShellBtn,
  ui.syncBtn,
  ui.launchBtn,
  ui.openExtBtn,
  ui.openRuntimeBtn,
  ui.openProfileBtn,
  ui.openRepoBtn,
];

async function withBusy(button, handler) {
  const prevStates = busyButtons.map((btn) => ({ btn, disabled: btn.disabled }));
  for (const { btn } of prevStates) {
    btn.disabled = true;
  }
  try {
    await handler();
  } finally {
    for (const state of prevStates) {
      state.btn.disabled = state.disabled;
    }
  }
}

ui.refreshBtn.addEventListener('click', async () => {
  await withBusy(ui.refreshBtn, async () => {
    const status = await refreshStatus();
    await refreshSelfCheck();
    if (status) setLog('状态已刷新。');
  });
});

ui.checkBtn.addEventListener('click', async () => {
  await withBusy(ui.checkBtn, async () => {
    const selfCheck = await refreshSelfCheck();
    if (selfCheck?.ready) {
      setLog('首启自检通过。', 'ok');
      return;
    }
    setLog('首启自检完成，存在待修复项。', 'error');
  });
});

ui.fixBtn.addEventListener('click', async () => {
  await withBusy(ui.fixBtn, async () => {
    setLog('正在执行一键修复（可能需要几十秒）...');
    const report = await window.deepseekClient.autoFix();
    renderStatus(report.status);
    renderSelfCheck(report.selfCheck);

    if (report.logs.length > 0) {
      setLog(report.logs.join(' | '), report.selfCheck.ready ? 'ok' : 'error');
      return;
    }

    setLog(report.selfCheck.ready ? '一键修复执行完成。' : '一键修复完成，但仍有未通过项。', report.selfCheck.ready ? 'ok' : 'error');
  });
});

ui.installBrowserBtn.addEventListener('click', async () => {
  await withBusy(ui.installBrowserBtn, async () => {
    setLog('正在安装项目内置 Chrome（可能需要 1-3 分钟）...');
    const report = await window.deepseekClient.installProjectBrowser();
    renderStatus(report.status);
    await refreshSelfCheck();
    setLog(report.logs.join(' | ') || '项目内置 Chrome 安装完成。', 'ok');
  });
});

ui.installShellBtn.addEventListener('click', async () => {
  await withBusy(ui.installShellBtn, async () => {
    setLog('正在安装 Shell Native Host...');
    const report = await window.deepseekClient.installShellHost();
    renderStatus(report.status);
    await refreshSelfCheck();
    setLog(report.logs.join(' | ') || 'Shell Native Host 安装完成。', report.status.shellHostReady ? 'ok' : 'error');
  });
});

ui.syncBtn.addEventListener('click', async () => {
  await withBusy(ui.syncBtn, async () => {
    setLog('正在同步扩展产物...');
    const status = await window.deepseekClient.prepareExtension();
    renderStatus(status);
    setLog('扩展产物同步完成。', 'ok');
  });
});

ui.launchBtn.addEventListener('click', async () => {
  await withBusy(ui.launchBtn, async () => {
    setLog('正在启动全功能模式...');
    await window.deepseekClient.launchFull();
    await refreshStatus();
    setLog('已触发浏览器启动，请在新窗口里使用 DeepSeek++。', 'ok');
  });
});

ui.openExtBtn.addEventListener('click', async () => {
  const result = await window.deepseekClient.openExtensionDir();
  if (!result.ok) {
    setLog(`打开扩展目录失败: ${result.error || 'unknown'}`, 'error');
  }
});

ui.openRuntimeBtn.addEventListener('click', async () => {
  const result = await window.deepseekClient.openRuntimeDir();
  if (!result.ok) {
    setLog(`打开 runtime 目录失败: ${result.error || 'unknown'}`, 'error');
  }
});

ui.openProfileBtn.addEventListener('click', async () => {
  const result = await window.deepseekClient.openProfileDir();
  if (!result.ok) {
    setLog(`打开配置目录失败: ${result.error || 'unknown'}`, 'error');
  }
});

ui.openRepoBtn.addEventListener('click', async () => {
  await window.deepseekClient.openUrl('https://github.com/zhu1090093659/deepseek-pp');
});

ui.resetIdBtn.addEventListener('click', async () => {
  await withBusy(ui.resetIdBtn, async () => {
    setLog('正在重置扩展 ID...');
    const status = await window.deepseekClient.resetFixedExtensionId();
    renderStatus(status);
    setLog('已重置固定扩展 ID，下次启动时将重新检测。', 'ok');
  });
});

window.deepseekClient.onStatusUpdated((status) => {
  renderStatus(status);
});

window.deepseekClient.onSelfCheckUpdated((selfCheck) => {
  renderSelfCheck(selfCheck);
});

refreshStatus();
refreshSelfCheck();
