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

module.exports = {
  buildUserPrompt,
  detectDirectLocalIntent,
  executeDirectLocalIntent,
  maybeExecuteToolCall,
  buildToolResultMessage,
};
