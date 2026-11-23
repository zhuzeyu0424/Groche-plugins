/* Roche 通知节奏 0.1.0 */
(() => {
  'use strict';
  const ID = 'roche-notification-pace', VERSION = '0.1.0';
  const PREF = ID + ':enabled';
  const audited = new Set([
    'ba249549fdfdb9d45f8bada5ac79d3e492eea86ad359557fcee32bc4c676d62f',
    'a9c889b8c18e167fff6af8bd8458a362e93f3d920210334d88f7f5fab6853e25'
  ]);
  if (!window.RochePlugin?.register) return;
  window.__rocheNotificationPace?.dispose?.();
  let enabled = true, disposed = false, host, detach, timer, visibleAt = 0;
  let audio, audioHint = '', renderSettings;
  const pending = [];
  try { enabled = localStorage.getItem(PREF) !== 'false'; } catch {}

  function soundUrl() {
    const value = host?.state.customAlertSoundEnabled && host.state.customAlertSoundUrl;
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value.trim(), location.href);
      if (['https:', 'blob:'].includes(url.protocol) ||
          (url.protocol === 'data:' && /^data:audio\//i.test(value.trim()))) return url.href;
    } catch {}
    return '';
  }

  async function playSound() {
    const url = soundUrl();
    if (!url) return;
    try {
      audio ||= new Audio();
      audio.preload = 'auto';
      audio.referrerPolicy = 'no-referrer';
      if (audio.src !== url) audio.src = url;
      audio.currentTime = 0;
      await audio.play();
      audioHint = '';
    } catch (error) {
      audioHint = error?.name === 'NotAllowedError' ? '点一下「试听」来开启声音' : '提示音加载失败，请检查 Roche 的音源';
    }
    renderSettings?.();
  }

  function textDelay(text) {
    const line = String(text || '').replace(/\s+/gu, ' ').slice(0, 160);
    const cjk = line.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length || 0;
    const words = line.match(/[\p{Script=Latin}\p{N}]+/gu)?.length || 0;
    const pauses = line.match(/[，。！？,.!?…]/gu)?.length || 0;
    return Math.max(1450, Math.min(4400, 950 + cjk * 75 + words * 155 + pauses * 70));
  }

  const foreground = () => enabled && !disposed && document.visibilityState === 'visible' &&
    host?.state.useSystemNotification === false;
  const isInChat = notice => String(host?.native.store.aiRequestState.activeConversationId || '') === String(notice.conversationId);
  function clearQueue() {
    clearTimeout(timer);
    timer = undefined;
    visibleAt = 0;
    pending.length = 0;
  }

  function schedule() {
    if (timer !== undefined || !pending.length) return;
    const nextAt = () => {
      const audioGap = audio && !audio.paused && Number.isFinite(audio.duration)
        ? Math.min(6000, Math.max(0, audio.duration * 1000 + 120)) : 0;
      return visibleAt ? visibleAt + Math.max(textDelay(pending[0].notice.text), audioGap) : 0;
    };
    timer = setTimeout(() => {
      timer = undefined;
      if (!foreground()) { clearQueue(); return; }
      if (performance.now() + 12 < nextAt()) { schedule(); return; }
      const next = pending.shift();
      if (!isInChat(next.notice)) {
        visibleAt = performance.now();
        host.show(next.notice);
        if (next.sound) void playSound();
      }
      schedule();
    }, Math.max(0, nextAt() - performance.now()));
  }

  function connect(native, url) {
    const state = native.store.notificationState;
    const noticeKey = 'lastNotification', soundKey = 'customAlertSoundEnabled';
    const oldNotice = Object.getOwnPropertyDescriptor(state, noticeKey);
    const oldSound = Object.getOwnPropertyDescriptor(state, soundKey);
    if (![oldNotice, oldSound].every(field => field?.configurable && field?.writable) ||
        typeof oldSound.value !== 'boolean' || typeof state.useSystemNotification !== 'boolean') return;
    let visible = oldNotice.value, soundEnabled = oldSound.value, publishing = false;
    let mutedThisTurn = false;
    const show = notice => {
      publishing = true;
      try { state[noticeKey] = notice; }
      finally { publishing = false; }
    };
    const getNotice = () => visible;
    const setNotice = notice => {
      if (publishing) { visible = notice; return; }
      const sound = mutedThisTurn;
      mutedThisTurn = false;
      if (!notice || !notice.conversationId || notice.deliveredViaSystem || !foreground()) {
        visible = notice;
        clearQueue();
        return;
      }
      if (!isInChat(notice)) {
        pending.push({notice, sound});
        schedule();
      }
    };
    const getSound = () => {
      if (soundEnabled && foreground() && state.customAlertSoundUrl &&
          String(new Error().stack || '').includes(url)) {
        // The audited addMessage branch reads this immediately before playing its sound.
        // The settings UI still sees the stored switch. The matching banner plays the sound.
        if (!mutedThisTurn) queueMicrotask(() => { mutedThisTurn = false; });
        mutedThisTurn = true;
        return false;
      }
      return soundEnabled;
    };
    const setSound = value => { soundEnabled = value; };
    try {
      Object.defineProperty(state, noticeKey, { configurable:true, enumerable:oldNotice.enumerable, get:getNotice, set:setNotice });
      Object.defineProperty(state, soundKey, { configurable:true, enumerable:oldSound.enumerable, get:getSound, set:setSound });
    } catch (error) {
      Object.defineProperty(state, noticeKey, oldNotice);
      throw error;
    }
    host = {native, state, show};
    detach = () => {
      if (Object.getOwnPropertyDescriptor(state, noticeKey)?.get === getNotice)
        Object.defineProperty(state, noticeKey, { ...oldNotice, value:visible });
      if (Object.getOwnPropertyDescriptor(state, soundKey)?.get === getSound)
        Object.defineProperty(state, soundKey, { ...oldSound, value:soundEnabled });
    };
  }

  async function attach() {
    const urls = new Set();
    for (const entry of performance.getEntriesByType('resource')) {
      try {
        const url = new URL(entry.name, location.href);
        if (url.origin === location.origin && /\/ai-core-[\w-]+\.js$/.test(url.pathname)) urls.add(url.href);
      } catch {}
    }
    for (const url of urls) {
      try {
        const module = await import(url);
        const native = Object.values(module).find(item => typeof item?.addMessage === 'function' &&
          item.store?.notificationState && item.store.aiRequestState);
        if (!native) continue;
        const bytes = new TextEncoder().encode(Function.prototype.toString.call(native.addMessage));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        if (audited.has(hash) && !disposed) connect(native, url);
        if (host) break;
      } catch {}
    }
    renderSettings?.();
  }

  function toggle(value) {
    enabled = value;
    try { localStorage.setItem(PREF, String(value)); } catch {}
    if (!enabled) { clearQueue(); audio?.pause(); }
  }

  function mount(el) {
    const section = document.createElement('section');
    section.style.cssText = 'max-width:440px;margin:auto;padding:28px 22px;line-height:1.6;color:inherit';
    section.innerHTML = '<h2 style="font-size:24px;font-weight:750;margin-bottom:20px">通知节奏</h2>' +
      '<label style="display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px;font-weight:650">模拟打字间隔<input type="checkbox"></label>' +
      '<p role="status" style="font-size:14px;margin:12px 0 20px"></p>' +
      '<button type="button" style="min-height:44px;border-radius:999px;padding:0 16px;background:#1c1c1e;color:#fff;font-weight:650">试听当前提示音</button>';
    el.replaceChildren(section);
    const check = section.querySelector('input'), status = section.querySelector('p'), test = section.querySelector('button');
    check.onchange = () => { toggle(check.checked); renderSettings(); };
    test.onclick = () => { void playSound(); };
    renderSettings = () => {
      check.checked = enabled;
      check.disabled = !host;
      test.disabled = !soundUrl();
      status.textContent = !host ? '尚未适配此版本的 Roche 通知' : host.state.useSystemNotification ?
        '当前使用系统通知。切换到 Roche 的页面通知后生效。' :
        audioHint || (enabled ? '第一条立即显示，后续通知按内容长短逐条出现。' : '目前使用 Roche 的通知速度。');
    };
    renderSettings();
    if (!host) void ready.then(() => renderSettings?.());
  }

  function visibility() {
    if (document.visibilityState !== 'visible') { clearQueue(); audio?.pause(); }
  }
  function dispose() {
    disposed = true;
    clearQueue();
    audio?.pause();
    detach?.();
    renderSettings = null;
    document.removeEventListener('visibilitychange', visibility);
  }

  document.addEventListener('visibilitychange', visibility);
  window.__rocheNotificationPace = {version:VERSION, dispose};
  const ready = attach();
  window.RochePlugin.register({
    id:ID, version:VERSION, name:'通知节奏',
    apps:[{id:ID+'-settings', name:'通知节奏', icon:'notifications', mount, unmount:el=>{ renderSettings=null; el?.replaceChildren(); }}]
  });
})();
