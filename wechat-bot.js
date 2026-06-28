/**
 * WeChat Bot — 微信 → DeepSeek AI 对话
 *
 * 接入微信官方 iLink Bot API (基于 openclaw-weixin 插件协议):
 *   https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html
 *
 * 前置条件:
 *   无需 AppID/SecretKey，直接通过二维码扫码登录。
 *
 * 流程:
 *   1. GET ilink/bot/get_bot_qrcode → 获取登录二维码
 *   2. GET ilink/bot/get_qrcode_status → 轮询扫码状态，confirmed 后获得 bot_token
 *   3. POST ilink/bot/getupdates → 长轮询接收微信消息
 *   4. DeepSeek API 处理 → POST ilink/bot/sendmessage 回复
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const url = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');

// ============================================================
// 配置
// ============================================================
const DEFAULT_API_BASE = process.env.DPP_WECHAT_API_BASE || 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = 3;
const CHANNEL_VERSION = '1.0.0';

// base_info 附带在所有 API 请求体中
function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

const CONFIG_DIR = (function () {
  try {
    return path.join(require('electron').app.getPath('userData'), 'wechat-bot');
  } catch (_) {
    return path.join(os.homedir(), '.deepseek-client', 'wechat-bot');
  }
})();
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
const SYNC_PATH = path.join(CONFIG_DIR, 'sync.json');
const CTX_TOKENS_PATH = path.join(CONFIG_DIR, 'context-tokens.json');

// ============================================================
// 持久化
// ============================================================
function ensureDir() { fs.mkdirSync(CONFIG_DIR, { recursive: true }); }
function loadJson(filePath, fallback) {
  try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return fallback; }
  return fallback;
}
function saveJson(filePath, data) { ensureDir(); fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8'); }

// ============================================================
// 状态
// ============================================================
let state = {
  status: 'stopped',
  qrCodeDataUrl: null,
  qrCodeToken: null,
  errorMessage: null,
  credentials: null,     // { bot_token, ilink_bot_id, ilink_user_id, baseUrl }
  pollTimer: null,
  stopped: false,
};
let mainWindowRef = null;
let apiBase = DEFAULT_API_BASE;
let sysMsgIdCursor = 0;
let conversationMap = new Map();

function getStatus() {
  return {
    status: state.status,
    qrCodeDataUrl: state.qrCodeDataUrl,
    error: state.errorMessage,
  };
}

// ============================================================
// HTTP 请求
// ============================================================
function httpReq(method, apiPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const base = opts.baseUrl || apiBase;
    const parsed = url.parse(base + '/' + apiPath.replace(/^\//, ''));
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const headers = {
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64'),
      ...opts.headers,
    };
    if (state.credentials && state.credentials.bot_token && !opts.skipAuth) {
      headers['AuthorizationType'] = 'ilink_bot_token';
      headers['Authorization'] = 'Bearer ' + state.credentials.bot_token;
    }
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.path, method, headers,
      timeout: opts.timeout || (opts.longPoll ? 45000 : 30000),
    }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); opts.longPoll ? resolve({ status: 200, data: null }) : reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================
// 二维码登录
// ============================================================
async function fetchQrCode() {
  // GET ilink/bot/get_bot_qrcode?bot_type=3
  const res = await httpReq('GET', 'ilink/bot/get_bot_qrcode?bot_type=' + BOT_TYPE, { skipAuth: true });
  if (!res.data || !res.data.qrcode) throw new Error('Failed to get QR code');
  return { qrcode: res.data.qrcode, qrcode_img_content: res.data.qrcode_img_content };
}

async function generateQrDataUrl(qrResponse) {
  // 本地生成二维码: 编码 qrcode_img_content (iLink 返回的扫码链接)
  // 如果 qrcode_img_content 不存在，则编码 get_qrcode_status 轮询 URL
  var data = qrResponse.qrcode_img_content ||
    (apiBase + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrResponse.qrcode));
  console.log('[WeChat Bot] QR data:', data.slice(0, 100));
  return new Promise((resolve) => {
    QRCode.toDataURL(data, { width: 280, margin: 1 }, (err, url) => {
      resolve(err ? null : url);
    });
  });
}

async function pollQrStatus(qrcode) {
  // GET ilink/bot/get_qrcode_status?qrcode=<token> (长轮询)
  const res = await httpReq('GET', 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode), {
    skipAuth: true, longPoll: true, timeout: 65000
  });
  if (!res.data) return { status: 'timeout' };
  return res.data; // { status: "wait"|"scaned"|"confirmed"|"expired", bot_token?, ilink_bot_id?, ilink_user_id? }
}

// ============================================================
// 消息收发
// ============================================================
async function getUpdates() {
  const buf = loadJson(SYNC_PATH, { get_updates_buf: '' });
  const res = await httpReq('POST', 'ilink/bot/getupdates', {
    body: {
      get_updates_buf: buf.get_updates_buf || '',
      base_info: buildBaseInfo(),
    },
    longPoll: true, timeout: 40000
  });
  if (!res.data) return [];
  // 检查错误码
  if ((res.data.ret != null && res.data.ret !== 0) || (res.data.errcode != null && res.data.errcode !== 0)) {
    console.error('[WeChat Bot] getUpdates error:', res.data.errcode, res.data.errmsg);
    return [];
  }
  if (res.data.get_updates_buf) {
    saveJson(SYNC_PATH, { get_updates_buf: res.data.get_updates_buf });
  }
  return res.data.msgs || [];
}

async function sendMessage(toUserId, text, contextToken) {
  sysMsgIdCursor += 1;
  const body = {
    msg: {
      to_user_id: toUserId,
      client_id: crypto.randomUUID(),
      message_type: 2,   // BOT
      message_state: 2,  // FINISH
      item_list: [{ type: 1, text_item: { text: text } }],
      context_token: contextToken || '',
      sys_msg_id: String(sysMsgIdCursor),
    },
    base_info: buildBaseInfo(),
  };
  await httpReq('POST', 'ilink/bot/sendmessage', { body });
}

// ============================================================
// DeepSeek API — 通过 webview 模拟用户输入发送消息
// ============================================================
function isWebviewReady(mainWindow) {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents;
}

async function execInChatView(mainWindow, script) {
  if (!isWebviewReady(mainWindow)) {
    throw new Error('聊天 webview 未就绪');
  }
  return await mainWindow.webContents.executeJavaScript(`
    (async function() {
      var chatView = document.getElementById('chatView');
      if (!chatView || typeof chatView.executeJavaScript !== 'function') {
        throw new Error('chatView 不可用');
      }
      return await chatView.executeJavaScript(${JSON.stringify(script)});
    })()
  `);
}

async function callDeepSeekApi(mainWindow, prompt) {
  if (!isWebviewReady(mainWindow)) {
    throw new Error('聊天 webview 未就绪');
  }

  // 1. 注入文本 + React beforeInput 事件 + 找按钮发送
  var promptJson = JSON.stringify(prompt);
  var sendLog = await execInChatView(
    mainWindow,
    '(function(){var dbg={};try{var p=' + promptJson + ';' +
    'var ta=document.querySelector("textarea");if(!ta)return JSON.stringify({e:"no textarea"});' +
    'var ns=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;' +
    'ns.call(ta,"");ns.call(ta,p);' +
    'ta.focus();' +
    'ta.dispatchEvent(new InputEvent("beforeinput",{bubbles:true,inputType:"insertText",data:p}));' +
    'ta.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:p}));' +
    'ta.dispatchEvent(new Event("change",{bubbles:true}));' +
    'var btns=document.querySelectorAll("button");var cands=[];' +
    'for(var i=0;i<btns.length;i++){var b=btns[i];if(b.disabled||!b.offsetParent)continue;cands.push({t:(b.textContent||"").trim().slice(0,20),c:(b.className||"").slice(0,30),a:b.getAttribute("aria-label")||""});}' +
    'dbg.cands=cands;' +
    'var sBtn=null;' +
    'for(var j=btns.length-1;j>=0;j--){var b2=btns[j];if(b2.disabled||!b2.offsetParent)continue;var cls2=(b2.className||"").toLowerCase();var aria2=(b2.getAttribute("aria-label")||"").toLowerCase();var txt2=(b2.textContent||"").trim().toLowerCase();if(cls2.indexOf("send")>=0||cls2.indexOf("submit")>=0||aria2.indexOf("send")>=0||aria2.indexOf("发送")>=0||txt2==="send"||txt2==="发送"){sBtn=b2;dbg.match="named";break;}}' +
    'if(!sBtn){var pbtns=ta.parentElement?ta.parentElement.querySelectorAll("button"):[];for(var k=pbtns.length-1;k>=0;k--){if(!pbtns[k].disabled&&pbtns[k].offsetParent){sBtn=pbtns[k];dbg.match="parent";break;}}}' +
    'if(sBtn){dbg.btnT=(sBtn.textContent||"").trim().slice(0,10);dbg.btnC=(sBtn.className||"").slice(0,30);sBtn.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));sBtn.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));sBtn.click();dbg.clicked=true;}' +
    'ta.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true,composed:true,cancelable:true}));' +
    'dbg.taVal=ta.value.slice(0,20);return JSON.stringify(dbg);' +
    '}catch(e){return JSON.stringify({e:e.message});}})()'
  );
  try { var dbg = JSON.parse(sendLog); console.log('[WeChat Bot] send debug:', JSON.stringify(dbg)); } catch(_) {}

  // 2. 轮询 .ds-markdown 提取 AI 回复
  var deadline = Date.now() + 60000;
  var lastContent = '';
  var stableCount = 0;

  while (Date.now() < deadline) {
    var resp = await execInChatView(
      mainWindow,
      '(function(){' +
      'var roots=document.querySelectorAll("._74c0879, .ds-assistant-message-main-content");' +
      'var text="";' +
      'if(roots.length>0){' +
      '  var root=roots[roots.length-1].cloneNode(true);' +
      '  var removeSelectors=[' +
      '    ".dpp-tool-block",'.replace(/'/g,'"') +
      '    ".dpp-artifact-results",'.replace(/'/g,'"') +
      '    ".dpp-agent-container",'.replace(/'/g,'"') +
      '    ".dpp-agent-step",'.replace(/'/g,'"') +
      '    ".dpp-agent-footer",'.replace(/'/g,'"') +
      '    ".dpp-agent-stop-btn",'.replace(/'/g,'"') +
      '    "[class*=tool]",'.replace(/'/g,'"') +
      '    "[class*=Tool]",'.replace(/'/g,'"') +
      '    "[class*=reason]",'.replace(/'/g,'"') +
      '    "[class*=Reason]",'.replace(/'/g,'"') +
      '    "[class*=think]",'.replace(/'/g,'"') +
      '    "[class*=Think]",'.replace(/'/g,'"') +
      '    "[class*=step]",'.replace(/'/g,'"') +
      '    "[class*=Step]",'.replace(/'/g,'"') +
      '    "[class*=agent]",'.replace(/'/g,'"') +
      '  ];' +
      '  for(var rs=0;rs<removeSelectors.length;rs++){' +
      '    var nodes=root.querySelectorAll(removeSelectors[rs]);' +
      '    for(var rn=0;rn<nodes.length;rn++)nodes[rn].remove();' +
      '  }' +
      '  text=(root.textContent||"").trim();' +
      '}' +
'if(text){' +
      '  var finalMarkers=["最终答案","最终结论","最终回答","Final Answer","Answer","总结：","总结如下"];' +
      '  for(var fm=0;fm<finalMarkers.length;fm++){' +
      '    var marker=finalMarkers[fm];var idx=text.indexOf(marker);' +
      '    if(idx>=0){text=text.slice(idx+marker.length).replace(/^[:：\\s-]*/,"").trim();break;}' +
      '  }' +
      '  text=text.replace(/^有两个工具[\\s\\S]*?\\n\\n/,"");' +
      '  text=text.replace(/^目前有[\\s\\S]*?\\n\\n/,"");' +
      '  text=text.replace(/^[\\s\\S]*?根据规则[\\s\\S]*?\\n\\n/,"");' +
      '  text=text.replace(/^(已思考|思考中|正在思考|Thinking|Reasoning)[:：\\n\\s-]*[\\s\\S]*?\\n\\n/i,"");' +
      '  text=text.replace(/已执行工具[^\\n]*\\n[\\s\\S]*?\\n\\n/g,"");' +
      '  text=text.replace(/Step\\s*\\d+[^\\n]*\\n[\\s\\S]*?\\n\\n/gi,"");' +
      '  text=text.replace(/Agent\\s*完成[^\\n]*/gi,"");' +
      '  text=text.replace(/以下是工具续跑[\\s\\S]*?<\\/tool_results>/gi,"");' +
      '  text=text.replace(/<[^>]+>/g,"");' +
      '  text=text.replace(/\\n{3,}/g,"\\n\\n").trim();' +
      '}' +
      'var l=!!document.querySelector("[class*=stop]");' +
      'return JSON.stringify({text:text,loading:l});})()'
    );
    try { var obj = JSON.parse(resp); } catch(e) { obj = { text:'', loading:false }; }

    if (!obj.loading && obj.text && obj.text.length > 5) {
      stableCount++;
      if (stableCount >= 3) return { text: obj.text, conversationId: null, parentMessageId: null };
    } else { stableCount = 0; }
    if (obj.text) lastContent = obj.text;
    await new Promise(function(r) { setTimeout(r, 3000); });
  }

  if (lastContent) return { text: lastContent, conversationId: null, parentMessageId: null };
  throw new Error('等待 AI 回复超时');
}

async function handleMessages(messages) {
  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    // msg 结构 (WeixinMessage): from_user_id, to_user_id, context_token, message_id,
    //   item_list: [{ type: 1=TEXT, text_item: { text: "..." } }]
    const userId = msg.from_user_id || '';
    const msgId = String(msg.message_id || '');
    const ctxToken = msg.context_token || '';

    if (!userId) continue;
    if (msgId.startsWith('sys_')) continue;

    // 解析 item_list
    const items = Array.isArray(msg.item_list) ? msg.item_list : [];
    const firstItem = items[0] || {};
    const itemType = firstItem.type != null ? Number(firstItem.type) : 0;

    // 纯文本: MessageItemType.TEXT = 1
    const isText = itemType === 1;
    const text = (firstItem.text_item && firstItem.text_item.text || msg.msg_buf || '').trim();

    // 非文本消息
    if (!isText) {
      console.log('[WeChat Bot] non-text msg from', userId, 'type:', itemType);
      await sendMessage(userId, '当前模型不支持图片/语音/视频等非文字输入，请发送文字消息。', ctxToken);
      continue;
    }

    if (!text) continue;

    console.log('[WeChat Bot] msg from', userId, ':', text.slice(0, 80));

    // 特殊命令
    if (text === '/reset') {
      conversationMap.delete(userId);
      await sendMessage(userId, '对话已重置', ctxToken);
      continue;
    }
    if (text === '/status') {
      await sendMessage(userId, 'Bot 状态: running | 活跃会话: ' + conversationMap.size, ctxToken);
      continue;
    }

    try {
      if (!isWebviewReady(mainWindowRef)) {
        await sendMessage(userId, '聊天 webview 未就绪，请稍后', ctxToken); continue;
      }

      const result = await callDeepSeekApi(mainWindowRef, text);

      if (result.text) {
        await sendLongMessage(userId, result.text, ctxToken);
      } else {
        await sendMessage(userId, 'AI 未返回有效回复', ctxToken);
      }
    } catch (err) {
      console.error('[WeChat Bot] ERROR:', err.message);
      await sendMessage(userId, '出错了: ' + (err.message || '未知错误'), ctxToken).catch(() => {});
    }
  }
}

async function sendLongMessage(userId, text, ctxToken) {
  const maxLen = 800;
  for (let i = 0; i < text.length; i += maxLen) {
    await sendMessage(userId, text.slice(i, i + maxLen), i === 0 ? ctxToken : '');
  }
}

// ============================================================
// 消息轮询循环
// ============================================================
function startPolling() {
  if (state.pollTimer) return;
  const poll = async () => {
    if (state.status !== 'running' || state.stopped) return;
    try {
      const messages = await getUpdates();
      if (messages && messages.length > 0) await handleMessages(messages);
    } catch (_) {}
    state.pollTimer = setTimeout(poll, 100);
  };
  state.pollTimer = setTimeout(poll, 100);
}

function stopPolling() {
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
}

// ============================================================
// 启动 / 停止
// ============================================================
async function start(mainWindow) {
  if (state.status === 'running' || state.status === 'starting') return getStatus();
  state.stopped = false;
  mainWindowRef = mainWindow;
  state.status = 'starting';
  state.qrCodeDataUrl = null;
  state.errorMessage = null;
  state.credentials = null;

  // 尝试加载已有凭证
  const saved = loadJson(CREDENTIALS_PATH, null);
  if (saved && saved.bot_token) {
    state.credentials = saved;
    apiBase = saved.baseUrl || DEFAULT_API_BASE;
    state.status = 'running';
    state.qrCodeDataUrl = null;
    state.errorMessage = null;
    sysMsgIdCursor = loadJson(path.join(CONFIG_DIR, 'sys-msg-cursor.json'), { cursor: 0 }).cursor;
    console.log('[WeChat Bot] Resumed session, bot_id:', saved.ilink_bot_id);
    startPolling();
    return getStatus();
  }

  try {
    const qr = await fetchQrCode();
    state.qrCodeToken = qr.qrcode;
    state.qrCodeDataUrl = await generateQrDataUrl(qr);
    state.status = 'scanning';
    console.log('[WeChat Bot] QR ready, img:', (qr.qrcode_img_content || '').slice(0, 80));

    const deadline = Date.now() + 180000; // 3分钟超时
    while (Date.now() < deadline) {
      const statusData = await pollQrStatus(state.qrCodeToken);

      if (statusData.status === 'confirmed' && statusData.bot_token) {
        state.credentials = {
          bot_token: statusData.bot_token,
          ilink_bot_id: statusData.ilink_bot_id || '',
          ilink_user_id: statusData.ilink_user_id || '',
          baseUrl: statusData.base_url || DEFAULT_API_BASE,
        };
        apiBase = state.credentials.baseUrl;
        saveJson(CREDENTIALS_PATH, state.credentials);

        state.status = 'running';
        state.qrCodeDataUrl = null;
        state.qrCodeToken = null;
        state.errorMessage = null;

        console.log('[WeChat Bot] Connected, bot_id:', state.credentials.ilink_bot_id);
        startPolling();
        return getStatus();
      }

      if (statusData.status === 'expired') {
        state.status = 'error';
        state.errorMessage = '二维码已过期，请重新启动';
        return getStatus();
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    state.status = 'error';
    state.errorMessage = '扫码超时 (3分钟)';
    return getStatus();
  } catch (err) {
    state.status = 'error';
    state.errorMessage = err.message;
    console.error('[WeChat Bot] Start error:', err.message);
    return getStatus();
  }
}

async function stop() {
  state.stopped = true;
  stopPolling();
  try { saveJson(path.join(CONFIG_DIR, 'sys-msg-cursor.json'), { cursor: sysMsgIdCursor }); } catch (_) {}
  conversationMap.clear();
  state = {
    status: 'stopped', qrCodeDataUrl: null, qrCodeToken: null,
    errorMessage: null, credentials: null, pollTimer: null, stopped: false,
  };
  return getStatus();
}

module.exports = { start, stop, getStatus };
