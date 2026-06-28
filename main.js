const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');
const wechatBot = require('./wechat-bot.js');

let mainWindow = null;
let tray = null;
let httpServer = null;
let extensionFileServer = null;
let extensionFilePort = 9998;
let cachedContentScripts = null;
let cachedSidepanelInjection = null;
const nativeHostPorts = new Map();
const BUILTIN_SHELL_HOST = 'com.deepseek_pp.shell';
const BUILTIN_SHELL_NAME = 'Shell Local';
const BUILTIN_SHELL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

app.commandLine.appendSwitch('disable-gpu-vsync');

// Avoid storage lock conflicts with other Electron apps using the same package name.
app.setPath('userData', path.join(app.getPath('appData'), 'deepseek-client-full'));

function resolveAppPath(...parts) {
  return path.join(__dirname, ...parts);
}

function resolveUnpackedAppPath(...parts) {
  return path.join(process.resourcesPath, 'app.asar.unpacked', ...parts);
}

function resolveResourcePath(...parts) {
  const unpackedPath = resolveUnpackedAppPath(...parts);
  if (app.isPackaged && fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }
  return resolveAppPath(...parts);
}

function ensureChildProcessCwd() {
  const cwd = path.join(app.getPath('userData'), 'runtime-workdir');
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

function getEnvironmentPath(env) {
  const canonicalKey = process.platform === 'win32' ? 'Path' : 'PATH';
  if (typeof env[canonicalKey] === 'string') return env[canonicalKey];
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  return key ? env[key] || '' : '';
}

function setEnvironmentPath(env, value) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = value;
}

function prependPathEntry(env, entry) {
  if (!entry || !fs.existsSync(entry)) return;
  const separator = process.platform === 'win32' ? ';' : ':';
  const current = getEnvironmentPath(env);
  const values = (current ? current.split(separator) : []).filter(Boolean);
  if (!values.includes(entry)) {
    values.unshift(entry);
    setEnvironmentPath(env, values.join(separator));
  }
}

function resolveBundledPythonExecutable() {
  const candidates = process.platform === 'darwin'
    ? [
        resolveResourcePath('runtime', 'python', 'darwin', 'bin', 'python3'),
        resolveResourcePath('runtime', 'python', 'darwin', 'bin', 'python3.14'),
      ]
    : process.platform === 'win32'
      ? [resolveResourcePath('runtime', 'python', 'win32', 'python.exe')]
      : [resolveResourcePath('runtime', 'python', 'linux', 'bin', 'python3')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function applyBundledRuntimeEnvironment() {
  const bundledPython = resolveBundledPythonExecutable();
  if (!bundledPython) return;
  process.env.DEEPSEEK_DESKTOP_PYTHON = bundledPython;
  process.env.DEEPSEEK_PP_PYTHON = bundledPython;
  prependPathEntry(process.env, path.dirname(bundledPython));
}

function isDeepSeekApiUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.origin === 'https://chat.deepseek.com' && parsed.pathname.indexOf('/api/v0/') === 0;
  } catch (_) {
    return false;
  }
}

function isBingSearchUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return (parsed.origin === 'https://cn.bing.com' || parsed.origin === 'https://www.bing.com')
      && parsed.pathname === '/search';
  } catch (_) {
    return false;
  }
}

function isDeepSeekChatUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.origin === 'https://chat.deepseek.com' && /\/(?:a\/)?chat\//.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

function resolveConfigPath() {
  return path.join(app.getPath('userData'), 'app-config.json');
}

function readAppConfig() {
  const configPath = resolveConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (_) {
    // ignore
  }
  return {};
}

function writeAppConfig(config) {
  const configPath = resolveConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function resolvePreferenceMemoryPath() {
  return path.join(app.getPath('userData'), 'preference-memory.md');
}

function resolveExtensionStorageLocalPath() {
  return path.join(app.getPath('userData'), 'extension-storage', 'local.json');
}

function getDefaultPreferenceMemoryLines() {
  return [
    'Prefer direct answers when the question can be answered from model knowledge without tools.',
    'For real-time information such as weather, news, and exchange rates: in quick mode, prefer DeepSeek native search when available; in expert mode, extension web_search/web_fetch may be used when needed. Do not use shell_exec for general web lookup.',
    'In WeChat replies, return only the final result. Omit reasoning, step-by-step traces, and tool execution process details.'
  ];
}

function migrateLegacyPreferenceMemoryFile() {
  const memoryPath = resolvePreferenceMemoryPath();
  if (!fs.existsSync(memoryPath)) return;
  try {
    const raw = fs.readFileSync(memoryPath, 'utf8');
    const legacyLine = '- For real-time information such as weather, news, and exchange rates: if DeepSeek native search is available in the current mode, prefer native search; otherwise use extension web_search. Do not use shell_exec for general web lookup.';
    if (!raw.includes(legacyLine)) return;
    const updated = raw.replace(
      legacyLine,
      '- For real-time information such as weather, news, and exchange rates: in quick mode, prefer DeepSeek native search when available; in expert mode, extension web_search/web_fetch may be used when needed. Do not use shell_exec for general web lookup.'
    );
    fs.writeFileSync(memoryPath, updated, 'utf8');
  } catch (_) {
    // ignore migration failures
  }
}

function ensurePreferenceMemoryFile() {
  const memoryPath = resolvePreferenceMemoryPath();
  if (fs.existsSync(memoryPath)) {
    migrateLegacyPreferenceMemoryFile();
    return memoryPath;
  }
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  const content = [
    '# Preference Memory',
    '',
    ...getDefaultPreferenceMemoryLines().map((line) => '- ' + line),
    ''
  ].join('\n');
  fs.writeFileSync(memoryPath, content, 'utf8');
  return memoryPath;
}

function readPreferenceMemoryLines() {
  const memoryPath = ensurePreferenceMemoryFile();
  try {
    const raw = fs.readFileSync(memoryPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);
  } catch (_) {
    return getDefaultPreferenceMemoryLines();
  }
}

function buildPreferenceMemoryPrompt() {
  const lines = readPreferenceMemoryLines();
  if (lines.length === 0) return '';
  return [
    '[Preference Memory]',
    '- These are remembered preferences for reference. The current conversation mode directive takes priority over any remembered preference.',
    ...lines.map((line) => '- ' + line),
    '[/Preference Memory]'
  ].join('\n');
}

function normalizePreferenceContentByMode(content, options = {}) {
  if (typeof content !== 'string') return '';
  const thinkingEnabled = options.thinkingEnabled === true;
  const segments = content
    .split(/(?<=[。！？!?；;，,])\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const filtered = segments.filter((part) => {
    const lowered = part.toLowerCase();
    const mentionsQuick = lowered.includes('快速模式') || lowered.includes('quick mode');
    const mentionsExpert = lowered.includes('专家模式') || lowered.includes('expert mode') || lowered.includes('thinking mode');

    if (thinkingEnabled) {
      if (mentionsQuick && !mentionsExpert) return false;
      if (lowered.includes('原生搜索') || lowered.includes('native search')) return false;
      return true;
    }

    if (mentionsExpert) return false;
    if (lowered.includes('扩展') && (lowered.includes('web_search') || lowered.includes('web_fetch'))) return false;
    return true;
  });

  return filtered.join(' ').trim();
}

function sanitizePromptByMode(prompt, options = {}) {
  if (typeof prompt !== 'string') return '';
  const thinkingEnabled = options.thinkingEnabled === true;
  const parts = prompt
    .split(/(?<=[。！？!?；;，,])\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const kept = parts.filter((part) => {
    const lowered = part.toLowerCase();
    if (thinkingEnabled) {
      if (lowered.includes('快速模式') || lowered.includes('quick mode') || lowered.includes('原生搜索') || lowered.includes('native search')) {
        return false;
      }
      return true;
    }

    if (lowered.includes('专家模式') || lowered.includes('expert mode') || lowered.includes('thinking mode')) {
      return false;
    }
    if (lowered.includes('扩展') && (lowered.includes('web_search') || lowered.includes('web_fetch'))) {
      return false;
    }
    if (lowered.includes('shell_exec') && lowered.includes('实时信息')) {
      return false;
    }
    return true;
  });

  return kept.join(' ').trim();
}

async function getExtensionMemoriesFromRuntime() {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      (async function() {
        try {
          async function readFromWebview(id) {
            var view = document.getElementById(id);
            if (!view || typeof view.executeJavaScript !== 'function') return null;
            return await view.executeJavaScript(
              '(async function(){try{if(!window.chrome||!chrome.runtime||typeof chrome.runtime.sendMessage!=="function")return [];var r=await chrome.runtime.sendMessage({type:"GET_MEMORIES"});return Array.isArray(r)?r:[];}catch(e){return {__dppError:String(e&&e.message?e.message:e)}}})()'
            );
          }
          var sidepanel = await readFromWebview('sidepanelView');
          if (Array.isArray(sidepanel) && sidepanel.length > 0) return sidepanel;
          var chat = await readFromWebview('chatView');
          if (Array.isArray(chat)) return chat;
          return [];
        } catch (_) {
          return [];
        }
      })()
    `);
    console.log('[Preference Memory] runtime memories count=', Array.isArray(result) ? result.length : 0);
    return Array.isArray(result) ? result : [];
  } catch (_) {
    return [];
  }
}

function buildPreferenceMemoryPromptFromExtensionMemories(memories, options = {}) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const thinkingEnabled = options.thinkingEnabled === true;
  const preferenceTagHints = [
    '行为偏好', '交付规范', '工具策略', '回复风格', '渠道规则', 'wechat', '微信',
    'shell', 'web_search', 'memory', 'preference', 'policy', 'style', 'tool'
  ];
  const preferenceTextHints = [
    '不要', '优先', '必须', '只返回', '不返回', 'direct answer', 'web_search',
    'shell_exec', 'wechat', '微信', 'tool', 'reply', 'response', 'style', 'policy'
  ];
  const lines = memories
    .filter((item) => item && typeof item === 'object')
    .filter((item) => item.scope !== 'project')
    .filter((item) => {
      const type = typeof item.type === 'string' ? item.type : '';
      const name = typeof item.name === 'string' ? item.name.toLowerCase() : '';
      const content = typeof item.content === 'string' ? item.content.toLowerCase() : '';
      const tags = Array.isArray(item.tags)
        ? item.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.toLowerCase())
        : [];

      if (type === 'feedback' || type === 'user') return true;

      if (tags.some((tag) => preferenceTagHints.some((hint) => tag.indexOf(hint) >= 0))) return true;
      if (preferenceTextHints.some((hint) => name.indexOf(hint) >= 0 || content.indexOf(hint) >= 0)) return true;

      return false;
    })
    .sort((a, b) => {
      const aPinned = a && a.pinned ? 1 : 0;
      const bPinned = b && b.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      const aUpdated = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
      const bUpdated = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
      return bUpdated - aUpdated;
    })
    .map((item) => {
      const type = typeof item.type === 'string' ? item.type : 'memory';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const content = normalizePreferenceContentByMode(
        typeof item.content === 'string' ? item.content.trim() : '',
        { thinkingEnabled }
      );
      if (!content) return '';
      return `${type}${name ? `/${name}` : ''}: ${content}`;
    })
    .filter(Boolean)
    .slice(0, 20);
  if (lines.length === 0) return '';
  return [
    '[Preference Memory]',
    '- These are remembered preferences for reference. The current conversation mode directive takes priority over any remembered preference.',
    ...lines.map((line) => '- ' + line),
    '[/Preference Memory]'
  ].join('\n');
}

async function inspectChatConversationMode() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    return await mainWindow.webContents.executeJavaScript(`
      (async function() {
        try {
          var chatView = document.getElementById('chatView');
          if (!chatView || typeof chatView.executeJavaScript !== 'function') return null;
          return await chatView.executeJavaScript(
            '(function(){var text=(document.body&&document.body.innerText)||"";return {quickMode:text.indexOf("快速模式")>=0||text.indexOf("Quick Mode")>=0,expertMode:text.indexOf("专家模式")>=0||text.indexOf("Expert Mode")>=0||text.indexOf("DeepThink")>=0};})()'
          );
        } catch (_) {
          return null;
        }
      })()
    `);
  } catch (_) {
    return null;
  }
}

function extractOriginalUserPrompt(prompt) {
  if (typeof prompt !== 'string') return '';
  const startMarker = '<!-- deepseek-pp-visible-user-prompt:start -->';
  const endMarker = '<!-- deepseek-pp-visible-user-prompt:end -->';
  const startIndex = prompt.indexOf(startMarker);
  if (startIndex >= 0) {
    const from = startIndex + startMarker.length;
    const endIndex = prompt.indexOf(endMarker, from);
    if (endIndex > from) {
      return prompt.slice(from, endIndex).trim();
    }
  }
  return prompt
    .replace(/\[Preference Memory\][\s\S]*?\[\/Preference Memory\]\s*/g, '')
    .replace(/\[Runtime Tool Policy\][\s\S]*?\[\/Runtime Tool Policy\]\s*/g, '')
    .replace(/## Web Search Rules[\s\S]*?Tool call format reminder:/g, '')
    .trim();
}

function stripManagedPromptBlocks(prompt) {
  if (typeof prompt !== 'string' || !prompt) return '';
  return prompt
    .replace(/\[Preference Memory\][\s\S]*?\[\/Preference Memory\]\s*/g, '')
    .trim();
}

function stripWebToolsFromPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt) return prompt;
  let result = prompt;
  result = result.replace(/^-\s*(?:web_search|web_fetch|shell_exec|shell_status|local_http_shell_exec|local_http_shell_status|local_folder_read|local_file_read|local_file_write|local_folder_list|shell_\w+):[\s\S]*?(?=\n-|\n##|\nAvailable|\nTool call|\n$)/gm, '');
  result = result.replace(/^(?:## Available Tools[\s\S]*?)(?=\n\n|\n##|\n\[)/gm, '\n');
  result = result.replace(/(Available tool tag names:\s*).*/g, '$1');
  return result;
}

function extractUserQuestion(prompt) {
  if (typeof prompt !== 'string' || !prompt) return prompt;
  const agentPatterns = /(以下是工具续跑|自动化续跑|上一轮回复没有包含|以下是刚才已经自动执行|无工具调用纠偏|必须直接输出下一步可执行工具)/;
  if (!agentPatterns.test(prompt)) return prompt;
  const taskMatch = prompt.match(/<original_task>([\s\S]*?)<\/original_task>/);
  if (taskMatch) {
    return taskMatch[1].trim();
  }
  const lines = prompt.split('\n');
  const cleanLines = [];
  let inBlock = false;
  for (var line of lines) {
    if (/<(original_task|tool_results|previous_assistant_text|tool_results_so_far)>/.test(line)) { inBlock = true; continue; }
    if (/<\/(original_task|tool_results|previous_assistant_text|tool_results_so_far)>/.test(line)) { inBlock = false; continue; }
    if (inBlock) continue;
    if (agentPatterns.test(line)) continue;
    if (/^如果|^请|^不要|^本轮|^这是第/.test(line.trim())) continue;
    const trimmed = line.trim();
    if (trimmed) cleanLines.push(trimmed);
  }
  if (cleanLines.length > 0) return cleanLines.join('\n');
  return 'Help answer the user\'s question using native search.';
}

function injectNativeSearchDirective(prompt) {
  if (typeof prompt !== 'string' || !prompt) return prompt;
  const directive = [
    '[Native Search Directive]',
    '- DeepSeek native search IS ACTIVE. Search results for real-time facts (weather, news, prices) are already included in this request.',
    '- Do NOT call extension tools (shell_exec, web_search, web_fetch). Answer directly from native search results.',
    '- If native search results are sufficient, output the answer. Do not request additional tools.',
    '[/Native Search Directive]',
    '',
  ].join('\n');
  let result = prompt;
  const agentRx = /(以下是工具续跑|自动化续跑|必须直接输出下一步可执行工具|无工具调用纠偏|上一轮回复没有包含)/;
  if (agentRx.test(result)) {
    const agentIdx = result.search(agentRx);
    if (agentIdx >= 0) {
      const origTaskMatch = result.match(/<original_task>([\s\S]*?)<\/original_task>/);
      const origTask = origTaskMatch ? origTaskMatch[1].trim() : '';
      const replacement = origTask
        ? `Answer the user's question directly using native search results. The original question was: "${origTask}"`
        : 'Answer the user\'s question directly using native search results.';
      result = directive + result.slice(0, agentIdx) + replacement;
    } else {
      result = directive + result;
    }
  }
  return result;
}

function persistRuntimeConversationMode(mode) {
  try {
    const storagePath = resolveExtensionStorageLocalPath();
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    let current = {};
    if (fs.existsSync(storagePath)) {
      current = JSON.parse(fs.readFileSync(storagePath, 'utf8')) || {};
    }
    current.deepseek_pp_runtime_conversation_mode = {
      quickMode: Boolean(mode && mode.quickMode),
      expertMode: Boolean(mode && mode.expertMode),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(storagePath, JSON.stringify(current, null, 2), 'utf8');
  } catch (error) {
    console.warn('[Runtime Mode] Failed to persist conversation mode:', error.message);
  }
}

function isRealtimeSearchPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.toLowerCase();
  return [
    '天气', '今天', '今日', '现在', '实时', '新闻', '汇率', '热搜', '股价', '金价', '比赛',
    'weather', 'today', 'current', 'realtime', 'real-time', 'news', 'exchange rate', 'stock price'
  ].some((keyword) => text.indexOf(keyword) >= 0);
}

async function injectPreferenceMemoryIntoRequestBody(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return bodyText;
  return bodyText;
}

function getFixedExtensionId() {
  const config = readAppConfig();
  return config.fixedExtensionId || null;
}

function setFixedExtensionId(extensionId) {
  const config = readAppConfig();
  config.fixedExtensionId = extensionId;
  writeAppConfig(config);
}

function resolveProjectRuntimeDir() {
  return resolveResourcePath('runtime', 'chrome');
}

function walkFindExecutable(rootDir, executableNames, maxDepth = 6) {
  if (!fs.existsSync(rootDir) || maxDepth < 0) {
    return null;
  }

  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > maxDepth) {
      continue;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const absolute = path.join(current.dir, entry.name);
      if (entry.isFile() && executableNames.has(entry.name)) {
        return absolute;
      }
      if (entry.isDirectory()) {
        stack.push({ dir: absolute, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function resolveProjectBrowserBinary() {
  const runtimeDir = resolveProjectRuntimeDir();
  const names = process.platform === 'darwin'
    ? new Set(['Google Chrome for Testing', 'Google Chrome', 'Microsoft Edge'])
    : process.platform === 'win32'
      ? new Set(['chrome.exe', 'msedge.exe'])
      : new Set(['chrome', 'google-chrome', 'microsoft-edge']);

  return walkFindExecutable(runtimeDir, names, 7);
}

function resolveSourceRoot() {
  if (process.env.DPP_SOURCE_DIR) {
    return path.resolve(process.env.DPP_SOURCE_DIR);
  }
  return path.resolve(__dirname, '..', 'tmp', 'deepseek-pp');
}

function resolveSourceDist() {
  return path.join(resolveSourceRoot(), 'dist', 'chrome-mv3');
}

function resolveExtensionPath() {
  if (process.env.DPP_EXTENSION_PATH) {
    return path.resolve(process.env.DPP_EXTENSION_PATH);
  }
  return resolveResourcePath('extension', 'chrome-mv3');
}

function resolveProfileDir() {
  if (process.env.DPP_CHROME_PROFILE) {
    return path.resolve(process.env.DPP_CHROME_PROFILE);
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'deepseek-client-full-chrome');
}

function resolveTargetUrl() {
  return process.env.DPP_TARGET_URL || 'https://chat.deepseek.com/';
}

function resolveEmbeddedShell() {
  return process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
}

function createManagedEnv(extraEnv) {
  const env = extraEnv && typeof extraEnv === 'object' ? { ...process.env, ...extraEnv } : { ...process.env };
  const bundledPython = resolveBundledPythonExecutable();
  if (bundledPython) {
    env.DEEPSEEK_DESKTOP_PYTHON = bundledPython;
    env.DEEPSEEK_PP_PYTHON = bundledPython;
    prependPathEntry(env, path.dirname(bundledPython));
  }
  return env;
}

function createNodeChildEnv(extraEnv) {
  const env = createManagedEnv(extraEnv);
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function spawnNodeScript(scriptPath, args, options) {
  return spawn(process.execPath, [scriptPath, ...(args || [])], {
    cwd: options && options.cwd ? options.cwd : ensureChildProcessCwd(),
    env: createNodeChildEnv(options && options.env ? options.env : undefined),
    shell: false,
    stdio: options && options.stdio ? options.stdio : ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function detectShellBrowserTarget(browserBinary) {
  const explicit = (process.env.DPP_SHELL_BROWSER || '').toLowerCase();
  if (explicit === 'chrome' || explicit === 'chrome-for-testing' || explicit === 'chromium' || explicit === 'edge') {
    return explicit;
  }

  const lower = String(browserBinary || '').toLowerCase();
  if (lower.includes('chrome for testing')) {
    return 'chrome-for-testing';
  }
  if (lower.includes('msedge')) {
    return 'edge';
  }
  if (lower.includes('chromium')) {
    return 'chromium';
  }
  return 'chrome';
}

function parseManifestBoundExtensionId(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const firstOrigin = Array.isArray(json.allowed_origins) ? json.allowed_origins[0] : null;
    if (!firstOrigin || typeof firstOrigin !== 'string') {
      return null;
    }

    const match = firstOrigin.match(/^chrome-extension:\/\/([a-z]{32})\/$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isValidChromeExtensionId(value) {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

function normalizePathForCompare(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function detectExtensionIdFromProfile(profileDir, extensionPath) {
  const candidates = [
    path.join(profileDir, 'Default', 'Secure Preferences'),
    path.join(profileDir, 'Default', 'Preferences'),
  ];

  const target = normalizePathForCompare(extensionPath);
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      continue;
    }

    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const settings = json && json.extensions && json.extensions.settings;
      if (!settings || typeof settings !== 'object') {
        continue;
      }

      for (const [id, item] of Object.entries(settings)) {
        const itemPath = normalizePathForCompare(item && item.path);
        if (itemPath && itemPath === target && isValidChromeExtensionId(id)) {
          return { extensionId: id, source: path.basename(file) };
        }
      }
    } catch {
      // Ignore invalid profile files and continue fallback detection.
    }
  }

  return null;
}

function resolveExtensionId(profileDir, extensionPath, shellManifestBoundExtensionId) {
  const explicit = process.env.DPP_EXTENSION_ID;
  if (isValidChromeExtensionId(explicit)) {
    return { extensionId: explicit, source: 'env' };
  }

  const profileDetected = detectExtensionIdFromProfile(profileDir, extensionPath);
  if (profileDetected) {
    return profileDetected;
  }

  if (isValidChromeExtensionId(shellManifestBoundExtensionId)) {
    return { extensionId: shellManifestBoundExtensionId, source: 'manifest' };
  }

  return { extensionId: deriveExtensionIdFromPath(extensionPath), source: 'path-hash' };
}

function deriveExtensionIdFromPath(extensionPath) {
  const hash = crypto.createHash('sha256').update(Buffer.from(extensionPath, 'utf8')).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const byte = hash[i];
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

function resolveShellNativeManifestPath(browser = 'chrome') {
  const home = os.homedir();
  const hostFile = 'com.deepseek_pp.shell.json';

  if (process.platform === 'darwin') {
    if (browser === 'edge') {
      return path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts', hostFile);
    }
    if (browser === 'chromium') {
      return path.join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts', hostFile);
    }
    if (browser === 'chrome-for-testing') {
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome for Testing', 'NativeMessagingHosts', hostFile);
    }
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', hostFile);
  }

  if (process.platform === 'linux') {
    if (browser === 'edge') {
      return path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts', hostFile);
    }
    if (browser === 'chromium') {
      return path.join(home, '.config', 'chromium', 'NativeMessagingHosts', hostFile);
    }
    return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', hostFile);
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'DeepSeek++', 'NativeMessagingHosts', hostFile);
  }

  return path.join(home, hostFile);
}

function resolveShellNativeManifestCandidates(browser = 'chrome') {
  const candidates = [resolveShellNativeManifestPath(browser)];
  if (process.platform === 'darwin' && browser === 'chrome') {
    candidates.unshift(
      path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Google',
        'Chrome for Testing',
        'NativeMessagingHosts',
        'com.deepseek_pp.shell.json',
      ),
    );
  }
  return candidates;
}

function resolveBrowserBinary() {
  const projectBinary = resolveProjectBrowserBinary();
  if (projectBinary) {
    return projectBinary;
  }

  if (process.env.DEEPSEEK_CHROME_BIN && fs.existsSync(process.env.DEEPSEEK_CHROME_BIN)) {
    return process.env.DEEPSEEK_CHROME_BIN;
  }

  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : process.platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/usr/bin/microsoft-edge-stable',
        ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function ensureExtensionSynced() {
  const sourceDist = resolveSourceDist();
  const extensionPath = resolveExtensionPath();

  if (!fs.existsSync(sourceDist)) {
    throw new Error(`deepseek-pp build output not found: ${sourceDist}`);
  }

  fs.rmSync(extensionPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
  fs.cpSync(sourceDist, extensionPath, { recursive: true });
}

function buildLauncherStatus() {
  const sourceRoot = resolveSourceRoot();
  const sourceDist = resolveSourceDist();
  const extensionPath = resolveExtensionPath();
  const projectRuntimeDir = resolveProjectRuntimeDir();
  const projectBrowserBinary = resolveProjectBrowserBinary();
  const browserBinary = resolveBrowserBinary();
  const profileDir = resolveProfileDir();
  const shellBrowserTarget = detectShellBrowserTarget(browserBinary);
  const shellManifestPath = resolveShellNativeManifestCandidates(shellBrowserTarget).find((candidate) => fs.existsSync(candidate))
    || resolveShellNativeManifestPath(shellBrowserTarget);
  const shellManifestExists = fs.existsSync(shellManifestPath);
  const shellManifestBoundExtensionId = parseManifestBoundExtensionId(shellManifestPath);
  const extensionIdResult = resolveExtensionId(profileDir, extensionPath, shellManifestBoundExtensionId);
  const extensionId = extensionIdResult.extensionId;
  const extensionIdSource = extensionIdResult.source;
  const shellHostReady = Boolean(shellManifestExists && shellManifestBoundExtensionId && shellManifestBoundExtensionId === extensionId);
  const bundledPython = resolveBundledPythonExecutable();

  return {
    sourceRoot,
    sourceDist,
    extensionPath,
    projectRuntimeDir,
    projectBrowserBinary,
    browserBinary,
    profileDir,
    targetUrl: resolveTargetUrl(),
    sourceDistExists: fs.existsSync(sourceDist),
    extensionExists: fs.existsSync(extensionPath),
    projectBrowserExists: Boolean(projectBrowserBinary),
    browserFound: Boolean(browserBinary),
    usingProjectBrowser: Boolean(projectBrowserBinary && browserBinary === projectBrowserBinary),
    extensionId,
    extensionIdSource,
    fixedExtensionId: getFixedExtensionId(),
    shellBrowserTarget,
    shellManifestPath,
    shellManifestExists,
    shellManifestBoundExtensionId,
    shellHostReady,
    bundledPython,
  };
}

function buildSelfCheck(status) {
  const checks = [
    {
      id: 'project-browser',
      title: '项目内置 Chrome Runtime 可用',
      ok: status.projectBrowserExists,
      detail: status.projectBrowserExists
        ? (status.projectBrowserBinary || '')
        : `未检测到项目内置浏览器，请安装到 ${status.projectRuntimeDir}`,
      autoFixable: true,
    },
    {
      id: 'browser',
      title: 'Chrome/Edge 浏览器可用',
      ok: status.browserFound,
      detail: status.browserFound ? (status.browserBinary || '') : '未检测到浏览器，请安装 Chrome/Edge 或设置 DEEPSEEK_CHROME_BIN。',
      autoFixable: false,
    },
    {
      id: 'source-dist',
      title: 'deepseek-pp 构建产物存在',
      ok: status.sourceDistExists,
      detail: status.sourceDistExists ? status.sourceDist : `未找到 ${status.sourceDist}`,
      autoFixable: true,
    },
    {
      id: 'extension-dir',
      title: '本地扩展目录已同步',
      ok: status.extensionExists,
      detail: status.extensionExists ? status.extensionPath : `未找到 ${status.extensionPath}`,
      autoFixable: true,
    },
    {
      id: 'shell-host',
      title: 'Shell Native Host 已安装并绑定当前扩展',
      ok: status.shellHostReady,
      detail: status.shellHostReady
        ? `${status.shellManifestPath} (extension-id: ${status.extensionId}, source: ${status.extensionIdSource})`
        : (
            status.shellManifestExists
              ? `检测到 manifest 但绑定ID不匹配：${status.shellManifestBoundExtensionId || 'unknown'}，期望 ${status.extensionId} (source: ${status.extensionIdSource})`
              : `未检测到 manifest：${status.shellManifestPath}，期望 extension-id: ${status.extensionId} (source: ${status.extensionIdSource})`
          ),
      autoFixable: true,
    },
  ];

  const ready = checks.every((check) => check.ok);
  return {
    ready,
    checks,
    nextAction: ready ? '可以直接点击“启动全功能模式”。' : '请先执行“一键修复”或根据提示手动修复。',
  };
}

function runCommand(command, args, cwd, envOverride) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: envOverride || createManagedEnv(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }

      const error = new Error(`command failed: ${command} ${args.join(' ')} (exit ${code})`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

// ============================================================
// 扩展静态文件服务器 (为 sidepanel iframe/webview 提供文件)
// ============================================================
function startExtensionFileServer(port = 9998) {
  if (extensionFileServer) {
    return Promise.resolve(extensionFilePort);
  }

  const ports = [port, 39998, 39999, 40000, 40001];
  return new Promise((resolve, reject) => {
    const requestHandler = (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200); res.end(); return;
      }

      const parsedUrl = url.parse(req.url, true);
      let filePath = parsedUrl.pathname;
      if (filePath === '/' || filePath === '') {
        filePath = '/sidepanel.html';
      }

      const fullPath = path.join(resolveExtensionPath(), filePath.replace(/^\/+/, ''));
      if (!fullPath.startsWith(resolveExtensionPath())) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
          '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
          '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
          '.wasm': 'application/wasm', '.ico': 'image/x-icon'
        };
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        
        // 对 sidepanel HTML 注入 chrome polyfill 脚本 (仅在 chrome.runtime 不存在时注入，避免覆盖 preload 版本)
        if (ext === '.html' && filePath.indexOf('sidepanel') >= 0 && filePath.indexOf('wrapper') < 0) {
          if (!cachedSidepanelInjection) {
            cachedSidepanelInjection = '<script>' +
              'if(!window.chrome||!window.chrome.runtime||typeof window.chrome.runtime.sendMessage!=="function"){' +
              'var _reqId=0,_pending={};' +
              'function _sendIPC(msg){' +
              '  var t=msg&&msg.type?msg.type:JSON.stringify(msg).slice(0,60);' +
              '  console.warn("[SP-send]",t,"inBridge="+!!(window.__spBridge&&window.__spBridge.sendMessage));' +
              '  if(window.__spBridge&&window.__spBridge.sendMessage){' +
              '    return window.__spBridge.sendMessage(msg).then(function(r){' +
              '      console.warn("[SP-resp]",t,"->",JSON.stringify(r).slice(0,100));return r;})' +
              '    .catch(function(e){console.error("[SP-err]",t,e.message);return{ok:true};});}' +
              '  console.warn("[SP-postMsg]",t);' +
              '  return new Promise(function(res){' +
              '    var id=++_reqId;var tmr=setTimeout(function(){delete _pending[id];res({ok:true})},10000);' +
              '    _pending[id]={res:res,t:tmr};' +
              '    window.postMessage({_b:true,_i:id,_m:msg},"*");' +
              '  });}' +
              'window.addEventListener("message",function(e){if(e.data&&e.data._b&&e.data._r!==undefined&&_pending[e.data._i]){' +
              '  clearTimeout(_pending[e.data._i].t);_pending[e.data._i].res(e.data._r);delete _pending[e.data._i];}});' +
              'console.warn("[SP-init] mock ready, bridge:",!!(window.__spBridge&&window.__spBridge.sendMessage));' +
              'window.chrome=window.chrome||{};' +
              '["storage","runtime","tabs","sidePanel","i18n","downloads","permissions","action","browserAction","contextMenus","alarms","offscreen","debugger","scripting","windows","webRequest","cookies","extension","notifications"].forEach(function(k){if(!window.chrome[k])window.chrome[k]={};});' +
              'var __dppBase=location.origin;' +
              '(function(){var c=window.chrome;c.runtime=c.runtime||{};c.runtime.id="deepseekppdesktopclient";' +
              'c.runtime.sendMessage=_sendIPC;' +
              'c.runtime.getURL=function(p){return __dppBase+"/"+String(p||"").replace(/^\\/+/,"")};' +
              'c.runtime.getManifest=function(){return{name:"DeepSeek++",version:"1.0.2",manifest_version:3}};' +
              'c.runtime.onMessage={addListener:function(){},removeListener:function(){}};' +
              'c.runtime.onInstalled={addListener:function(){}};' +
              'c.runtime.connect=function(){return{postMessage:function(){},onMessage:{addListener:function(){}},onDisconnect:{addListener:function(){}},disconnect:function(){}}};' +
              'c.storage=c.storage||{};["local","session","sync"].forEach(function(a){c.storage[a]=c.storage[a]||{};' +
              'c.storage[a].get=function(k){if(window.__spBridge&&window.__spBridge.storageGet){return window.__spBridge.storageGet(a,k)}return Promise.resolve(k&&typeof k==="object"?k:{})};' +
              'c.storage[a].set=function(v){if(window.__spBridge&&window.__spBridge.storageSet){return window.__spBridge.storageSet(a,v)}return Promise.resolve()};' +
              'c.storage[a].remove=function(k){if(window.__spBridge&&window.__spBridge.storageRemove){return window.__spBridge.storageRemove(a,k)}return Promise.resolve()}});' +
              'c.storage.onChanged={addListener:function(){},removeListener:function(){}};' +
              'c.i18n=c.i18n||{};c.i18n.getUILanguage=function(){return"zh-CN"};' +
              'c.permissions=c.permissions||{};c.permissions.contains=function(){return Promise.resolve(true)};' +
              'c.permissions.request=function(){return Promise.resolve(true)};' +
              'c.action=c.action||{};c.action.setBadgeText=function(){};' +
              'c.action.setBadgeBackgroundColor=function(){};c.browserAction=c.action;' +
              'c.contextMenus=c.contextMenus||{};c.contextMenus.create=function(){};' +
              'c.contextMenus.removeAll=function(){};c.contextMenus.onClicked={addListener:function(){}};' +
              'c.alarms=c.alarms||{};c.alarms.create=function(){};c.alarms.onAlarm={addListener:function(){}};' +
              'c.downloads=c.downloads||{};c.downloads.download=function(){};' +
              'c.tabs=c.tabs||{};c.tabs.query=function(){return Promise.resolve([{id:1,url:"https://chat.deepseek.com/",title:"DeepSeek",active:!0,windowId:1}])};' +
              'c.tabs.sendMessage=function(){};' +
              'c.tabs.create=function(p){if(window.__spBridge&&window.__spBridge.tabsCreate){return window.__spBridge.tabsCreate(p)}return Promise.resolve({id:2})};' +
              'c.tabs.update=function(id,p){if(window.__spBridge&&window.__spBridge.tabsUpdate){return window.__spBridge.tabsUpdate(id,p)}return Promise.resolve({id:id||1})};' +
              'c.sidePanel=c.sidePanel||{};c.sidePanel.open=function(){};c.sidePanel.setPanelBehavior=function(){};' +
              'c.offscreen=c.offscreen||{};c.offscreen.hasDocument=function(){return Promise.resolve(!1)};' +
              'c.debugger=c.debugger||{};c.debugger.attach=function(){};' +
              'c.windows=c.windows||{};c.windows.getCurrent=function(){return Promise.resolve({id:1})};' +
              'c.commands=c.commands||{};c.commands.getAll=function(){return Promise.resolve([])};' +
              '})();' +
              '}' +
              'window.addEventListener("error",function(e){console.error("[sp] error:",e.message)});' +
              'window.addEventListener("unhandledrejection",function(e){console.error("[sp] unhandled:",e.reason?.message)});' +
              '</script>';
          }
          var html = fs.readFileSync(fullPath, 'utf8');
          html = html.replace('<head>', '<head>' + cachedSidepanelInjection);
          res.writeHead(200);
          res.end(html);
        } else {
          res.writeHead(200);
          res.end(fs.readFileSync(fullPath));
        }
      } else {
        res.writeHead(404); res.end('Not found');
      }
    };

    const tryPort = (index) => {
      if (index >= ports.length) {
        reject(new Error('No available ports for extension file server'));
        return;
      }

      const port = ports[index];
      extensionFileServer = http.createServer(requestHandler);
      extensionFileServer.listen(port, '127.0.0.1', () => {
        extensionFilePort = port;
        console.log(`[Extension File Server] started at http://127.0.0.1:${port}`);
        resolve(port);
      });

      extensionFileServer.on('error', (error) => {
        extensionFileServer = null;
        if (error.code === 'EADDRINUSE') {
          console.log(`[Extension File Server] port ${port} busy, trying next...`);
          tryPort(index + 1);
        } else {
          reject(error);
        }
      });
    };

    tryPort(0);
  });
}

// HTTP MCP 服务器 - 为嵌入的扩展提供工具接口
function startHttpMcpServer(portOrPorts = 9999) {
  if (httpServer) {
    return Promise.resolve(portOrPorts);
  }

  const ports = Array.isArray(portOrPorts)
    ? portOrPorts
    : [portOrPorts, 39099, 39100, 39101, 39102];

  return new Promise((resolve, reject) => {
    const requestHandler = async (req, res) => {
      // 设置 CORS 头
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const query = parsedUrl.query;

        // 健康检查
        if (pathname === '/health') {
          res.writeHead(200);
          res.end(JSON.stringify({
            app: 'deepseek-client-full',
            ok: true,
          }));
          return;
        }

        // 执行命令
        if (pathname === '/exec') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const result = await execEmbeddedShell(data.cmd || '', data.cwd || null);
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                ...result,
              }));
            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({
                success: false,
                error: error.message,
                stdout: error.stdout || '',
                stderr: error.stderr || '',
              }));
            }
          });
          return;
        }

        // 读文件
        if (pathname === '/read-file') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const filepath = data.filepath || '';
              const content = fs.readFileSync(filepath, 'utf8');
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                content,
                path: filepath,
              }));
            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({
                success: false,
                error: error.message,
              }));
            }
          });
          return;
        }

        // 写文件
        if (pathname === '/write-file') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const filepath = data.filepath || '';
              const content = data.content || '';
              const dir = path.dirname(filepath);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(filepath, content, 'utf8');
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                path: filepath,
              }));
            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({
                success: false,
                error: error.message,
              }));
            }
          });
          return;
        }

        // 列出目录
        if (pathname === '/ls') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const dir = data.dir || data.path || os.homedir();
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              const files = entries.map(entry => ({
                name: entry.name,
                isDirectory: entry.isDirectory(),
                isFile: entry.isFile(),
                size: entry.isFile() ? fs.statSync(path.join(dir, entry.name)).size : null,
              }));
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                path: dir,
                entries: files,
              }));
            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({
                success: false,
                error: error.message,
              }));
            }
          });
          return;
        }

        // 搜索文件
        if (pathname === '/search-files') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const root = data.root || os.homedir();
              const query = data.query || '';
              const maxResults = Math.min(data.maxResults || 30, 100);

              const results = [];
              const walkDir = (dir, depth = 0) => {
                if (results.length >= maxResults || depth > 5) return;
                try {
                  const entries = fs.readdirSync(dir, { withFileTypes: true });
                  for (const entry of entries) {
                    if (results.length >= maxResults) break;
                    if (entry.name.toLowerCase().includes(query.toLowerCase())) {
                      results.push(path.join(dir, entry.name));
                    }
                    if (entry.isDirectory() && depth < 5) {
                      walkDir(path.join(dir, entry.name), depth + 1);
                    }
                  }
                } catch (_) {}
              };

              walkDir(root);
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                results,
                query,
              }));
            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({
                success: false,
                error: error.message,
              }));
            }
          });
          return;
        }

        // 工作空间信息
        if (pathname === '/workspace-info') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const cwd = data.cwd || os.homedir();
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                cwd,
                home: os.homedir(),
                platform: process.platform,
                shell: resolveEmbeddedShell(),
              }));
            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({
                success: false,
                error: error.message,
              }));
            }
          });
          return;
        }

        // MCP 请求
        if (pathname === '/mcp/request') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const { method, params, url: mcpUrl } = data;

              if (method === 'tools/list') {
                res.writeHead(200);
                res.end(JSON.stringify({
                  success: true,
                  tools: [
                    { name: 'shell_exec', description: 'Execute shell command' },
                    { name: 'read_file', description: 'Read file content' },
                    { name: 'write_file', description: 'Write file content' },
                    { name: 'list_dir', description: 'List directory contents' },
                    { name: 'search_files', description: 'Search for files' },
                  ],
                }));
                return;
              }

              res.writeHead(400);
              res.end(JSON.stringify({
                success: false,
                error: 'Unknown MCP method',
              }));
            } catch (error) {
              res.writeHead(500);
              res.end(JSON.stringify({
                success: false,
                error: error.message,
              }));
            }
          });
          return;
        }

        // 404
        res.writeHead(404);
        res.end(JSON.stringify({
          success: false,
          error: 'Not found',
        }));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({
          success: false,
          error: error.message,
        }));
      }
    };

    const tryPort = (index) => {
      if (index >= ports.length) {
        reject(new Error('No available ports for HTTP MCP Server'));
        return;
      }

      const port = ports[index];
      httpServer = http.createServer(requestHandler);
      httpServer.listen(port, '127.0.0.1', () => {
        console.log(`[HTTP MCP Server] 已启动在 http://127.0.0.1:${port}`);
        resolve(port);
      });

      httpServer.on('error', (error) => {
        httpServer = null;
        if (error.code === 'EADDRINUSE') {
          console.log(`[HTTP MCP Server] 端口 ${port} 被占用，尝试下一个...`);
          tryPort(index + 1);
        } else {
          console.error(`[HTTP MCP Server] 错误:`, error);
          reject(error);
        }
      });
    };

    tryPort(0);
  });
}

async function getEmbeddedShellStatus() {
  return {
    ok: true,
    shell: resolveEmbeddedShell(),
    cwd: os.homedir(),
    home: os.homedir(),
    platform: process.platform,
    node: process.version,
  };
}

async function execEmbeddedShell(command, cwd) {
  const shellPath = resolveEmbeddedShell();
  const workingDir = cwd ? path.resolve(cwd) : os.homedir();
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', command]
    : ['-lc', command];

  const result = await runCommand(shellPath, args, workingDir);
  return {
    ok: true,
    shell: shellPath,
    cwd: workingDir,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
  };
}

async function buildSourceDistIfNeeded(status, logs) {
  if (status.sourceDistExists) {
    return status;
  }

  const sourceRoot = status.sourceRoot;
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packageJsonPath = path.join(sourceRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`source package.json not found: ${packageJsonPath}`);
  }

  logs.push(`未检测到构建产物，开始在 ${sourceRoot} 构建 deepseek-pp...`);

  const nodeModulesPath = path.join(sourceRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    logs.push('未检测到 node_modules，先执行 npm install...');
    await runCommand(npmBin, ['install'], sourceRoot);
  }

  await runCommand(npmBin, ['run', 'build:chrome'], sourceRoot);
  logs.push('deepseek-pp 构建完成。');
  return buildLauncherStatus();
}

async function installProjectBrowserIfNeeded(status, logs) {
  if (status.projectBrowserExists) {
    return status;
  }

  const runtimeDir = status.projectRuntimeDir;
  
  // 彻底清理 runtime 目录确保干净的安装环境
  if (fs.existsSync(runtimeDir)) {
    console.log('[Launcher] 清理旧的 runtime 目录...');
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runtimeDir, { recursive: true });

  logs.push('未检测到项目内置浏览器，开始安装 Chrome for Testing 到项目 runtime...');
  
  // 调用专门的安装脚本，它有重试逻辑和更好的错误处理
  const installerScript = path.join(resolveAppPath(), 'scripts', 'install-browser.mjs');
  try {
    await runCommand(process.execPath, [installerScript], resolveAppPath(), createNodeChildEnv());
    logs.push('项目内置浏览器安装完成。');
  } catch (err) {
    logs.push(`浏览器安装失败: ${err.message}`);
    throw err;
  }
  
  return buildLauncherStatus();
}

async function runAutoFix() {
  const logs = [];
  let status = buildLauncherStatus();

  status = await installProjectBrowserIfNeeded(status, logs);
  status = await buildSourceDistIfNeeded(status, logs);

  if (!status.extensionExists) {
    logs.push('扩展目录缺失，开始同步扩展产物...');
    ensureExtensionSynced();
    status = buildLauncherStatus();
    logs.push('扩展同步完成。');
  }

  if (!status.shellHostReady) {
    logs.push('Shell Native Host 未就绪，开始自动安装...');
    const result = await installShellNativeHost();
    status = result.status;
    logs.push(...result.logs);
  }

  const report = {
    status,
    selfCheck: buildSelfCheck(status),
    logs,
  };

  safeSend('launcher:status-updated', status);
  safeSend('launcher:self-check-updated', report.selfCheck);
  return report;
}

async function installProjectBrowser() {
  const logs = [];
  const status = await installProjectBrowserIfNeeded(buildLauncherStatus(), logs);
  safeSend('launcher:status-updated', status);
  safeSend('launcher:self-check-updated', buildSelfCheck(status));
  return { status, logs };
}

async function installShellNativeHost() {
  const logs = [];
  const status = buildLauncherStatus();

  if (!status.browserFound) {
    throw new Error('未检测到浏览器，无法安装 Shell Native Host。');
  }

  const installerPath = resolveResourcePath('shell-host-bin', 'lib', 'installer.mjs');
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Shell Native Host installer not found: ${installerPath}`);
  }

  logs.push(`准备安装 Shell Native Host（browser=${status.shellBrowserTarget}, extension-id=${status.extensionId}）...`);
  await runCommand(
    process.execPath,
    [
      installerPath,
      'install',
      '--browser',
      status.shellBrowserTarget,
      '--extension-id',
      status.extensionId,
      '--skip-officecli',
    ],
    ensureChildProcessCwd(),
    createNodeChildEnv(),
  );
  logs.push('Shell Native Host 安装命令执行完成。');

  const nextStatus = buildLauncherStatus();
  if (!nextStatus.shellHostReady) {
    logs.push('Shell Native Host 安装后仍未就绪，请检查权限。');
  }

  safeSend('launcher:status-updated', nextStatus);
  safeSend('launcher:self-check-updated', buildSelfCheck(nextStatus));
  return { status: nextStatus, logs };
}

async function installShellNativeHostForExtensionId(extensionId, browserTarget) {
  const installerPath = resolveResourcePath('shell-host-bin', 'lib', 'installer.mjs');
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Shell Native Host installer not found: ${installerPath}`);
  }

  await runCommand(
    process.execPath,
    [
      installerPath,
      'install',
      '--browser',
      browserTarget,
      '--extension-id',
      extensionId,
      '--skip-officecli',
    ],
    ensureChildProcessCwd(),
    createNodeChildEnv(),
  );

  return buildLauncherStatus();
}

async function queryBrowserExtensionId(debugPort) {
  try {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: debugPort,
          path: '/json/list',
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const targets = JSON.parse(data);
              const extensionTarget = targets.find(
                (target) => (
                  (target.type === 'service_worker' || target.type === 'background_page')
                  && typeof target.url === 'string'
                  && target.url.startsWith('chrome-extension://')
                )
              );
              if (extensionTarget) {
                const match = extensionTarget.url.match(/chrome-extension:\/\/([a-z0-9]+)\//);
                if (match) {
                  resolve(match[1]);
                  return;
                }
              }
              resolve(null);
            } catch (_) {
              resolve(null);
            }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve(null);
      });
    });
  } catch (_) {
    return null;
  }
}

async function updateShellManifestWithRealExtensionId(extensionId) {
  const manifestPaths = resolveShellNativeManifestCandidates('chrome');
  const newOrigin = `chrome-extension://${extensionId}/`;
  let updated = false;

  for (const manifestPath of manifestPaths) {
    if (!fs.existsSync(manifestPath)) {
      continue;
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.allowed_origins) || !manifest.allowed_origins.includes(newOrigin)) {
        console.log(`[Shell Host] Updating manifest with extension ID: ${extensionId} -> ${manifestPath}`);
        manifest.allowed_origins = [newOrigin];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        updated = true;
      }
    } catch (err) {
      console.log(`[Shell Host] Error updating manifest ${manifestPath}:`, err.message);
    }
  }

  return updated;
}

async function launchFullRuntime() {
  let status = buildLauncherStatus();
  if (!status.extensionExists) {
    throw new Error('extension not found. please run extension sync first.');
  }
  if (!status.browserFound) {
    throw new Error('Chrome/Edge binary not found. set DEEPSEEK_CHROME_BIN first.');
  }

  const preferredExtensionId = status.fixedExtensionId || null;
  if (!status.shellHostReady && preferredExtensionId) {
    console.log(`[Launcher] Shell Native Host 未就绪，使用扩展 ID 自动安装: ${preferredExtensionId}`);
    status = await installShellNativeHostForExtensionId(preferredExtensionId, status.shellBrowserTarget);
  }

  // 强制使用项目内置浏览器，如果不存在则自动安装
  if (!status.projectBrowserExists) {
    console.log('[Launcher] 项目内置浏览器不存在，自动安装中...');
    installProjectBrowser()
      .then(() => {
        console.log('[Launcher] 项目浏览器安装完成，即将启动...');
        launchBrowserInstance(status);
      })
      .catch((err) => {
        console.error('[Launcher] 项目浏览器安装失败:', err.message);
      });
  } else {
    launchBrowserInstance(status);
  }
}

function launchBrowserInstance(status) {
  // 重新获取状态以确保是最新的
  const updatedStatus = buildLauncherStatus();
  const projectBinary = updatedStatus.projectBrowserBinary;
  if (!projectBinary) {
    console.error('[Launcher] Failed to resolve project browser binary.');
    return;
  }

  fs.mkdirSync(updatedStatus.profileDir, { recursive: true });
  const debugPort = 9223;
  const args = [
    `--user-data-dir=${updatedStatus.profileDir}`,
    `--disable-extensions-except=${updatedStatus.extensionPath}`,
    `--load-extension=${updatedStatus.extensionPath}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-default-browser-check',
    '--no-first-run',
    '--new-window',
    updatedStatus.targetUrl,
  ];

  const child = spawn(projectBinary, args, {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  // 启动浏览器后，等待 2s 让它加载扩展，然后查询扩展 ID 并保存/更新 manifest
  setTimeout(async () => {
    let extensionId = null;
    console.log('[Launcher] 启动后查询真实扩展 ID...');
    for (let i = 0; i < 5; i++) {
      extensionId = await queryBrowserExtensionId(debugPort);
      if (extensionId) {
        console.log(`[Launcher] ✅ 获取扩展 ID: ${extensionId}`);
        setFixedExtensionId(extensionId);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!extensionId) {
      extensionId = getFixedExtensionId();
      if (extensionId) {
        console.log(`[Launcher] 查询失败，回退到已保存扩展 ID: ${extensionId}`);
      }
    }

    if (extensionId) {
      await installShellNativeHostForExtensionId(extensionId, updatedStatus.shellBrowserTarget);
      await updateShellManifestWithRealExtensionId(extensionId);
      const nextStatus = buildLauncherStatus();
      safeSend('launcher:status-updated', nextStatus);
      safeSend('launcher:self-check-updated', buildSelfCheck(nextStatus));
    }
  }, 2000);
}

function safeSend(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: 'DeepSeek Desktop',
    webPreferences: {
      preload: resolveAppPath('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
    show: false,
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile(resolveAppPath('app-shell.html'));
  attachEditContextMenu(mainWindow.webContents);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    const status = buildLauncherStatus();
    safeSend('launcher:status-updated', status);
    safeSend('launcher:self-check-updated', buildSelfCheck(status));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function attachEditContextMenu(contents) {
  if (!contents || contents.__dppEditContextMenuAttached) {
    return;
  }

  contents.__dppEditContextMenuAttached = true;
  contents.on('context-menu', (_, params) => {
    const template = [];
    const editable = Boolean(params.isEditable);
    const hasSelection = Boolean(params.selectionText);
    const editFlags = params.editFlags || {};

    if (editFlags.canUndo) template.push({ role: 'undo' });
    if (editFlags.canRedo) template.push({ role: 'redo' });
    if (template.length > 0) template.push({ type: 'separator' });

    if (editFlags.canCut && editable) template.push({ role: 'cut' });
    if (editFlags.canCopy && (editable || hasSelection)) template.push({ role: 'copy' });
    if (editFlags.canPaste && editable) template.push({ role: 'paste' });
    if (editFlags.canSelectAll && (editable || hasSelection)) template.push({ role: 'selectAll' });

    if (template.length === 0) {
      return;
    }

    const targetWindow = BrowserWindow.fromWebContents(contents) || mainWindow;
    Menu.buildFromTemplate(template).popup({ window: targetWindow || undefined });
  });
}

async function handlePrepareExtension() {
  ensureExtensionSynced();
  const status = buildLauncherStatus();
  safeSend('launcher:status-updated', status);
  safeSend('launcher:self-check-updated', buildSelfCheck(status));
  return status;
}

async function handleLaunchFull() {
  launchFullRuntime();
  return buildLauncherStatus();
}

function createAppMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'DeepSeek',
      submenu: [
        {
          label: '启动全功能模式',
          click: async () => {
            try {
              await handlePrepareExtension();
              await handleLaunchFull();
            } catch (error) {
              dialog.showErrorBox('启动失败', error instanceof Error ? error.message : String(error));
            }
          },
        },
        {
          label: '同步扩展产物',
          click: async () => {
            try {
              await handlePrepareExtension();
            } catch (error) {
              dialog.showErrorBox('同步失败', error instanceof Error ? error.message : String(error));
            }
          },
        },
        {
          label: '安装项目内置 Chrome',
          click: async () => {
            try {
              await installProjectBrowser();
            } catch (error) {
              dialog.showErrorBox('安装失败', error instanceof Error ? error.message : String(error));
            }
          },
        },
        {
          label: '安装 Shell Native Host',
          click: async () => {
            try {
              await installShellNativeHost();
            } catch (error) {
              dialog.showErrorBox('安装失败', error instanceof Error ? error.message : String(error));
            }
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => app.quit(),
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开 DeepSeek 网站',
          click: () => shell.openExternal('https://chat.deepseek.com/'),
        },
        {
          label: '打开 DeepSeek++ 仓库',
          click: () => shell.openExternal('https://github.com/zhu1090093659/deepseek-pp'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createTray() {
  const iconPath = resolveAppPath('extension', 'chrome-mv3', 'icon', '32.png');
  if (!fs.existsSync(iconPath)) {
    return;
  }

  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: '安装项目内置 Chrome', click: async () => { try { await installProjectBrowser(); } catch (_) {} } },
    { label: '安装 Shell Native Host', click: async () => { try { await installShellNativeHost(); } catch (_) {} } },
    { label: '同步扩展产物', click: async () => { try { await handlePrepareExtension(); } catch (_) {} } },
    { label: '启动全功能模式', click: async () => { try { await handlePrepareExtension(); await handleLaunchFull(); } catch (_) {} } },
    { label: '退出', click: () => { app.quit(); } }
  ]);
  tray.setToolTip('DeepSeek Client Launcher');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

// ============================================================
// Webview-sidepanel message bridge (keyed by channel)
// ============================================================
const webviewMessageBridge = {
  toContentListeners: [],
  toSidepanelListeners: [],

  sendToWebview(message) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:broadcast:toContent', message);
    }
  },

  sendToSidepanel(message) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:broadcast:toSidepanel', message);
    }
  },

  // 转发 webview → sidepanel
  forwardToSidepanel(message) {
    this.sendToSidepanel(message);
  },

  // 转发 sidepanel → webview
  forwardToWebview(message) {
    this.sendToWebview(message);
  }
};

// ============================================================
// 预创建 Shell MCP 预设
// ============================================================
function ensureShellMcpPreset() {
  const data = readExtensionLocalStorage();

  const serversKey = 'deepseek_pp_mcp_servers';
  let wrapper = data[serversKey];
  if (!wrapper || !wrapper.servers) {
    wrapper = { version: 1, servers: [], toolCaches: [] };
  }

  const servers = wrapper.servers;
  const shellIndex = servers.findIndex(function(s) {
    const name = (s && (s.displayName || s.name || '')).toLowerCase();
    return (s && s.transport && s.transport.nativeHost === 'com.deepseek_pp.shell') || name.indexOf('shell') >= 0 || name.indexOf('local') >= 0;
  });
  const now = Date.now();
  let changed = false;

  if (shellIndex < 0) {
    const shellPreset = {
      version: 1,
      id: 'builtin-shell-' + now,
      displayName: 'Shell Local',
      enabled: true,
      transport: {
        kind: 'native_messaging', url: '', nativeHost: 'com.deepseek_pp.shell',
        command: '', args: [], cwd: '', env: {}
      },
      headers: [], secrets: [],
      timeouts: { connectMs: 5000, requestMs: 120000, discoveryMs: 10000 },
      limits: { maxResultBytes: 128000, maxToolCount: 9 },
      allowlist: { mode: 'allow', toolNames: ['shell_exec', 'shell_status', 'python_status', 'local_skill_preview', 'local_folder_pick'] },
      execution: { mode: 'auto', enabled: true },
      status: 'ready', lastConnectedAt: now, lastError: '',
      createdAt: now, updatedAt: now
    };
    servers.push(shellPreset);
    changed = true;
    console.log('[MCP] Shell preset created:', shellPreset.id);
  } else {
    const shellPreset = servers[shellIndex] || {};
    shellPreset.version = 1;
    shellPreset.displayName = 'Shell Local';
    shellPreset.enabled = true;
    shellPreset.transport = Object.assign({ kind: 'native_messaging', url: '', nativeHost: 'com.deepseek_pp.shell', command: '', args: [], cwd: '', env: {} }, shellPreset.transport || {}, { kind: 'native_messaging', nativeHost: 'com.deepseek_pp.shell' });
    shellPreset.headers = Array.isArray(shellPreset.headers) ? shellPreset.headers : [];
    shellPreset.secrets = Array.isArray(shellPreset.secrets) ? shellPreset.secrets : [];
    shellPreset.timeouts = { connectMs: 5000, requestMs: 120000, discoveryMs: 10000 };
    shellPreset.limits = { maxResultBytes: 128000, maxToolCount: 9 };
    shellPreset.allowlist = { mode: 'allow', toolNames: ['shell_exec', 'shell_status', 'python_status', 'local_skill_preview', 'local_folder_pick'] };
    shellPreset.execution = { mode: 'auto', enabled: true };
    shellPreset.status = shellPreset.status === 'ready' ? 'ready' : 'unknown';
    shellPreset.lastError = shellPreset.lastError || '';
    shellPreset.updatedAt = now;
    servers[shellIndex] = shellPreset;
    changed = true;
    console.log('[MCP] Shell preset upgraded:', shellPreset.id || '(existing)');
  }

  if (changed) {
    wrapper.servers = servers;
    data[serversKey] = wrapper;
    writeExtensionLocalStorage(data);
  }
}

// ============================================================
// 消息默认响应 (background.js 未应答时的回退数据)
// ============================================================
function getDefaultResponse(message) {
  const type = message && message.type;
  if (!type) return { ok: true };
  if (type === 'GET_AUTOMATIONS') return getAutomationState().automations;
  if (type === 'GET_AUTOMATION_RUNS') return getAutomationState().runs;
  if (type === 'RUN_AUTOMATION_NOW') {
    const automationId = message && message.payload ? message.payload.automationId : null;
    const state = getAutomationState();
    return {
      ok: false,
      error: 'Automation request timed out before background responded.',
      automation: state.automations.find((item) => item && item.id === automationId) || null,
      run: null,
    };
  }
  if (type.indexOf('AUTOMATION') >= 0) {
    const state = getAutomationState();
    return { ok: true, automations: state.automations, runs: state.runs };
  }
  if (type === 'GET_MCP_SERVERS' || type === 'GET_MCP_TOOL_CACHE') {
    const data = readExtensionLocalStorage();
    const state = data.deepseek_pp_mcp_servers || { servers: [], toolCaches: [] };
    if (type === 'GET_MCP_SERVERS') {
      return Array.isArray(state.servers) ? state.servers : [];
    }
    const serverId = message && message.payload ? message.payload.serverId : undefined;
    const caches = Array.isArray(state.toolCaches) ? state.toolCaches : [];
    return caches.find(function(cache) { return cache && cache.serverId === serverId; }) || null;
  }
  if (type === 'TEST_MCP_SERVER_CONNECTION' || type === 'REFRESH_MCP_SERVER_TOOLS') {
    const data = readExtensionLocalStorage();
    const state = data.deepseek_pp_mcp_servers || { servers: [], toolCaches: [] };
    const serverId = message && message.payload ? message.payload.serverId : undefined;
    const cache = (Array.isArray(state.toolCaches) ? state.toolCaches : []).find(function(item) {
      return item && item.serverId === serverId;
    }) || null;
    if (type === 'TEST_MCP_SERVER_CONNECTION') {
      return {
        ok: !!(cache && cache.health && cache.health.status === 'ready'),
        cache: cache,
        health: cache ? cache.health : null,
      };
    }
    return cache;
  }
  if (type === 'GET_TOOL_CALL_HISTORY') return [];
  if (type.indexOf('BROWSER') >= 0) return { ok: true, enabled: false, browserControlEnabled: false, tabs: [] };
  if (type.indexOf('MEMOR') >= 0) return { ok: true, memories: [] };
  if (type.indexOf('SKILL') >= 0) return { ok: true, skills: [], sources: [] };
  if (type.indexOf('PRESET') >= 0) return { ok: true, presets: [], activePreset: null };
  if (type.indexOf('PROJECT') >= 0) return { ok: true, projects: [] };
  if (type.indexOf('SETTING') >= 0 || type.indexOf('BACKGROUND') >= 0 || type.indexOf('PET') >= 0) return { ok: true, settings: {} };
  if (type.indexOf('SAVE_') >= 0 || type.indexOf('DELETE') >= 0 || type.indexOf('TOGGLE') >= 0 || type.indexOf('UPDATE') >= 0) return { ok: true };
  if (type.indexOf('CHAT_ENABLED') >= 0 || type.indexOf('API_KEY') >= 0) return { ok: true, enabled: false };
  if (type.indexOf('LOCALE') >= 0 || type.indexOf('LANG') >= 0) return { ok: true, locale: 'zh-CN' };
  if (type.indexOf('THEME') >= 0) return { ok: true, theme: 'light' };
  if (type.indexOf('AUTH') >= 0) return { ok: true, authenticated: false };
  if (type.indexOf('SYNC') >= 0 || type.indexOf('WEBDAV') >= 0) return { ok: true, config: null };
  if (type.indexOf('TOOL_DESCRIPTORS') >= 0) return { ok: true, tools: [] };
  if (type === 'GET_PLATFORM_CAPABILITIES') {
    return {
      kind: 'browser_extension',
      name: 'WebExtension',
      capabilities: {
        storage: true,
        runtimeMessaging: true,
        downloads: true,
        filePicker: true,
        folderPicker: true,
        assetUrl: true,
        sidePanel: true,
        nativeMessaging: true,
        contextMenus: true,
        alarms: true,
        tabs: true,
        tabGroups: false,
        debugger: true,
        browserControl: true,
        accessibilityTree: true
      }
    };
  }
  if (type.indexOf('EXPORT') >= 0) return { ok: true, conversations: [] };
  return { ok: true };
}

function resolveBundledNativeHostScript(host) {
  if (host === BUILTIN_SHELL_HOST) {
    return resolveResourcePath('shell-host-bin', 'native', 'shell-mcp-host.mjs');
  }
  return null;
}

function sendNativePortEvent(state, channel, payload) {
  try {
    if (state.sender && !state.sender.isDestroyed()) {
      state.sender.send(channel + state.portId, payload);
    }
  } catch (_) {}
}

function destroyNativePort(portId, reason) {
  const state = nativeHostPorts.get(portId);
  if (!state) return;
  nativeHostPorts.delete(portId);

  if (state.child && !state.child.killed) {
    try { state.child.kill(); } catch (_) {}
  }

  sendNativePortEvent(state, 'chrome:native:onDisconnect:', { reason: reason || 'closed' });
}

function drainNativeHostStdout(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 4) {
    const length = state.buffer.readUInt32LE(0);
    if (length <= 0 || length > 10 * 1024 * 1024) {
      console.error('[Native] Invalid message length from host:', state.host, length);
      destroyNativePort(state.portId, 'invalid_frame');
      return;
    }
    if (state.buffer.length < 4 + length) return;

    const json = state.buffer.subarray(4, 4 + length).toString('utf8');
    state.buffer = state.buffer.subarray(4 + length);

    try {
      const message = JSON.parse(json);
      sendNativePortEvent(state, 'chrome:native:onMessage:', message);
    } catch (error) {
      console.error('[Native] Failed to parse host response:', error.message);
    }
  }
}

function writeNativeHostMessage(state, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32LE(json.length, 0);
  json.copy(frame, 4);
  state.child.stdin.write(frame);
}

function createBundledNativePort(sender, portId, host) {
  const scriptPath = resolveBundledNativeHostScript(host);
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return null;
  }

  const child = spawnNodeScript(scriptPath, [], {
    cwd: ensureChildProcessCwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = {
    portId,
    host,
    sender,
    child,
    buffer: Buffer.alloc(0),
  };

  child.stdout.on('data', (chunk) => drainNativeHostStdout(state, chunk));
  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.log('[Native host]', text);
  });
  child.on('error', (error) => {
    console.error('[Native] Host process error:', host, error.message);
    destroyNativePort(portId, 'process_error');
  });
  child.on('close', () => {
    if (nativeHostPorts.get(portId) === state) {
      destroyNativePort(portId, 'process_closed');
    }
  });

  nativeHostPorts.set(portId, state);
  return state;
}

function readExtensionLocalStorage() {
  const storagePath = path.join(app.getPath('userData'), 'extension-storage', 'local.json');
  try {
    if (fs.existsSync(storagePath)) {
      return JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function writeExtensionLocalStorage(data) {
  const dir = path.join(app.getPath('userData'), 'extension-storage');
  fs.mkdirSync(dir, { recursive: true });
  const storagePath = path.join(dir, 'local.json');
  fs.writeFileSync(storagePath, JSON.stringify(data, null, 2));
}

function normalizeAutomationEntry(item) {
  const automation = item && typeof item === 'object' ? { ...item } : {};
  const schedule = automation.schedule && typeof automation.schedule === 'object' ? automation.schedule : {};
  const promptOptions = automation.promptOptions && typeof automation.promptOptions === 'object' ? automation.promptOptions : {};
  const deepseek = automation.deepseek && typeof automation.deepseek === 'object' ? automation.deepseek : {};
  automation.schedule = {
    kind: typeof schedule.kind === 'string' ? schedule.kind : 'manual',
    expression: typeof schedule.expression === 'string' ? schedule.expression : '',
    timezone: typeof schedule.timezone === 'string' ? schedule.timezone : 'UTC',
    enabled: schedule.enabled !== false,
    minimumIntervalMinutes: typeof schedule.minimumIntervalMinutes === 'number' ? schedule.minimumIntervalMinutes : 15,
  };
  automation.promptOptions = {
    modelType: promptOptions.modelType ?? null,
    searchEnabled: promptOptions.searchEnabled === true,
    thinkingEnabled: promptOptions.thinkingEnabled === true,
    refFileIds: Array.isArray(promptOptions.refFileIds) ? promptOptions.refFileIds : [],
  };
  automation.deepseek = {
    chatSessionId: deepseek.chatSessionId ?? null,
    parentMessageId: deepseek.parentMessageId ?? null,
    sessionUrl: deepseek.sessionUrl ?? null,
    lastHistorySyncedAt: deepseek.lastHistorySyncedAt ?? null,
  };
  automation.status = typeof automation.status === 'string' ? automation.status : 'active';
  automation.lastError = automation.lastError && typeof automation.lastError === 'object' ? automation.lastError : null;
  automation.enabled = automation.enabled !== false;
  return automation;
}

function normalizeAutomationRunEntry(item) {
  const run = item && typeof item === 'object' ? { ...item } : {};
  run.request = run.request && typeof run.request === 'object' ? { ...run.request } : {};
  run.result = run.result && typeof run.result === 'object' ? { ...run.result } : null;
  run.error = run.error && typeof run.error === 'object' ? run.error : null;
  return run;
}

function getAutomationState() {
  const data = readExtensionLocalStorage();
  const wrapper = data.deepseek_pp_automations && typeof data.deepseek_pp_automations === 'object'
    ? data.deepseek_pp_automations
    : { version: 1, automations: [], runs: [] };
  return {
    wrapper,
    automations: Array.isArray(wrapper.automations) ? wrapper.automations.map(normalizeAutomationEntry) : [],
    runs: Array.isArray(wrapper.runs) ? wrapper.runs.map(normalizeAutomationRunEntry) : [],
  };
}

function createShellToolDescriptor(server, tool) {
  return {
    id: 'mcp:' + server.id + ':' + tool.name,
    provider: {
      kind: 'mcp',
      id: server.id,
      displayName: server.displayName,
      transport: 'native_messaging'
    },
    name: tool.name,
    invocationName: ('mcp_' + String(server.id || '').replace(/[^A-Za-z0-9_]+/g, '_') + '_' + String(tool.name || '').replace(/[^A-Za-z0-9_]+/g, '_')).slice(0, 96),
    title: tool.title || tool.name,
    description: tool.description || tool.name,
    inputSchema: tool.inputSchema || { type: 'object', properties: {}, required: [], additionalProperties: false },
    execution: {
      enabled: server.enabled && server.execution && server.execution.enabled !== false && server.execution.mode === 'auto',
      mode: server.execution && server.execution.mode ? server.execution.mode : 'auto',
      risk: (tool.annotations && tool.annotations.risk) || 'low',
      timeoutMs: server.timeouts && server.timeouts.requestMs ? server.timeouts.requestMs : 120000,
      maxResultBytes: server.limits && server.limits.maxResultBytes ? server.limits.maxResultBytes : 128000,
    },
    annotations: tool.annotations || {},
  };
}

function getShellServerState() {
  const data = readExtensionLocalStorage();
  const state = data.deepseek_pp_mcp_servers || { servers: [], toolCaches: [] };
  const servers = Array.isArray(state.servers) ? state.servers : [];
  const caches = Array.isArray(state.toolCaches) ? state.toolCaches : [];
  const server = servers.find(function(item) {
    return item && item.transport && item.transport.nativeHost === BUILTIN_SHELL_HOST;
  }) || null;
  const cache = server ? (caches.find(function(item) { return item && item.serverId === server.id; }) || null) : null;
  return { data, state, server, cache };
}

function renderBuiltInToolResultDetail(result) {
  if (!result) return '';
  if (result.structuredContent !== undefined) {
    try { return JSON.stringify(result.structuredContent, null, 2); } catch (_) {}
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter(function(item) { return item && item.type === 'text' && typeof item.text === 'string'; })
      .map(function(item) { return item.text; })
      .join('\n');
    if (text) return text;
    try { return JSON.stringify(result.content, null, 2); } catch (_) {}
  }
  return '';
}

async function ensureBuiltInShellCache(options) {
  const force = !!(options && options.force);
  const state = getShellServerState();
  if (!state.server) return null;
  const now = Date.now();
  if (!force && state.cache && state.cache.expiresAt > now && state.cache.health && state.cache.health.status === 'ready') {
    return state.cache;
  }
  await warmShellMcpCache();
  return getShellServerState().cache;
}

async function executeBuiltInShellToolCall(call) {
  const shellState = getShellServerState();
  if (!shellState.server) return null;
  const startedAt = Date.now();
  const scriptPath = resolveBundledNativeHostScript(BUILTIN_SHELL_HOST);
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return {
      ok: false,
      summary: 'MCP 服务不可用',
      detail: 'Built-in Shell host script is missing.',
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      error: { code: 'builtin_shell_host_missing', message: 'Built-in Shell host script is missing.', retryable: false },
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const response = await sendNativeJsonRpc(scriptPath, {
      jsonrpc: '2.0',
      id: 'call-' + startedAt,
      method: 'tools/call',
      params: {
        name: call.name,
        arguments: call.payload || {},
      },
    }, Math.min(
      (shellState.server.timeouts && shellState.server.timeouts.requestMs) || 120000,
      (call.payload && typeof call.payload.timeout_ms === 'number' && call.payload.timeout_ms > 0) ? call.payload.timeout_ms : 120000,
    ));

    const rpcResult = response && response.result ? response.result : {};
    const detail = renderBuiltInToolResultDetail(rpcResult);
    const completedAt = Date.now();
    return {
      ok: rpcResult.isError !== true,
      summary: rpcResult.isError ? 'MCP 工具返回错误' : 'MCP 工具已执行',
      detail: detail,
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      output: rpcResult.structuredContent !== undefined ? rpcResult.structuredContent : rpcResult.content,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      truncated: false,
      error: rpcResult.isError ? {
        code: 'mcp_tool_result_error',
        message: detail || 'MCP tool returned isError=true.',
        retryable: false,
      } : undefined,
    };
  } catch (error) {
    const completedAt = Date.now();
    return {
      ok: false,
      summary: 'MCP 工具调用失败',
      detail: error instanceof Error ? error.message : String(error),
      name: call.name,
      provider: call.provider,
      descriptorId: call.descriptorId,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      error: {
        code: 'mcp_tool_call_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

async function tryHandleBuiltInShellRuntimeMessage(message) {
  const type = message && message.type;
  const shellState = getShellServerState();
  if (!shellState.server) return null;

  if (type === 'GET_MCP_SERVERS') {
    return shellState.state.servers;
  }

  if (type === 'GET_MCP_TOOL_CACHE') {
    const serverId = message && message.payload ? message.payload.serverId : undefined;
    if (serverId === shellState.server.id) {
      return shellState.cache;
    }
    return null;
  }

  if (type === 'TEST_MCP_SERVER_CONNECTION' || type === 'REFRESH_MCP_SERVER_TOOLS') {
    const serverId = message && message.payload ? message.payload.serverId : undefined;
    if (serverId !== shellState.server.id) return null;
    const cache = await ensureBuiltInShellCache({ force: true });
    if (type === 'TEST_MCP_SERVER_CONNECTION') {
      return {
        ok: !!(cache && cache.health && cache.health.status === 'ready'),
        cache: cache,
        health: cache ? cache.health : null,
      };
    }
    return cache;
  }

  if (type === 'EXECUTE_TOOL_CALL' && message && message.payload) {
    const call = message.payload;
    const providerId = call && call.provider && call.provider.kind === 'mcp' ? call.provider.id : null;
    const descriptorId = call && typeof call.descriptorId === 'string' ? call.descriptorId : '';
    const targetsShell = providerId === shellState.server.id || descriptorId.indexOf('mcp:' + shellState.server.id + ':') === 0;
    if (!targetsShell) return null;
    return executeBuiltInShellToolCall(call);
  }

  return null;
}

function sendNativeJsonRpc(scriptPath, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnNodeScript(scriptPath, [], {
      cwd: ensureChildProcessCwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = Buffer.alloc(0);
    let settled = false;

    const finish = function(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(function() {
      finish(new Error('Native MCP request timed out after ' + timeoutMs + ' ms'));
    }, timeoutMs);

    child.stdout.on('data', function(chunk) {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      while (stdoutBuffer.length >= 4) {
        const length = stdoutBuffer.readUInt32LE(0);
        if (length <= 0 || length > 10 * 1024 * 1024) {
          finish(new Error('Invalid native host frame length: ' + length));
          return;
        }
        if (stdoutBuffer.length < 4 + length) return;
        const json = stdoutBuffer.subarray(4, 4 + length).toString('utf8');
        stdoutBuffer = stdoutBuffer.subarray(4 + length);
        try {
          finish(null, JSON.parse(json));
          return;
        } catch (error) {
          finish(error);
          return;
        }
      }
    });

    child.stderr.on('data', function(chunk) {
      const text = String(chunk || '').trim();
      if (text) console.log('[Native host]', text);
    });

    child.on('error', function(error) {
      finish(error);
    });

    child.on('close', function(code) {
      if (!settled) {
        finish(new Error('Native host exited before response (code ' + code + ')'));
      }
    });

    const envelope = {
      protocol: 'deepseek-pp-mcp-native',
      version: 1,
      server: { id: 'prewarm-shell' },
      message: request,
    };
    const body = Buffer.from(JSON.stringify(envelope), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    child.stdin.write(header);
    child.stdin.write(body);
  });
}

async function warmShellMcpCache() {
  const scriptPath = resolveBundledNativeHostScript('com.deepseek_pp.shell');
  if (!scriptPath || !fs.existsSync(scriptPath)) return;

  const data = readExtensionLocalStorage();
  const wrapper = data.deepseek_pp_mcp_servers;
  if (!wrapper || !Array.isArray(wrapper.servers)) return;

  const server = wrapper.servers.find(function(item) {
    return item && item.transport && item.transport.nativeHost === 'com.deepseek_pp.shell';
  });
  if (!server || server.enabled === false) return;

  const startedAt = Date.now();
  try {
    await sendNativeJsonRpc(scriptPath, {
      jsonrpc: '2.0',
      id: 'init-' + startedAt,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        clientInfo: { name: 'DeepSeek++', version: '1.0.0' },
      },
    }, server.timeouts && server.timeouts.connectMs ? server.timeouts.connectMs : 5000);

    const listResponse = await sendNativeJsonRpc(scriptPath, {
      jsonrpc: '2.0',
      id: 'tools-' + startedAt,
      method: 'tools/list',
    }, server.timeouts && server.timeouts.discoveryMs ? server.timeouts.discoveryMs : 10000);

    const tools = listResponse && listResponse.result && Array.isArray(listResponse.result.tools)
      ? listResponse.result.tools
      : [];
    const descriptors = tools.map(function(tool) { return createShellToolDescriptor(server, tool); });
    const completedAt = Date.now();
    const entry = {
      serverId: server.id,
      descriptors: descriptors,
      refreshedAt: completedAt,
      expiresAt: completedAt + BUILTIN_SHELL_CACHE_TTL_MS,
      health: {
        serverId: server.id,
        status: 'ready',
        checkedAt: completedAt,
        latencyMs: completedAt - startedAt,
        toolCount: descriptors.length,
        error: null,
      },
    };

    wrapper.toolCaches = [entry].concat(Array.isArray(wrapper.toolCaches) ? wrapper.toolCaches.filter(function(cache) {
      return cache && cache.serverId !== server.id;
    }) : []);
    server.status = 'ready';
    server.lastConnectedAt = completedAt;
    server.lastError = null;
    server.updatedAt = completedAt;
    data.deepseek_pp_mcp_servers = wrapper;
    writeExtensionLocalStorage(data);
    console.log('[MCP] Shell cache warmed:', descriptors.length, 'tools');
  } catch (error) {
    const completedAt = Date.now();
    wrapper.toolCaches = [{
      serverId: server.id,
      descriptors: [],
      refreshedAt: completedAt,
      expiresAt: completedAt + 30000,
      health: {
        serverId: server.id,
        status: 'error',
        checkedAt: completedAt,
        latencyMs: completedAt - startedAt,
        toolCount: 0,
        error: error.message,
      },
    }].concat(Array.isArray(wrapper.toolCaches) ? wrapper.toolCaches.filter(function(cache) {
      return cache && cache.serverId !== server.id;
    }) : []);
    server.status = 'error';
    server.lastError = error.message;
    server.updatedAt = completedAt;
    data.deepseek_pp_mcp_servers = wrapper;
    writeExtensionLocalStorage(data);
    console.error('[MCP] Shell cache warm failed:', error.message);
  }
}

function registerIpcHandlers() {
  ipcMain.handle('launcher:get-status', async () => buildLauncherStatus());
  ipcMain.handle('launcher:get-self-check', async () => buildSelfCheck(buildLauncherStatus()));
  ipcMain.handle('app:get-shell-status', async () => getEmbeddedShellStatus());
  ipcMain.handle('app:exec-shell', async (_, payload) => execEmbeddedShell(payload?.command || '', payload?.cwd || null));
  ipcMain.handle('launcher:install-project-browser', async () => installProjectBrowser());
  ipcMain.handle('launcher:install-shell-host', async () => installShellNativeHost());
  ipcMain.handle('launcher:auto-fix', async () => runAutoFix());
  ipcMain.handle('launcher:prepare-extension', async () => handlePrepareExtension());
  ipcMain.handle('launcher:launch-full', async () => handleLaunchFull());
  ipcMain.handle('launcher:reset-fixed-extension-id', async () => {
    const config = readAppConfig();
    delete config.fixedExtensionId;
    writeAppConfig(config);
    console.log('[Launcher] 已重置固定扩展 ID，下次启动时将重新检测。');
    return buildLauncherStatus();
  });
  ipcMain.handle('launcher:open-extension-dir', async () => {
    const result = await shell.openPath(resolveExtensionPath());
    return { ok: !result, error: result || null };
  });
  ipcMain.handle('launcher:open-profile-dir', async () => {
    const result = await shell.openPath(resolveProfileDir());
    return { ok: !result, error: result || null };
  });
  ipcMain.handle('launcher:open-runtime-dir', async () => {
    const runtimeDir = resolveProjectRuntimeDir();
    fs.mkdirSync(runtimeDir, { recursive: true });
    const result = await shell.openPath(runtimeDir);
    return { ok: !result, error: result || null };
  });
  ipcMain.handle('launcher:open-url', async (_, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });

  // ============================================================
  // Chrome API Polyfill IPC Handlers (webview preload → main)
  // ============================================================

  // 提供扩展目录路径 (同步)
  ipcMain.on('chrome:getExtensionPath', (event) => {
    event.returnValue = resolveExtensionPath();
  });

  // 提供扩展文件服务器端口
  ipcMain.handle('chrome:getExtensionFilePort', async () => {
    return extensionFilePort;
  });

  ipcMain.handle('app:fetchDeepSeekApi', async (_, request) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is unavailable for DeepSeek API proxy fetch.');
    }
    if (!request || !isDeepSeekApiUrl(request.url)) {
      throw new Error('Unsupported DeepSeek API proxy URL.');
    }

    const webContents = mainWindow.webContents;
    const ses = webContents.session;
    const requestUrl = request.url;
    const isPowChallenge = typeof requestUrl === 'string' && requestUrl.indexOf('/api/v0/chat/create_pow_challenge') >= 0;
    if (isPowChallenge) {
      console.log('[DeepSeek API proxy] create_pow_challenge request');
    }

    const body = await injectPreferenceMemoryIntoRequestBody(request.body);

    const response = await ses.fetch(requestUrl, {
      method: request.method || 'GET',
      headers: request.headers || {},
      body: body,
      bypassCustomProtocolHandlers: false,
      credentials: 'include',
    });

    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const arrayBuffer = await response.arrayBuffer();
    if (isPowChallenge) {
      console.log('[DeepSeek API proxy] create_pow_challenge response:', response.status, response.statusText, 'bytes=', arrayBuffer.byteLength);
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers,
      bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
      url: response.url,
    };
  });

  ipcMain.handle('app:fetchBingDiagnostic', async (_, request) => {
    if (!request || !isBingSearchUrl(request.url)) {
      throw new Error('Unsupported Bing diagnostic URL');
    }

    const ses = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.webContents.session
      : BrowserWindow.getAllWindows()[0]?.webContents.session;
    if (!ses) {
      throw new Error('Electron session is not ready');
    }

    const response = await ses.fetch(request.url, {
      method: 'GET',
      headers: request.headers || {},
      bypassCustomProtocolHandlers: false,
      credentials: 'omit',
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      bodyText: text,
      url: response.url,
    };
  });

  ipcMain.handle('app:getPreferenceMemory', async () => {
    return {
      path: resolvePreferenceMemoryPath(),
      lines: readPreferenceMemoryLines(),
    };
  });

  ipcMain.handle('app:setPreferenceMemory', async (_, payload) => {
    const lines = Array.isArray(payload && payload.lines)
      ? payload.lines.filter((line) => typeof line === 'string').map((line) => line.trim()).filter(Boolean)
      : [];
    const memoryPath = resolvePreferenceMemoryPath();
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    const content = ['# Preference Memory', '', ...lines.map((line) => '- ' + line), ''].join('\n');
    fs.writeFileSync(memoryPath, content, 'utf8');
    return { ok: true, path: memoryPath, lines };
  });

  ipcMain.handle('app:setRuntimeConversationMode', async (_, payload) => {
    const mode = payload || {};
    persistRuntimeConversationMode(mode);
    return { ok: true };
  });


  // 诊断日志 (renderer → main process stderr)
  ipcMain.on('app:diagnosticLog', (_, msg) => {
    console.log('[diagnostic] ' + msg);
  });
  ipcMain.handle('app:getWebviewPreloadPath', async () => {
    const preloadPath = path.resolve(__dirname, 'webview-preload.js');
    const fileUrl = 'file://' + (process.platform === 'win32' ? '/' : '') + preloadPath.replace(/\\/g, '/');
    console.log('[preload] Chat preload URL:', fileUrl);
    return fileUrl;
  });

  // 提供 background webview preload 脚本的路径
  ipcMain.handle('app:getBackgroundPreloadPath', async () => {
    const preloadPath = path.resolve(__dirname, 'background-preload.js');
    const fileUrl = 'file://' + (process.platform === 'win32' ? '/' : '') + preloadPath.replace(/\\/g, '/');
    return fileUrl;
  });

  // 提供 sidepanel webview preload 路径
  ipcMain.handle('app:getSidepanelPreloadPath', async () => {
    const preloadPath = path.resolve(__dirname, 'sidepanel-preload.js');
    const fileUrl = 'file://' + (process.platform === 'win32' ? '/' : '') + preloadPath.replace(/\\/g, '/');
    console.log('[preload] Sidepanel preload URL:', fileUrl);
    return fileUrl;
  });

  // 提供 background.js 代码 (用于 background webview)
  ipcMain.handle('chrome:getBackgroundScript', async () => {
    const extPath = resolveExtensionPath();
    const bgPath = path.join(extPath, 'background.js');
    try {
      if (fs.existsSync(bgPath)) {
        const code = fs.readFileSync(bgPath, 'utf8');
        console.log('[preload] Cached background.js (' + code.length + ' bytes)');
        return code;
      }
    } catch (err) {
      console.error('[preload] Failed to read background.js:', err.message);
    }
    return '';
  });

  // 同步版本 (用于 webview preload)
  ipcMain.on('chrome:getBackgroundScriptSync', (event) => {
    const extPath = resolveExtensionPath();
    const bgPath = path.join(extPath, 'background.js');
    try {
      if (fs.existsSync(bgPath)) {
        const code = fs.readFileSync(bgPath, 'utf8');
        event.returnValue = code;
        return;
      }
    } catch (err) {
      console.error('[preload] Failed to read background.js:', err.message);
    }
    event.returnValue = '';
  });

  // 提供 content scripts 代码 (用于 chat webview)
  ipcMain.handle('chrome:getContentScripts', async () => {
    if (!cachedContentScripts) {
      const extPath = resolveExtensionPath();
      cachedContentScripts = {};
      const contentPath = path.join(extPath, 'content-scripts', 'content.js');
      const mainWorldPath = path.join(extPath, 'content-scripts', 'main-world.js');
      try {
        if (fs.existsSync(contentPath)) {
          cachedContentScripts.content = fs.readFileSync(contentPath, 'utf8');
          console.log('[preload] Cached content.js (' + cachedContentScripts.content.length + ' bytes)');
        }
      } catch (err) {
        console.error('[preload] Failed to read content.js:', err.message);
      }
      try {
        if (fs.existsSync(mainWorldPath)) {
          cachedContentScripts.mainWorld = fs.readFileSync(mainWorldPath, 'utf8');
          console.log('[preload] Cached main-world.js (' + cachedContentScripts.mainWorld.length + ' bytes)');
        }
      } catch (err) {
        console.error('[preload] Failed to read main-world.js:', err.message);
      }
    }
    return cachedContentScripts || {};
  });

  // storage
  ipcMain.handle('chrome:storage:get', async (_, area, keys) => {
    // 从本地文件读取持久化存储
    const storagePath = path.join(app.getPath('userData'), 'extension-storage', `${area}.json`);
    try {
      if (fs.existsSync(storagePath)) {
        return JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      }
    } catch (_) {}
    return {};
  });

  ipcMain.handle('chrome:storage:set', async (_, area, items) => {
    const dir = path.join(app.getPath('userData'), 'extension-storage');
    fs.mkdirSync(dir, { recursive: true });
    const storagePath = path.join(dir, `${area}.json`);
    let current = {};
    try {
      if (fs.existsSync(storagePath)) {
        current = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      }
    } catch (_) {}
    Object.assign(current, items);
    fs.writeFileSync(storagePath, JSON.stringify(current, null, 2));
    return true;
  });

  ipcMain.handle('chrome:storage:remove', async (_, area, keys) => {
    const storagePath = path.join(app.getPath('userData'), 'extension-storage', `${area}.json`);
    try {
      if (fs.existsSync(storagePath)) {
        const current = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
        for (const key of keys) {
          delete current[key];
        }
        fs.writeFileSync(storagePath, JSON.stringify(current, null, 2));
      }
    } catch (_) {}
    return true;
  });

  // runtime message passing - 路由到 chat webview 的 background.js (在 preload 中共驻)
  const pendingRequests = new Map();
  let requestIdCounter = 0;

  ipcMain.handle('chrome:runtime:sendMessage', async (_, message) => {
    const typeStr = message && message.type ? message.type : '';

    if (typeStr === 'APP_FETCH_BING_DIAGNOSTIC') {
      const payload = message && message.payload ? message.payload : {};
      if (!payload || !payload.url) {
        return { ok: false, error: 'missing_url', status: 0, bodyText: '' };
      }
      const ses = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.webContents.session
        : BrowserWindow.getAllWindows()[0]?.webContents.session;
      if (!ses) {
        return { ok: false, error: 'session_not_ready', status: 0, bodyText: '' };
      }
      try {
        const response = await ses.fetch(payload.url, {
          method: 'GET',
          headers: payload.headers || {},
          bypassCustomProtocolHandlers: false,
          credentials: 'omit',
        });
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          bodyText: await response.text(),
          url: response.url,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          bodyText: '',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const builtInShellResponse = await tryHandleBuiltInShellRuntimeMessage(message);
    if (builtInShellResponse !== null) {
      return builtInShellResponse;
    }
    
    // 广播型消息 (由 background.js 发出，不需响应): 只转发到 sidepanel
    const broadcastTypes = ['AUTH_STATUS_CHANGED', 'THEME_UPDATED', 'STATE_UPDATED', 
      'MCP_SERVERS_UPDATED', 'TOOL_DESCRIPTORS_UPDATED', 'BACKGROUND_UPDATED',
      'PET_UPDATED', 'REFRESH_DEEPSEEK_AUTH', 'HEADERS_CAPTURED', 'CHAT_STREAM_CHUNK'];
    if (broadcastTypes.indexOf(typeStr) >= 0) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('chrome:broadcast:toSidepanel', message);
      }
      return { ok: true };
    }

    // 请求型消息: 广播到 chat webview，等待 background 响应
    const requestId = ++requestIdCounter;
    message._requestId = requestId;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:broadcast:toContent', message);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(getDefaultResponse(message));
      }, 10000);

      pendingRequests.set(requestId, { resolve, timer, message });
    });
  });

  // background.js 的 sendResponse 回调 → 匹配 requestId
  ipcMain.on('chrome:bg:sendResponse', (_, requestId, response) => {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      if (response === undefined) {
        pending.resolve(getDefaultResponse(pending.message));
      } else {
        pending.resolve(response);
      }
    }
  });

  // background.js 主动发送的消息 → 广播到 sidepanel 和 content
  ipcMain.handle('chrome:bg:sendMessage', async (_, message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:broadcast:toContent', message);
      mainWindow.webContents.send('chrome:broadcast:toSidepanel', message);
    }
    return { ok: true };
  });

  // tabs
  ipcMain.handle('chrome:tabs:query', async (_, queryInfo) => {
    return [{
      id: 1,
      url: 'https://chat.deepseek.com/',
      title: 'DeepSeek',
      active: true,
      windowId: 1
    }];
  });

  ipcMain.handle('chrome:tabs:sendMessage', async (_, tabId, message) => {
    // 转发到 webview
    webviewMessageBridge.sendToWebview(message);
    return { ok: true };
  });

  ipcMain.handle('chrome:tabs:create', async (_, createProperties) => {
    if (createProperties && createProperties.url) {
      if (mainWindow && !mainWindow.isDestroyed() && isDeepSeekChatUrl(createProperties.url)) {
        mainWindow.webContents.send('chrome:chat:navigate', { url: createProperties.url });
        return { id: 1, url: createProperties.url, active: true, windowId: 1 };
      }
      await shell.openExternal(createProperties.url);
    }
    return { id: 2 };
  });

  ipcMain.handle('chrome:tabs:update', async (_, tabId, updateProperties) => {
    if (updateProperties && updateProperties.url) {
      if (mainWindow && !mainWindow.isDestroyed() && isDeepSeekChatUrl(updateProperties.url)) {
        mainWindow.webContents.send('chrome:chat:navigate', { url: updateProperties.url });
        return { id: 1, url: updateProperties.url, active: true, windowId: 1 };
      }
      await shell.openExternal(updateProperties.url);
      return { id: tabId || 1, url: updateProperties.url, active: true, windowId: 1 };
    }
    return { id: tabId || 1 };
  });

  ipcMain.handle('chrome:tabs:remove', async () => {
    return;
  });

  // sidepanel
  ipcMain.on('chrome:sidepanel:open', (_, options) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:sidepanel:open', options);
    }
  });

  ipcMain.on('chrome:openSidepanel', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:sidepanel:open');
    }
  });

  // downloads
  ipcMain.handle('chrome:downloads:download', async (_, options) => {
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: options.filename || 'download',
      title: '下载文件'
    });
    if (savePath) {
      if (options.url && options.url.startsWith('data:')) {
        const matches = options.url.match(/^data:[^;]*;base64,(.*)$/);
        if (matches) {
          fs.writeFileSync(savePath, Buffer.from(matches[1], 'base64'));
        } else {
          const content = decodeURIComponent(options.url.split(',')[1] || '');
          fs.writeFileSync(savePath, content, 'utf8');
        }
      }
      return { id: Date.now(), filename: savePath };
    }
    return { id: 0 };
  });

  // permissions
  ipcMain.handle('chrome:permissions:contains', async (_, perms) => {
    return true;
  });

  ipcMain.handle('chrome:permissions:request', async (_, perms) => {
    return true;
  });

  // port messaging (sandbox-offscreen)
  ipcMain.on('chrome:port:postMessage', (_, { portId, name, msg }) => {
    // 处理 port 消息 - 转发到 sidepanel 或本地处理
    if (name === 'sandbox-offscreen') {
      // 沙箱执行请求 - 通过主进程执行
      handleSandboxRun(msg).then(result => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('chrome:port:onMessage:' + portId, result);
        }
      });
    }
  });

  ipcMain.on('chrome:port:disconnect', (_, portId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:port:onDisconnect:' + portId);
    }
  });

  // native messaging (替代为直接 shell 执行)
  ipcMain.on('chrome:native:connect', (event, { portId, host }) => {
    console.log('[Native] connectNative called for host:', host);
    if (nativeHostPorts.has(portId)) {
      destroyNativePort(portId, 'reconnect');
    }
    createBundledNativePort(event.sender, portId, host);
  });

  ipcMain.on('chrome:native:postMessage', async (event, { portId, host, msg }) => {
    try {
      const nativeState = nativeHostPorts.get(portId);
      if (nativeState) {
        writeNativeHostMessage(nativeState, msg);
        return;
      }

      let parsed;
      if (typeof msg === 'string') {
        try { parsed = JSON.parse(msg); } catch(_) {}
      } else if (msg && typeof msg === 'object') {
        parsed = msg;
      }

      if (parsed && parsed.method) {
        if (parsed.method === 'tools/list') {
          // 返回可用工具列表
          var response = JSON.stringify({
            jsonrpc: '2.0', id: parsed.id,
            result: { tools: [
              { name: 'shell_exec', description: 'Execute a shell command on the local machine',
                inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'The shell command to execute' }, cwd: { type: 'string', description: 'Working directory' } }, required: ['command'] } },
              { name: 'read_file', description: 'Read file contents',
                inputSchema: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] } },
              { name: 'write_file', description: 'Write content to a file',
                inputSchema: { type: 'object', properties: { filepath: { type: 'string' }, content: { type: 'string' } }, required: ['filepath', 'content'] } },
              { name: 'list_dir', description: 'List directory contents',
                inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
            ] }
          });
          event.sender.send('chrome:native:onMessage:' + portId, response);
          return;
        }

        if (parsed.method === 'tools/call' && parsed.params) {
          var toolName = parsed.params.name;
          var args = parsed.params.arguments || {};
          var result;

          if (toolName === 'shell_exec') {
            result = await execEmbeddedShell(args.command || '', args.cwd || null);
          } else if (toolName === 'read_file') {
            try {
              result = { stdout: fs.readFileSync(args.filepath, 'utf8'), stderr: '', exitCode: 0 };
            } catch(e) {
              result = { stdout: '', stderr: e.message, exitCode: 1 };
            }
          } else if (toolName === 'write_file') {
            try {
              var dir = path.dirname(args.filepath);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(args.filepath, args.content || '', 'utf8');
              result = { stdout: 'File written', stderr: '', exitCode: 0 };
            } catch(e) {
              result = { stdout: '', stderr: e.message, exitCode: 1 };
            }
          } else if (toolName === 'list_dir') {
            try {
              var entries = fs.readdirSync(args.path || os.homedir(), { withFileTypes: true });
              result = { stdout: JSON.stringify(entries.map(function(e) { return { name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }; })), stderr: '', exitCode: 0 };
            } catch(e) {
              result = { stdout: '[]', stderr: e.message, exitCode: 1 };
            }
          } else {
            result = { stdout: '', stderr: 'Unknown tool: ' + toolName, exitCode: 1 };
          }

          var response = JSON.stringify({
            jsonrpc: '2.0', id: parsed.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.exitCode !== 0 }
          });
          event.sender.send('chrome:native:onMessage:' + portId, response);
          return;
        }

        // Other methods: return empty error
        var errResp = JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32601, message: 'Method not found' } });
        event.sender.send('chrome:native:onMessage:' + portId, errResp);
      }
    } catch (err) {
      console.error('[Native] Error:', err.message);
      var errResp = JSON.stringify({ jsonrpc: '2.0', id: parsed ? parsed.id : null, error: { code: -32603, message: err.message } });
      try { event.sender.send('chrome:native:onMessage:' + portId, errResp); } catch(_) {}
    }
  });

  ipcMain.on('chrome:native:disconnect', (event, { portId, host }) => {
    console.log('[Native] disconnectNative:', host);
    if (nativeHostPorts.has(portId)) {
      destroyNativePort(portId, 'client_disconnect');
      return;
    }
    event.sender.send('chrome:native:onDisconnect:' + portId);
  });

  // offscreen (sandbox code execution)
  ipcMain.handle('chrome:offscreen:createDocument', async (_, parameters) => {
    return {};
  });

  // debugger
  ipcMain.handle('chrome:debugger:sendCommand', async (_, payload) => {
    return {};
  });

  // scripting
  ipcMain.handle('chrome:scripting:executeScript', async (_, injection) => {
    return [{ result: null }];
  });

  // sidepanel → webview 消息转发
  ipcMain.on('chrome:sidepanel:sendToWebview', (_, message) => {
    webviewMessageBridge.sendToWebview(message);
  });

  // webview → sidepanel 消息转发
  ipcMain.on('chrome:webview:sendToSidepanel', (_, message) => {
    webviewMessageBridge.sendToSidepanel(message);
  });

  // WeChat Bot
  ipcMain.handle('wechat:start', async () => {
    return wechatBot.start(mainWindow);
  });
  ipcMain.handle('wechat:stop', async () => {
    return wechatBot.stop();
  });
  ipcMain.handle('wechat:status', async () => {
    return wechatBot.getStatus();
  });
}

async function handleSandboxRun(msg) {
  const { type, payload } = msg || {};
  if (type !== 'OFFSCREEN_SANDBOX_RUN') {
    return { type: 'OFFSCREEN_SANDBOX_RESULT', requestId: msg.requestId, result: { error: 'unknown message type' } };
  }

  const { code, language, timeout } = payload || {};
  try {
    const tmpDir = path.join(os.tmpdir(), 'deepseek-sandbox-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    let result;
    if (language === 'python' || language === 'py') {
      const scriptPath = path.join(tmpDir, 'script.py');
      fs.writeFileSync(scriptPath, code);
      const r = await execEmbeddedShell(`python3 ${scriptPath}`, tmpDir);
      result = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } else if (language === 'javascript' || language === 'js') {
      const scriptPath = path.join(tmpDir, 'script.js');
      fs.writeFileSync(scriptPath, code);
      const r = await execEmbeddedShell(`node ${scriptPath}`, tmpDir);
      result = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } else {
      result = { error: 'unsupported language: ' + language };
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      type: 'OFFSCREEN_SANDBOX_RESULT',
      requestId: msg.requestId,
      result
    };
  } catch (err) {
    return {
      type: 'OFFSCREEN_SANDBOX_RESULT',
      requestId: msg.requestId,
      result: { error: err.message, stdout: '', stderr: '', exitCode: 1 }
    };
  }
}

app.whenReady().then(async () => {
  applyBundledRuntimeEnvironment();
  // 启动 HTTP MCP 服务器
  try {
    await startHttpMcpServer(9999);
  } catch (error) {
    console.error('[HTTP MCP Server] startup failed:', error);
  }

  // 启动扩展静态文件服务器
  try {
    extensionFilePort = await startExtensionFileServer(9998);
  } catch (error) {
    console.error('[Extension File Server] startup failed:', error);
  }

  registerIpcHandlers();
  app.on('web-contents-created', (_, contents) => {
    attachEditContextMenu(contents);
  });
  createWindow();
  createAppMenu();
  createTray();

  // 延迟创建并预热 Shell MCP 预设 (等 background.js 初始化完成后)
  setTimeout(function() {
    ensureShellMcpPreset();
    warmShellMcpCache().catch(function(error) {
      console.error('[MCP] Warm shell cache failed:', error.message);
    });
  }, 8000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  setTimeout(function() { createDesktopPet(); }, 3000);
});

let petWindow = null;

function createDesktopPet() {
  if (petWindow && !petWindow.isDestroyed()) return;

  // 用截图的小鲸鱼
  const logoPath = path.resolve(__dirname, 'pet-whale.png');
  const logoB64 = fs.existsSync(logoPath)
    ? 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64')
    : '';

  const petSize = 80;
  petWindow = new BrowserWindow({
    width: petSize + 80,
    height: petSize + 40,
    x: 100,
    y: 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  petWindow.setVisibleOnAllWorkspaces(true);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; }
    body { background:transparent; overflow:hidden; user-select:none; -webkit-app-region:no-drag; }
    .pet { width:${petSize}px; height:${petSize}px; margin:20px 40px 0;
      background:url(${logoB64}) no-repeat center/contain;
      animation: swim 8s ease-in-out infinite; }
    .bubble { position:absolute; top:2px; left:50%; transform:translateX(-50%);
      background:rgba(255,255,255,.92); border-radius:10px; padding:3px 10px;
      font:bold 12px sans-serif; color:#333; white-space:nowrap; display:none;
      box-shadow:0 1px 6px rgba(0,0,0,.08); pointer-events:none; }
    .bubble.show { display:block; }
    @keyframes swim {
      0%,5%   { transform:translateX(32px) scaleX(1); }
      15%     { transform:translateX(16px) scaleX(1); }
      25%     { transform:translateX(0) scaleX(1); }
      30%     { transform:translateX(0) scaleX(-1); }
      40%     { transform:translateX(16px) scaleX(-1); }
      55%     { transform:translateX(32px) scaleX(-1); }
      65%     { transform:translateX(32px) scaleX(1); }
      75%     { transform:translateX(16px) scaleX(1); }
      90%     { transform:translateX(0) scaleX(1); }
      100%    { transform:translateX(0) scaleX(1); }
    }
  </style></head><body>
    <div class="pet" id="pet"></div>
    <div class="bubble" id="bubble">点我提问</div>
    <script>
      const { ipcRenderer } = require('electron');
      var pet = document.getElementById('pet');
      var bubble = document.getElementById('bubble');
      var startX, startY, startTime;
      var dragged = false;

      pet.addEventListener('mousedown', function(e) {
        startX = e.screenX;
        startY = e.screenY;
        startTime = Date.now();
        dragged = false;
      });

      document.addEventListener('mousemove', function(e) {
        if (startX === undefined) return;
        var dx = e.screenX - startX;
        var dy = e.screenY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          dragged = true;
          ipcRenderer.send('pet:move', dx, dy);
          startX = e.screenX;
          startY = e.screenY;
        }
      });

      document.addEventListener('mouseup', function(e) {
        var dt = Date.now() - startTime;
        if (!dragged) {
          if (dt < 300) {
            ipcRenderer.send('pet:click');
          }
        }
        startX = undefined;
      });

      pet.addEventListener('dblclick', function(e) {
        ipcRenderer.send('pet:dblclick');
      });

      // 气泡轮播
      var msgs = ['点我提问','有什么可以帮你?','Hi ~','今天有什么任务?'];
      var mi = 0;
      function showBubble() {
        bubble.textContent = msgs[mi % msgs.length];
        bubble.classList.add('show');
        setTimeout(function(){ bubble.classList.remove('show'); }, 4000);
        mi++;
      }
      showBubble();
      setInterval(showBubble, 12000);
    </script></body></html>`;

  petWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  ipcMain.removeAllListeners('pet:move');
  ipcMain.removeAllListeners('pet:click');
  ipcMain.removeAllListeners('pet:dblclick');

  ipcMain.on('pet:move', function(_, dx, dy) {
    if (petWindow && !petWindow.isDestroyed()) {
      var [x, y] = petWindow.getPosition();
      petWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
    }
  });

  ipcMain.on('pet:click', function() {
    createMiniChat();
  });

  ipcMain.on('pet:dblclick', function() {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let miniChatWindow = null;

function createMiniChat() {
  if (miniChatWindow && !miniChatWindow.isDestroyed()) {
    miniChatWindow.show();
    miniChatWindow.focus();
    return;
  }
  miniChatWindow = new BrowserWindow({
    width: 420,
    height: 320,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  miniChatWindow.setVisibleOnAllWorkspaces(true);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:rgba(30,30,30,.92); border-radius:16px; overflow:hidden;
      font:13px/1.5 -apple-system,sans-serif; color:#e0e0e0; display:flex; flex-direction:column; height:100vh; }
    .header { padding:8px 14px; display:flex; justify-content:space-between; align-items:center;
      border-bottom:1px solid rgba(255,255,255,.08); -webkit-app-region:drag; }
    .header span { font-size:12px; color:#999; }
    .header button { background:none; border:none; color:#666; cursor:pointer; font-size:14px; -webkit-app-region:no-drag; }
    .msgs { flex:1; overflow-y:auto; padding:12px; }
    .input-row { display:flex; padding:8px 12px; gap:8px; border-top:1px solid rgba(255,255,255,.08); }
    .input-row input { flex:1; background:rgba(255,255,255,.1); border:none; border-radius:8px;
      padding:8px 12px; color:#fff; outline:none; }
    .input-row button { background:#4D6BFE; border:none; border-radius:8px; padding:8px 14px;
      color:#fff; cursor:pointer; font-weight:600; }
  </style></head><body>
    <div class="header">
      <span>快速提问</span>
      <button onclick="closeWin()">✕</button>
    </div>
    <div class="msgs" id="msgs"></div>
    <div class="input-row">
      <input id="q" placeholder="输入问题..." onkeydown="if(event.key==='Enter')ask()">
      <button onclick="ask()">发送</button>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
      function ask() {
        var q = document.getElementById('q').value.trim();
        if (!q) return;
        document.getElementById('msgs').innerHTML += '<div style="text-align:right;color:#4D6BFE;margin:4px 0">'+q+'</div>';
        document.getElementById('q').value = '';
        ipcRenderer.send('mini:ask', q);
      }
      function closeWin() { ipcRenderer.send('mini:close'); }
      ipcRenderer.on('mini:reply', function(_, text) {
        document.getElementById('msgs').innerHTML += '<div style="margin:4px 0">'+text+'</div>';
        document.getElementById('msgs').scrollTop = document.getElementById('msgs').scrollHeight;
      });
    </script></body></html>`;

  miniChatWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  miniChatWindow.on('closed', function() { miniChatWindow = null; });

  ipcMain.removeAllListeners('mini:ask');
  ipcMain.removeAllListeners('mini:close');

  ipcMain.on('mini:ask', function(_, question) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.executeJavaScript(`
          (async function() {
            var chatView = document.getElementById('chatView');
            if (!chatView || typeof chatView.executeJavaScript !== 'function') return;
            var q = ${JSON.stringify(question)};
            await chatView.executeJavaScript(
              '(function(){var p=' + JSON.stringify(q) + ';' +
              'var ta=document.querySelector("textarea");if(!ta)return;' +
              'var ns=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;' +
              'ns.call(ta,"");ns.call(ta,p);ta.focus();' +
              'ta.dispatchEvent(new InputEvent("beforeinput",{bubbles:true,inputType:"insertText",data:p}));' +
              'ta.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:p}));' +
              'ta.dispatchEvent(new Event("change",{bubbles:true}));' +
              'var btns=document.querySelectorAll("button");var sBtn=null;' +
              'for(var i=btns.length-1;i>=0;i--){var b=btns[i];if(b.disabled||!b.offsetParent)continue;var cls=(b.className||"").toLowerCase();var aria=(b.getAttribute("aria-label")||"").toLowerCase();var txt=(b.textContent||"").trim().toLowerCase();if(cls.indexOf("send")>=0||aria.indexOf("send")>=0||aria.indexOf("发送")>=0||txt==="send"||txt==="发送"){sBtn=b;break;}}' +
              'if(!sBtn){var pbtns=ta.parentElement?ta.parentElement.querySelectorAll("button"):[];for(var j=pbtns.length-1;j>=0;j--){if(!pbtns[j].disabled&&pbtns[j].offsetParent){sBtn=pbtns[j];break;}}}' +
              'if(sBtn){sBtn.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));sBtn.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));sBtn.click();}' +
              'ta.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true,composed:true,cancelable:true}));' +
              '})()'
            );
          })()
        `);
      } catch(_) {}
    }
    // 轮询主窗口最新回复
    var lastReply = '';
    var stableCount = 0;
    var pollTimer = setInterval(function() {
      if (!mainWindow || mainWindow.isDestroyed() || !miniChatWindow || miniChatWindow.isDestroyed()) {
        clearInterval(pollTimer);
        return;
      }
      try {
        mainWindow.webContents.executeJavaScript(`
          (async function(){
            var chatView=document.getElementById('chatView');
            if(!chatView)return"";
            return await chatView.executeJavaScript(
              '(function(){var roots=document.querySelectorAll("._74c0879, .ds-assistant-message-main-content");' +
              'if(!roots.length)return"";var r=roots[roots.length-1].cloneNode(true);' +
              'var sels=[".dpp-tool-block",".dpp-agent-container",".dpp-agent-step","[class*=tool]","[class*=think]","[class*=reason]","[class*=step]"];' +
              'for(var i=0;i<sels.length;i++){var ns=r.querySelectorAll(sels[i]);for(var j=0;j<ns.length;j++)ns[j].remove();}' +
              'return (r.textContent||"").trim();})()'
            );
          })()
        `).then(function(text) {
          if (text && text.length > 5 && text === lastReply) {
            stableCount++;
            if (stableCount >= 3 && miniChatWindow && !miniChatWindow.isDestroyed()) {
              clearInterval(pollTimer);
              // 在主进程做过滤，避免regex转义问题
              var answer = text;
              var marks = ['最终答案','最终结论','最终回答'];
              for (var m=0;m<marks.length;m++) {
                var idx = answer.indexOf(marks[m]);
                if (idx >= 0) { answer = answer.slice(idx+marks[m].length).replace(/^[:\-\s]+/,'').trim(); break; }
              }
              answer = answer.replace(/^有两个工具[\s\S]*?\n\n/,'');
              answer = answer.replace(/^根据(搜索|查询|最新|实时|气象)[^\n]*\n/g,'');
              answer = answer.replace(/温馨提示[：:][\s\S]*$/g,'');
              answer = answer.replace(/\n{3,}/g,'\n\n').trim();
              miniChatWindow.webContents.send('mini:reply', answer);
            }
          } else if (text) {
            lastReply = text;
            stableCount = 0;
          }
        }).catch(function(){});
      } catch(_) {}
    }, 2000);
    setTimeout(function() { clearInterval(pollTimer); }, 30000);
    if (miniChatWindow) miniChatWindow.webContents.send('mini:reply', '正在查询...');
  });

  ipcMain.on('mini:close', function() {
    if (miniChatWindow) { miniChatWindow.close(); miniChatWindow = null; }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
