import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'dist');
const APP_DIR = path.join(DIST, 'mac-arm64');
const SOURCE_APP = path.join(APP_DIR, 'Electron.app');
const TARGET_APP = path.join(APP_DIR, 'DeepSeek Desktop.app');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE_JSON.version;
const ICON_SOURCE = path.join(ROOT, 'build', 'app-icon.icns');
const DMG_PATH = path.join(DIST, `DeepSeek Desktop-${VERSION}-arm64.dmg`);
const ZIP_PATH = path.join(DIST, `DeepSeek Desktop-${VERSION}-arm64-mac.zip`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout.trim();
}

function ensureAppBundle() {
  if (fs.existsSync(TARGET_APP)) {
    return TARGET_APP;
  }
  if (!fs.existsSync(SOURCE_APP)) {
    throw new Error(`Missing app bundle: ${SOURCE_APP}`);
  }
  fs.renameSync(SOURCE_APP, TARGET_APP);
  return TARGET_APP;
}

function patchMainBundle(appPath) {
  const contents = path.join(appPath, 'Contents');
  const plist = path.join(contents, 'Info.plist');
  const macosDir = path.join(contents, 'MacOS');
  const resourcesDir = path.join(contents, 'Resources');
  const oldExe = path.join(macosDir, 'Electron');
  const newExe = path.join(macosDir, 'DeepSeek Desktop');

  if (fs.existsSync(oldExe) && !fs.existsSync(newExe)) {
    fs.renameSync(oldExe, newExe);
  }

  if (fs.existsSync(ICON_SOURCE)) {
    fs.copyFileSync(ICON_SOURCE, path.join(resourcesDir, 'app-icon.icns'));
  }

  run('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', 'DeepSeek Desktop', plist]);
  run('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', 'DeepSeek Desktop', plist]);
  run('/usr/bin/plutil', ['-replace', 'CFBundleExecutable', '-string', 'DeepSeek Desktop', plist]);
  run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.example.deepseek-desktop', plist]);
  run('/usr/bin/plutil', ['-replace', 'CFBundleIconFile', '-string', 'app-icon.icns', plist]);
}

function adHocSign(appPath) {
  run('/usr/bin/xattr', ['-cr', appPath]);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
}

function buildZip(appPath) {
  if (fs.existsSync(ZIP_PATH)) fs.rmSync(ZIP_PATH, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, ZIP_PATH]);
}

function buildDmg(appPath) {
  if (fs.existsSync(DMG_PATH)) fs.rmSync(DMG_PATH, { force: true });
  run('/usr/bin/hdiutil', ['create', '-volname', 'DeepSeek Desktop', '-srcfolder', appPath, '-ov', '-format', 'UDZO', DMG_PATH]);
}

function main() {
  const appPath = ensureAppBundle();
  patchMainBundle(appPath);
  adHocSign(appPath);
  buildZip(appPath);
  buildDmg(appPath);
  const signedInfo = runCapture('/usr/bin/codesign', ['-dv', appPath]);
  console.log('[finalize-mac-package] done');
  console.log('[finalize-mac-package] app:', appPath);
  console.log('[finalize-mac-package] zip:', ZIP_PATH);
  console.log('[finalize-mac-package] dmg:', DMG_PATH);
  console.log('[finalize-mac-package] codesign:', signedInfo.split('\n')[0] || 'ok');
}

main();
