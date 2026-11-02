/* Roche voice chat 0.1.0. No embedded credentials, dependencies or automatic retries. */
(function () {
  'use strict';
  if (!window.RochePlugin?.register) throw new Error('请通过 Roche 的插件管理安装本文件。');
  const instances = new WeakMap(); let conversationId='';
  const cut = (v, n) => String(v ?? '').slice(0, n);
  const uid = () => 'rvc_' + (crypto.randomUUID?.() || Date.now() + '_' + Math.random().toString(36).slice(2));
  const asText = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(x => typeof x === 'string' ? x : x?.text || '').join('\n') : '';
  const profileText = p => JSON.stringify(Object.fromEntries(['name', 'displayName', 'bio', 'persona', 'description', 'traits', 'relationship', 'relationshipStage'].filter(k => p?.[k]).map(k => [k, p[k]])));
  const CSS = `
    :host{display:block;height:100%;color:#252522;font:15px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color-scheme:light}
    *{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer;border:0}button:disabled{cursor:default;opacity:.42}
    .app{height:100%;min-height:0;display:flex;flex-direction:column;background:#f7f7f9}
    header{padding:calc(12px + env(safe-area-inset-top, 0px)) 18px 12px;border-bottom:1px solid #ddd9d0;background:#ffffff;display:flex;align-items:center;gap:12px}
    h1{font-size:19px;margin:0 0 4px;letter-spacing:.02em}p{margin:0}.sub,.note{font-size:12px;color:#68685f;line-height:1.6}
    .round{width:38px;height:38px;border-radius:50%;background:#eceae3;color:inherit;flex-shrink:0}.grow{flex:1;min-width:0}
    .settings{margin:10px 16px 0;border:1px solid #ddd9d0;border-radius:16px;background:#ffffff;padding:10px 12px;flex-shrink:0}
    summary{cursor:pointer;font-size:13px;font-weight:600}.options{display:grid;gap:12px;max-height:35dvh;overflow:auto;padding-top:12px}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px}.row input[type=checkbox]{width:18px;height:18px;accent-color:#303036;flex-shrink:0}
    select,input[type=text]{min-width:0;max-width:62%;padding:7px 8px;border:1px solid #d5d3cb;border-radius:8px;background:white;color:inherit}
    #voice{width:62%}.messages{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:22px 16px 14px;display:flex;flex-direction:column;gap:15px}
    .empty{margin:auto;text-align:center;max-width:280px;padding:24px 0;color:#68685f;line-height:1.8}.empty b{display:block;color:#313b35;font-size:20px;margin:12px 0 4px}
    .empty .mark{display:inline-grid;place-items:center;width:70px;height:70px;border-radius:24px;background:#e3eae1;font-size:30px;color:#303036}
    .msg{max-width:88%;align-self:flex-start}.msg.user{align-self:flex-end}.who{font-size:11px;letter-spacing:.03em;color:#73766d;margin:0 8px 5px}
    .user .who{text-align:right}.bubble{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;background:#ededf1;padding:11px 14px;border-radius:18px 18px 18px 5px}
    .user .bubble{background:#303036;color:white;border-radius:18px 18px 5px 18px}.failed .bubble{border:1px dashed #a77b59;opacity:.8}.pending .bubble{opacity:.7}
    .play{background:transparent;color:#3f5847;font-size:12px;padding:7px 8px;min-height:34px}.failed .who{color:#895335}
    footer{padding:10px 16px max(14px,env(safe-area-inset-bottom));background:#ffffff;border-top:1px solid #ddd9d0;flex-shrink:0}
    .status{font-size:12px;line-height:1.6;min-height:24px;padding:0 2px 7px;color:#586858;overflow-wrap:anywhere}.status.error{color:#945333}
    .compose{display:flex;gap:8px;align-items:flex-end}textarea{flex:1;min-width:0;resize:none;height:66px;max-height:150px;border:1px solid #d8d6cf;border-radius:15px;padding:11px 12px;background:white;color:#252522;font-size:16px;line-height:1.4}
    .send{height:46px;padding:0 15px;background:#303036;color:white;border-radius:14px}.controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
    .mic{flex:1;border:1px solid #cbd5c9;border-radius:13px;min-height:44px;background:#e8eee5;color:#294333;font-weight:600}
    .mic.on{background:#763e35;border-color:#763e35;color:white}.stop{border-radius:13px;background:#efede7;color:#55534e;padding:8px 14px;min-height:44px}
    .notice{padding-top:8px;font-size:11px;color:#7a7a70;line-height:1.5}.hidden{display:none!important}.context{font-size:11px;color:#75776c;line-height:1.5}
    @media(prefers-color-scheme:dark){:host{color:#eee;color-scheme:dark}.app{background:#20221f}header,footer,.settings{background:#292c27;border-color:#42483e}.sub,.note,.empty,.context,.notice,.who{color:#b2b8aa}.empty b{color:#edf0e9}.round,.stop{background:#42483e;color:#eee}.bubble{background:#3e4739}.user .bubble,.send{background:#b7c8a5;color:#202b1c}textarea,select,input[type=text]{background:#20221f;color:#eee;border-color:#5b6354}.mic{background:#364932;color:#dcebd1;border-color:#66755a}.status,.play{color:#c0d5b2}.status.error{color:#f1b896}}
    @media(prefers-reduced-motion:no-preference){.msg{animation:appear .18s ease-out}@keyframes appear{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}}
  `;
  function mount(container, api) {
    instances.get(container)?.();
    const layer=document.createElement('dialog'); layer.style.cssText='position:fixed;inset:0;margin:0;padding:0;border:0;width:100vw;max-width:none;height:100dvh;max-height:none;overflow:hidden'; container.append(layer); layer.showModal(); const shell = document.createElement('div');
    shell.style.cssText = 'height:100%;min-height:0;';
    const root = shell.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><section class="app" aria-label="语音聊天">
      <header><button class="round" id="close" aria-label="关闭">×</button><div class="grow"><h1>通话</h1><p class="sub">此刻，听你说</p></div><button class="round" id="export" aria-label="导出本页记录" title="导出记录">↓</button></header>
      <details class="settings"><summary id="summary">正在读取角色…</summary><div class="options">
        <label class="row">聊天角色<select id="character" aria-label="聊天角色"></select></label>
        <label class="row">识别语言<select id="language"><option value="zh-CN">中文普通话</option><option value="en-GB">英语</option><option value="zh-HK">粤语</option></select></label>
        <label class="row">回复语言<select id="reply"><option value="English">英语</option><option value="Chinese">中文</option><option value="Auto">跟随我的语言</option></select></label>
        <label class="row">说完自动发送<input id="autosend" type="checkbox"></label>
        <label class="row">自动朗读回复<input id="autoplay" type="checkbox" checked></label>
        <label class="row">带入最近聊天与记忆<input id="context" type="checkbox" checked></label>
        <label class="row">角色声音 ID<input id="voice" type="text" placeholder="优先使用角色已绑定的声音" autocomplete="off"></label>
        <p class="note">声音 ID 不是 API 密钥。模型与语音接口沿用 Roche 设置；支持打字与点按说话，暂不连续监听。</p>
        <p class="context" id="contextInfo">最近 12 条聊天、最多 10 条事实记忆及核心摘要；世界书与主聊天预设暂未带入。</p>
        <label class="row">沉默后接话<select id="silence"><option value="0">关闭</option><option value="30">30 秒</option><option value="45" selected>45 秒</option><option value="60">60 秒</option></select></label>
      </div></details>
      <div class="messages" id="messages" role="log" aria-label="本页聊天记录"></div>
      <footer><p class="status" id="status" role="status" aria-live="polite">正在准备…</p>
        <div class="compose"><textarea id="draft" maxlength="4000" placeholder="可以打字，也可以点下面说话" aria-label="消息内容" rows="2"></textarea><button id="send" class="send">发送</button></div>
        <div class="controls"><button id="start" class="stop">开始通话</button><button id="end" class="stop" disabled>结束并保存</button><button id="mic" class="mic">点一下说话</button><button id="stop" class="stop" disabled>停止</button></div>
        <p class="notice">结束后保存文字到当前聊天；后台暂停。主动接话每次最多一句，沿用聊天及语音 API 计费。</p>
      </footer></section>`;
    layer.append(shell);
    const el = id => root.getElementById(id);
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const s = { active:false, ending:false, idle:null, proactiveUsed:false, sessionId:'', cid:'', disposed:false, ready:false, busy:false, operation:0, recognizer:null, recTimer:null, controller:null, audio:null, audioId:null, audioGeneration:0, ttsPending:new Map(), characters:[], character:null, persona:null, baseContext:'', records:[], urls:new Map(), historyKey:'', settings:{}, writeQueue:Promise.resolve() };
    function status(message, error=false) { if (s.disposed) return; el('status').textContent=message; el('status').classList.toggle('error', error); }
    function controls() {
      const locked=!s.ready||s.busy||s.ending, listening=!!s.recognizer;
      el('start').disabled=locked||s.active;el('end').disabled=!s.active||s.ending;el('character').disabled=locked||s.active; el('send').disabled=locked||!s.active||listening||!el('draft').value.trim();
      el('mic').disabled=locked||!s.active||!Recognition;
      el('mic').textContent=listening?'结束说话':'点一下说话'; el('mic').classList.toggle('on',listening);
      el('stop').disabled=!s.busy&&!listening&&!s.audio;
      ['character','language','reply','voice','context','autosend','autoplay'].forEach(id=>{el(id).disabled=locked||listening;});
      el('character').disabled=locked||s.active; root.querySelectorAll('.play').forEach(b=>{b.disabled=locked||listening;});
    }
    function render() {
      const list=el('messages'); list.replaceChildren();
      if (!s.records.length) {
        const empty=document.createElement('div'); empty.className='empty';
        empty.innerHTML='<span class="mark">◖◗</span><b>换一种聊天方式</b><p>点麦克风说一句，识别后可以修改。<br>也能像平时一样打字。</p>';
        list.append(empty);
      }
      for (const m of s.records) {
        const node=document.createElement('article'); node.className='msg '+m.role+' '+(m.state||'');
        const who=document.createElement('p'); who.className='who'; who.textContent=(m.role==='user'?'我':s.character?.displayName||s.character?.name||'对方')+(m.state==='pending'?' · 等待回复':m.state==='failed'?' · 未收到回复':'');
        const bubble=document.createElement('div'); bubble.className='bubble'; bubble.textContent=m.content;
        node.append(who,bubble);
        if (m.role==='assistant') {
          const play=document.createElement('button'); play.className='play';
          play.textContent=s.urls.has(m.id)?'播放回复':'朗读';
          play.addEventListener('click',()=>speak(m)); node.append(play);
        }
        list.append(node);
      }
      list.scrollTop=list.scrollHeight; controls();
    }
    function persist() {
      if (!s.historyKey || s.disposed) return;
      const key=s.historyKey, records=s.records.map(m=>({...m}));
      s.writeQueue=s.writeQueue.catch(()=>{}).then(()=>api.storage.set(key,{records,sessionId:s.sessionId,cid:s.cid})).catch(()=>{status('本页记录保存失败；可点右上角导出。',true);});
    }
    function saveSettings() {
      const settings={characterId:s.character?.id, language:el('language').value,reply:el('reply').value,autosend:el('autosend').checked,autoplay:el('autoplay').checked,context:el('context').checked,voices:{...s.settings.voices,[s.character?.id]:el('voice').value.trim()}};
      s.settings=settings;
      s.writeQueue=s.writeQueue.catch(()=>{}).then(()=>api.storage.set('settings',settings)).catch(()=>{status('设置未保存，下次打开可能恢复默认。',true);});
    }
    function revokeAudio() { s.audioGeneration++;s.ttsPending.clear();for(const url of s.urls.values()) if(url.startsWith('blob:')) URL.revokeObjectURL(url); s.urls.clear(); }
    function stopAudio() { if(s.audio){s.audio.onended=null;s.audio.onerror=null;s.audio.pause();s.audio.removeAttribute('src');s.audio.load();s.audio=null;s.audioId=null;} }
    function abortRecognition() {
      clearTimeout(s.recTimer);s.recTimer=null;
      const r=s.recognizer;s.recognizer=null;
      if(r){r.onresult=r.onend=r.onerror=null;try{r.abort();}catch{}}
    }
    function stopAll(message='已停止。不会自动重发。') {
      clearTimeout(s.idle); const wasBusy=s.busy;
      s.operation++; s.controller?.abort();s.controller=null; abortRecognition();stopAudio();
      s.busy=false;
      for(const m of s.records) if(m.state==='pending')m.state='failed';
      persist();render();
      status(wasBusy?message+' 已提交的请求可能仍在服务端完成并计费。':message);
    }
    function beginRecognition() {
      if(s.disposed||s.busy||!s.active||!s.ready||!Recognition)return;clearTimeout(s.idle);
      if(s.recognizer){try{s.recognizer.stop();status('正在整理识别结果…');}catch{abortRecognition();controls();}return;}
      stopAudio();
      const r=new Recognition(), original=el('draft').value.trim();
      let finalText='', interim='', failed=false, sawFinal=false;
      r.lang=el('language').value;r.continuous=false;r.interimResults=true;r.maxAlternatives=1;
      s.recognizer=r;
      const combine=v=>[original,v.trim()].filter(Boolean).join(' ').slice(0,4000);
      r.onresult=e=>{
        if(s.disposed||s.recognizer!==r)return;
        const finals=[], pending=[];
        for(let i=0;i<e.results.length;i++) (e.results[i].isFinal?finals:pending).push(e.results[i][0]?.transcript||'');
        finalText=finals.join(' ');interim=pending.join(' ');sawFinal=!!finalText.trim();
        el('draft').value=combine([finalText,interim].filter(Boolean).join(' '));controls();
      };
      r.onerror=e=>{
        if(s.recognizer!==r||s.disposed)return;
        failed=true;
        const messages={'not-allowed':'没有获得语音权限。请允许 Safari 使用麦克风与语音识别，或先使用键盘听写。','service-not-allowed':'系统未允许语音识别。可检查 Siri / 听写设置，或直接使用键盘听写。','audio-capture':'暂时无法使用麦克风，请检查权限或其他应用是否占用。','network':'语音识别连接失败。可以检查网络，或使用键盘听写。','no-speech':'没有识别到说话，点麦克风可以再试一次。','aborted':'语音识别已停止。'};
        abortRecognition();controls();
        status(messages[e.error]||'语音识别未完成，可以修改输入框里的文字后发送。',true);
      };
      r.onend=()=>{
        if(s.recognizer!==r||s.disposed)return;
        s.recognizer=null;clearTimeout(s.recTimer);s.recTimer=null;
        // Keep interim text for editing, but never automatically submit a provisional recognition result.
        el('draft').value=combine(finalText||interim);controls();
        if(failed)return;
        if(sawFinal && el('autosend').checked && !document.hidden){send();}
        else status(sawFinal?'已识别，可以修改后发送。':interim?'识别尚未确认，请检查文字后点发送。':'没有识别到内容，请再试一次。');
      };
      try {r.start();status('正在听…说完会结束，也可以再点一次结束。');controls();s.recTimer=setTimeout(()=>{if(s.recognizer===r){try{r.stop();}catch{abortRecognition();controls();}}},60000);}
      catch{abortRecognition();controls();status('浏览器没有启动语音识别。请用 Safari 打开，或使用键盘上的听写麦克风。',true);}
    }
    async function loadContext(character, token) {
      const cid=String(character.conversationId||character.id||'');
      let conversation=null, persona=null, history=[], memories=null, warning=false;
      const results=await Promise.allSettled([
        api.conversation.get(cid),api.persona.getUserPersonas(),api.persona.getActiveUserPersona(),
        el('context').checked?api.memory.getShortTerm({conversationId:cid,limit:12}):Promise.resolve([]),
        el('context').checked?api.memory.getLongTerm({conversationId:cid,limit:10}):Promise.resolve(null)
      ]);
      if(s.disposed||s.operation!==token)return;
      const val=(i,f)=>results[i].status==='fulfilled'?results[i].value:f;
      conversation=val(0,null);const personas=val(1,[]);persona=personas.find(p=>p.id===conversation?.myActivePersonaId)||val(2,null);
      history=val(3,[]);memories=val(4,null);warning=results.some(r=>r.status==='rejected');
      s.persona=persona;
      const parts=['Character profile:\n'+cut(profileText(character),10000),'User profile:\n'+cut(profileText(persona),3000)];
      // Only plain text from this character's conversation is sent; no images or global database reads.
      const lines=(Array.isArray(history)?history:[]).sort((a,b)=>Number(a.timestamp||0)-Number(b.timestamp||0)).map(m=>{
        const text=asText(m.text||m.content);if(!text||text.includes('data:')||/^(image|sticker|video|file)$/i.test(m.type||''))return '';
        const name=m.senderName||(String(m.senderId)===String(character.id)?character.name:'User');return cut(name,80)+': '+cut(text,900);
      }).filter(Boolean);
      const facts=(Array.isArray(memories?.facts)?memories.facts:[]).slice(0,10).map(m=>cut(m.summaryText||m.action||m.text||m.content||'',400)).filter(Boolean);
      if(lines.length) parts.push('Recent main-chat context (background only):\n'+cut(lines.join('\n'),5000));
      if(memories?.core){const c=memories.core;parts.push('Core memory:\n'+cut(typeof c==='string'?c:JSON.stringify(c),1500));}
      if(facts.length)parts.push('Fact memories:\n'+cut(facts.join('\n'),2500));
      s.baseContext=parts.join('\n\n');
      el('contextInfo').textContent='当前带入角色 / 身份、'+lines.length+' 条主聊天、'+facts.length+' 条事实记忆。背景约 '+s.baseContext.length.toLocaleString()+' 字符（不是 token）。世界书与主聊天预设暂未带入。'+(warning?' 部分资料读取失败。':'');
      return warning;
    }
    async function chooseCharacter(id) {
      abortRecognition();stopAudio();revokeAudio();
      const token=++s.operation;s.ready=false;s.busy=false;s.baseContext='';s.records=[];el('draft').value='';controls();
      s.character=s.characters.find(c=>String(c.id)===String(id))||s.characters[0];
      if(!s.character){status('还没有可选角色，请先在 Roche 添加角色。',true);render();return;}
      el('character').value=s.character.id;
      el('voice').value=s.settings.voices?.[s.character.id]||s.character.voiceId||s.character.ttsVoiceId||'';
      el('summary').textContent=(s.character.displayName||s.character.name||'角色')+' · 聊天设置';
      s.historyKey='history:'+s.character.id;
      status('正在载入角色与本页会话…');render();
      const [saved,context]=await Promise.allSettled([api.storage.get(s.historyKey),loadContext(s.character,token)]);
      if(s.disposed||token!==s.operation)return;
      const recovery=saved.status==='fulfilled'?saved.value:null; const records=Array.isArray(recovery?.records)?recovery.records:[]; s.sessionId=recovery?.sessionId||uid();s.cid=String(s.character.conversationId||s.character.id); if(recovery?.cid&&recovery.cid!==s.cid)throw Error('conversation mismatch');
      s.records=records.filter(m=>['user','assistant'].includes(m?.role)&&typeof m.content==='string').map(m=>({...m,id:m.id||uid(),content:cut(m.content,8000),state:m.state==='pending'?'failed':m.state}));
      s.ready=true;render();saveSettings();
      status(context.status==='rejected'?'角色背景读取失败；请重新选择角色后再试。':Recognition?'准备好了。默认识别后先确认，再发送。':'此浏览器未提供语音识别，可用键盘听写输入，仍可朗读回复。',context.status==='rejected');
      if(context.status==='rejected'){s.ready=false;controls();el('character').disabled=false;}
    }
    async function send(proactive=false) {
      proactive=proactive===true; const content=proactive?'The user has been quiet. Say one short natural check-in as the character. Do not invent a user reply.':el('draft').value.trim();
      if(!s.active||s.ending||!content||s.busy||s.recognizer||!s.ready||s.disposed)return;
      // Acquire the lock synchronously, before any await or host API call.
      clearTimeout(s.idle); if(!proactive)s.proactiveUsed=false; s.busy=true;stopAudio();const token=++s.operation;
      const turn={id:uid(),role:'user',content,state:'pending'};
      const prior=s.records.filter(m=>!m.state).slice(-16);
      if(!proactive)s.records.push(turn);el('draft').value='';persist();render();status('正在等回复…');
      const language=el('reply').value;
      const prompt='Continue a casual conversation as the selected character. Reply naturally, usually in 1–3 short sentences suitable for speaking aloud. Output plain spoken text, without message protocol tags, speaker prefixes, stage directions or unsolicited translations. '+(language==='Auto'?'Use the language of the latest user message.':'Reply in '+language+'.')+'\n\n'+s.baseContext;
      let budget=6000;const recent=[];
      for(let i=prior.length-1;i>=0&&budget>0;i--){const text=cut(prior[i].content,Math.min(1500,budget));budget-=text.length;recent.unshift({role:prior[i].role,content:text});}
      s.controller=new AbortController();
      try{
        const response=await api.ai.chat({messages:[{role:'system',content:prompt},...recent,{role:'user',content}],stream:false,signal:s.controller.signal});
        if(s.disposed||s.operation!==token)return;
        const answer=asText(response?.text||response?.choices?.[0]?.message?.content||response?.content).trim();
        if(!answer)throw new Error('empty-reply');
        turn.state='';const reply={id:uid(),role:'assistant',content:cut(answer,8000)};s.records.push(reply);persist();
        s.busy=false;s.controller=null;render();status('已收到回复。');
        if(el('autoplay').checked)await speak(reply); if(!s.audio)armIdle();
      }catch(error){
        if(s.disposed||s.operation!==token)return;
        turn.state='failed';s.busy=false;s.controller=null;
        if(!proactive&&!el('draft').value)el('draft').value=content;
        persist();render();status('这次没有收到回复，文字已保留。请先检查 API 状态或账单，再决定是否重新发送；插件没有自动重试。',true);
      }
    }
    async function playURL(url, record, token) {
      stopAudio();const audio=new Audio(url);s.audio=audio;s.audioId=record.id;
      audio.onended=()=>{if(s.audio!==audio||s.disposed)return;stopAudio();status('播放结束，可以继续说话或打字。');controls();armIdle();};
      audio.onerror=()=>{if(s.audio!==audio||s.disposed)return;stopAudio();status('音频播放失败。已有文字回复；不会重新生成回复。',true);controls();};
      try{await audio.play();if(s.disposed||s.operation!==token)return;status('正在朗读…可点“停止”打断。');controls();}
      catch{if(s.disposed||s.operation!==token)return;stopAudio();status('浏览器暂停了自动播放。请点回复下方“播放回复”，无需再次生成语音。');controls();}
    }
    async function speak(record) {
      if(s.disposed||s.ending||s.busy||s.recognizer||!s.ready)return;
      const voiceId=el('voice').value.trim();
      if(!voiceId){status('这个角色没有声音 ID。展开聊天设置填写 ElevenLabs 声音 ID，即可朗读；API 密钥仍使用 Roche 设置。',true);return;}
      const token=++s.operation;stopAudio();
      if(s.urls.has(record.id)){await playURL(s.urls.get(record.id),record,token);return;}
      if(record.content.length>1600){status('这条回复较长，已保留文字；试用版只朗读 1600 字符以内的回复。',true);return;}
      s.busy=true;controls();status('正在生成语音…');
      try{
        // The host TTS API has no abort hook. Keep its result from playing after stop/unmount.
        if(!s.ttsPending.has(record.id)) {
          const generation=s.audioGeneration;
          const pending=Promise.resolve().then(()=>api.voice.tts({id:record.id,text:record.content,voiceId,senderName:s.character.name||'Character',language:el('reply').value==='Auto'?( /[\u3400-\u9fff]/.test(record.content)?'Chinese':'English'):el('reply').value,persist:false})).then(url=>{
            if(typeof url!=='string'||!url)throw new Error('missing-audio');
            if(s.disposed||s.audioGeneration!==generation){if(url.startsWith('blob:'))URL.revokeObjectURL(url);return null;}
            s.urls.set(record.id,url);
            if(s.urls.size>20){const first=s.urls.keys().next().value;const old=s.urls.get(first);if(old.startsWith('blob:'))URL.revokeObjectURL(old);s.urls.delete(first);}
            return url;
          }).finally(()=>{if(s.ttsPending.get(record.id)===pending)s.ttsPending.delete(record.id);});
          s.ttsPending.set(record.id,pending);
        }
        const url=await s.ttsPending.get(record.id);
        if(s.disposed||s.operation!==token)return;
        if(typeof url!=='string'||!url)throw new Error('missing-audio');
        s.urls.set(record.id,url);s.busy=false;render();await playURL(url,record,token);
      }catch{
        if(s.disposed||s.operation!==token)return;
        s.busy=false;render();status('文字回复已保存，但语音没有生成成功。请检查 Roche 的 ElevenLabs 开关、声音 ID 与额度。插件没有自动重试。',true);
      }
    }

    function armIdle(){
      clearTimeout(s.idle);const seconds=Number(el('silence').value);
      if(!seconds||!s.active||s.ending||s.proactiveUsed||s.busy||s.audio||s.recognizer||document.hidden||el('draft').value.trim())return;
      s.idle=setTimeout(()=>{if(!s.active||s.ending||s.busy||s.audio||s.recognizer||document.hidden||el('draft').value.trim())return;s.proactiveUsed=true;send(true);},seconds*1000);
    }
    async function finish(){
      if(s.ending||!s.active)return;s.ending=true;stopAll('通话已结束。');controls();
      try{
        const messages=s.records.filter(m=>!m.state);
        if(messages.length){
          const transcript=messages.map(m=>(m.role==='user'?'用户':s.character.name||'角色')+'：'+m.content).join('\n');
          await s.writeQueue;
          const result=await api.chat.createCard({id:s.sessionId,conversationId:s.cid,messageType:'call-record',isMe:true,senderId:'',timestamp:Date.now(),cardData:{title:'通话记录',transcript},modelText:'以下是用户与当前角色已发生的通话记录：\n'+transcript});
          if(!result?.id)throw Error('未确认聊天记录保存结果');
        }
        await api.storage.set(s.historyKey,null);s.records=[];s.sessionId=uid();s.active=false;revokeAudio();render();status('已保存到当前聊天，后续可参与 Roche 的记忆总结。');
      }catch(e){status('保存未完成，通话草稿仍保留。请再次点结束并保存：'+e.message,true);}
      finally{s.ending=false;controls();}
    }
    el('start').addEventListener('click',()=>{if(!s.ready||s.active)return;s.active=true;s.proactiveUsed=false;persist();controls();status('通话中，输入或说话后点发送。');armIdle();});
    el('end').addEventListener('click',finish);el('silence').addEventListener('change',armIdle);

    el('draft').addEventListener('input',()=>{clearTimeout(s.idle);if(s.recognizer){abortRecognition();status('已改为手动编辑。');}controls();});
    el('draft').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.isComposing){e.preventDefault();send();}});
    el('send').addEventListener('click',send);el('mic').addEventListener('click',beginRecognition);
    el('stop').addEventListener('click',()=>stopAll());
    el('character').addEventListener('change',()=>chooseCharacter(el('character').value));
    for(const id of ['language','reply','autosend','autoplay','voice'])el(id).addEventListener('change',()=>{saveSettings();if(id==='voice'||id==='reply'){stopAudio();revokeAudio();render();}if(id==='autosend')status(el(id).checked?'已开启：识别得到完整结果后将直接发送。':'已关闭：识别后先确认文字，再发送。');});
    el('context').addEventListener('change',async()=>{s.ready=false;controls();const token=++s.operation;status('正在更新带入的背景…');try{await loadContext(s.character,token);if(s.disposed||token!==s.operation)return;s.ready=true;saveSettings();status('背景已更新。');}catch{status('背景读取失败，请重新选择角色。',true);}controls();el('character').disabled=false;});
    el('export').addEventListener('click',()=>{const blob=new Blob([JSON.stringify({version:1,character:s.character?.displayName||s.character?.name,exportedAt:new Date().toISOString(),messages:s.records},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='Roche-语音聊天-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);});
    const onHide=()=>{clearTimeout(s.idle);if(document.hidden&&(s.busy||s.recognizer||s.audio))stopAll('已切到后台，语音已暂停。');};
    const onPageHide=()=>{if(s.busy||s.recognizer||s.audio)stopAll('页面已离开。');};
    document.addEventListener('visibilitychange',onHide);window.addEventListener('pagehide',onPageHide);
    function cleanup(){if(s.disposed)return;clearTimeout(s.idle);s.disposed=true;s.operation++;s.controller?.abort();abortRecognition();stopAudio();revokeAudio();document.removeEventListener('visibilitychange',onHide);window.removeEventListener('pagehide',onPageHide);layer.remove();instances.delete(container);}
    instances.set(container,cleanup);el('close').addEventListener('click',async()=>{if(s.active){await finish();return;}cleanup();api.ui.closeApp();});layer.addEventListener('cancel',e=>{e.preventDefault();el('close').click();});
    render();
    (async()=>{
      try{
        const [characters,settings]=await Promise.all([api.character.list(),api.storage.get('settings')]);
        if(s.disposed)return;
        s.characters=Array.isArray(characters)?characters:[];s.settings=settings||{};
        for(const c of s.characters){const option=document.createElement('option');option.value=c.id;option.textContent=c.displayName||c.name||c.id;el('character').append(option);}
        for(const id of ['language','reply'])if(s.settings[id])el(id).value=s.settings[id];
        for(const id of ['autosend','autoplay','context'])if(typeof s.settings[id]==='boolean')el(id).checked=s.settings[id];
        await chooseCharacter(s.characters.find(c=>String(c.conversationId||c.id)===conversationId)?.id||s.settings.characterId);
      }catch{status('插件接口未准备好，或当前 Roche 版本不兼容。请关闭后重新打开；没有发送聊天请求。',true);}
    })();
  }
  function card(el,data){const d=data?.cardData||data?.data||data||{};el.replaceChildren();const box=document.createElement('details');box.style.cssText='padding:14px;border-radius:18px;background:#f0f0f3;color:#222;max-width:100%';const title=document.createElement('summary');title.textContent='通话记录';const text=document.createElement('p');text.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';text.textContent=d.transcript||'';box.append(title,text);el.append(box);}
  window.RochePlugin.register({id:'roche-call',name:'通话',version:'0.1.0',chat:{scope:{conversationTypes:['direct']},plusActions:[{id:'call',label:'通话',iconSvg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 3h4l2 5-3 2c2 3 3 4 6 6l2-3 5 2v4c-8 5-22-9-16-16Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',open:async(ctx,api)=>{conversationId=String(ctx.conversationId||'');await api.ui.openApp('voice-chat');}}],messageTypes:[{id:'call-record',mount:card,update:card,unmount:el=>el.replaceChildren()}]},apps:[{id:'voice-chat',name:'通话',icon:'call',mount,unmount(container){instances.get(container)?.();}}]});
})();
