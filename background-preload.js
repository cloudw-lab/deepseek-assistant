// background-preload.js
// 仅用于 background webview - 提供 chrome.* API polyfill (不注入 content scripts)
// 在 webview 中直接通过 eval 加载 background.js

(function() {
  'use strict';

  var { contextBridge, ipcRenderer } = require('electron');
  var EXTENSION_ID = 'deepseekppdesktopclient';
  var storageCache = { local: new Map(), session: new Map() };
  var storageListeners = [];
  var messageListeners = [];
  var lastError = undefined;
  var nativeFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : null;

  function isDeepSeekApiUrl(target) {
    try {
      var parsed = new URL(String(target), 'https://chat.deepseek.com/');
      return parsed.origin === 'https://chat.deepseek.com' && parsed.pathname.indexOf('/api/v0/') === 0;
    } catch (_) {
      return false;
    }
  }

  function isBingSearchUrl(target) {
    try {
      var parsed = new URL(String(target), 'https://chat.deepseek.com/');
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
      });
    };
  }

  function _get(area, keys) {
    var cache = storageCache[area];
    var result = {};
    if (keys === null || keys === undefined) {
      cache.forEach(function(v, k) { result[k] = v; });
    } else if (Array.isArray(keys)) {
      keys.forEach(function(k) { if (cache.has(k)) result[k] = cache.get(k); });
    } else if (typeof keys === 'object') {
      Object.keys(keys).forEach(function(k) {
        result[k] = cache.has(k) ? cache.get(k) : keys[k];
      });
    }
    ipcRenderer.invoke('chrome:storage:get', area, keys).then(function(remote) {
      if (remote && typeof remote === 'object') {
        Object.keys(remote).forEach(function(k) { cache.set(k, remote[k]); });
      }
    }).catch(function() {});
    return Promise.resolve(result);
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
    storageListeners.forEach(function(cb) {
      try { cb(changes, area); } catch(_) {}
    });
  }

  var noopListeners = {
    addListener: function() {},
    removeListener: function() {},
    hasListener: function() { return false; }
  };

  // 构建 chrome 对象
  var bgChrome = {
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
      sendMessage: function(msg) {
        console.log('[background] runtime.sendMessage', JSON.stringify(msg).slice(0, 200));
        return ipcRenderer.invoke('chrome:bg:sendMessage', msg).then(function(resp) {
          if (resp && resp._error) {
            lastError = { message: resp._error };
            return undefined;
          }
          lastError = undefined;
          return resp;
        }).catch(function(err) {
          lastError = { message: err ? err.message : 'unknown' };
          return undefined;
        });
      },

      onMessage: {
        addListener: function(cb) {
          messageListeners.push(cb);
          console.log('[background] onMessage listener added, total:', messageListeners.length);
        },
        removeListener: function(cb) {
          var i = messageListeners.indexOf(cb);
          if (i >= 0) messageListeners.splice(i, 1);
        },
        hasListener: function(cb) { return messageListeners.indexOf(cb) >= 0; }
      },

      getURL: function(p) {
        if (p && p.charAt(0) === '/') return 'chrome-extension://' + EXTENSION_ID + p;
        return 'chrome-extension://' + EXTENSION_ID + '/' + (p || '');
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
        var portId = 'bgport_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        var msgListeners = [];
        var discListeners = [];

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
            discListeners.forEach(function(cb) { try { cb(port); } catch(_) {} });
          },
          get disconnected() { return disconnected; }
        };

        ipcRenderer.on('bg:port:onMessage:' + portId, function(_ev, msg) {
          if (disconnected) return;
          msgListeners.forEach(function(cb) { try { cb(msg, port); } catch(_) {} });
        });

        return port;
      },

      connectNative: function(nativeHost) {
        var disconnected = false;
        var msgListeners = [];
        var discListeners = [];
        var portId = 'bgnative_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

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
      getPanelBehavior: function() { return Promise.resolve({ openPanelOnActionClick: true }); }
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
      sendCommand: function(target, method, params) {
        return ipcRenderer.invoke('chrome:debugger:sendCommand', { target: target, method: method, params: params });
      },
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

    commands: { getAll: function() { return Promise.resolve([]); }, onCommand: noopListeners },
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
        if (p && p.charAt(0) === '/') return 'chrome-extension://' + EXTENSION_ID + p;
        return 'chrome-extension://' + EXTENSION_ID + '/' + (p || '');
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

  // 暴露到全局
  if (typeof self !== 'undefined') self.chrome = bgChrome;
  if (typeof window !== 'undefined') window.chrome = bgChrome;
  if (typeof globalThis !== 'undefined') globalThis.chrome = bgChrome;
  contextBridge.exposeInMainWorld('chrome', bgChrome);

  // 暴露 messageListeners 用于 IPC 消息转发
  contextBridge.exposeInMainWorld('__bgMessageListeners', {
    dispatch: function(msg, sender) {
      messageListeners.forEach(function(cb) {
        try { cb(msg, sender || { id: EXTENSION_ID }, function(resp) {
          // sendResponse callback → IPC back to main process
          console.log('[background] sendResponse called with:', JSON.stringify(resp).slice(0, 200));
          ipcRenderer.send('chrome:bg:sendResponse', msg && msg._requestId, resp);
        }); } catch(e) { console.error('[background] listener error:', e); }
      });
    }
  });

  // 监听来自 main process 的消息转发
  ipcRenderer.on('bg:dispatchMessage', function(_ev, msg) {
    var sender = { id: msg._senderOrigin || EXTENSION_ID };
    messageListeners.forEach(function(cb) {
      try {
        cb(msg, sender, function(resp) {
          console.log('[background] sendResponse callback:', JSON.stringify(resp).slice(0, 200));
          ipcRenderer.send('chrome:bg:sendResponse', msg._requestId, resp);
        });
      } catch(e) {
        console.error('[background] dispatch error:', e.message);
      }
    });
  });

  // 监听来自 main process 的广播
  ipcRenderer.on('chrome:broadcast:toBackground', function(_ev, message) {
    var sender = { id: EXTENSION_ID, url: EXTENSION_ID };
    messageListeners.forEach(function(cb) {
      try { cb(message, sender, function(resp) {
        if (resp !== undefined) {
          ipcRenderer.send('chrome:bg:sendResponse', message && message._requestId, resp);
        }
      }); } catch(_) {}
    });
  });

  // ============================================================
  // 加载 background.js
  // ============================================================
  function loadBackgroundScript() {
    ipcRenderer.invoke('chrome:getBackgroundScript').then(function(code) {
      if (code) {
        console.log('[background-preload] Got background.js (' + code.length + ' bytes), executing...');
        try {
          eval(code);
          console.log('[background-preload] background.js executed successfully');
        } catch(e) {
          console.error('[background-preload] background.js eval error:', e.message, '\nStack:', e.stack);
        }
      } else {
        console.error('[background-preload] No background.js code received');
      }
    }).catch(function(err) {
      console.error('[background-preload] Failed to load background.js:', err.message);
    });
  }

  console.log('[background-preload] Initialized, loading background.js...');
  loadBackgroundScript();
})();
