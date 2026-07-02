const agentRouter = require('./agent-router.js');
const protocol = require('./tool-protocol.js');

function buildUserPrompt(question, injectTools) {
  var prefix = injectTools ? (protocol.buildToolPrompt(agentRouter.TOOLS) + '\nUser: ') : '';
  return prefix + String(question || '');
}

function detectDirectLocalIntent(question) {
  var intents = agentRouter.detectIntent(question || '');
  if (!intents.length) return null;
  if (intents[0].confidence < 1.0) return null;
  return intents[0];
}

async function executeDirectLocalIntent(intent) {
  return agentRouter.executeTool(intent.tool, intent.params);
}

async function maybeExecuteToolCall(answer) {
  var call = protocol.extractToolCall(answer);
  if (!call) return null;
  var result = await agentRouter.executeTool(call.tool, call.args || {});
  return {
    tool: call.tool,
    args: call.args || {},
    raw: result,
    text: protocol.normalizeToolResult(result),
  };
}

function buildToolResultMessage(execResult) {
  return '[Tool Result: ' + execResult.tool + ']\n' + execResult.text;
}

async function continueWithToolCall(answer, opts) {
  if (!answer || !opts || !opts.wcid) return false;
  var execResult = await maybeExecuteToolCall(answer);
  if (!execResult) return false;

  var toolMsg = '\n\n' + buildToolResultMessage(execResult);
  if (opts.miniChatWindow && !opts.miniChatWindow.isDestroyed()) {
    opts.miniChatWindow.webContents.send('mini:replyComplete', toolMsg);
  }

  try {
    var wc = require('electron').webContents.fromId(opts.wcid);
    if (wc && !wc.isDestroyed()) {
      wc.executeJavaScript(
        '(function(){' +
        'var ta=document.querySelector("textarea");if(!ta)return;' +
        'var ns=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;' +
        'ns.call(ta,"");ns.call(ta,' + JSON.stringify(toolMsg.trim()) + ');ta.focus();' +
        'ta.dispatchEvent(new InputEvent("beforeinput",{bubbles:true,inputType:"insertText",data:' + JSON.stringify(toolMsg.trim()) + '}));' +
        'ta.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:' + JSON.stringify(toolMsg.trim()) + '}));' +
        'ta.dispatchEvent(new Event("change",{bubbles:true}));' +
        'var btns=document.querySelectorAll("button");var sBtn=null;' +
        'for(var i=btns.length-1;i>=0;i--){var b=btns[i];if(b.disabled||!b.offsetParent)continue;var cls=(b.className||"").toLowerCase();if(cls.indexOf("send")>=0){sBtn=b;break;}}' +
        'if(sBtn){sBtn.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));sBtn.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));sBtn.click();}' +
        'ta.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true,composed:true,cancelable:true}));' +
        '})()'
      ).catch(function(){});
    }
  } catch (_) {}
  return true;
}

module.exports = {
  buildUserPrompt,
  detectDirectLocalIntent,
  executeDirectLocalIntent,
  maybeExecuteToolCall,
  buildToolResultMessage,
  continueWithToolCall,
};
