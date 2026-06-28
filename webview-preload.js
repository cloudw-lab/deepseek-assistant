// webview-preload.js
// Electron webview preload - chrome.* API polyfill + deepseek-pp content script injection

(function() {
'use strict';

try {
  const { contextBridge, ipcRenderer } = require('electron');


const EXTENSION_ID = 'deepseekppdesktopclient';

// Polyfills for missing APIs in webview preload context
if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  crypto.randomUUID = function() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };
}

const nativeFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : null;
// 暴露原始 fetch 供 wechat-bot 通过 executeJavaScript 调用，绕过预载拦截
if (nativeFetch) {
  window.__deepseekNativeFetch = nativeFetch;
  console.log('[webview-preload] fetch override ACTIVE');
} else {
  console.log('[webview-preload] fetch override SKIPPED - nativeFetch is null');
}
var extensionFileBaseUrl = null;

ipcRenderer.invoke('chrome:getExtensionFilePort').then(function(port) {
  if (port) {
    extensionFileBaseUrl = 'http://127.0.0.1:' + port;
    console.log('[webview-preload] Extension file base URL:', extensionFileBaseUrl);
  }
}).catch(function() {});

function resolveExtensionAssetUrl(p) {
  var normalized = String(p || '').replace(/^\/+/, '');
  if (extensionFileBaseUrl) {
    return extensionFileBaseUrl + '/' + normalized;
  }
  return 'chrome-extension://' + EXTENSION_ID + '/' + normalized;
}

function isDeepSeekApiUrl(target) {
  try {
    var parsed = new URL(String(target), window.location && window.location.href ? window.location.href : 'https://chat.deepseek.com/');
    return parsed.origin === 'https://chat.deepseek.com' && parsed.pathname.indexOf('/api/v0/') === 0;
  } catch (_) {
    return false;
  }
}

function isBingSearchUrl(target) {
  try {
    var parsed = new URL(String(target), window.location && window.location.href ? window.location.href : 'https://chat.deepseek.com/');
    return (parsed.origin === 'https://cn.bing.com' || parsed.origin === 'https://www.bing.com')
      && parsed.pathname === '/search';
  } catch (_) {
    return false;
  }
}

function headersToObject(headers) {
  var result = {};
  if (!headers) return result;
  try {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach(function(value, key) { result[key] = value; });
      return result;
    }
  } catch (_) {}
  if (Array.isArray(headers)) {
    headers.forEach(function(entry) {
      if (Array.isArray(entry) && entry.length >= 2) result[String(entry[0])] = String(entry[1]);
    });
    return result;
  }
  if (typeof headers === 'object') {
    Object.keys(headers).forEach(function(key) { result[key] = String(headers[key]); });
  }
  return result;
}

function decodeBase64ToUint8Array(base64) {
  var binary = atob(base64 || '');
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

if (nativeFetch) {
  globalThis.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isDeepSeekApiUrl(url) && !isBingSearchUrl(url)) {
      return nativeFetch(input, init);
    }

    console.log('[webview-preload] fetch proxy:', (init && init.method) || 'GET', url.slice(0, 100));

    var headers = headersToObject(init && init.headers ? init.headers : (input && input.headers ? input.headers : undefined));
    var body = init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : undefined;
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      body = String(body);
    }

    var channel = isBingSearchUrl(url) ? 'app:fetchBingDiagnostic' : 'app:fetchDeepSeekApi';

    return ipcRenderer.invoke(channel, {
      url: url,
      method: (init && init.method) || (input && input.method) || 'GET',
      headers: headers,
      body: body,
    }).then(function(result) {
      if (isBingSearchUrl(url)) {
        return new Response(result.bodyText || '', {
          status: result.status,
          statusText: result.statusText,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      var bodyBytes = decodeBase64ToUint8Array(result.bodyBase64 || '');
      return new Response(bodyBytes, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers || {},
      });
    }).catch(function(err) {
      console.error('[webview-preload] DeepSeek API proxy fetch failed:', err && err.message ? err.message : String(err), url);
      throw err;
    });
  };
}

// ============================================================
// Storage (内存缓存 + IPC 持久化)
// ============================================================
const storageCache = { local: new Map(), session: new Map() };
const storageListeners = [];

function _buildStorageResult(cache, keys, remote) {
  var result = {};
  var source = remote && typeof remote === 'object' ? remote : null;

  if (keys === null || keys === undefined) {
    if (source) {
      Object.keys(source).forEach(function(k) { result[k] = source[k]; });
    } else {
      cache.forEach(function(v, k) { result[k] = v; });
    }
    return result;
  }

  if (typeof keys === 'string') {
    if (source && Object.prototype.hasOwnProperty.call(source, keys)) {
      result[keys] = source[keys];
    } else if (cache.has(keys)) {
      result[keys] = cache.get(keys);
    }
    return result;
  }

  if (Array.isArray(keys)) {
    keys.forEach(function(k) {
      if (source && Object.prototype.hasOwnProperty.call(source, k)) {
        result[k] = source[k];
      } else if (cache.has(k)) {
        result[k] = cache.get(k);
      }
    });
    return result;
  }

  if (typeof keys === 'object') {
    Object.keys(keys).forEach(function(k) {
      if (source && Object.prototype.hasOwnProperty.call(source, k)) {
        result[k] = source[k];
      } else if (cache.has(k)) {
        result[k] = cache.get(k);
      } else {
        result[k] = keys[k];
      }
    });
  }

  return result;
}

function _get(area, keys) {
  const cache = storageCache[area];
  return ipcRenderer.invoke('chrome:storage:get', area, keys).then(function(remote) {
    if (remote && typeof remote === 'object') {
      Object.keys(remote).forEach(function(k) { cache.set(k, remote[k]); });
    }
    return _buildStorageResult(cache, keys, remote);
  }).catch(function() {
    return _buildStorageResult(cache, keys, null);
  });
}

function _set(area, items) {
  var cache = storageCache[area];
  var changes = {};
  Object.keys(items).forEach(function(k) {
    changes[k] = { oldValue: cache.get(k), newValue: items[k] };
    cache.set(k, items[k]);
  });
  ipcRenderer.invoke('chrome:storage:set', area, items).catch(function() {});
  _fireChanges(changes, area);
  return Promise.resolve();
}

function _remove(area, keys) {
  var cache = storageCache[area];
  var keyList = Array.isArray(keys) ? keys : [keys];
  var changes = {};
  keyList.forEach(function(k) {
    changes[k] = { oldValue: cache.get(k), newValue: undefined };
    cache.delete(k);
  });
  ipcRenderer.invoke('chrome:storage:remove', area, keyList).catch(function() {});
  _fireChanges(changes, area);
  return Promise.resolve();
}

function _fireChanges(changes, area) {
  if (storageListeners.length === 0) return;
  storageListeners.forEach(function(cb) {
    try { cb(changes, area); } catch(_) {}
  });
}

// ============================================================
// Runtime (消息传递: 优先本地 dispatch，回退 IPC)
// ============================================================
var messageListeners = [];
var lastError = undefined;
var _inBroadcastDispatch = false;

function _sendMessage(msg) {
  // 在 broadcast dispatch 期间的重入调用，直接走 IPC
  if (_inBroadcastDispatch) {
    return _sendViaIpc(msg);
  }

  // 如果 background.js 还没加载完，等待它 (最多 3 秒)
  if (messageListeners.length === 0 && _bgLoadPromise) {
    return _bgLoadPromise.then(function() {
      return _dispatchMessage(msg);
    });
  }

  return _dispatchMessage(msg);
}

function _dispatchMessage(msg) {
  var asyncCallback = null;
  var syncResult = undefined;
  var hasSyncResult = false;

  for (var i = 0; i < messageListeners.length; i++) {
    var cb = messageListeners[i];
    try {
      var result = cb(msg, { id: EXTENSION_ID }, function(resp) {
        if (asyncCallback) asyncCallback(resp);
      });
      if (result === true) {
        return new Promise(function(resolve) {
          asyncCallback = resolve;
          var timeoutId = setTimeout(function() {
            if (asyncCallback) { asyncCallback = null; _sendViaIpc(msg).then(resolve); }
          }, 2000);
          asyncCallback = function(resp) {
            clearTimeout(timeoutId);
            asyncCallback = null;
            resolve(resp);
          };
        });
      }
      if (result !== undefined) {
        syncResult = result;
        hasSyncResult = true;
      }
    } catch(e) {}
  }

  if (hasSyncResult) return Promise.resolve(syncResult);
  return _sendViaIpc(msg);
}

function _sendViaIpc(msg) {
  return ipcRenderer.invoke('chrome:runtime:sendMessage', msg).then(function(resp) {
    if (resp && resp._error) {
      lastError = { message: resp._error };
      return undefined;
    }
    lastError = undefined;
    return resp;
  }).catch(function(err) {
    lastError = { message: err.message };
    return undefined;
  });
}

// ============================================================
// 构建 chrome 对象
// ============================================================
var noopListeners = {
  addListener: function() {},
  removeListener: function() {},
  hasListener: function() { return false; }
};

var chromePolyfill = {
  storage: {
    local: {
      get: function(k) { return _get('local', k); },
      set: function(v) { return _set('local', v); },
      remove: function(k) { return _remove('local', k); },
      getBytesInUse: function() { return Promise.resolve(0); },
      clear: function() { storageCache.local.clear(); return Promise.resolve(); },
      QUOTA_BYTES: 10485760
    },
    session: {
      get: function(k) { return _get('session', k); },
      set: function(v) { return _set('session', v); },
      remove: function(k) { return _remove('session', k); },
      getBytesInUse: function() { return Promise.resolve(0); },
      clear: function() { storageCache.session.clear(); return Promise.resolve(); },
      QUOTA_BYTES: 10485760
    },
    sync: {
      get: function() { return Promise.resolve({}); },
      set: function() { return Promise.resolve(); },
      remove: function() { return Promise.resolve(); },
      getBytesInUse: function() { return Promise.resolve(0); },
      clear: function() { return Promise.resolve(); },
      QUOTA_BYTES: 102400
    },
    onChanged: {
      addListener: function(cb) { storageListeners.push(cb); },
      removeListener: function(cb) {
        var i = storageListeners.indexOf(cb);
        if (i >= 0) storageListeners.splice(i, 1);
      },
      hasListener: function(cb) { return storageListeners.indexOf(cb) >= 0; }
    }
  },

  runtime: {
    id: EXTENSION_ID,
    lastError: {
      get message() { return lastError ? lastError.message : undefined; }
    },
    sendMessage: _sendMessage,

    onMessage: {
      addListener: function(cb) { messageListeners.push(cb); },
      removeListener: function(cb) {
        var i = messageListeners.indexOf(cb);
        if (i >= 0) messageListeners.splice(i, 1);
      },
      hasListener: function(cb) { return messageListeners.indexOf(cb) >= 0; }
    },

    getURL: function(p) {
      return resolveExtensionAssetUrl(p);
    },

    getManifest: function() {
      return {
        manifest_version: 3, name: 'DeepSeek++', version: '1.0.2',
        permissions: ['storage', 'alarms', 'nativeMessaging', 'contextMenus', 'offscreen', 'tabs', 'sidePanel'],
        host_permissions: ['*://chat.deepseek.com/*', 'https://api.deepseek.com/*', 'http://localhost/*', 'http://127.0.0.1/*']
      };
    },

    connect: function(connectInfo) {
      var name = connectInfo && connectInfo.name;
      var disconnected = false;
      var msgListeners = [];
      var discListeners = [];
      var portId = 'port_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

      var port = {
        name: name || '',
        sender: { id: EXTENSION_ID },
        postMessage: function(msg) {
          if (disconnected) return;
          ipcRenderer.send('chrome:port:postMessage', { portId: portId, name: name, msg: msg });
        },
        onMessage: {
          addListener: function(cb) { msgListeners.push(cb); },
          removeListener: function(cb) {
            var i = msgListeners.indexOf(cb);
            if (i >= 0) msgListeners.splice(i, 1);
          },
          hasListener: function(cb) { return msgListeners.indexOf(cb) >= 0; }
        },
        onDisconnect: {
          addListener: function(cb) { discListeners.push(cb); },
          removeListener: function(cb) {
            var i = discListeners.indexOf(cb);
            if (i >= 0) discListeners.splice(i, 1);
          },
          hasListener: function(cb) { return discListeners.indexOf(cb) >= 0; }
        },
        disconnect: function() {
          if (disconnected) return;
          disconnected = true;
          ipcRenderer.send('chrome:port:disconnect', portId);
          discListeners.forEach(function(cb) { try { cb(port); } catch(_) {} });
        },
        get disconnected() { return disconnected; }
      };

      // 监听 port 消息回传
      ipcRenderer.on('chrome:port:onMessage:' + portId, function(_ev, msg) {
        if (disconnected) return;
        msgListeners.forEach(function(cb) { try { cb(msg, port); } catch(_) {} });
      });
      ipcRenderer.on('chrome:port:onDisconnect:' + portId, function() {
        if (disconnected) return;
        disconnected = true;
        discListeners.forEach(function(cb) { try { cb(port); } catch(_) {} });
      });

      return port;
    },

    connectNative: function(nativeHost) {
      var disconnected = false;
      var msgListeners = [];
      var discListeners = [];
      var portId = 'native_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

      var port = {
        name: nativeHost,
        postMessage: function(msg) {
          if (disconnected) return;
          ipcRenderer.send('chrome:native:postMessage', { portId: portId, host: nativeHost, msg: msg });
        },
        onMessage: {
          addListener: function(cb) { msgListeners.push(cb); },
          removeListener: function(cb) {
            var i = msgListeners.indexOf(cb);
            if (i >= 0) msgListeners.splice(i, 1);
          },
          hasListener: function(cb) { return msgListeners.indexOf(cb) >= 0; }
        },
        onDisconnect: {
          addListener: function(cb) { discListeners.push(cb); },
          removeListener: function(cb) {
            var i = discListeners.indexOf(cb);
            if (i >= 0) discListeners.splice(i, 1);
          },
          hasListener: function(cb) { return discListeners.indexOf(cb) >= 0; }
        },
        disconnect: function() {
          if (disconnected) return;
          disconnected = true;
          ipcRenderer.send('chrome:native:disconnect', { portId: portId, host: nativeHost });
          discListeners.forEach(function(cb) { try { cb(port); } catch(_) {} });
        }
      };

      ipcRenderer.send('chrome:native:connect', { portId: portId, host: nativeHost });
      ipcRenderer.on('chrome:native:onMessage:' + portId, function(_ev, msg) {
        if (disconnected) return;
        msgListeners.forEach(function(cb) { try { cb(msg, port); } catch(_) {} });
      });
      ipcRenderer.on('chrome:native:onDisconnect:' + portId, function() {
        if (disconnected) return;
        disconnected = true;
        discListeners.forEach(function(cb) { try { cb(port); } catch(_) {} });
      });

      return port;
    },

    onConnect: noopListeners,
    onInstalled: {
      addListener: function(cb) { cb({ reason: 'install', previousVersion: '1.0.0' }); },
      removeListener: function() {},
      hasListener: function() { return false; }
    },
    onStartup: noopListeners,
    openOptionsPage: function() { ipcRenderer.send('chrome:openSidepanel'); return Promise.resolve(); }
  },

  tabs: {
    TAB_ID_NONE: -1,
    query: function(q) { return ipcRenderer.invoke('chrome:tabs:query', q); },
    sendMessage: function(tabId, msg) { return ipcRenderer.invoke('chrome:tabs:sendMessage', tabId, msg); },
    create: function(p) { return ipcRenderer.invoke('chrome:tabs:create', p); },
    update: function(tabId, p) { return ipcRenderer.invoke('chrome:tabs:update', tabId, p); },
    remove: function(tabId) { return ipcRenderer.invoke('chrome:tabs:remove', tabId); },
    getCurrent: function() { return Promise.resolve({ id: 1, url: 'https://chat.deepseek.com/', title: 'DeepSeek', active: true, windowId: 1 }); },
    onUpdated: noopListeners, onRemoved: noopListeners, onActivated: noopListeners
  },

  sidePanel: {
    open: function(opts) { ipcRenderer.send('chrome:sidepanel:open', opts); return Promise.resolve(); },
    setPanelBehavior: function() { return Promise.resolve(); },
    getPanelBehavior: function() { return Promise.resolve({ openPanelOnActionClick: true }); },
    setOptions: function() { return Promise.resolve(); }
  },

  i18n: {
    getUILanguage: function() { return typeof navigator !== 'undefined' ? navigator.language : 'zh-CN'; },
    getMessage: function() { return ''; }
  },

  downloads: {
    download: function(opts) { return ipcRenderer.invoke('chrome:downloads:download', opts); },
    onChanged: noopListeners
  },

  permissions: {
    contains: function(p) { return ipcRenderer.invoke('chrome:permissions:contains', p); },
    request: function(p) { return ipcRenderer.invoke('chrome:permissions:request', p); },
    remove: function() { return Promise.resolve(true); },
    getAll: function() { return Promise.resolve({ permissions: ['storage', 'tabs'], origins: ['*://chat.deepseek.com/*'] }); },
    onAdded: noopListeners, onRemoved: noopListeners
  },

  action: {
    setBadgeText: function() { return Promise.resolve(); },
    setBadgeBackgroundColor: function() { return Promise.resolve(); },
    setTitle: function() { return Promise.resolve(); },
    setIcon: function() { return Promise.resolve(); },
    getTitle: function() { return Promise.resolve(''); },
    getBadgeText: function() { return Promise.resolve(''); },
    disable: function() { return Promise.resolve(); },
    enable: function() { return Promise.resolve(); },
    onClicked: noopListeners
  },
  browserAction: {
    setBadgeText: function() { return Promise.resolve(); },
    setBadgeBackgroundColor: function() { return Promise.resolve(); },
    setTitle: function() { return Promise.resolve(); },
    setIcon: function() { return Promise.resolve(); },
    disable: function() { return Promise.resolve(); },
    enable: function() { return Promise.resolve(); },
    onClicked: noopListeners
  },

  contextMenus: {
    create: function() { return Promise.resolve(); },
    update: function() { return Promise.resolve(); },
    remove: function() { return Promise.resolve(); },
    removeAll: function() { return Promise.resolve(); },
    onClicked: noopListeners,
    ACTION_MENU_TOP_LEVEL_LIMIT: 6,
    ContextType: { ALL: 'all', PAGE: 'page', SELECTION: 'selection', LINK: 'link' },
    ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' }
  },

  alarms: {
    create: function() { return Promise.resolve(); },
    get: function() { return Promise.resolve(undefined); },
    getAll: function() { return Promise.resolve([]); },
    clear: function() { return Promise.resolve(true); },
    clearAll: function() { return Promise.resolve(true); },
    onAlarm: noopListeners
  },

  offscreen: {
    hasDocument: function() { return Promise.resolve(false); },
    createDocument: function(params) { return ipcRenderer.invoke('chrome:offscreen:createDocument', params); },
    closeDocument: function() { return Promise.resolve(); },
    Reason: { IFRAME_SCRIPTING: 'IFRAME_SCRIPTING', WORKERS: 'WORKERS', BLOBS: 'BLOBS', DOM_PARSER: 'DOM_PARSER', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' }
  },

  debugger: {
    attach: function() { return Promise.resolve(); },
    detach: function() { return Promise.resolve(); },
    sendCommand: function(target, method, params) { return ipcRenderer.invoke('chrome:debugger:sendCommand', { target: target, method: method, params: params }); },
    getTargets: function() { return Promise.resolve([]); },
    onEvent: noopListeners, onDetach: noopListeners
  },

  scripting: {
    executeScript: function(inj) { return ipcRenderer.invoke('chrome:scripting:executeScript', inj); },
    insertCSS: function() { return Promise.resolve(); },
    removeCSS: function() { return Promise.resolve(); },
    getRegisteredContentScripts: function() { return Promise.resolve([]); },
    registerContentScripts: function() { return Promise.resolve(); },
    unregisterContentScripts: function() { return Promise.resolve(); }
  },

  webNavigation: {
    getFrame: function() { return Promise.resolve({ frameId: 0, parentFrameId: -1 }); },
    getAllFrames: function() { return Promise.resolve([]); },
    onBeforeNavigate: noopListeners, onCommitted: noopListeners,
    onCompleted: noopListeners, onDOMContentLoaded: noopListeners, onErrorOccurred: noopListeners
  },

  windows: {
    WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2,
    getCurrent: function() { return Promise.resolve({ id: 1, focused: true, alwaysOnTop: false, incognito: false }); },
    getAll: function() { return Promise.resolve([]); },
    create: function() { return Promise.resolve({ id: 2 }); },
    update: function() { return Promise.resolve({ id: 1 }); },
    remove: function() { return Promise.resolve(); },
    onFocusChanged: noopListeners, onRemoved: noopListeners, onCreated: noopListeners
  },

  webRequest: {
    onBeforeRequest: noopListeners, onBeforeSendHeaders: noopListeners,
    onHeadersReceived: noopListeners, onCompleted: noopListeners, onErrorOccurred: noopListeners
  },

  declarativeNetRequest: {
    updateSessionRules: function() { return Promise.resolve(); },
    updateDynamicRules: function() { return Promise.resolve(); },
    getDynamicRules: function() { return Promise.resolve([]); },
    getSessionRules: function() { return Promise.resolve([]); },
    onRuleMatchedDebug: noopListeners
  },

  commands: {
    getAll: function() { return Promise.resolve([]); },
    onCommand: noopListeners
  },

  cookies: {
    get: function() { return Promise.resolve(null); },
    getAll: function() { return Promise.resolve([]); },
    set: function() { return Promise.resolve(null); },
    remove: function() { return Promise.resolve(null); },
    getAllCookieStores: function() { return Promise.resolve([]); },
    onChanged: noopListeners
  },

  extension: {
    getURL: function(p) {
      return resolveExtensionAssetUrl(p);
    },
    getViews: function() { return [window]; },
    isAllowedIncognitoAccess: function() { return Promise.resolve(false); },
    isAllowedFileSchemeAccess: function() { return Promise.resolve(false); },
    inIncognitoContext: false,
    onRequest: noopListeners, onRequestExternal: noopListeners
  },

  pageAction: {
    show: function() { return Promise.resolve(); },
    hide: function() { return Promise.resolve(); },
    setTitle: function() { return Promise.resolve(); },
    getTitle: function() { return Promise.resolve(''); },
    setIcon: function() { return Promise.resolve(); },
    setPopup: function() { return Promise.resolve(); },
    getPopup: function() { return Promise.resolve(''); },
    onClicked: noopListeners
  },

  notifications: {
    create: function() { return Promise.resolve(''); },
    update: function() { return Promise.resolve(true); },
    clear: function() { return Promise.resolve(true); },
    getAll: function() { return Promise.resolve({}); },
    getPermissionLevel: function() { return Promise.resolve('granted'); },
    onClosed: noopListeners, onClicked: noopListeners, onButtonClicked: noopListeners
  }
};

// ============================================================
// 将 chrome 设置为全局变量
// ============================================================
self.chrome = chromePolyfill;
globalThis.chrome = chromePolyfill;
try { window.chrome = chromePolyfill; } catch(e) {}
console.log('[webview-preload] DeepSeek++ polyfill loaded. Extension ID: ' + EXTENSION_ID);

// ============================================================
// 加载并注入 content scripts (通过 IPC 获取代码)
// content scripts 仅在 chat.deepseek.com 页面注入
// ============================================================
var contentScriptsCached = null;
var contentScriptsInjected = false;
var mainWorldInjected = false;
var backgroundLoaded = false;
var _bgLoadPromise = null;
var _bgLoadResolve = null;

function loadBackgroundScript() {
  if (backgroundLoaded) return _bgLoadPromise;
  backgroundLoaded = true;
  _bgLoadPromise = new Promise(function(resolve) { _bgLoadResolve = resolve; });
  
  ipcRenderer.invoke('chrome:getBackgroundScript').then(function(code) {
    if (code && code.length > 0) {
      try {
        eval(code);
        console.log('[webview-preload] background.js loaded, listeners:' + messageListeners.length);
      } catch(e) {
        console.error('[webview-preload] background.js error:', e.message);
      }
    }
    if (_bgLoadResolve) { _bgLoadResolve(); _bgLoadResolve = null; }
  }).catch(function(err) {
    console.error('[webview-preload] background.js load fail:', err.message);
    if (_bgLoadResolve) { _bgLoadResolve(); _bgLoadResolve = null; }
  });
  
  return _bgLoadPromise;
}

// 尽早加载 background.js (在 chrome.* 初始化后立即加载)
loadBackgroundScript();

function injectContentScript(code, isMainWorld) {
  if (!code) return;
  console.log('[webview-preload] Injecting ' + (isMainWorld ? 'main-world' : 'content') + ' script (' + code.length + ' bytes)');

  if (isMainWorld) {
    var target = document.documentElement || document.head || document.body;
    if (!target) {
      console.error('[webview-preload] No DOM target for main-world injection, retrying on DOMContentLoaded');
      document.addEventListener('DOMContentLoaded', function() {
        var t = document.documentElement || document.head || document.body;
        if (t) {
          var script = document.createElement('script');
          script.textContent = code;
          script.setAttribute('data-deepseek-pp', 'main-world');
          t.appendChild(script);
          script.remove();
        }
      }, { once: true });
      return;
    }
    var script = document.createElement('script');
    script.textContent = code;
    script.setAttribute('data-deepseek-pp', 'main-world');
    target.appendChild(script);
    script.remove();
  } else {
    try {
      (0, eval)(code);
    } catch (err) {
      console.error('[webview-preload] Error executing content script:', err.message, err.stack);
    }
  }
}

function tryInjectForDeepSeek(url) {
  if (contentScriptsInjected) return;
  if (!url || url.indexOf('chat.deepseek.com') < 0) return;

  console.log('[webview-preload] DeepSeek page detected: ' + url);
  contentScriptsInjected = true;

  if (contentScriptsCached) {
    contentScriptsCached.content && injectContentScript(contentScriptsCached.content, false);
    injectMainWorldScript(contentScriptsCached.mainWorld);
  } else {
    ipcRenderer.invoke('chrome:getContentScripts').then(function(scripts) {
      contentScriptsCached = scripts;
      if (scripts && scripts.content) injectContentScript(scripts.content, false);
      injectMainWorldScript(scripts && scripts.mainWorld);
    }).catch(function(err) {
      console.error('[webview-preload] Failed to load content scripts:', err.message);
    });
  }
}

function injectMainWorldScript(mainWorldCode) {
  if (!mainWorldCode) return;
  if (mainWorldInjected) return;
  mainWorldInjected = true;
  injectContentScript(mainWorldCode, true);
}

// 预取 content scripts
ipcRenderer.invoke('chrome:getContentScripts').then(function(scripts) {
  contentScriptsCached = scripts;
  console.log('[webview-preload] Content scripts pre-fetched');
}).catch(function(err) {
  console.error('[webview-preload] Failed to pre-fetch content scripts:', err.message);
});

// 初始 URL 检查
var initialUrl = (window.location && window.location.href) || '';
tryInjectForDeepSeek(initialUrl);

// 在 document_start 尽早注入 main-world，避免 bridge 握手晚于页面 fetch hook
if (initialUrl && initialUrl.indexOf('chat.deepseek.com') >= 0) {
  if (contentScriptsCached && contentScriptsCached.mainWorld) {
    injectMainWorldScript(contentScriptsCached.mainWorld);
  } else {
    ipcRenderer.invoke('chrome:getContentScripts').then(function(scripts) {
      contentScriptsCached = scripts;
      injectMainWorldScript(scripts && scripts.mainWorld);
    }).catch(function(err) {
      console.error('[webview-preload] Early main-world preload failed:', err.message);
    });
  }
}

// 监听来自宿主的路由变化通知 (webview 导航后 URL 变化)
ipcRenderer.on('check-deepseek-url', function(_ev, url) {
  tryInjectForDeepSeek(url);
});

// 也通过 DOM 事件监听 (SPA 路由变化等)
window.addEventListener('load', function() {
  tryInjectForDeepSeek(window.location.href);
});

// ============================================================
// 监听来自宿主的广播消息
// ============================================================
ipcRenderer.on('chrome:broadcast:toContent', function(_ev, message) {
  var sender = { id: EXTENSION_ID };
  var requestId = message && message._requestId;
  var asyncPending = false;
  var syncResponse = undefined;
  
  _inBroadcastDispatch = true;
  try {
    for (var i = 0; i < messageListeners.length; i++) {
      try {
        var result = messageListeners[i](message, sender, function(resp) {
          if (requestId !== undefined && resp !== undefined) {
            ipcRenderer.send('chrome:bg:sendResponse', requestId, resp);
          }
        });
        if (result === true) {
          asyncPending = true;
        } else if (result !== undefined && syncResponse === undefined) {
          syncResponse = result;
        }
      } catch(_) {}
    }
  } finally {
    _inBroadcastDispatch = false;
  }
  
  if (!asyncPending && syncResponse !== undefined && requestId !== undefined) {
    ipcRenderer.send('chrome:bg:sendResponse', requestId, syncResponse);
  }
});

ipcRenderer.on('chrome:sidepanel:message', function(_ev, message) {
  var sender = { id: 'sidepanel' };
  messageListeners.forEach(function(cb) {
    try { cb(message, sender, function() {}); } catch(_) {}
  });
});

} catch (preloadError) {
  console.error('[webview-preload] FATAL preload error:', preloadError.message, preloadError.stack);
}
})();
