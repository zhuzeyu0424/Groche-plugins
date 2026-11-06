/* Roche 记录清理 0.1.1. User-confirmed scoped deletion; memories stay intact. */
(() => {
'use strict';
  const PROTECTED_TYPES = new Set(['system_memory','system','system_notice','hidden','system_memory_summary']);
  const cleanId = value => typeof value==='string'||typeof value==='number'?String(value).trim():'';
  const rowBytes = rows => rows.reduce((n,row)=>n+new TextEncoder().encode(JSON.stringify(row)).length,0);
  const protectedMessage = row => !row || !cleanId(row.id) || PROTECTED_TYPES.has(String(row.type||'').toLowerCase()) || row.isSystem===true || row.isFavorited===true || row.isFavorite===true || row.isPinned===true || row.pinned===true || row.isBookmarked===true;
  const ordered = rows => [...rows].sort((a,b)=>(Number(a.timestamp)||0)-(Number(b.timestamp)||0)||cleanId(a.id).localeCompare(cleanId(b.id)));
  function uniqueRows(rows){
    const map=new Map();for(const row of rows){const id=cleanId(row?.id);if(id&&!map.has(id))map.set(id,row);}return [...map.values()];
  }
  function dayRange(from,to){
    const parse=value=>{
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))throw Error('请选择完整日期');
      const date=new Date(value+'T00:00:00');
      if(!Number.isFinite(date.getTime())||date.getFullYear()!==Number(value.slice(0,4))||date.getMonth()+1!==Number(value.slice(5,7))||date.getDate()!==Number(value.slice(8,10)))throw Error('日期无效');
      return date;
    };
    const start=parse(from),end=parse(to);if(end<start)throw Error('结束日期不能早于开始日期');end.setDate(end.getDate()+1);
    return {from:start.getTime(),until:end.getTime()};
  }
  function planOnline(rows, policy){
    const cid=cleanId(policy.conversationId);if(!cid)throw Error('无法确认当前聊天');
    const all=ordered(uniqueRows(rows.filter(r=>cleanId(r?.conversationId)===cid)));
    const requestedKeep=Number(policy.keepRecent??500),requestedFloor=Number(policy.contextFloor??0);
    if(!Number.isInteger(requestedKeep)||requestedKeep<0||!Number.isInteger(requestedFloor)||requestedFloor<0)throw Error('保留条数无效');
    const floor=requestedFloor,keep=Math.max(floor,requestedKeep);
    const recent=new Set(all.slice(Math.max(0,all.length-keep)).map(r=>cleanId(r.id)));
    let candidates=all.filter(r=>!recent.has(cleanId(r.id))&&!protectedMessage(r)&&Number.isFinite(Number(r.timestamp))&&Number(r.timestamp)>0);
    const boundary=Number(policy.boundary)||0;
    if(policy.summaryOnly!==false)candidates=candidates.filter(r=>boundary>0&&Number(r.timestamp)<=boundary);
    if(policy.kind==='dates'){
      const range=dayRange(policy.fromDate,policy.toDate);
      candidates=candidates.filter(r=>Number(r.timestamp)>=range.from&&Number(r.timestamp)<range.until);
    }else if(policy.kind==='count'){
      const n=Number(policy.count);if(!Number.isInteger(n)||n<1||n>100000)throw Error('请填写 1 至 100000 的整数条数');candidates=candidates.slice(0,n);
    }else throw Error('请选择日期或条数');
    return {mode:'online',conversationId:cid,rows:candidates,ids:candidates.map(r=>cleanId(r.id)),count:candidates.length,bytes:rowBytes(candidates),keepRecent:keep,protectedCount:all.filter(protectedMessage).length,summaryOnly:policy.summaryOnly!==false,boundary,reason:policy.summaryOnly!==false&&!boundary?'未找到本聊天的总结进度；可先完成总结，或在备份后取消“仅已总结”。':''};
  }
  function archiveSummaryIds(parentId, summaryMessages=[], facts=[]){
    const ids=new Set();
    for(const m of summaryMessages){
      if(cleanId(m?.conversationId)!==parentId||m.type!=='system_memory'||!String(m.text||m.content||'').trim())continue;
      const id=cleanId(m.offlineSessionId)||(cleanId(m.id).startsWith('sys_mem_offline_archive_')?cleanId(m.id).slice('sys_mem_offline_archive_'.length):'');if(id)ids.add(id);
    }
    for(const f of facts){
      if(cleanId(f?.conversationId)!==parentId||f.source!=='offline_archive_summary'||!String(f.summaryText||f.action||'').trim())continue;
      const id=cleanId(f.sourceSessionId||f.offlineSessionId||f.sessionId);if(id)ids.add(id);
    }
    return ids;
  }
  function planOffline(rows, policy){
    const cid=cleanId(policy.conversationId);if(!cid)throw Error('无法确认当前聊天');
    const requested=new Set((policy.sessionIds||[]).map(cleanId));
    const sessions=(policy.sessions||[]).filter(s=>cleanId(s.parentChatId)===cid&&cleanId(s.id)!==cid&&requested.has(cleanId(s.id)));
    if(sessions.length!==requested.size)throw Error('归档范围已变化，请重新预览');
    const summarized=archiveSummaryIds(cid,policy.summaryMessages,policy.facts);
    const eligible=sessions.filter(s=>policy.summaryOnly===false||summarized.has(cleanId(s.id)));
    const ids=new Set(eligible.map(s=>cleanId(s.id)));
    const chosen=ordered(uniqueRows(rows.filter(r=>ids.has(cleanId(r?.conversationId))&&!protectedMessage(r))));
    const items=eligible.map(s=>{const selected=chosen.filter(r=>cleanId(r.conversationId)===cleanId(s.id));return {sessionId:cleanId(s.id),timestamp:s.timestamp,count:selected.length,bytes:rowBytes(selected),hasSummary:summarized.has(cleanId(s.id))};});
    return {mode:'offline',conversationId:cid,rows:chosen,ids:chosen.map(r=>cleanId(r.id)),items,count:chosen.length,bytes:rowBytes(chosen),summaryOnly:policy.summaryOnly!==false,skippedArchives:sessions.length-eligible.length,unsummarizedArchives:items.filter(s=>!s.hasSummary).length};
  }
  async function fingerprintRows(rows){
    const text=JSON.stringify([...rows].map(r=>[cleanId(r.id||r.conversationId),r]).sort((a,b)=>a[0].localeCompare(b[0])));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  }


// Audited Roche host adapter. All direct IndexedDB transactions below are readonly.
// The only mutation is the native, signature-checked deleteMessages operation.
async function createHistoryHost() {
  const idOf = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const unsupported = () => Error('当前 Roche 版本尚未适配批量清理；没有删除任何记录。请先更新插件。');
  const auditHash = 'abc860376c4ed859476f397d1432894e7479f7c0c85ce43ffd3d8c6b5c7bda54';
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const urls = new Set();
  const consider = value => {
    try {
      const url = new URL(value, location.href);
      if (url.origin === location.origin && /\/ai-core-[A-Za-z0-9_-]+\.js$/.test(url.pathname)) urls.add(url.href);
    } catch (_) {}
  };
  for (const entry of performance.getEntriesByType('resource')) consider(entry.name);
  for (const node of document.querySelectorAll('script[src],link[rel="modulepreload"][href]')) consider(node.src || node.href);
  if (!urls.size) throw unsupported();
  const candidates = [];
  for (const url of urls) {
    let module;
    try { module = await import(url); } catch (_) { continue; }
    for (const value of Object.values(module)) {
      try {
        if (!value || typeof value !== 'object' || typeof value.deleteMessages !== 'function' || typeof value.loadMessages !== 'function' || typeof value.getConversation !== 'function' || !value.store?.messages) continue;
        if (candidates.some(candidate => candidate.native === value)) continue;
        candidates.push({native:value, url});
      } catch (_) {}
    }
  }
  if (candidates.length !== 1) throw unsupported();
  const {native, url:hostUrl} = candidates[0], deleteMessages = native.deleteMessages;
  if (await hash(Function.prototype.toString.call(deleteMessages)) !== auditHash) throw unsupported();

  const stores = ['messages', 'conversations', 'offline_sessions', 'fact_memories', 'vector_memories', 'core_memories'];
  async function withDatabase(callback) {
    const db = await new Promise((resolve, reject) => {
      // Omitting a version prevents schema upgrades; abort if the database does not yet exist.
      const request = indexedDB.open('Roche_db');
      let absent = false;
      request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
      request.onerror = () => reject(absent ? Error('尚未找到 Roche 聊天数据库') : request.error || Error('读取数据库失败'));
      request.onblocked = () => reject(Error('数据库正在升级，请刷新 Roche 后重试'));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      if (stores.some(name => !db.objectStoreNames.contains(name))) throw unsupported();
      return await callback(db);
    } finally { db.close(); }
  }
  function scopedRows(store, field, id, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const rows = [];
      let source = store, query;
      if (store.indexNames.contains(field)) { source = store.index(field); query = IDBKeyRange.only(id); }
      else if (store.keyPath === field) query = IDBKeyRange.only(id);
      const request = source.openCursor(query);
      request.onerror = () => reject(request.error || Error('读取记录失败'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(rows);
        const row = cursor.value;
        if (idOf(row?.[field]) === id && predicate(row)) rows.push(row);
        cursor.continue();
      };
    });
  }
  function readonly(db, names, callback) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, 'readonly');
      let result, queryError;
      tx.oncomplete = () => queryError ? reject(queryError) : resolve(result);
      tx.onerror = () => reject(tx.error || queryError || Error('读取数据库失败'));
      tx.onabort = () => reject(tx.error || queryError || Error('读取数据库中断'));
      Promise.resolve().then(() => callback(tx)).then(value => { result = value; }, error => {
        queryError = error; try { tx.abort(); } catch (_) { reject(error); }
      });
    });
  }
  const requireId = value => { const id = idOf(value); if (!id) throw Error('无法确认当前聊天'); return id; };
  async function readMessages(conversationId) {
    const id = requireId(conversationId);
    return withDatabase(db => readonly(db, ['messages'], tx => scopedRows(tx.objectStore('messages'), 'conversationId', id)));
  }
  async function listArchives(parentId) {
    const id = requireId(parentId);
    const rows = await withDatabase(db => readonly(db, ['offline_sessions'], tx => scopedRows(tx.objectStore('offline_sessions'), 'parentChatId', id)));
    return rows.filter(row => idOf(row.id) && idOf(row.id) !== id).sort((a,b) => Number(b.timestamp||0) - Number(a.timestamp||0));
  }
  async function getConversation(conversationId) {
    const id = requireId(conversationId);
    const rows = await withDatabase(db => readonly(db, ['conversations'], tx => scopedRows(tx.objectStore('conversations'), 'id', id)));
    return rows[0] || null;
  }
  async function readMemorySnapshot(conversationId) {
    const id = requireId(conversationId);
    const snapshot = await withDatabase(db => readonly(db, ['messages', 'fact_memories', 'vector_memories', 'core_memories'], async tx => {
      // Start all cursor requests while the same readonly transaction is active.
      const [systemMessages, facts, vectors, core] = await Promise.all([
        scopedRows(tx.objectStore('messages'), 'conversationId', id, row => row.type === 'system_memory'),
        scopedRows(tx.objectStore('fact_memories'), 'conversationId', id),
        scopedRows(tx.objectStore('vector_memories'), 'conversationId', id),
        scopedRows(tx.objectStore('core_memories'), 'conversationId', id)
      ]);
      return {systemMessages, facts, vectors, core};
    }));
    // Embeddings can be large. Retain an exact-record digest rather than a second dense copy.
    const vectorDigests = [];
    for (const row of snapshot.vectors) vectorDigests.push({id:row.id, conversationId:row.conversationId, recordSha256:await hash(JSON.stringify(row))});
    snapshot.vectors = vectorDigests;
    return snapshot;
  }
  async function isBusy(conversationId) {
    const id = requireId(conversationId), state = native.store;
    // Reject cleanup while any reply is still being written. An offline reply uses a session ID.
    if (Object.values(state.aiRequestState?.typingStatus || {}).some(Boolean)) return true;
    if (state.videoCallState?.isActive) return true;
    if (state.paginationState?.[id]?.isLoading) return true;
    const rows = state.messages?.[id] || [];
    return rows.some(row => row?.isStreaming === true || row?.isGenerating === true || row?.text === 'PENDING' || row?.content === 'PENDING');
  }
  async function deleteMessageBatch(conversationId, ids) {
    const id = requireId(conversationId);
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw Error('清理批次无效');
    const wanted = ids.map(idOf);
    if (wanted.some(value => !value) || new Set(wanted).size !== wanted.length) throw Error('清理记录无效');
    if (await isBusy(id)) throw Error('Roche 正在生成或加载，请稍后重新预览');
    if (native.deleteMessages !== deleteMessages || await hash(Function.prototype.toString.call(deleteMessages)) !== auditHash) throw unsupported();
    const wantedSet = new Set(wanted), found = await withDatabase(db => readonly(db, ['messages'], tx => {
      const store = tx.objectStore('messages');
      return Promise.all(wanted.map(messageId => new Promise((resolve, reject) => {
        const request = store.get(messageId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || Error('读取待清理记录失败'));
      })));
    }));
    if (found.some(row => !row || idOf(row.conversationId) !== id || !wantedSet.has(idOf(row.id)) || protectedMessage(row))) throw Error('记录或保护状态已变化，请重新预览');
    // Native deletion intentionally updates the reactive message cache as well as IndexedDB.
    // It only runs for initialized caches. Native loading is read-only with respect to messages.
    if (!Array.isArray(native.store.messages[id])) await native.loadMessages(id, {force:true});
    if (!Array.isArray(native.store.messages[id])) throw Error('当前记录缓存未能加载；没有提交清理');
    if (await isBusy(id)) throw Error('Roche 正在生成或加载，请稍后重新预览');
    await deleteMessages.call(native, id, found.map(row => row.id));
  }
  return {
    readMessages, listArchives, getConversation, readMemorySnapshot, isBusy, deleteMessageBatch,
    readSummaryBoundary(conversationId) {
      const id = requireId(conversationId), value = Number(localStorage.getItem('noir_memory_boundary_' + id));
      return Number.isFinite(value) && value > 0 ? value : 0;
    },
    hostSource:hostUrl
  };
}


// Own DOM nodes only. Conversation identity always comes from the owning Vue component.
function attachHistoryEntries(onOpen) {
  const marker = 'data-roche-history-cleaner-entry';
  const entries = new Map();
  let disposed = false, scheduled = 0;
  const componentName = component => String(component?.type?.__name || component?.type?.name || '');
  const cidOf = component => {
    const value = component?.props?.chatId;
    return typeof value === 'string' ? value.trim() : '';
  };
  const visible = element => element?.isConnected && element.getClientRects().length > 0 && !element.closest('[hidden],[inert]');
  function owners(element) {
    // Production Vue omits __vueParentComponent on rendered DOM nodes. Its mounted
    // container still retains the live root vnode; walk only active rendered branches
    // and match the actual header/title vnode instead of guessing an active chat ID.
    const roots = new Set();
    for (let node = element; node && node !== document; node = node.parentElement) {
      if(node._vnode)roots.add(node._vnode);
      if(node.__vue_app__?._container?._vnode)roots.add(node.__vue_app__._container._vnode);
    }
    for(const container of document.querySelectorAll('#app,[data-v-app]')){
      if(container._vnode)roots.add(container._vnode);
      if(container.__vue_app__?._container?._vnode)roots.add(container.__vue_app__._container._vnode);
    }
    const visited=new Set(),matches=[];
    function visit(vnode,owner,depth){
      if(!vnode||typeof vnode!=='object'||visited.has(vnode)||visited.size>=50000)return;
      visited.add(vnode);
      const current=vnode.component||owner;
      if(current?.isUnmounted||current?.isDeactivated)return;
      if(vnode.el===element&&current)matches.push({owner:current,depth});
      if(vnode.component?.subTree)visit(vnode.component.subTree,current,depth+1);
      if(Array.isArray(vnode.children))for(const child of vnode.children)visit(child,current,depth+1);
      if(vnode.suspense?.activeBranch)visit(vnode.suspense.activeBranch,current,depth+1);
    }
    for(const root of roots)visit(root,null,0);
    let current=matches.sort((a,b)=>b.depth-a.depth)[0]?.owner;
    // Development builds and old supported hosts can expose the direct hook.
    if(!current)for(let node=element;node&&node!==document;node=node.parentElement){
      if(node.__vueParentComponent){current=node.__vueParentComponent;break;}
    }
    const components=[],seen=new Set();
    while(current&&!seen.has(current)){
      seen.add(current);components.push(current);current=current.parent;
    }
    return components;
  }
  function onlineContext(header) {
    if (!visible(header) || !header.classList.contains('chat-search-header-row')) return null;
    const chain = owners(header);
    const modal = chain.find(c => componentName(c) === 'ChatSearchModal');
    const chat = chain.find(c => componentName(c) === 'Chat');
    const id = cidOf(modal);
    if (!id || modal?.isUnmounted || chat?.isUnmounted) return null;
    // A reused search modal must not target a different mounted chat.
    if (chat && cidOf(chat) !== id) return null;
    return {mode:'online', conversationId:id};
  }
  function offlineContext(title) {
    if (!visible(title) || title.textContent.trim() !== '历史记录') return null;
    const header = title.parentElement, panel = header?.parentElement;
    if (!header?.classList.contains('border-b') || !header.querySelector('button') || !panel?.classList.contains('max-w-md')) return null;
    const owner = owners(title).find(c => componentName(c) === 'OfflineMode');
    const id = cidOf(owner);
    // OfflineMode itself can fall back to a global active ID; this plugin deliberately does not.
    if (!id || owner?.isUnmounted) return null;
    return {mode:'offline', conversationId:id};
  }
  function drop(anchor) {
    const entry=entries.get(anchor);if(!entry)return;
    entry.button.onclick=null;entry.row.remove();entries.delete(anchor);
  }
  function install(anchor, target, mode, resolve) {
    if (entries.has(anchor)) return;
    const row=document.createElement('div');row.setAttribute(marker, mode);
    row.style.cssText='display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:7px 16px 9px;flex-shrink:0;';
    const button=document.createElement('button');button.type='button';button.textContent='批量清理';
    button.setAttribute('aria-label',mode==='online'?'批量清理当前聊天记录':'批量清理线下归档正文');
    button.style.cssText='appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;min-height:34px;padding:6px 14px;border:1px solid #e5e5e9;border-radius:18px;background:#f7f7f8;color:#27272a;font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;';
    button.onclick=event=>{
      event.preventDefault();event.stopPropagation();
      const context=resolve(anchor);
      if(disposed || !context || !row.isConnected){drop(anchor);return;}
      // Re-resolve identity on every click. No cached title, name or last-active chat is used.
      onOpen({...context,hostContext:{isCurrent:()=>{
        const current=resolve(anchor);
        return !disposed&&row.isConnected&&current?.mode===context.mode&&current?.conversationId===context.conversationId;
      }}});
    };
    row.append(button);
    if(mode==='online') target.insertBefore(row,anchor.nextSibling);
    else target.parentElement.insertBefore(row,target.nextSibling);
    entries.set(anchor,{row,button,mode,resolve});
  }
  function scan() {
    scheduled=0;if(disposed)return;
    for(const[anchor,entry]of entries)if(!entry.row.isConnected||!entry.resolve(anchor))drop(anchor);
    for(const header of document.querySelectorAll('.chat-search-header-row')){
      if(header.closest('['+marker+']')||!onlineContext(header))continue;
      const target=header.parentElement;
      if(target)install(header,target,'online',onlineContext);
    }
    // Current native OfflineMode uses this title in its archive modal; other history pages are ignored.
    for(const title of document.querySelectorAll('span.font-serif.font-bold.text-lg')){
      if(title.closest('['+marker+']')||!offlineContext(title))continue;
      install(title,title.parentElement,'offline',offlineContext);
    }
  }
  function schedule(){if(!disposed&&!scheduled)scheduled=requestAnimationFrame(scan);}
  const observer=new MutationObserver(records=>{
    if(records.some(record=>!record.target.closest?.('['+marker+']')))schedule();
  });
  observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  window.addEventListener('pageshow',schedule);
  document.addEventListener('visibilitychange',schedule);
  scan();
  const dispose=()=>{
    if(disposed)return;disposed=true;observer.disconnect();if(scheduled)cancelAnimationFrame(scheduled);
    window.removeEventListener('pageshow',schedule);document.removeEventListener('visibilitychange',schedule);
    for(const anchor of [...entries.keys()])drop(anchor);
  };
  dispose.rescan=()=>{if(disposed)return;if(scheduled)cancelAnimationFrame(scheduled);scan();};
  dispose.status=()=>{
    const online=[...document.querySelectorAll('.chat-search-header-row')].filter(visible);
    const offline=[...document.querySelectorAll('span.font-serif.font-bold.text-lg')].filter(el=>visible(el)&&el.textContent.trim()==='历史记录');
    return {onlineCandidates:online.length,offlineCandidates:offline.length,entries:entries.size,scopeResolved:online.filter(onlineContext).length+offline.filter(offlineContext).length,productionRoots:[...document.querySelectorAll('#app,[data-v-app]')].filter(el=>el._vnode||el.__vue_app__?._container?._vnode).length,disposed};
  };
  return dispose;
}


class CleanupSession {
  constructor(host,context){
    this.host=host;this.context=context;this.cid=cleanId(context.conversationId);this.mode=context.mode;
    if(!this.cid||!['online','offline'].includes(this.mode))throw Error('请从当前聊天的历史记录进入');
    this.plan=null;this.running=false;this.stopRequested=false;this.revision=0;
  }
  assertCurrent(){if(this.context.hostContext?.isCurrent&&!this.context.hostContext.isCurrent())throw Error('聊天窗口已变化，请关闭后从当前历史记录重新进入');}
  async init(){
    this.assertCurrent();this.conversation=await this.host.getConversation(this.cid);
    if(!this.conversation)throw Error('当前聊天已不存在');
    this.contextFloor=this.floorFor(this.conversation);
    const memory=this.mode==='offline'?await this.host.readMemorySnapshot(this.cid):{};
    this.sessions=this.mode==='offline'?await this.host.listArchives(this.cid):[];
    return {conversation:this.conversation,sessions:this.sessions,memory,contextFloor:this.contextFloor};
  }
  floorFor(conversation){
    const configured=Number(conversation?.localSettings?.shortTermMemoryLimit??15);
    const limit=Number.isFinite(configured)&&configured>0?Math.trunc(configured):15;
    // The audited host includes 2 * shortTermMemoryLimit + 10 raw messages in online context.
    return Math.max(40,limit*2+10);
  }
  async buildPlan(policy){
    this.assertCurrent();
    const cid=this.cid;
    if(this.mode==='online'){
      const conversation=await this.host.getConversation(cid);if(!conversation)throw Error('当前聊天已不存在');
      const rows=await this.host.readMessages(cid,{all:true});
      return planOnline(rows,{...policy,conversationId:cid,contextFloor:this.floorFor(conversation),boundary:await this.host.readSummaryBoundary(cid)});
    }
    const sessions=await this.host.listArchives(cid),memory=await this.host.readMemorySnapshot(cid);
    const selected=new Set((policy.sessionIds||[]).map(cleanId));
    if(!selected.size)throw Error('请先选择归档');
    const scoped=sessions.filter(s=>cleanId(s.parentChatId)===cid&&selected.has(cleanId(s.id))&&cleanId(s.id)!==cid);
    if(scoped.length!==selected.size)throw Error('归档范围已变化，请重新选择');
    const summarized=archiveSummaryIds(cid,memory.systemMessages,memory.facts),rows=[];
    // Read only selected sessions, sequentially, rather than loading every archive into memory.
    for(const s of scoped){
      if(policy.summaryOnly!==false&&!summarized.has(cleanId(s.id)))continue;
      rows.push(...await this.host.readMessages(cleanId(s.id),{all:true}));
    }
    return planOffline(rows,{...policy,conversationId:cid,sessions,summaryMessages:memory.systemMessages,facts:memory.facts});
  }
  async preview(policy){
    if(this.running)throw Error('正在清理，请稍候');
    this.invalidate();const revision=this.revision,snapshot=structuredClone(policy);
    const plan=await this.buildPlan(snapshot);
    plan.policy=snapshot;plan.fingerprint=await fingerprintRows(plan.rows);
    if(this.revision!==revision)throw Error('筛选条件已变化，请重新预览');this.plan=plan;
    return plan;
  }
  invalidate(){this.revision++;this.plan=null;}
  requestStop(){this.stopRequested=true;}
  async memoryUnchanged(before){
    const after=await this.host.readMemorySnapshot(this.cid);
    for(const store of ['systemMessages','facts','vectors','core']){
      const current=new Map((after[store]||[]).map(row=>[cleanId(row.id||row.conversationId),row]));
      const original=before[store]||[],present=original.map(row=>current.get(cleanId(row.id||row.conversationId)));
      if(present.some(row=>!row)||await fingerprintRows(original)!==await fingerprintRows(present))return false;
    }
    return true;
  }
  async assertIdle(plan){
    const cids=new Set([this.cid,...plan.rows.map(r=>cleanId(r.conversationId))]);
    for(const cid of cids)if(await this.host.isBusy(cid))throw Error('当前聊天正在回复、生成或总结，请完成后再清理');
  }
  async execute({backupConfirmed=false,onProgress=()=>{}}={}){
    if(this.running||window.__rocheHistoryDeletionLock)throw Error('已有清理任务正在进行');
    if(!backupConfirmed)throw Error('请先确认已保存完整 Roche 备份');
    const plan=this.plan;if(!plan?.count)throw Error('请先预览待删除记录');
    this.running=true;this.stopRequested=false;window.__rocheHistoryDeletionLock=true;
    try{
    this.assertCurrent();await this.assertIdle(plan);
    const fresh=await this.buildPlan(plan.policy);
    if(await fingerprintRows(fresh.rows)!==plan.fingerprint)throw Error('记录或保护范围已变化，请重新预览');
    fresh.rows=null;
    const memory=await this.host.readMemorySnapshot(this.cid);
    const batches=[];
    for(const cid of new Set(plan.rows.map(r=>cleanId(r.conversationId)))){
      const ids=plan.rows.filter(r=>cleanId(r.conversationId)===cid).map(r=>cleanId(r.id));
      for(let i=0;i<ids.length;i+=200)batches.push({cid,ids:ids.slice(i,i+200)});
    }
    let completed=0,error=null;
    try{
      for(const batch of batches){
        if(this.stopRequested)break;
        this.assertCurrent();await this.assertIdle(plan);
        const current=await this.host.readMessages(batch.cid,{all:true}),ids=new Set(batch.ids);
        const actual=current.filter(r=>ids.has(cleanId(r.id))&&cleanId(r.conversationId)===batch.cid);
        const expected=plan.rows.filter(r=>ids.has(cleanId(r.id))&&cleanId(r.conversationId)===batch.cid);
        if(await fingerprintRows(actual)!==await fingerprintRows(expected))throw Error('当前批次记录已变化，请重新预览');
        if(this.mode==='online'){
          const conversation=await this.host.getConversation(this.cid);
          if(!conversation)throw Error('当前聊天已不存在');
          const eligible=planOnline(current,{...plan.policy,kind:'count',count:100000,conversationId:this.cid,contextFloor:this.floorFor(conversation),boundary:await this.host.readSummaryBoundary(this.cid)});
          const allowed=new Set(eligible.ids);if(batch.ids.some(id=>!allowed.has(id)))throw Error('当前上下文或总结范围已变化，请重新预览');
        }
        if(this.stopRequested)break;
        await this.host.deleteMessageBatch(batch.cid,batch.ids);completed+=batch.ids.length;
        onProgress({deleted:completed,total:plan.count});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }catch(e){error=e;}
    try{
      let remaining=0;
      const targetIds=new Set(plan.ids);
      for(const cid of new Set(plan.rows.map(r=>cleanId(r.conversationId)))){
        const rows=await this.host.readMessages(cid,{all:true});
        remaining+=rows.filter(r=>cleanId(r.conversationId)===cid&&targetIds.has(cleanId(r.id))).length;
      }
      const memoryPreserved=await this.memoryUnchanged(memory),result={deleted:plan.count-remaining,remaining,stopped:this.stopRequested,memoryPreserved};
      this.plan=null;
      if(!memoryPreserved)throw Error('检测到记忆在清理期间发生变化，已停止。请保留备份并检查记忆；不会自动覆盖或恢复。');
      if(error){error.message+='；已清理 '+result.deleted+' 条，剩余 '+remaining+' 条';throw error;}
      if(remaining&&!this.stopRequested)throw Error('部分记录未清理：已完成 '+result.deleted+' 条，剩余 '+remaining+' 条');
      return result;
    }finally{this.plan=null;}
    }finally{this.running=false;window.__rocheHistoryDeletionLock=false;}
  }
}

const formatBytes=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':n>=1024?Math.round(n/1024)+' KB':n+' B';
const formatDate=value=>{const d=new Date(Number(value));return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'日期未知';};
const localDay=value=>{const d=new Date(value);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
const historyCss=`
:host{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#19191c;color-scheme:light;--muted:#83838c;--line:#ededf0}*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;-webkit-tap-highlight-color:transparent}button:disabled{cursor:default;opacity:.35}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #777;outline-offset:2px}button,input,select{touch-action:manipulation}button{border:0;color:inherit}button,input,select{min-height:44px}header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px 15px;border-bottom:1px solid var(--line);flex-shrink:0}h1{font-size:20px;line-height:1.35;margin:0;font-weight:650}header p{font-size:12px;color:var(--muted);margin:3px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:245px}header button{background:#f3f3f5;border-radius:24px;width:44px;font-size:23px;line-height:1}main{overflow:auto;overscroll-behavior:contain;padding:20px;min-height:0;flex:1;-webkit-overflow-scrolling:touch}section{margin-bottom:22px}.caption{margin:0 0 11px;font-size:13px;color:var(--muted)}.segments{display:flex;background:#f1f1f4;padding:4px;border-radius:15px;margin-bottom:20px}.segments button{flex:1;min-height:38px;background:transparent;border-radius:11px;font-size:14px}.segments .active{background:white;box-shadow:0 1px 5px #0000000b}.field{display:block;margin:0 0 15px}.field span{display:block;font-size:13px;margin:0 0 7px;color:#65656d}input:not([type=checkbox]),select{display:block;min-width:0;width:100%;padding:11px 13px;border:1px solid #e6e6eb;background:#fff;border-radius:13px;font-size:16px;color:#1b1b20}input[type=date]{max-width:100%;min-height:47px;padding:10px 7px}.twocol{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.inline{display:flex;align-items:center;justify-content:space-between;gap:12px}.toggle{display:flex;align-items:center;gap:11px;min-height:44px;font-size:14px;cursor:pointer}.toggle input{width:20px;height:20px;min-height:20px;accent-color:#171719;flex-shrink:0}small{display:block;font-size:12px;line-height:1.6;color:var(--muted);margin:6px 0 0}.subtle{background:#f4f4f6;border-radius:13px;padding:11px 16px;min-height:43px}.outline{border:1px solid #dfdfe5;border-radius:13px;padding:11px 15px;background:white}.primary{background:#19191c;color:white;border-radius:16px;padding:13px 18px;font-weight:600}.danger{background:#b62e3c;color:white;border-radius:16px;padding:13px 18px;font-weight:600}.full{width:100%}.hide{display:none!important}.preview{border:1px solid #e3e3e8;border-radius:20px;padding:18px;margin-top:20px}.big{font-size:30px;font-weight:650;letter-spacing:-1px;line-height:1.25}.big span{font-size:13px;font-weight:400;color:var(--muted);letter-spacing:0;margin-left:6px}.preview p{font-size:13px;margin:9px 0 0;color:#61616b}.preview .warning{color:#a44924}.archivelist{border:1px solid #e8e8ed;border-radius:17px;overflow:hidden;margin-top:12px;max-height:255px;overflow-y:auto}.archive{display:flex;gap:11px;align-items:center;padding:12px 13px;border-bottom:1px solid #eee;cursor:pointer}.archive:last-child{border-bottom:0}.archive input{accent-color:#171719;width:19px;height:19px;min-height:19px;flex-shrink:0}.archive strong{font-weight:500;font-size:14px}.archive small{margin:2px 0 0}.empty{text-align:center;padding:28px 10px;color:var(--muted);font-size:14px}.status{font-size:13px;color:#575761;line-height:1.6;white-space:pre-wrap;margin-top:14px}.error{color:#a52e3b}.success{color:#2c6a4b}footer{padding:14px 20px max(16px,env(safe-area-inset-bottom));border-top:1px solid var(--line);flex-shrink:0;background:#fff}footer small{margin:8px 0 0;text-align:center}.backup{font-size:13px;margin-top:14px;min-height:38px;padding:8px 12px}#backupConfirmed{margin-left:0}.shell{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:white}.loading{padding:40px 20px;text-align:center;color:var(--muted)}[hidden]{display:none!important}@media(max-width:360px){main{padding:16px}header{padding:15px 16px}footer{padding-left:16px;padding-right:16px}input[type=date]{font-size:14px}.twocol{gap:7px}}`;

class CleanerDialog {
  constructor(session){this.session=session;this.disposed=false;this.loading=false;this.controller=new AbortController();}
  async open(){
    const dialog=document.createElement('dialog');this.dialog=dialog;
    dialog.setAttribute('aria-label',this.session.mode==='online'?'批量清理聊天记录':'批量清理归档正文');
    dialog.style.cssText='position:fixed;inset:0;margin:auto;border:0;outline:none;padding:0;width:min(100% - 24px,460px);height:min(790px,calc(100dvh - max(24px,env(safe-area-inset-top)) - max(24px,env(safe-area-inset-bottom))));max-height:calc(100dvh - 48px);max-width:calc(100vw - 24px);overflow:hidden;border-radius:25px;background:#fff;color:#19191c;box-shadow:0 24px 100px #0004;';
    const shadowHost=document.createElement('div');shadowHost.style.cssText='height:100%;width:100%;';dialog.append(shadowHost);
    this.root=shadowHost.attachShadow({mode:'open'});
    this.root.innerHTML='<style>'+historyCss+'</style><div class="shell"><header><div><h1>'+(this.session.mode==='online'?'批量清理':'清理归档正文')+'</h1><p id="chatName"></p></div><button id="close" aria-label="关闭">×</button></header><main><div class="loading">正在读取当前聊天…</div></main><footer hidden></footer></div>';
    this.root.querySelector('#close').onclick=()=>this.close();
    dialog.addEventListener('cancel',e=>{e.preventDefault();this.close();});
    document.body.append(dialog);dialog.showModal();this.el('close').focus({preventScroll:true});
    try{const data=await this.session.init();if(this.disposed)return;this.render(data);}catch(e){if(!this.disposed)this.root.querySelector('main').textContent=e.message||'读取失败';}
    return this;
  }
  el(id){return this.root.getElementById(id);}
  render(data){
    const offline=this.session.mode==='offline';
    this.el('chatName').textContent=data.conversation.title||data.conversation.name||'当前聊天';
    const today=localDay(Date.now()),monthAgo=localDay(Date.now()-30*86400000);
    this.root.querySelector('main').innerHTML=`
      ${offline?`<p class="caption">保留摘要记忆与历史索引，只清理剧情正文。</p><div class="twocol"><label class="field"><span>开始日期</span><input id="fromDate" type="date"></label><label class="field"><span>结束日期</span><input id="toDate" type="date"></label></div><div class="inline"><span id="archiveCount" class="caption" style="margin:0"></span><button id="selectAll" class="subtle" type="button">全选可清理</button></div><div id="archives" class="archivelist"></div>`:`<div id="kind" class="segments"><button type="button" data-kind="count" class="active">按条数</button><button type="button" data-kind="dates">按日期</button></div><div id="countFields"><label class="field"><span>从最早记录开始清理</span><input id="count" type="number" min="1" max="100000" inputmode="numeric" value="50"></label></div><div id="dateFields" class="twocol hide"><label class="field"><span>开始日期</span><input id="fromDate" type="date" value="${monthAgo}"></label><label class="field"><span>结束日期</span><input id="toDate" type="date" value="${today}"></label></div><label class="field"><span>至少保留最近</span><input id="keepRecent" type="number" min="${data.contextFloor}" inputmode="numeric" value="${Math.max(500,data.contextFloor)}"><small>当前上下文至少保留 ${data.contextFloor} 条。收藏、置顶与记忆消息会跳过。</small></label>`}
      <section style="margin-top:16px"><label class="toggle"><input id="summaryOnly" type="checkbox" checked>仅清理已总结的${offline?'归档':'记录'}</label><small>${offline?'依据已保存的归档摘要判断。没有摘要的归档默认跳过。':'依据该聊天的总结进度判断；摘要可能不会保留原文的所有细节。'}</small></section>
      <button id="preview" class="outline full" type="button">预览清理范围</button>
      <div id="plan" class="preview hide" aria-live="polite"></div>
      <div id="status" class="status" role="status"></div>`;
    this.root.querySelector('footer').innerHTML='<label class="toggle"><input id="backupConfirmed" type="checkbox">已保存完整 Roche 备份</label><button id="confirmDelete" type="button" class="danger full" disabled>确认删除</button><button id="stop" type="button" class="outline full hide">停止后续清理</button><small>清理后不会保留本机回收副本。</small>';
    this.root.querySelector('footer').hidden=false;
    this.kind='count';this.selected=new Set();this.visibleSessions=[];
    this.el('preview').onclick=()=>this.preview();this.el('confirmDelete').onclick=()=>this.execute();
    this.el('backupConfirmed').onchange=()=>this.syncDelete();
    this.el('stop').onclick=()=>{this.session.requestStop();this.el('stop').disabled=true;this.status('正在停止，将完成当前批次后结束。');};
    if(!offline){
      this.el('kind').onclick=e=>{const b=e.target.closest('[data-kind]');if(!b)return;this.kind=b.dataset.kind;for(const el of this.el('kind').children)el.classList.toggle('active',el===b);this.el('countFields').classList.toggle('hide',this.kind!=='count');this.el('dateFields').classList.toggle('hide',this.kind!=='dates');this.invalidate();};
    }else{
      this.el('selectAll').onclick=()=>{const all=this.visibleSessions.filter(s=>!this.summaryOnly()||this.hasSummary.has(cleanId(s.id)));const filled=all.length&&all.every(s=>this.selected.has(cleanId(s.id)));for(const s of all)filled?this.selected.delete(cleanId(s.id)):this.selected.add(cleanId(s.id));this.drawArchives();this.invalidate();};
      this.hasSummary=archiveSummaryIds(this.session.cid,data.memory.systemMessages,data.memory.facts);this.drawArchives();
    }
    for(const field of this.root.querySelectorAll('main input'))field.addEventListener('input',()=>{if(offline&&(field.id==='summaryOnly'||field.id==='fromDate'||field.id==='toDate'))this.drawArchives();this.invalidate();});
  }
  summaryOnly(){return this.el('summaryOnly').checked;}
  invalidate(){if(this.session.running)return;this.session.invalidate();this.el('plan').classList.add('hide');this.el('backupConfirmed').checked=false;this.syncDelete();this.status('');}
  scopeDisabled(disabled){for(const el of this.root.querySelectorAll('main input,main button'))el.disabled=disabled;if(!disabled&&this.session.mode==='offline')this.drawArchives();}
  syncDelete(){this.el('confirmDelete').disabled=this.loading||this.session.running||!this.session.plan?.count||!this.el('backupConfirmed').checked;}
  drawArchives(){
    const from=this.el('fromDate').value,to=this.el('toDate').value;
    let range=null;if(from&&to){try{range=dayRange(from,to);}catch{range={from:Infinity,until:0};}}
    this.visibleSessions=ordered(this.session.sessions).reverse().filter(s=>!range||(Number(s.timestamp)>=range.from&&Number(s.timestamp)<range.until));
    const container=this.el('archives');container.replaceChildren();
    for(const s of this.visibleSessions){
      const id=cleanId(s.id),has=this.hasSummary.has(id),label=document.createElement('label');label.className='archive';
      const input=document.createElement('input');input.type='checkbox';input.checked=this.selected.has(id);input.disabled=this.summaryOnly()&&!has;input.dataset.session=id;
      if(input.disabled){input.checked=false;this.selected.delete(id);}
      input.onchange=()=>{input.checked?this.selected.add(id):this.selected.delete(id);this.invalidate();};
      const text=document.createElement('div'),strong=document.createElement('strong'),small=document.createElement('small');strong.textContent=formatDate(s.timestamp);small.textContent=has?'已有摘要':'未确认摘要';text.append(strong,small);label.append(input,text);container.append(label);
    }
    if(!this.visibleSessions.length){const p=document.createElement('div');p.className='empty';p.textContent='这个范围没有归档';container.append(p);}
    this.el('archiveCount').textContent='已选 '+this.visibleSessions.filter(s=>this.selected.has(cleanId(s.id))).length+' / '+this.visibleSessions.length+' 份';
  }
  policy(){
    if(this.session.mode==='online')return {kind:this.kind,count:Number(this.el('count').value),fromDate:this.el('fromDate').value,toDate:this.el('toDate').value,keepRecent:Number(this.el('keepRecent').value),summaryOnly:this.summaryOnly()};
    const from=this.el('fromDate').value,to=this.el('toDate').value;
    if((from&&!to)||(!from&&to))throw Error('请填写开始和结束日期，或清空两个日期');
    if(from&&to)dayRange(from,to);
    const visible=new Set(this.visibleSessions.map(s=>cleanId(s.id)));
    return {sessionIds:[...this.selected].filter(id=>visible.has(id)),summaryOnly:this.summaryOnly()};
  }
  status(text,error=false){const el=this.el('status');if(!el)return;el.textContent=text;el.className='status'+(error?' error':'');}
  async preview(){
    if(this.loading||this.session.running)return;this.loading=true;this.scopeDisabled(true);this.el('preview').disabled=true;this.el('backupConfirmed').checked=false;this.syncDelete();this.status('正在计算范围…');
    try{
      const plan=await this.session.preview(this.policy());if(this.disposed)return;
      const box=this.el('plan');box.replaceChildren();box.classList.remove('hide');
      const count=document.createElement('div');count.className='big';count.textContent=String(plan.count);const unit=document.createElement('span');unit.textContent='条 · 约 '+formatBytes(plan.bytes);count.append(unit);box.append(count);
      const line=document.createElement('p');line.textContent=plan.count?formatDate(plan.rows[0].timestamp)+' — '+formatDate(plan.rows[plan.rows.length-1].timestamp):'当前范围没有可清理记录';box.append(line);
      const note=document.createElement('p');note.textContent=this.session.mode==='offline'?'已有记忆与归档索引保留；正文清空后无法在历史里回看原剧情。':'已保存的记忆保留；已删除的原文将无法搜索或回看。';box.append(note);
      if(plan.reason){const p=document.createElement('p');p.className='warning';p.textContent=plan.reason;box.append(p);}
      if(!plan.summaryOnly){const p=document.createElement('p');p.className='warning';p.textContent='包含未确认总结的内容。未进入记忆的细节会丢失。';box.append(p);}
      if(plan.skippedArchives){const p=document.createElement('p');p.textContent='已跳过 '+plan.skippedArchives+' 份无摘要归档';box.append(p);}
      if(plan.count){const b=document.createElement('button');b.id='backup';b.type='button';b.className='outline backup';b.textContent='导出所选记录';b.onclick=()=>this.exportSelected();box.append(b);}
      this.status('');
    }catch(e){this.status(e.message||'预览失败',true);}finally{this.loading=false;if(!this.disposed){this.scopeDisabled(false);this.el('preview').disabled=false;this.syncDelete();}}
  }
  exportSelected(){
    const plan=this.session.plan;if(!plan?.count)return;
    const blob=new Blob([JSON.stringify({format:'roche-history-cleaner-export',version:1,createdAt:new Date().toISOString(),conversationId:this.session.cid,mode:this.session.mode,messages:plan.rows},null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Roche_所选记录_'+localDay(Date.now())+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    this.status('已请求导出。请确认文件保存成功；此文件是所选原文副本，不是完整 Roche 备份。');
  }
  async execute(){
    if(this.loading||this.session.running||!this.session.plan?.count)return;
    const confirmed=this.el('backupConfirmed').checked;if(!confirmed)return;
    this.loading=true;this.syncDelete();this.el('preview').disabled=true;this.el('confirmDelete').classList.add('hide');this.el('stop').classList.remove('hide');
    for(const el of this.root.querySelectorAll('main input,main button'))el.disabled=true;
    this.status('正在核对范围与记忆…');
    try{
      const result=await this.session.execute({backupConfirmed:confirmed,onProgress:p=>this.status('已清理 '+p.deleted+' / '+p.total+' 条')});
      this.el('plan').classList.add('hide');this.el('backupConfirmed').checked=false;
      this.status((result.stopped?'已停止。':'已完成。')+'已清理 '+result.deleted+' 条'+(result.remaining?'，剩余 '+result.remaining+' 条':'')+'，已有记忆核对通过。关闭并重新打开历史记录可刷新列表。');
    }catch(e){this.status(e.message||'清理未完成',true);this.session.plan=null;}
    finally{
      this.loading=false;if(!this.disposed){for(const el of this.root.querySelectorAll('main input,main button'))el.disabled=false;this.el('preview').disabled=false;this.el('stop').classList.add('hide');this.el('stop').disabled=false;this.el('confirmDelete').classList.remove('hide');this.syncDelete();if(this.session.mode==='offline')this.drawArchives();}
    }
  }
  close(){
    if(this.session.running||this.loading){this.session.requestStop();this.status('请稍候，当前操作完成后可关闭。');return;}
    this.destroy();
  }
  destroy(){if(this.disposed)return;this.disposed=true;this.session.requestStop();this.session.plan=null;this.dialog?.close();this.dialog?.remove();this.controller.abort();}
}

function installHistoryCleaner(){
  const ID='roche-history-cleaner',VERSION='0.1.1';
  if(!window.RochePlugin?.register)throw Error('请在 Roche 插件管理中安装');
  window.__rocheHistoryCleaner?.dispose?.();
  let view=null,disposed=false,opening=false;
  const detach=attachHistoryEntries(async context=>{
    if(disposed||opening||view?.session.running||window.__rocheHistoryDeletionLock)return;opening=true;
    view?.destroy();
    try{const host=await createHistoryHost();if(disposed)return;view=new CleanerDialog(new CleanupSession(host,context));await view.open();}
    catch(e){window.Roche?.ui?.toast?.(e.message||'暂不支持当前 Roche 版本');}finally{opening=false;}
  });
  window.__rocheHistoryCleaner={version:VERSION,inspect:()=>detach.status(),rescan:()=>detach.rescan(),dispose(){if(disposed)return;disposed=true;detach();view?.destroy();view=null;}};
  window.RochePlugin.register({id:ID,name:'记录清理',version:VERSION,apps:[{id:'roche-history-cleaner-help',name:'记录清理',icon:'delete_sweep',mount(el){
    el.style.cssText='padding:24px;font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#29292e;background:white;';el.replaceChildren();
    const h=document.createElement('h2');h.textContent='记录清理';const version=document.createElement('p');version.textContent='v'+VERSION;version.style.cssText='font-size:12px;color:#808089;margin-top:-12px';
    const p=document.createElement('p');p.textContent='线上：打开搜索聊天记录，在搜索框下方点“批量清理”。';
    const q=document.createElement('p');q.textContent='线下：打开历史记录，在标题下方点“批量清理”。';
    const s=document.createElement('p');s.style.cssText='font-size:13px;color:#808089';s.textContent='先预览，再确认删除。保留已有记忆；线下仅清理归档正文，历史索引保留。';
    const button=document.createElement('button');button.textContent='检查入口';button.type='button';button.style.cssText='appearance:none;-webkit-appearance:none;border:1px solid #dedee4;border-radius:22px;padding:10px 20px;background:#f5f5f7;color:#222;font:inherit;min-height:44px;';
    const status=document.createElement('p');status.style.cssText='font-size:13px;color:#767680';status.setAttribute('role','status');
    button.onclick=()=>{detach.rescan();const info=detach.status();status.textContent=info.disposed?'插件已重载，请关闭后重新打开本页。':info.entries?'已挂载 '+info.entries+' 个批量清理入口。':info.onlineCandidates+info.offlineCandidates?'找到了历史窗口，暂未确认所属会话。未开放清理。':'请先返回聊天，打开搜索聊天记录或线下历史记录。';};
    el.append(h,version,p,q,s,button,status);
  }}]});
}

installHistoryCleaner();
})();
