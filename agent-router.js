/**
 * Agent Router - 本地工具执行 + 意图路由
 *
 * 用途：解析 mini chat 发送的用户指令，识别是否需要本地工具执行，
 * 先执行本地操作（shell_exec / file_read 等），将结果注入到聊天上下文。
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================
// 工具注册表
// ============================================================
const TOOLS = {
  shell_exec: {
    name: 'shell_exec',
    description: 'Execute a shell command on the local machine',
    params: { command: 'string' },
    handler: async (params) => {
      const cmd = params.command || '';
      if (!cmd.trim()) throw new Error('Empty command');
      try {
        const result = execSync(cmd, {
          timeout: 30000,
          maxBuffer: 1024 * 1024 * 5,
          encoding: 'utf8',
          cwd: os.homedir(),
        });
        return { success: true, stdout: result, stderr: '' };
      } catch (e) {
        return { success: false, stdout: e.stdout || '', stderr: e.stderr || '', error: e.message };
      }
    }
  },

  file_read: {
    name: 'file_read',
    description: 'Read a file from the local filesystem',
    params: { path: 'string' },
    handler: async (params) => {
      const p = params.path || '';
      if (!p) throw new Error('No file path specified');
      if (!fs.existsSync(p)) throw new Error('File not found: ' + p);
      const stat = fs.statSync(p);
      if (stat.size > 1024 * 1024 * 2) throw new Error('File too large (>2MB)');
      const content = fs.readFileSync(p, 'utf8');
      return { success: true, content: content, path: p, size: stat.size };
    }
  },

  file_write: {
    name: 'file_write',
    description: 'Write content to a file',
    params: { path: 'string', content: 'string' },
    handler: async (params) => {
      const p = params.path || '';
      const content = params.content || '';
      if (!p) throw new Error('No file path specified');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return { success: true, path: p, size: content.length };
    }
  },

  folder_list: {
    name: 'folder_list',
    description: 'List files in a directory',
    params: { path: 'string' },
    handler: async (params) => {
      const p = params.path || os.homedir();
      if (!fs.existsSync(p)) throw new Error('Directory not found: ' + p);
      const entries = fs.readdirSync(p, { withFileTypes: true });
      const list = entries.slice(0, 100).map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'
      }));
      return { success: true, path: p, count: entries.length, items: list };
    }
  },

  sys_info: {
    name: 'sys_info',
    description: 'Get system information',
    params: {},
    handler: async () => {
      return {
        success: true,
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        homedir: os.homedir(),
        cwd: process.cwd(),
        uptime: Math.floor(os.uptime()),
        memory: {
          total: Math.floor(os.totalmem() / (1024*1024*1024)) + 'GB',
          free: Math.floor(os.freemem() / (1024*1024*1024)) + 'GB'
        }
      };
    }
  },
};

// ============================================================
// 意图识别 - 判断是否应该先执行本地工具
// ============================================================
function detectIntent(text) {
  const lower = text.toLowerCase();
  const matches = [];

  // Direct command prefix: "/exec ls -la"
  if (lower.startsWith('/exec ')) {
    matches.push({ tool: 'shell_exec', params: { command: text.slice(7).trim() }, confidence: 1.0 });
  }

  // Direct file read prefix: "/read /path/to/file"
  if (lower.startsWith('/read ')) {
    matches.push({ tool: 'file_read', params: { path: text.slice(6).trim() }, confidence: 1.0 });
  }

  // Direct file write prefix: "/write /path content"
  if (lower.startsWith('/write ')) {
    const parts = text.slice(7).trim().split(/\s+/);
    const writePath = parts[0];
    const writeContent = parts.slice(1).join(' ');
    matches.push({ tool: 'file_write', params: { path: writePath, content: writeContent }, confidence: 1.0 });
  }

  // Direct folder list prefix: "/ls [path]"
  if (lower.startsWith('/ls')) {
    const lsPath = text.slice(3).trim() || os.homedir();
    matches.push({ tool: 'folder_list', params: { path: lsPath }, confidence: 1.0 });
  }

  // Direct sys info: "/sys"
  if (lower.startsWith('/sys')) {
    matches.push({ tool: 'sys_info', params: {}, confidence: 1.0 });
  }

  // Pattern-based detection
  const patterns = [
    { regex: /查(看|询|找).*文件.*(内容|里面)/, tool: 'file_read' },
    { regex: /列(出|表).*(文件|目录|文件夹)/, tool: 'folder_list' },
    { regex: /执行.*(命令|脚本|shell|bash|终端)/, tool: 'shell_exec' },
    { regex: /(ls|pwd|whoami|date|df|du|top|ps|netstat|ifconfig)\b/, tool: 'shell_exec' },
  ];

  for (const p of patterns) {
    if (p.regex.test(lower)) {
      matches.push({ tool: p.tool, params: {}, confidence: 0.5 });
    }
  }

  return matches;
}

// ============================================================
// 工具执行
// ============================================================
async function executeTool(toolName, params) {
  const tool = TOOLS[toolName];
  if (!tool) throw new Error('Unknown tool: ' + toolName);
  console.log('[Agent] executing', toolName, JSON.stringify(params).slice(0, 100));
  try {
    const result = await tool.handler(params);
    console.log('[Agent] result:', JSON.stringify(result).slice(0, 200));
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
// 获取工具描述（注入到聊天上下文）
// ============================================================
function getToolSystemPrompt() {
  const lines = ['\n--- Local Agent Tools ---\n'];
  lines.push('You have access to the following LOCAL tools. When the user asks to do something on their machine, use /exec, /read, /write, /ls, /sys prefixes to invoke tools.\n');
  for (const [name, tool] of Object.entries(TOOLS)) {
    lines.push(`- ${name}: ${tool.description}`);
  }
  lines.push('\nTo invoke a tool, use:');
  lines.push('/exec <command>  - run a shell command');
  lines.push('/read <path>     - read a file');
  lines.push('/write <path> <content> - write to a file');
  lines.push('/ls [path]       - list directory');
  lines.push('/sys             - system info\n');
  return lines.join('\n');
}

module.exports = { TOOLS, detectIntent, executeTool, getToolSystemPrompt };
