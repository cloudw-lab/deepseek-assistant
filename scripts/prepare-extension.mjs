import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');

const sourceRoot = process.env.DPP_SOURCE_DIR
  ? path.resolve(process.env.DPP_SOURCE_DIR)
  : path.resolve(appRoot, '..', 'tmp', 'deepseek-pp');

const sourceDist = path.join(sourceRoot, 'dist', 'chrome-mv3');
const targetDist = path.join(appRoot, 'extension', 'chrome-mv3');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function copyDirectoryContents(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const realPath = fs.realpathSync(sourcePath);
      const stat = fs.statSync(realPath);
      if (stat.isDirectory()) {
        copyDirectoryContents(realPath, targetPath);
      } else {
        fs.copyFileSync(realPath, targetPath);
      }
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function copyExtensionWithRetry(source, target, attempts = 3) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      copyDirectoryContents(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (index === attempts - 1) {
        throw error;
      }
      sleep(250 * (index + 1));
    }
  }
  throw lastError;
}

function waitForFile(filePath, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    sleep(100);
  }
  return false;
}

function replaceAllOrThrow(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`patch target not found: ${label}`);
  }
  return source.replaceAll(from, to);
}

function patchBundledExtension(targetRoot) {
  const backgroundPath = path.join(targetRoot, 'background.js');
}

if (!fs.existsSync(sourceDist)) {
  console.error('[prepare-extension] deepseek-pp build output not found.');
  console.error(`[prepare-extension] expected: ${sourceDist}`);
  console.error('[prepare-extension] run: cd ../tmp/deepseek-pp && npm run build:chrome');
  process.exit(1);
}

fs.rmSync(targetDist, { recursive: true, force: true });
fs.mkdirSync(path.dirname(targetDist), { recursive: true });
copyExtensionWithRetry(sourceDist, targetDist);

console.log('[prepare-extension] synced DeepSeek++ extension assets.');
console.log(`[prepare-extension] source: ${sourceDist}`);
console.log(`[prepare-extension] target: ${targetDist}`);

// 修改 manifest.json 以支持本地 HTTP MCP 服务
const manifestPath = path.join(targetDist, 'manifest.json');
try {
  if (!waitForFile(manifestPath)) {
    copyExtensionWithRetry(sourceDist, targetDist, 1);
    if (!waitForFile(manifestPath)) {
      throw new Error(`manifest not found after copy: ${manifestPath}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  // 添加本地主机权限
  if (!manifest.host_permissions) {
    manifest.host_permissions = [];
  }
  
  const localPermissions = [
    'http://localhost/*',
    'http://127.0.0.1/*',
  ];
  
  for (const perm of localPermissions) {
    if (!manifest.host_permissions.includes(perm)) {
      manifest.host_permissions.push(perm);
    }
  }
  
  // 更新 CSP 以允许连接到本地 HTTP 服务
  if (!manifest.content_security_policy) {
    manifest.content_security_policy = {};
  }
  
  const extensionPagesCsp = manifest.content_security_policy.extension_pages || '';
  if (!extensionPagesCsp.includes('connect-src')) {
    manifest.content_security_policy.extension_pages = extensionPagesCsp + "; connect-src 'self' blob: http://localhost:* http://127.0.0.1:*";
  }
  
  const sandboxCsp = manifest.content_security_policy.sandbox || '';
  if (!sandboxCsp.includes('connect-src')) {
    manifest.content_security_policy.sandbox = sandboxCsp + "; connect-src 'self' blob: http://localhost:* http://127.0.0.1:*";
  }
  
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('[prepare-extension] added local HTTP permissions and CSP to manifest.');
  patchBundledExtension(targetDist);
  console.log('[prepare-extension] done.');
} catch (error) {
  console.warn('[prepare-extension] failed to patch manifest:', error instanceof Error ? error.message : String(error));
}
