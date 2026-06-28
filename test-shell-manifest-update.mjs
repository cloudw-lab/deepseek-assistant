#!/usr/bin/env node

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 模拟 queryBrowserExtensionId 函数
async function queryBrowserExtensionId(debugPort) {
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
            console.log(`[Debug] Retrieved ${targets.length} targets from Chrome`);
            const extensionTarget = targets.find(
              (t) => t.type === 'background_page' && t.url.startsWith('chrome-extension://')
            );
            if (extensionTarget) {
              console.log(`[Debug] Found extension target: ${extensionTarget.url}`);
              const match = extensionTarget.url.match(/chrome-extension:\/\/([a-z0-9]+)\//);
              if (match) {
                resolve(match[1]);
                return;
              }
            }
            resolve(null);
          } catch (err) {
            console.log(`[Debug] Error parsing targets:`, err.message);
            resolve(null);
          }
        });
      }
    );
    req.on('error', (err) => {
      console.log(`[Debug] HTTP error:`, err.message);
      resolve(null);
    });
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function updateShellManifestWithRealExtensionId(extensionId) {
  const manifestPath = path.join(
    homedir(),
    `Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek_pp.shell.json`
  );

  if (!fs.existsSync(manifestPath)) {
    console.log(`[Shell Host] Manifest not found at ${manifestPath}`);
    return false;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const newOrigin = `chrome-extension://${extensionId}/`;
    
    if (!manifest.allowed_origins.includes(newOrigin)) {
      console.log(`[Shell Host] Updating manifest with extension ID: ${extensionId}`);
      manifest.allowed_origins = [newOrigin];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`[Shell Host] ✅ Manifest updated successfully.`);
      return true;
    } else {
      console.log(`[Shell Host] ✅ Manifest already has correct extension ID: ${extensionId}`);
    }
  } catch (err) {
    console.log(`[Shell Host] Error updating manifest:`, err.message);
    return false;
  }

  return false;
}

async function main() {
  console.log('🧪 Testing Shell Manifest Auto-Update Logic\n');
  
  // 如果没有 Chrome 运行，模拟一个扩展 ID 来测试更新流程
  const testExtensionId = 'kdmpkkahkhdmdhfkdihkopikgcocbpbf';
  
  console.log(`1️⃣ Testing manifest update with ID: ${testExtensionId}`);
  const result = await updateShellManifestWithRealExtensionId(testExtensionId);
  
  if (result) {
    console.log('\n✅ Manifest update test PASSED');
  } else {
    console.log('\n⚠️  Manifest update returned false (could be already updated)');
  }
  
  // 验证 manifest 内容
  const manifestPath = path.join(
    homedir(),
    `Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek_pp.shell.json`
  );
  
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log(`\n📄 Current manifest allowed_origins:`);
    console.log(manifest.allowed_origins);
  }
  
  console.log('\n💡 To test with real Chrome running:');
  console.log('1. Start Chrome with --remote-debugging-port=9223');
  console.log('2. Load the extension via Launcher');
  console.log('3. The manifest will auto-update to match the real extension ID');
}

main().catch(console.error);
