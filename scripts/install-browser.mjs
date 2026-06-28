#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.resolve(projectRoot, 'runtime');
const maxRetries = 3;
const downloadBaseUrl =
  process.env.DEEPSEEK_CHROME_DOWNLOAD_BASE_URL ||
  process.env.PUPPETEER_DOWNLOAD_BASE_URL ||
  'https://storage.googleapis.com/chrome-for-testing-public';
const installTimeoutMs = Number(process.env.DEEPSEEK_CHROME_INSTALL_TIMEOUT_MS || 0);

console.log('[Chrome Installer] 开始安装项目内置 Chrome 浏览器...\n');
console.log(`[Chrome Installer] 下载源: ${downloadBaseUrl}`);

// 确保在项目根目录运行
process.chdir(projectRoot);
console.log(`[Chrome Installer] 工作目录: ${process.cwd()}\n`);

async function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true });
    let timeoutId = null;
    if (installTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out after ${installTimeoutMs}ms`));
      }, installTimeoutMs);
    }
    child.on('close', (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

function cleanupRuntime() {
  console.log('[Chrome Installer] 清理 runtime 目录...');
  if (fs.existsSync(runtimeDir)) {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
}

async function installBrowser() {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`\n[Chrome Installer] 尝试 #${attempt}/${maxRetries}...\n`);
    
    try {
      // 首次尝试前清理，后续重试保留已下载内容，避免重复全量下载
      if (attempt === 1) {
        cleanupRuntime();
      } else if (!fs.existsSync(runtimeDir)) {
        fs.mkdirSync(runtimeDir, { recursive: true });
      }
      
      // 尝试下载稳定版本
      await runCommand('npx', [
        '-y',
        '@puppeteer/browsers@latest',
        'install',
        'chrome@stable',
        `--base-url=${downloadBaseUrl}`,
        `--path=${runtimeDir}`,
      ]);
      
      console.log('\n✅ [Chrome Installer] Chrome 安装成功！');
      return;
    } catch (err) {
      console.log(`\n❌ [Chrome Installer] 尝试 #${attempt} 失败: ${err.message}`);
      
      if (attempt < maxRetries) {
        console.log(`[Chrome Installer] ${3 - attempt} 次重试机会还剩...\n`);
        // 等待 3s 后重试
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } else {
        console.error('\n❌ [Chrome Installer] 所有重试均失败。');
        console.error('\n常见解决方案：');
        console.error('  1️⃣  检查网络连接是否正常');
        console.error('  2️⃣  检查磁盘空间 (需要 ~300MB)：df -h');
        console.error('  3️⃣  尝试清理缓存：rm -rf ~/.cache/puppeteer');
        console.error('  4️⃣  手动重试：npm run install:project-browser');
        console.error('  5️⃣  如果持续失败，使用系统 Chrome 替代：export DEEPSEEK_CHROME_BIN=/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome');
        process.exit(1);
      }
    }
  }
}

installBrowser().catch((err) => {
  console.error('\n❌ 安装失败:', err.message);
  process.exit(1);
});
