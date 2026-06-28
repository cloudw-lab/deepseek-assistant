# DeepSeek 桌面客户端（集成 deepseek-pp）

基于 Electron 28 的桌面应用，内嵌 DeepSeek Chat 网页 + deepseek-pp 扩展程序。

## 功能

- **聊天**：内嵌 webview 直接使用 DeepSeek Chat，扩展能力（MCP/Shell 工具）通过 Polyfill 运行
- **扩展面板**：右侧可展开/收起的 deepseek-pp 侧边栏面板
- **本地 Shell**：内置本地命令执行能力
- **运行时**：环境检测、一键修复、一键启动外部 Chrome（完整扩展运行时）

## 要求

- Node.js 18+
- deepseek-pp 源码目录（默认 `../tmp/deepseek-pp`，可通过 `DPP_SOURCE_DIR` 覆盖）
- macOS 打包需要 Python 3（`prepare:python-runtime` 会自动捆绑）

## 快速开始

```bash
# 1. 构建 deepseek-pp 扩展
cd ../tmp/deepseek-pp
npm install
npm run build:chrome

# 2. 启动桌面客户端
cd ../deepseek-client-full
npm install
npm start
```

`npm start` 会自动同步扩展产物并启动 Electron 窗口，聊天页、扩展面板、本地 Shell 均可直接使用。

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 同步扩展 + 启动 Electron |
| `npm run prepare:extension` | 同步插件产物（构建前必须执行） |
| `npm run prepare:python-runtime` | 捆绑 macOS Python 运行环境（仅 macOS 打包需要） |
| `npm run install:project-browser` | 安装项目内置 Chrome |
| `npm run start:full` | 同步扩展 + 直接启动外部 Chrome（跳过 Electron） |
| `npm run build:mac` | 同步 + 捆绑 Python + 打包 macOS（DMG + ZIP） |
| `npm run build:win` | 同步扩展 + 打包 Windows（NSIS + Portable） |

指定架构打包：

```bash
npx electron-builder --mac --arm64    # macOS arm64
npx electron-builder --mac --x64      # macOS x64
npx electron-builder --win --x64      # Windows x64
```

## 可选环境变量

| 变量 | 用途 |
|------|------|
| `DPP_SOURCE_DIR` | deepseek-pp 源码目录（默认 `../tmp/deepseek-pp`） |
| `DPP_EXTENSION_PATH` | 覆盖扩展加载目录 |
| `DEEPSEEK_CHROME_BIN` | 指定 Chrome/Edge 可执行文件路径 |
| `DPP_CHROME_PROFILE` | 指定浏览器独立配置目录 |
| `DEEPSEEK_CHROME_DOWNLOAD_BASE_URL` | Chrome 下载镜像源 |
| `DEEPSEEK_CHROME_INSTALL_TIMEOUT_MS` | Chrome 安装超时时间（毫秒） |
| `DPP_TARGET_URL` | 启动后打开的 URL（默认 `https://chat.deepseek.com/`） |

示例：

```bash
DPP_SOURCE_DIR=/path/to/deepseek-pp npm start
DEEPSEEK_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm start
```

镜像源示例（下载慢时使用）：

```bash
export DEEPSEEK_CHROME_DOWNLOAD_BASE_URL=https://npmmirror.com/mirrors/chrome-for-testing
npm run install:project-browser
```

## 项目结构

| 文件 | 作用 |
|------|------|
| `main.js` | Electron 主进程，创建窗口、启动 HTTP 服务器、IPC 处理 |
| `app-shell.html` | 主窗口（聊天 + Shell + 运行时三个面板） |
| `app-shell-renderer.js` | 主窗口 DOM 逻辑，webview 管理、侧边栏生命周期 |
| `preload.js` | 主窗口 preload，暴露 `window.deepseekClient.*` |
| `webview-preload.js` | 聊天 webview preload，chrome.* API Polyfill + 扩展注入 |
| `sidepanel-preload.js` | 扩展面板 webview preload，postMessage 桥接 |
| `background-preload.js` | 后台 webview preload（已废弃） |
| `scripts/prepare-extension.mjs` | 同步 deepseek-pp 构建产物 |
| `scripts/prepare-python-runtime.mjs` | 捆绑 macOS Python 运行时 |
| `scripts/launch-chrome-full.mjs` | 启动外部 Chrome（完整扩展运行时） |
| `scripts/install-browser.mjs` | 下载安装 Chrome for Testing |
| `shell-host-bin/` | Shell Native Host 安装器和服务进程 |
| `extension/chrome-mv3/` | 同步后的扩展产物（由 `prepare:extension` 生成） |

## 偏好记忆

应用会在发送 DeepSeek 请求前自动注入一层轻量“偏好记忆”，用于统一约束桌面端和微信机器人的回答风格与工具策略。

- **优先来源**：DeepSeek++ 现有“记忆”面板中的非项目级记忆，但会优先筛选更像“偏好/规则”的条目（尤其是 `反馈` / `用户` 类型，以及带工具策略、回复风格、微信规则等标签/内容的记忆）
- **回退来源**：`userData/preference-memory.md`
- 适合保存：回复风格、工具选择偏好、微信返回规则、项目级行为约束

如果记忆面板里没有可用条目，会回退到默认偏好，例如：

- 能直接回答就直接回答
- 天气/新闻/汇率等实时问题：如果当前模式可用 DeepSeek 原生搜索，优先原生搜索；否则再用扩展 `web_search`，不要 `shell_exec`
- 微信只返回最终结果，不返回思考/步骤/工具执行过程

## 性能说明

本应用在 Electron webview 中通过 JavaScript Polyfill 模拟 Chrome 扩展 API（`chrome.runtime`、`chrome.storage` 等），有已知限制：

- 扩展面板有健康检测机制，如反复加载空白会触发重试（最多 3 次），关闭面板即可终止
- 所有文件 I/O 为同步操作，不适合高并发场景
- 聊天流式输出时 `chrome:broadcast:toContent` 会逐 token 触发广播，已有节流处理

## License

MIT
