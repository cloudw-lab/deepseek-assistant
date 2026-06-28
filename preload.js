const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deepseekClient', {
  platform: process.platform,
  version: process.versions.electron,
  getShellStatus: () => ipcRenderer.invoke('app:get-shell-status'),
  execShell: (command, cwd) => ipcRenderer.invoke('app:exec-shell', { command, cwd }),
  getStatus: () => ipcRenderer.invoke('launcher:get-status'),
  getSelfCheck: () => ipcRenderer.invoke('launcher:get-self-check'),
  autoFix: () => ipcRenderer.invoke('launcher:auto-fix'),
  installProjectBrowser: () => ipcRenderer.invoke('launcher:install-project-browser'),
  installShellHost: () => ipcRenderer.invoke('launcher:install-shell-host'),
  prepareExtension: () => ipcRenderer.invoke('launcher:prepare-extension'),
  launchFull: () => ipcRenderer.invoke('launcher:launch-full'),
  resetFixedExtensionId: () => ipcRenderer.invoke('launcher:reset-fixed-extension-id'),
  openExtensionDir: () => ipcRenderer.invoke('launcher:open-extension-dir'),
  openProfileDir: () => ipcRenderer.invoke('launcher:open-profile-dir'),
  openRuntimeDir: () => ipcRenderer.invoke('launcher:open-runtime-dir'),
  openUrl: (url) => ipcRenderer.invoke('launcher:open-url', url),
  getExtensionFilePort: () => ipcRenderer.invoke('chrome:getExtensionFilePort'),
  getWebviewPreloadPath: () => ipcRenderer.invoke('app:getWebviewPreloadPath'),
  getBackgroundPreloadPath: () => ipcRenderer.invoke('app:getBackgroundPreloadPath'),
  getSidepanelPreloadPath: () => ipcRenderer.invoke('app:getSidepanelPreloadPath'),
  getPreferenceMemory: () => ipcRenderer.invoke('app:getPreferenceMemory'),
  setPreferenceMemory: (lines) => ipcRenderer.invoke('app:setPreferenceMemory', { lines }),
  setRuntimeConversationMode: (mode) => ipcRenderer.invoke('app:setRuntimeConversationMode', mode),
  diagnosticLog: (msg) => ipcRenderer.send('app:diagnosticLog', msg),
  onStatusUpdated: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('launcher:status-updated', listener);
    return () => ipcRenderer.removeListener('launcher:status-updated', listener);
  },
  onSelfCheckUpdated: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('launcher:self-check-updated', listener);
    return () => ipcRenderer.removeListener('launcher:self-check-updated', listener);
  },
  // Sidepanel events
  onSidepanelOpen: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('chrome:sidepanel:open', listener);
    return () => ipcRenderer.removeListener('chrome:sidepanel:open', listener);
  },
  // Broadcast forwarding: main → webview content scripts
  onBroadcastToContent: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('chrome:broadcast:toContent', listener);
    return () => ipcRenderer.removeListener('chrome:broadcast:toContent', listener);
  },
  // Broadcast forwarding: main → background webview
  onBackgroundDispatch: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('bg:dispatchMessage', listener);
    return () => ipcRenderer.removeListener('bg:dispatchMessage', listener);
  },
  // Broadcast forwarding: main → background webview
  onBroadcastToBackground: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('chrome:broadcast:toBackground', listener);
    return () => ipcRenderer.removeListener('chrome:broadcast:toBackground', listener);
  },
  onBroadcastToSidepanel: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('chrome:broadcast:toSidepanel', listener);
    return () => ipcRenderer.removeListener('chrome:broadcast:toSidepanel', listener);
  },
  onNavigateChat: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('chrome:chat:navigate', listener);
    return () => ipcRenderer.removeListener('chrome:chat:navigate', listener);
  },
  // Port messaging forwarding
  onPortMessage: (portId, callback) => {
    const channel = 'chrome:port:onMessage:' + portId;
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPortDisconnect: (portId, callback) => {
    const channel = 'chrome:port:onDisconnect:' + portId;
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Native messaging forwarding
  onNativeMessage: (portId, callback) => {
    const channel = 'chrome:native:onMessage:' + portId;
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onNativeDisconnect: (portId, callback) => {
    const channel = 'chrome:native:onDisconnect:' + portId;
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // Send from sidepanel to webview 
  sendSidepanelToWebview: (message) => ipcRenderer.send('chrome:sidepanel:sendToWebview', message),
  // Send from webview to sidepanel
  sendWebviewToSidepanel: (message) => ipcRenderer.send('chrome:webview:sendToSidepanel', message),
  // WeChat Bot
  wechatStart: () => ipcRenderer.invoke('wechat:start'),
  wechatStop: () => ipcRenderer.invoke('wechat:stop'),
  wechatStatus: () => ipcRenderer.invoke('wechat:status'),
});
