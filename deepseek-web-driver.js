const fs = require('fs');
const path = require('path');

function getChatWebContentsId(mainWindow) {
  return mainWindow.webContents.executeJavaScript(
    '(function(){var cv=document.getElementById("chatView");return cv?cv.getWebContentsId():-1})()'
  );
}

function startNewConversation(wc) {
  return wc.executeJavaScript(
    '(function(){' +
    'var btn=document.querySelector("[aria-label=\\"New chat\\"], [aria-label=\\"新对话\\"]");' +
    'if(!btn){var as=document.querySelectorAll("a");for(var i=0;i<as.length;i++){if(as[i].href&&as[i].href.indexOf("/chat")>=0&&!as[i].href.includes("/s/")){btn=as[i];break;}}}' +
    'if(btn)btn.click();' +
    'else{window.location.href="https://chat.deepseek.com/";}' +
    '})()'
  );
}

function buildInjectedTurnCode(opts) {
  var question = opts.question || '';
  var mode = opts.mode || 'default';
  var imageScripts = Array.isArray(opts.imageScripts) ? opts.imageScripts : [];
  var promptPrefix = opts.promptPrefix || '';
  return (
    '(' + (function(){
      window.__miniDiag = [];
      function dbg() {
        try {
          var args = [];
          for (var i = 0; i < arguments.length; i++) args.push(String(arguments[i]));
          window.__miniDiag.push(args.join(' '));
        } catch (_) {}
      }
      var Q='PLACEHOLDER_Q';
      var M='PLACEHOLDER_M';
      var IMG_COUNT = 0;
      var IMG_DATA = [];
      var modeMap={"default":"快速模式","DEFAULT":"快速模式","expert":"专家模式","EXPERT":"专家模式","vision":"识图模式","VISION":"识图模式"};
      var target=modeMap[M]||"快速模式";
      var patterns = [];
      if (target === "识图模式") patterns = ["识图模式", "识图", "vision", "V3", "DeepSeek-V3", "图片理解", "视觉"];
      else if (target === "专家模式") patterns = ["专家模式", "专家", "expert", "R1", "DeepSeek-R1", "深度思考"];
      else patterns = ["快速模式", "快速", "default"];
      function isSelected(el) {
        if (!el) return false;
        var cls = ((el.className || '') + ' ' + (el.parentElement && el.parentElement.className || '')).toLowerCase();
        var aria = el.getAttribute('aria-selected');
        var state = el.getAttribute('data-state');
        return aria === 'true' || state === 'active' || cls.indexOf('active') >= 0 || cls.indexOf('selected') >= 0 || cls.indexOf('current') >= 0;
      }
      function modeReady() {
        if (target === "快速模式") return true;
        var pageText = (document.body && (document.body.innerText || document.body.textContent) || '').trim();
        if (pageText.indexOf('使用' + target + '开始对话') >= 0) return true;
        if (chosenModeEl && isSelected(chosenModeEl)) return true;
        return false;
      }
      function findTopModeClickable(t) {
        var all = document.querySelectorAll('*');
        var best = null;
        var bestTop = Infinity;
        for (var i=0; i<all.length; i++) {
          var el = all[i];
          var txt = (el.textContent || '').trim();
          if (el.children.length > 0) continue;
          if (!(txt === t || txt.indexOf(t) >= 0)) continue;
          var rect = el.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) continue;
          if (rect.top < 0 || rect.top > Math.min(window.innerHeight * 0.65, 700)) continue;
          if (rect.top < bestTop) { bestTop = rect.top; best = el; }
        }
        if (!best) return null;
        var clickable = best;
        while (clickable && clickable.tagName !== 'BUTTON' && clickable.tagName !== 'A' && clickable.getAttribute('role') !== 'tab' && clickable.getAttribute('role') !== 'button') {
          clickable = clickable.parentElement;
        }
        return clickable || best;
      }
      var chosenModeEl = null;
      var found = false;
      for (var p=0; p<patterns.length && !found; p++) {
        chosenModeEl = findTopModeClickable(patterns[p]);
        if (chosenModeEl) {
          dbg('mode candidate=', patterns[p], 'text=', (chosenModeEl.innerText || chosenModeEl.textContent || '').trim());
          var r = chosenModeEl.getBoundingClientRect();
          ['mousedown','mouseup','click'].forEach(function(type){
            chosenModeEl.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,buttons:1}));
          });
          found = true;
        }
      }
      if (!found) dbg('no mode candidate found for', target, patterns.join('|'));
      function pasteImage(idx) {
        if (idx >= IMG_COUNT) { typeAndSend(); return; }
        var d = IMG_DATA[idx];
        var ta = document.querySelector('textarea');
        if (!ta) { dbg('paste waiting textarea idx=', idx); setTimeout(function(){ pasteImage(idx); }, 300); return; }
        try {
          dbg('paste start idx=', idx, 'mime=', d.mime, 'b64len=', d.b64 ? d.b64.length : 0);
          var raw=atob(d.b64);
          var bytes=new Uint8Array(raw.length);
          for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
          var blob=new Blob([bytes],{type:d.mime});
          var file=new File([blob],'image.'+(d.mime.split('/')[1]||'png'),{type:d.mime});
          var dt=new DataTransfer();
          dt.items.add(file);
          ta.focus();
          var ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true});
          Object.defineProperty(ev,'clipboardData',{value:dt});
          ta.dispatchEvent(ev);
          dbg('paste dispatched idx=', idx);
        } catch(e) { dbg('paste error idx=', idx, e && e.message ? e.message : String(e)); }
        setTimeout(function(){ pasteImage(idx+1); }, 600);
      }
      function clickSendWhenReady(retries, allowFormSubmit) {
        var bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').trim();
        if (bodyText.indexOf('文件解析中') >= 0 || bodyText.indexOf('解析中') >= 0 || bodyText.indexOf('上传中') >= 0 || bodyText.indexOf('处理中') >= 0 || bodyText.indexOf('上传图片') >= 0 || bodyText.indexOf('图片解析') >= 0 || bodyText.indexOf('识别中') >= 0) {
          dbg('still parsing/uploading, wait retries=', retries);
          if (retries > 0) setTimeout(function(){ clickSendWhenReady(retries - 1, allowFormSubmit); }, 500);
          return;
        }
        var ta0=document.querySelector("textarea");
        if(allowFormSubmit && ta0){
          var form = ta0.closest ? ta0.closest('form') : null;
          if(form){
            try { if(typeof form.requestSubmit === 'function'){ dbg('requestSubmit()'); form.requestSubmit(); return; } } catch(_) {}
            try {
              dbg('dispatch submit event');
              var submitEv = new Event('submit', {bubbles:true, cancelable:true});
              form.dispatchEvent(submitEv);
              if(!submitEv.defaultPrevented && typeof form.submit === 'function'){ dbg('native form.submit()'); form.submit(); }
              return;
            } catch(_) {}
          }
        }
        var candidates = document.querySelectorAll("button,[role=button]");
        var sBtn=null;
        var bestScore = -Infinity;
        for(var i=0;i<candidates.length;i++){
          var b=candidates[i];
          var rect=b.getBoundingClientRect();
          if(!rect || rect.width<=0 || rect.height<=0) continue;
          if(!b.offsetParent) continue;
          var cls=(b.className||"").toLowerCase();
          var aria=(b.getAttribute("aria-label")||"").toLowerCase();
          var txt=(b.textContent||"").trim().toLowerCase();
          // Exclude mode/tool toggle buttons
          if(txt.indexOf("深度思考")>=0 || txt.indexOf("智能搜索")>=0 || txt.indexOf("快速模式")>=0 || txt.indexOf("专家模式")>=0 || txt.indexOf("识图模式")>=0) continue;
          if(cls.indexOf("capsule")>=0 || cls.indexOf("iconlabel")>=0) continue;
          var score = 0;
          if(cls.indexOf("send")>=0 || aria.indexOf("send")>=0 || aria.indexOf("发送")>=0 || txt==="send" || txt==="发送") score += 1000;
          // Prefer primary/filled buttons (send button style)
          if(cls.indexOf("primary")>=0 || cls.indexOf("filled")>=0) score += 500;
          if(b.querySelector && b.querySelector('svg')) score += 100;
          if(score > bestScore){ bestScore = score; sBtn = b; }
        }
        // Minimum score threshold to avoid misidentifying toggle buttons
        if(bestScore < 200) sBtn = null;
        if(sBtn){
          var ariaDisabled=(sBtn.getAttribute("aria-disabled")||"").toLowerCase()==='true';
          var classDisabled = ((sBtn.className || '').toLowerCase().indexOf('disabled') >= 0);
          dbg('send candidate text=', (sBtn.innerText || sBtn.textContent || '').trim(), 'class=', sBtn.className || '', 'disabled=', !!sBtn.disabled, 'ariaDisabled=', ariaDisabled, 'classDisabled=', classDisabled, 'score=', bestScore);
          if(sBtn.disabled || ariaDisabled || classDisabled){
            if(retries > 0) setTimeout(function(){ clickSendWhenReady(retries - 1, allowFormSubmit); }, 500);
            return;
          }
          var r=sBtn.getBoundingClientRect();
          dbg('clicking send button');
          setTimeout(function(){ ['mousedown','mouseup'].forEach(function(type){ sBtn.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,buttons:1})); }); if(typeof sBtn.click === 'function') sBtn.click(); }, (M === 'vision' || M === 'VISION') ? 300 : 0);
          return;
        }
        dbg('no send candidate, retries=', retries);
        if(retries > 0) { setTimeout(function(){ clickSendWhenReady(retries - 1, allowFormSubmit); }, 500); return; }
      }
      function typeAndSend() {
        var ta=document.querySelector("textarea");
        if (Q && ta) {
          var ns=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;
          ns.call(ta,"");ns.call(ta,Q);ta.focus();
          ta.dispatchEvent(new InputEvent("beforeinput",{bubbles:true,inputType:"insertText",data:Q}));
          ta.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:Q}));
          ta.dispatchEvent(new Event("change",{bubbles:true}));
        }
        if (!Q && IMG_COUNT > 0) { clickSendWhenReady(200, true); return; }
        if (Q) clickSendWhenReady(120, true);
      }
      function waitForModeAndPaste(retries, totalWaits) {
        if (totalWaits === undefined) totalWaits = 0;
        var ta = document.querySelector('textarea');
        var ready = modeReady();
        if (ready && ta && ta.offsetParent && !ta.disabled) { dbg('mode ready, start paste'); pasteImage(0); return; }
        totalWaits++;
        if (retries <= 0) {
          if (target === "快速模式" || totalWaits >= 4) {
            dbg('mode wait timeout, force paste');
            pasteImage(0); return;
          }
          dbg('mode not ready yet, extend waiting');
          setTimeout(function(){ waitForModeAndPaste(12, totalWaits); }, 800); return;
        }
        setTimeout(function(){ waitForModeAndPaste(retries - 1, totalWaits); }, 400);
      }
      setTimeout(function(){ waitForModeAndPaste(12); }, 800);
    }).toString()
      .replace("'PLACEHOLDER_Q'", JSON.stringify(promptPrefix + question))
      .replace("'PLACEHOLDER_M'", JSON.stringify(mode))
      .replace('IMG_COUNT = 0', 'IMG_COUNT = ' + imageScripts.length)
      .replace('IMG_DATA = []', 'IMG_DATA = ' + JSON.stringify(imageScripts))
      + ')()'
  );
}

function startDomStream(wc) {
  try { wc.send('chat:stream:start'); } catch (_) {}
}

function stopDomStream(wc) {
  try { wc.send('chat:stream:stop'); } catch (_) {}
}

function buildImageScripts(images) {
  var list = [];
  (Array.isArray(images) ? images : []).forEach(function(imgPath) {
    try {
      var ext = path.extname(imgPath).toLowerCase();
      var mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/png';
      var b64 = fs.readFileSync(imgPath).toString('base64');
      list.push({ b64: b64, mime: mime });
    } catch (_) {}
  });
  return list;
}

function startDiagPull(opts) {
  var wcid = opts.wcid;
  var onLine = opts.onLine;
  var timer = setInterval(function() {
    var live = require('electron').webContents.fromId(wcid);
    if (!live || live.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    live.executeJavaScript('(function(){var d=window.__miniDiag||[];window.__miniDiag=[];return d;})()')
      .then(function(list) {
        if (Array.isArray(list) && list.length && typeof onLine === 'function') {
          list.forEach(function(line) { onLine(line); });
        }
      })
      .catch(function() {});
  }, 500);
  return timer;
}

function startReplyPolling(opts) {
  var wcid = opts.wcid;
  var miniChatWindow = opts.miniChatWindow;
  var onFinal = opts.onFinal;
  var onTimeout = opts.onTimeout;
  var onDebugStop = opts.onDebugStop;
  var timerRef = { timer: null };
  var lastText = '';
  var stable = 0;
  var attempts = 0;
  var initialMsgCount = -1;
  var initDone = false;
  var thinkingSeenCount = 0;
  var thinkingTextLen = 0; // track text length when thinking was detected
  var finalized = false; // prevent double-fire

  function poll() {
    attempts++;
    if (!miniChatWindow || miniChatWindow.isDestroyed()) {
      clearInterval(timerRef.timer); timerRef.timer = null; return;
    }
    var pw = require('electron').webContents.fromId(wcid);
    if (!pw || pw.isDestroyed()) {
      clearInterval(timerRef.timer); timerRef.timer = null; return;
    }
    pw.executeJavaScript(
      '(function(){var roots=document.querySelectorAll("._74c0879, .ds-assistant-message-main-content, [class*=assistant], [class*=message-main]");' +
      'var count=roots.length;' +
      'if(!count)return JSON.stringify({count:0,text:""});' +
      'var r=roots[count-1].cloneNode(true);' +
      'var nodes=r.querySelectorAll(".dpp-tool-block,.dpp-agent-container");' +
      'for(var i=0;i<nodes.length;i++)nodes[i].remove();' +
      'return JSON.stringify({count:count,text:(r.textContent||"").trim()});})()'
    ).then(function(result) {
      var data = {};
      try { data = JSON.parse(result); } catch(_) { data = { count: 0, text: '' }; }
      var count = data.count || 0;
      var text = data.text || '';

      if (!initDone) {
        console.log('[Poll#' + attempts + '] init count=' + count + ' text=' + (text||'').slice(0,40));
        initialMsgCount = count;
        initDone = true;
        // Immediately schedule next poll to start checking
        timerRef.timer = setTimeout(poll, 800);
        return;
      }

      // Skip stale messages (pre-existing before this question)
      if (count <= initialMsgCount) {
        if (attempts > 80) {
          clearTimeout(timerRef.timer); timerRef.timer = null;
          onTimeout();
          return;
        }
        timerRef.timer = setTimeout(poll, 2000);
        return;
      }

      console.log('[Poll#' + attempts + '] NEW count=' + count + ' text=' + (text||'').slice(0,80));

      // Handle thinking blocks: wait for real answer to appear (either new message or substantial growth)
      var isThinking = text.indexOf('已思考') === 0 || text.indexOf('正在思考') === 0 || text.indexOf('已执行工具') === 0;
      if (isThinking) {
        if (count > thinkingSeenCount) {
          thinkingSeenCount = count;
          thinkingTextLen = text.length;
        }
        // If text has grown substantially since thinking was first detected, answer may be appended
        if (thinkingTextLen > 0 && count === thinkingSeenCount && text.length > thinkingTextLen + 60) {
          // Answer was appended to same message; strip thinking prefix lines and proceed
          var lines = text.split('\n');
          var cut = -1;
          for (var j = 0; j < lines.length; j++) {
            if (/^(已思考|正在思考|已执行工具|Step\s*\d+|Agent\s*完成)/.test(lines[j].trim())) cut = j;
          }
          if (cut >= 0 && cut < lines.length - 1) {
            text = lines.slice(cut + 1).join('\n').trim();
          }
          // Fall through to stability check with extracted answer
        } else {
          console.log('[Poll#' + attempts + '] thinking block, waiting for answer count=' + count + ' thinkLen=' + thinkingTextLen + ' curLen=' + text.length);
          lastText = ''; stable = 0;
          timerRef.timer = setTimeout(poll, 2000);
          return;
        }
      }

      // If we've seen thinking blocks, ensure we're past them
      if (thinkingSeenCount > 0 && count <= thinkingSeenCount) {
        // Check if text grew significantly (answer appended to same node)
        if (text.length > thinkingTextLen + 60) {
          thinkingSeenCount = 0; // accept this as answer, fall through
        } else {
          console.log('[Poll#' + attempts + '] still in thinking phase count=' + count);
          lastText = ''; stable = 0;
          timerRef.timer = setTimeout(poll, 2000);
          return;
        }
      }

      if (text && text.length > 30 && text === lastText) stable++;
      else if (text && text.length > 30) { lastText = text; stable = 0; }
      if ((stable >= 4 || attempts > 60) && lastText.length > 10) {
        if (finalized) return;
        finalized = true;
        clearInterval(timerRef.timer); timerRef.timer = null;
        onFinal(lastText);
        if (onDebugStop) onDebugStop(pw);
      }
      if (attempts > 90 && lastText.length === 0) {
        clearInterval(timerRef.timer); timerRef.timer = null;
        onTimeout();
        if (onDebugStop) onDebugStop(pw);
      }
      if (timerRef.timer !== null) timerRef.timer = setTimeout(poll, 2000);
    }).catch(function(){
      if (timerRef.timer !== null) timerRef.timer = setTimeout(poll, 2000);
    });
  }
  timerRef.timer = setTimeout(poll, 2000);
  return timerRef;
}

module.exports = {
  getChatWebContentsId,
  startNewConversation,
  buildInjectedTurnCode,
  startDomStream,
  stopDomStream,
  buildImageScripts,
  startDiagPull,
  startReplyPolling,
};
