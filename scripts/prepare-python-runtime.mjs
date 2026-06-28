import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TARGET_ROOT = path.join(ROOT, 'runtime', 'python');

function runPythonInfo() {
  const result = spawnSync('python3', ['-c', 'import json,sys,sysconfig;print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"base_prefix":sys.base_prefix}))'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'python3 not available').trim());
  }
  return JSON.parse(result.stdout.trim());
}

function ensureEmptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function pruneDir(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneMatches(root, names) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (names.has(entry.name)) {
      pruneDir(fullPath);
      continue;
    }
    if (entry.isDirectory()) {
      pruneMatches(fullPath, names);
    }
  }
}

function prepareDarwinRuntime() {
  const info = runPythonInfo();
  const prefix = info.base_prefix;
  if (!prefix || !fs.existsSync(prefix)) {
    throw new Error(`Python base_prefix does not exist: ${prefix}`);
  }

  const target = path.join(TARGET_ROOT, 'darwin');
  ensureEmptyDir(target);

  const requiredDirs = ['bin', 'lib', 'Resources'];
  for (const name of requiredDirs) {
    const source = path.join(prefix, name);
    if (fs.existsSync(source)) {
      copyDir(source, path.join(target, name));
    }
  }

  const requiredFiles = ['Python'];
  for (const name of requiredFiles) {
    const source = path.join(prefix, name);
    if (fs.existsSync(source)) {
      copyFile(source, path.join(target, name));
    }
  }

  const versionedLibDir = fs.readdirSync(path.join(target, 'lib'), { withFileTypes: true })
    .find((entry) => entry.isDirectory() && /^python3\./.test(entry.name));
  if (versionedLibDir) {
    const pythonLibRoot = path.join(target, 'lib', versionedLibDir.name);
    pruneDir(path.join(pythonLibRoot, 'site-packages'));
    pruneDir(path.join(pythonLibRoot, 'ensurepip'));
    pruneDir(path.join(pythonLibRoot, 'idlelib'));
    pruneDir(path.join(pythonLibRoot, 'tkinter'));
    pruneDir(path.join(pythonLibRoot, 'turtledemo'));
    pruneDir(path.join(pythonLibRoot, 'test'));
    pruneDir(path.join(pythonLibRoot, 'tests'));
    pruneMatches(pythonLibRoot, new Set(['__pycache__']));
  }

  console.log(`[prepare-python-runtime] bundled macOS Python ${info.version}`);
  console.log(`[prepare-python-runtime] source: ${prefix}`);
  console.log(`[prepare-python-runtime] target: ${target}`);
}

function main() {
  if (os.platform() === 'darwin') {
    prepareDarwinRuntime();
    return;
  }
  console.log(`[prepare-python-runtime] skipped on unsupported build host: ${os.platform()}`);
}

main();
