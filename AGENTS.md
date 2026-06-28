# AGENTS.md

## Project overview

Electron 28 desktop app (DeepSeek Desktop) that loads the DeepSeek++ Chrome extension inside `<webview>` tags + spawns external Chrome. No bundler, no TypeScript — all plain CommonJS/ESM.

## Key files

| File | Role |
|------|------|
| `main.js` | Electron main process (~2900 lines). Creates BrowserWindow, two HTTP servers (extension files + MCP), IPC handlers |
| `app-shell-renderer.js` | Main window DOM logic. Manages webviews, sidepanel lifecycle, throttle helpers |
| `preload.js` | Main-window preload → exposes `window.deepseekClient.*` via contextBridge |
| `webview-preload.js` | Chat webview preload → `chrome.*` API polyfill, injects background.js + content scripts |
| `sidepanel-preload.js` | Sidepanel webview preload → postMessage bridge |
| `background-preload.js` | Background webview preload (deprecated, mostly unused) |

## Build prerequisites

The extension source lives **outside this repo**. Default path: `../tmp/deepseek-pp`. Override with env `DPP_SOURCE_DIR`.

```
# 1. Build the extension first (in the other repo)
cd ../tmp/deepseek-pp && npm run build:chrome

# 2. Sync extension + start Electron
cd ../deepseek-client-full
npm run prepare:extension   # copies dist/chrome-mv3 → extension/chrome-mv3
npm start                   # prepare + launch Electron
```

## Commands

```
npm start                   # prepare:extension + electron .
npm run prepare:extension   # sync extension assets (REQUIRED before any run/build)
npm run prepare:python-runtime  # bundle macOS Python (Mac build only)
npm run build:mac           # prepare + electron-builder --mac
npm run build:win           # prepare + electron-builder --win
```

To target a specific arch:

```
npx electron-builder --mac --arm64
npx electron-builder --win --x64
```

Always run `npm run prepare:extension` before every build. For Mac builds, also run `npm run prepare:python-runtime`.

## Architecture notes

- The chat webview loads `https://chat.deepseek.com/` with `webview-preload.js`. The preload polyfills `chrome.*` APIs and `eval()`s the extension's `background.js` + content scripts directly in the webview process.
- The sidepanel webview loads `http://127.0.0.1:{port}/sidepanel.html` from a local HTTP server (started in `main.js`). The server injects a large chrome polyfill `<script>` into the sidepanel HTML.
- A second HTTP server provides shell exec / file I/O / MCP tool endpoints.
- Storage is flat JSON files in `app.getPath('appData')/deepseek-client-full/extension-storage/`. All read/writes are synchronous and block the main process.
- A lightweight preference-memory layer is injected in `main.js` before every DeepSeek API request. It prefers the existing DeepSeek++ memory store (`GET_MEMORIES` via chat webview runtime) and falls back to `app.getPath('userData')/preference-memory.md`. Keep entries short, durable, and behavioral (tool policy, response style, channel policy).

## Performance gotchas

- **Sidepanel reload loop**: `app-shell-renderer.js` has a sidepanel health probe (2s timeout) + reload timeout (1.2s) with max 3 attempts and a 3s cooldown. If the sidepanel keeps loading blank (`about:blank` or wrong URL), it enters a reload loop. Closing the sidepanel panel stops it.
- **No bundler**: all JS ships unminified. The `chrome.*` polyfill (~400 lines) is duplicated across `webview-preload.js` and `background-preload.js`.
- **Sync fs everywhere**: `main.js` uses `fs.readFileSync`/`writeFileSync` for every HTTP request, every storage operation, and every native host tool call. Don't add more sync I/O in hot paths.
- **`chrome:broadcast:toContent`** in `webview-preload.js` iterates all registered message listeners synchronously on every broadcast — during chat streaming this can fire per-token.

## Environment variables

| Var | Purpose |
|-----|---------|
| `DPP_SOURCE_DIR` | deepseek-pp source root (default `../tmp/deepseek-pp`) |
| `DPP_EXTENSION_PATH` | Override extension dir for Electron load |
| `DEEPSEEK_CHROME_BIN` | Custom browser binary path |
| `DPP_CHROME_PROFILE` | Custom browser profile dir |
| `DEEPSEEK_CHROME_DOWNLOAD_BASE_URL` | Mirror for Chrome-for-Testing downloads |
| `DPP_TARGET_URL` | URL opened after launch (default `https://chat.deepseek.com/`) |

## No tests, no lint

There is no test suite, no linter config, and no typechecking. Changes should be verified by running `npm start` and checking the app works.

## WeChat Bot (optional)

`wechat-bot.js` provides a personal-WeChat → DeepSeek AI bridge using the WeChat iLink Bot API (same protocol as `@tencent-weixin/openclaw-weixin`).

**Prerequisites:**
- No AppID/SecretKey required — uses QR code scan login directly.
- The bot persists credentials to `userData/wechat-bot/` for session resumption.

**Usage:**
- Click "微信机器人" button in the app toolbar → click "启动机器人" → scan QR code with WeChat
- Send text messages; the bot forwards them to DeepSeek Chat API and replies with AI responses
- `/reset` clears conversation context; `/status` shows bot status
- The bot uses the same Electron session as the chat webview (shared auth/cookies)
- API base: `https://ilinkai.weixin.qq.com` (override with `DPP_WECHAT_API_BASE`)

**API reference:** https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html
