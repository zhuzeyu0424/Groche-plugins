/* Adds a local unread marker and a text-only transcript button to incoming Roche voice cards. */
(() => {
  'use strict';
  const slot = '__rocheWeChatVoiceTools';
  window[slot]?.dispose();
  const id = 'roche-wechat-voice-tools';
  const storeKey = `${id}:seen`;
  const themeSelector = '.chat-viewport-root';
  const voiceSelector = '.chat-card--voice[data-card-type="voice"][data-message-side="received"]';
  const owned = 'data-wx-voice-tools';
  const storage = readState() || { startedAt: Date.now(), seen: [] };
  const seen = new Set(storage.seen);
  saveState();

  const style = document.createElement('style');
  style.setAttribute(owned, '');
  style.textContent = `
.chat-viewport-root .wx-voice-tools {
  position:absolute; z-index:2; left:calc(100% + 6px); top:20px; transform:translateY(-50%);
  display:flex; align-items:center; gap:5px; white-space:nowrap;
}
.chat-viewport-root .wx-voice-tools[hidden], .chat-viewport-root .wx-voice-tools__text[hidden],
.chat-viewport-root .wx-voice-tools__dot[hidden], .chat-viewport-root .wx-voice-tools__button[hidden] {display:none!important}
.chat-viewport-root .chat-message-row:has([role="checkbox"],input[type="checkbox"],[class~="w-[42px]"][class~="opacity-100"]) .wx-voice-tools,
.chat-viewport-root .chat-card--voice:has(> .voice-transcript-area) .wx-voice-tools {display:none!important}
.chat-viewport-root .wx-voice-tools__dot {
  flex:none; width:6px; height:6px; border-radius:50%; background:#e3484d;
  box-shadow:0 0 0 1px rgba(255,255,255,.6);
}
.chat-viewport-root .wx-voice-tools__button {
  box-sizing:border-box; appearance:none; cursor:pointer; min-height:28px; margin:0;
  padding:4px 7px; border:0; border-radius:10px; background:#fafafa; color:#515454;
  font:500 11px/1 var(--wx-font,-apple-system,sans-serif);
}
.chat-viewport-root .wx-voice-tools__button:focus-visible {outline:2px solid #3f7264; outline-offset:2px}
.chat-viewport-root .wx-voice-tools__text {
  box-sizing:border-box; width:max-content; max-width:100%; margin:5px 0 0; padding:8px 11px;
  border-radius:5px; background:var(--wx-translation-bg,#fff); color:var(--wx-ink,#111);
  font:400 14px/1.55 var(--wx-font,-apple-system,sans-serif); white-space:pre-wrap; overflow-wrap:anywhere;
}
@media (prefers-color-scheme:dark) {
  .chat-viewport-root .wx-voice-tools__button {background:#393b3b;color:#eee}
}
`;
  document.head.append(style);

  function readState() {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey));
      if (Number.isFinite(raw?.startedAt) && Array.isArray(raw?.seen)) return raw;
    } catch (_) { /* Use the current session if storage is unavailable. */ }
    return null;
  }

  function saveState() {
    try {
      const current = readState();
      for (const key of current?.seen || []) seen.add(key);
      localStorage.setItem(storeKey, JSON.stringify({ startedAt: storage.startedAt, seen: [...seen] }));
    } catch (_) { /* The current page still remembers what was opened. */ }
  }

  function readVoices(ids) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('Roche_db');
      open.onupgradeneeded = () => open.transaction.abort();
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('messages')) {db.close(); resolve(new Map()); return;}
        const transaction = db.transaction('messages', 'readonly');
        const messages = transaction.objectStore('messages');
        const result = new Map();
        transaction.oncomplete = () => { db.close(); resolve(result); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
        for (const key of ids) {
          const request = messages.get(key);
          request.onsuccess = () => {
            if (request.result) { result.set(key, request.result); return; }
            const numericKey = Number(key);
            if (!Number.isSafeInteger(numericKey) || String(numericKey) !== key) return;
            const fallback = messages.get(numericKey);
            fallback.onsuccess = () => { if (fallback.result) result.set(key, fallback.result); };
          };
        }
      };
    });
  }

  function idOf(card) {
    const message = card.closest('[id^="msg-"]');
    return message?.closest('.chat-message-row') ? message.id.slice(4) : '';
  }

  function matchesTheme(root) {
    if (!root) return false;
    const computed = getComputedStyle(root);
    return Boolean(computed.getPropertyValue('--wx-canvas').trim() && computed.getPropertyValue('--wx-self').trim());
  }

  const active = new Map();
  let frame = 0;
  let timeout = 0;
  let retryBudget = 3;
  let disposed = false;
  let nextTranscript = 0;

  function updateDot(record) {
    record.dot.hidden = !record.newVoice || seen.has(record.key);
    record.tools.hidden = record.dot.hidden && record.button.hidden;
  }

  function mount(card, record, voice) {
    const transcript = String(voice.text || '').trim();
    const timestamp = Number(voice.timestamp);
    const tools = document.createElement('div');
    tools.className = 'wx-voice-tools';
    tools.setAttribute(owned, '');
    const dot = document.createElement('span');
    dot.className = 'wx-voice-tools__dot';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', '未查看的语音');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wx-voice-tools__button';
    button.textContent = '转文字';
    button.hidden = !transcript;
    const text = document.createElement('div');
    text.id = `wx-voice-tools-text-${++nextTranscript}`;
    text.className = 'wx-voice-tools__text';
    text.setAttribute(owned, '');
    text.textContent = transcript;
    text.hidden = true;
    button.setAttribute('aria-controls', text.id);
    button.setAttribute('aria-expanded', 'false');
    const events = new AbortController();
    const options = {signal:events.signal};
    Object.assign(record, {tools, dot, button, text, events, newVoice:Number.isFinite(timestamp) && timestamp > storage.startedAt});

    function markSeen() {
      if (record.newVoice && !seen.has(record.key)) {
        seen.add(record.key);
        saveState();
        updateDot(record);
      }
    }
    function setExpanded(open) {
      text.hidden = !open;
      button.textContent = open ? '收起文字' : '转文字';
      button.setAttribute('aria-expanded', String(open));
    }
    button.addEventListener('click', event => {
      event.stopPropagation();
      setExpanded(text.hidden);
      markSeen();
    }, options);
    for (const name of ['touchstart','touchend','touchmove','contextmenu']) {
      button.addEventListener(name, event => event.stopPropagation(), {...options, passive:true});
    }
    card.addEventListener('click', event => {
      if (tools.contains(event.target)) return;
      setExpanded(false);
      markSeen();
    }, {...options, capture:true});

    tools.append(dot, button);
    card.append(tools);
    card.after(text);
    updateDot(record);
  }

  function remove(card, record) {
    record.events?.abort();
    record.tools?.remove();
    record.text?.remove();
    active.delete(card);
  }

  async function scan() {
    frame = 0;
    const roots = new Set([...document.querySelectorAll(themeSelector)].filter(matchesTheme));
    for (const [card, record] of active) {
      if (!card.isConnected || !roots.has(card.closest(themeSelector)) || !card.matches(voiceSelector) ||
          idOf(card) !== record.key || (record.tools && record.tools.parentElement !== card)) remove(card, record);
    }
    const pending = new Map();
    for (const root of roots) {
      for (const card of root.querySelectorAll(voiceSelector)) {
        if (active.has(card)) continue;
        const key = idOf(card);
        if (!key) continue;
        const record = {key};
        active.set(card, record);
        pending.set(card, record);
      }
    }
    if (!pending.size) return;
    let voices;
    try { voices = await readVoices(new Set([...pending.values()].map(record => record.key))); }
    catch (_) { voices = new Map(); }
    if (disposed) return;
    let missing = false;
    for (const [card, record] of pending) {
      if (active.get(card) !== record) continue;
      if (!card.isConnected || !card.matches(voiceSelector) || idOf(card) !== record.key || !matchesTheme(card.closest(themeSelector))) {
        remove(card, record);
        continue;
      }
      const voice = voices.get(record.key);
      if (voice?.type === 'voice') mount(card, record, voice);
      if (!voice) { active.delete(card); missing = true; }
    }
    if (missing && !timeout && retryBudget > 0) {
      retryBudget--;
      timeout = setTimeout(() => { timeout = 0; schedule(); }, 650);
    }
  }

  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(scan);
  }

  const watch = new MutationObserver(records => {
    if (!records.some(({target, addedNodes, removedNodes}) => {
      const element = target.nodeType === 1 ? target : target.parentElement;
      if (!element || element.closest(`[${owned}]`)) return false;
      if (element.matches('style') || element.closest('.chat-message-row')) {
        const nodes = [...addedNodes, ...removedNodes];
        return !nodes.length || nodes.some(node => node.nodeType !== 1 || !node.hasAttribute(owned));
      }
      return [...addedNodes, ...removedNodes].some(node => node.nodeType === 1 && !node.hasAttribute(owned) &&
        (node.matches(`${themeSelector},.chat-message-row,style`) || node.querySelector(`${themeSelector},.chat-message-row`)));
    })) return;
    retryBudget = 3;
    schedule();
  });
  watch.observe(document.documentElement, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['id']});
  const onStorage = event => {
    if (event.key !== storeKey) return;
    for (const key of readState()?.seen || []) seen.add(key);
    for (const record of active.values()) if (record.dot) updateDot(record);
  };
  window.addEventListener('storage', onStorage);
  window[slot] = {
    dispose() {
      disposed = true;
      watch.disconnect();
      window.removeEventListener('storage', onStorage);
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      for (const [card, record] of active) remove(card, record);
      style.remove();
      delete window[slot];
    },
  };
  window.RochePlugin?.register({id, name:'微信语音小工具', version:'0.1.0'});
  schedule();
})();
