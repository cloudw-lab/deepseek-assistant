import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');
const extensionPath = process.env.DPP_EXTENSION_PATH
  ? path.resolve(process.env.DPP_EXTENSION_PATH)
  : path.join(appRoot, 'extension', 'chrome-mv3');

const profileDir = process.env.DPP_CHROME_PROFILE
  ? path.resolve(process.env.DPP_CHROME_PROFILE)
  : path.join(os.homedir(), 'Library', 'Application Support', 'deepseek-client-full-chrome');

const targetUrl = process.env.DPP_TARGET_URL || 'https://chat.deepseek.com/';

function resolveChromeBinary() {
  const explicit = process.env.DEEPSEEK_CHROME_BIN;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
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

if (!fs.existsSync(extensionPath)) {
  console.error('[launch-full] extension not found. run npm run prepare:extension first.');
  console.error(`[launch-full] expected: ${extensionPath}`);
  process.exit(1);
}

const browserBin = resolveChromeBinary();
if (!browserBin) {
  console.error('[launch-full] Chrome/Edge binary not found.');
  console.error('[launch-full] set DEEPSEEK_CHROME_BIN to your browser executable path.');
  process.exit(1);
}

fs.mkdirSync(profileDir, { recursive: true });

const args = [
  `--user-data-dir=${profileDir}`,
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  '--no-default-browser-check',
  '--no-first-run',
  '--new-window',
  targetUrl,
];

console.log('[launch-full] launching browser runtime for full DeepSeek++ feature set.');
console.log(`[launch-full] browser: ${browserBin}`);
console.log(`[launch-full] extension: ${extensionPath}`);
console.log(`[launch-full] profile: ${profileDir}`);
console.log(`[launch-full] url: ${targetUrl}`);

const child = spawn(browserBin, args, {
  stdio: 'inherit',
  detached: true,
});

child.on('error', (error) => {
  console.error('[launch-full] failed to launch browser:', error.message);
  process.exitCode = 1;
});

child.unref();
