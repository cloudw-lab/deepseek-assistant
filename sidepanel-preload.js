// sidepanel-preload.js
// 监听 mock 的 postMessage 请求，通过 IPC 转发到 main process
// 不依赖 DOM 操作 (document.head 在 preload 阶段可能为 null)

(function() {
  'use strict';
  var electron = require('electron');
  var ipcRenderer = electron.ipcRenderer;
  var contextBridge = electron.contextBridge;

  var bridge = {
    sendMessage: function(message) {
      return ipcRenderer.invoke('chrome:runtime:sendMessage', message);
    },
    tabsCreate: function(createProperties) {
      return ipcRenderer.invoke('chrome:tabs:create', createProperties);
    },
    tabsUpdate: function(tabId, updateProperties) {
      return ipcRenderer.invoke('chrome:tabs:update', tabId, updateProperties);
    },
    storageGet: function(area, keys) {
      return ipcRenderer.invoke('chrome:storage:get', area, keys);
    },
    storageSet: function(area, items) {
      return ipcRenderer.invoke('chrome:storage:set', area, items);
    },
    storageRemove: function(area, keys) {
      return ipcRenderer.invoke('chrome:storage:remove', area, keys);
    }
  };

  try {
    if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
      contextBridge.exposeInMainWorld('__spBridge', bridge);
    } else {
      window.__spBridge = bridge;
    }
  } catch (_) {
    try { window.__spBridge = bridge; } catch (_) {}
  }

  window.addEventListener('message', function(event) {
    var d = event.data;
    // mock 发送的请求: { _b: true, _i: id, _m: msg }  (没有 _r)
    // mock 期望的响应: { _b: true, _i: id, _r: result }
    if (!d || d._b !== true || d._r !== undefined) return;
    
    ipcRenderer.invoke('chrome:runtime:sendMessage', d._m).then(function(r) {
      event.source.postMessage({ _b: true, _i: d._i, _r: r }, '*');
    }).catch(function() {
      event.source.postMessage({ _b: true, _i: d._i, _r: { ok: true } }, '*');
    });
  });

  console.log('[sidepanel-preload] postMessage bridge ready, direct bridge:', !!(window.__spBridge && window.__spBridge.sendMessage));
})();
