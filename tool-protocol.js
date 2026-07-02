function extractToolCall(text) {
  if (!text) return null;
  var m = String(text).match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!m) return null;
  try {
    var obj = JSON.parse(m[1]);
    if (!obj || typeof obj !== 'object' || !obj.tool) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

function extractFinalAnswer(text) {
  if (!text) return '';
  var m = String(text).match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i);
  if (m) return m[1].trim();
  return String(text).trim();
}

function normalizeToolResult(result) {
  if (!result || typeof result !== 'object') return String(result || '');
  if (result.success && typeof result.stdout === 'string' && result.stdout) return result.stdout.trim();
  if (result.success && typeof result.content === 'string' && result.content) return result.content.trim();
  if (result.success && Array.isArray(result.items)) {
    return result.items.map(function(it) {
      return (it.type === 'dir' ? '[DIR]  ' : '[FILE] ') + it.name;
    }).join('\n');
  }
  return JSON.stringify(result, null, 2);
}

function buildToolPrompt(tools) {
  var lines = ['--- Local Agent Tools ---'];
  lines.push('When local tools are required, respond ONLY with <tool_call>{...}</tool_call>.');
  lines.push('When you are completely done, respond ONLY with <final_answer>...</final_answer>.');
  Object.keys(tools || {}).forEach(function(name) {
    var tool = tools[name];
    lines.push('- ' + name + ': ' + tool.description);
  });
  return lines.join('\n');
}

module.exports = {
  extractToolCall,
  extractFinalAnswer,
  normalizeToolResult,
  buildToolPrompt,
};
