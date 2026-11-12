/* 微信多图收起 v0.1.0 — only decorates existing image rows; no message writes. */
(() => {
  'use strict';
  const KEY = '__rocheWeChatAlbums';
  window[KEY]?.dispose();
  const ROOT = '.chat-viewport-root';
  const ROW = '.chat-message-row';
  const OWN = 'data-wx-album-owned';
  const STORAGE = 'roche.wechat.albums.enabled';
  let enabled = true, stopped = false, frame = 0;
  try { enabled = localStorage.getItem(STORAGE) !== '0'; } catch (_) {}
  const expanded = new Set();
  const states = new Map();
  const panels = new Map();
  const style = document.createElement('style');
  style.setAttribute(OWN,'style');
  style.textContent = `
${ROOT} ${ROW}[data-wx-album-hidden] { display:none !important; }
${ROOT} [data-wx-album-body] { position:relative !important; overflow:visible !important; }
${ROOT} .wx-album-toggle {
  position:absolute; right:calc(100% + 10px); top:var(--wx-album-toggle-y,100px);
  transform:translateY(-50%); z-index:5; min-height:28px; min-width:50px;
  margin:0; padding:5px 12px; border:0; border-radius:18px; box-shadow:none;
  background:#e0e0e0; color:#656565; font:400 12px/18px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
  white-space:nowrap; cursor:pointer; touch-action:manipulation;
}
${ROOT} .wx-album-toggle:hover { background:#d8d8d8; }
${ROOT} .wx-album-toggle:focus-visible { outline:2px solid #168b45; outline-offset:3px; }
${ROOT} [data-wx-album-front="collapsed"] .chat-message-content { margin-right:8px !important; }
${ROOT} [data-wx-album-front="collapsed"] .chat-card--image {
  position:relative !important; isolation:isolate; overflow:visible !important;
  width:clamp(116px,38vw,156px) !important; min-width:0 !important; max-width:100% !important;
}
${ROOT} [data-wx-album-front="collapsed"] .image-card--ready,
${ROOT} [data-wx-album-front="collapsed"] .image-card--ready > .cursor-zoom-in {
  position:relative !important; width:100% !important; min-width:0 !important; max-width:100% !important; overflow:visible !important;
}
${ROOT} [data-wx-album-front="collapsed"] img.image-card__image {
  position:relative !important; z-index:2; display:block !important;
  width:100% !important; height:auto !important; aspect-ratio:3/4 !important;
  max-width:100% !important; max-height:none !important; object-fit:cover !important; border-radius:6px !important;
}
${ROOT} .wx-album-peek { position:absolute; inset:0; z-index:-1; pointer-events:none; }
${ROOT} .wx-album-peek img {
  position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:cover;
  border-radius:6px; transform-origin:center; transform:translate(6px,0) rotate(3deg);
  filter:brightness(.88); pointer-events:none;
}
${ROOT} .wx-album-peek img + img { transform:translate(12px,1px) rotate(5deg); z-index:-1; filter:brightness(.72); }
${ROOT} .wx-album-avatar { display:block; width:100%; height:100%; border:0; padding:0; border-radius:inherit;
  background-size:cover; background-position:center; cursor:pointer; }
`;
  document.head.append(style);

  function message(row) { return row.querySelector('.chat-message'); }
  function id(row) { return row.querySelector('[id^="msg-"]')?.id || row.dataset.messageId || null; }
  function candidate(row) {
    const msg = message(row);
    if (!msg?.classList.contains('chat-message--sent') || !id(row)) return null;
    if (row.querySelector('.chat-card--sticker,.chat-card--voice,.chat-card--video,.chat-bubble--text')) return null;
    const cards = row.querySelectorAll('.chat-card--image');
    if (cards.length !== 1) return null;
    const card = cards[0], image = card.querySelector('.image-card__image');
    if (!image || !(image.currentSrc || image.getAttribute('src')) || !card.querySelector('.image-card--ready')) return null;
    const body = card.closest('.chat-message-body');
    if (!body || card.querySelector('[class*="border-l-"]')) return null;
    const sender = msg.dataset.senderId || row.dataset.senderId || '';
    return {row,msg,card,image,body,sender};
  }
  function beginsSection(row) {
    const inner = row.querySelector('[id^="msg-"]');
    if (inner && Array.from(row.children).some(child => child !== inner && !child.hasAttribute(OWN))) return true;
    return !!row.querySelector('.chat-message-time,.chat-message-timestamp,[data-message-separator]');
  }
  function selecting(root) {
    return !!root.querySelector('.chat-message-row input[type="checkbox"],.chat-message-row [role="checkbox"],[class~="w-[42px]"][class~="opacity-100"]');
  }
  function avatarFor(state) {
    // Native "only last avatar" mode can put a placeholder on the cover row.
    if (state.first.msg.querySelector('.chat-message-avatar')) return;
    const slot = state.first.msg.querySelector('.chat-message-avatar-placeholder');
    const source = state.items.map(item => item.msg.querySelector('.chat-message-avatar')).find(Boolean);
    if (!slot || !source) return;
    const sourceImage = source.querySelector('img');
    const background = sourceImage ? `url(${JSON.stringify(sourceImage.currentSrc || sourceImage.src)})` : getComputedStyle(source).backgroundImage;
    if (!background || background === 'none') return;
    const visual = document.createElement('button');
    visual.type = 'button'; visual.className = 'wx-album-avatar'; visual.setAttribute(OWN,'avatar');
    visual.setAttribute('aria-label','查看我的头像');
    visual.style.backgroundImage = background;
    visual.addEventListener('click',e => { e.stopPropagation(); source.click(); });
    slot.append(visual); state.avatar = visual;
  }
  function position(state) {
    if (!state.first.image.isConnected) return;
    const box = state.first.image.getBoundingClientRect();
    const body = state.first.body.getBoundingClientRect();
    state.button.style.setProperty('--wx-album-toggle-y',`${Math.round(box.top - body.top + box.height / 2)}px`);
  }
  function apply(state) {
    const open = expanded.has(state.key);
    state.first.row.setAttribute('data-wx-album-front',open?'expanded':'collapsed');
    state.first.body.setAttribute('data-wx-album-body','');
    state.button.textContent = open ? '收起' : `展开 ${state.items.length}`;
    state.button.setAttribute('aria-expanded',String(open));
    state.button.setAttribute('aria-label',open?'收起这组图片':`展开这组 ${state.items.length} 张图片`);
    for (const item of state.items.slice(1)) item.row.toggleAttribute('data-wx-album-hidden',!open);
    state.peek?.remove(); state.peek = null; state.avatar?.remove(); state.avatar = null;
    if (!open) {
      const peek = document.createElement('span'); peek.className = 'wx-album-peek'; peek.setAttribute(OWN,'peek'); peek.setAttribute('aria-hidden','true');
      state.items.slice(1,3).forEach(item => {
        const img = document.createElement('img'); img.src = item.image.currentSrc || item.image.src; img.alt = ''; img.draggable = false; peek.append(img);
      });
      state.first.card.append(peek); state.peek = peek; avatarFor(state);
    }
    position(state);
  }
  function remove(state) {
    state.resize.disconnect(); state.button.remove(); state.peek?.remove(); state.avatar?.remove();
    state.first.row.removeAttribute('data-wx-album-front'); state.first.body.removeAttribute('data-wx-album-body');
    state.items.forEach(item => item.row.removeAttribute('data-wx-album-hidden'));
    states.delete(state.key);
  }
  function create(items) {
    const first = items[0], key = id(first.row);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'wx-album-toggle'; button.setAttribute(OWN,'toggle');
    const state = {key,first,items,button,peek:null,avatar:null,sources:items.map(item=>item.image.currentSrc || item.image.src)};
    state.resize = new ResizeObserver(() => position(state));
    state.resize.observe(first.image);
    button.addEventListener('click',e => {
      e.preventDefault(); e.stopPropagation();
      const top = button.getBoundingClientRect().top;
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      apply(state);
      // Preserve the cover's position when a scroll container is bottom-anchored.
      const shift = button.getBoundingClientRect().top - top;
      if (Math.abs(shift) > 1) {
        let node = first.row.parentElement;
        while (node && node !== document.body) {
          if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) { node.scrollTop += shift; break; }
          node = node.parentElement;
        }
      }
    });
    first.body.append(button); states.set(key,state); apply(state);
  }
  function scan() {
    frame = 0;
    if (stopped) return;
    if (!enabled) { [...states.values()].forEach(remove); return; }
    const groups = [];
    for (const root of document.querySelectorAll(ROOT)) {
      if (selecting(root)) continue;
      const rows = [...root.querySelectorAll(ROW)].filter(row => !row.parentElement.closest(ROW));
      let run = [];
      const flush = () => { if (run.length >= 2) groups.push(run); run = []; };
      for (const row of rows) {
        const item = candidate(row), prev = run[run.length - 1];
        if (!item) { flush(); continue; }
        if (prev && (beginsSection(row) || prev.sender !== item.sender || prev.row.parentElement !== row.parentElement || prev.row.nextElementSibling !== row)) flush();
        run.push(item);
      }
      flush();
    }
    const live = new Set(groups.map(items => id(items[0].row)));
    for (const state of [...states.values()]) if (!live.has(state.key)) remove(state);
    for (const items of groups) {
      const key = id(items[0].row), state = states.get(key);
      const unchanged = state && state.items.length === items.length && state.items.every((item,i) => item.row === items[i].row && item.image === items[i].image && item.body === items[i].body && state.sources[i] === (items[i].image.currentSrc || items[i].image.src)) && state.button.isConnected;
      if (unchanged) continue;
      if (state) remove(state);
      create(items);
    }
  }
  function schedule() { if (!stopped && !frame) frame = requestAnimationFrame(scan); }
  const observer = new MutationObserver(records => {
    if (records.some(record => {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (element?.closest(`[${OWN}]`)) return false;
      if (record.type === 'childList') {
        const nodes = [...record.addedNodes,...record.removedNodes];
        if (nodes.length && nodes.every(node => node.nodeType === 1 && node.hasAttribute(OWN))) return false;
      }
      return !!element?.closest(ROOT) || [...record.addedNodes,...record.removedNodes].some(node => node.nodeType === 1 && (node.matches(ROOT) || node.querySelector(ROOT)));
    })) schedule();
  });
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','src','open']});
  document.addEventListener('load',schedule,true);
  function setEnabled(value) {
    enabled = !!value;
    try { localStorage.setItem(STORAGE,enabled?'1':'0'); } catch (_) {}
    scan();
    for (const panel of panels.values()) panel.update();
  }
  function mount(container) {
    const shadow = container.shadowRoot || container.attachShadow({mode:'open'});
    shadow.innerHTML = `<style>:host{display:block;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#222}main{padding:24px}h1{font-size:21px;margin:0 0 20px}label{display:flex;gap:12px;align-items:center}input{width:20px;height:20px;accent-color:#168b45}p{color:#666;font-size:14px}button{font:inherit;padding:8px 16px;border:1px solid #ccc;border-radius:8px;background:transparent;color:inherit}@media(prefers-color-scheme:dark){:host{color:#eee}p{color:#aaa}}</style><main><h1>微信多图收起</h1><label><input type="checkbox">连续发送的图片自动堆叠</label><p>仅整理你连续发送的图片。点图片仍然打开原来的查看界面；文字、表情包和时间分隔会结束当前一组。</p><button type="button">全部收起</button><p>停用或卸载插件后刷新 Roche，即恢复原来的逐条显示。</p></main>`;
    const input = shadow.querySelector('input');
    input.addEventListener('change',() => setEnabled(input.checked));
    shadow.querySelector('button').addEventListener('click',() => { expanded.clear(); states.forEach(apply); });
    const panel = {update:() => {input.checked=enabled;},dispose:() => {shadow.innerHTML='';}};
    panels.set(container,panel); panel.update();
  }
  function dispose() {
    if (stopped) return;
    stopped = true; observer.disconnect(); cancelAnimationFrame(frame); document.removeEventListener('load',schedule,true);
    [...states.values()].forEach(remove); style.remove(); panels.forEach(panel=>panel.dispose()); panels.clear();
    if (window[KEY]?.dispose === dispose) delete window[KEY];
  }
  window[KEY] = {dispose,setEnabled,refresh:scan};
  if (window.RochePlugin?.register) window.RochePlugin.register({
    id:'roche-wechat-albums',name:'微信多图收起',version:'0.1.0',
    apps:[{id:'roche-wechat-albums-settings',name:'多图收起',icon:'photo_library',mount,unmount:container=>{panels.get(container)?.dispose();panels.delete(container);}}]
  });
  scan();
})();
