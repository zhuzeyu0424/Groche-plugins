(() => {
  'use strict';

  const ID = 'roche-voice-duration';
  const VERSION = '0.1.0';
  const NAME = '语音时长校准';
  if (typeof window.RochePlugin?.register !== 'function') return;
  window.__rocheVoiceDuration?.dispose();

  const VOICE = '.chat-card--voice[data-card-type="voice"]';
  const CARD = '.chat-viewport-root ' + VOICE;
  const PLAYER = 'audio#tts-audio-player';
  const MEDIA_EVENTS = ['loadedmetadata', 'durationchange', 'playing'];
  const labels = new WeakMap();
  const durations = new Map();
  let audioCache;
  let cacheRequest;
  let frame = 0;
  let disposed = false;

  function resolveAudioCache() {
    if (cacheRequest) return cacheRequest;
    const entry = performance.getEntriesByType('resource').find(resource => {
      const url = new URL(resource.name);
      return url.origin === location.origin && /^\/assets\/ai-core-[\w-]+\.js$/.test(url.pathname);
    });
    if (!entry) return Promise.resolve();

    // Import the already loaded Roche module. Its cache maps message IDs to blob URLs.
    cacheRequest = import(entry.name).then(module => {
      const cache = module.w?.ttsCache;
      if (cache instanceof Map) audioCache = cache;
    }).catch(() => { cacheRequest = undefined; });
    return cacheRequest;
  }

  function labelNode(card) {
    const row = card.firstElementChild;
    if (!row?.querySelector('.chat-voice-wave')) return null;
    const label = Array.from(row.children).find(element =>
      element.tagName === 'SPAN' && !element.classList.contains('animate-spin'));
    const text = label?.firstChild;
    return text?.nodeType === Node.TEXT_NODE && text === label.lastChild ? text : null;
  }

  function updateLabels() {
    frame = 0;
    for (const card of document.querySelectorAll(CARD)) {
      const text = labelNode(card);
      if (!text) continue;
      let previous = labels.get(text);
      if (!previous || text.data !== previous.display) {
        if (!/^\d{1,2}'$/.test(text.data)) continue;
        previous = { original: text.data, display: text.data };
        labels.set(text, previous);
      }

      const message = card.closest('.chat-message-row > [id^="msg-"]');
      const source = message && audioCache?.get('tts_' + message.id.slice(4));
      const seconds = durations.get(source);
      const display = seconds === undefined ? '语音' : `${seconds}'`;
      previous.display = display;
      if (text.data !== display) text.data = display;
    }
  }

  function queueUpdate() {
    if (!disposed && !frame) frame = requestAnimationFrame(updateLabels);
  }

  async function measure(player) {
    if (!player?.matches?.(PLAYER) || !document.querySelector(CARD)) return;
    const source = player.currentSrc || player.src;
    const duration = player.duration;
    if (!source.startsWith('blob:') || !Number.isFinite(duration) || duration <= 0) return;

    await resolveAudioCache();
    if (disposed || !audioCache) return;
    durations.set(source, Math.max(1, Math.round(duration)));
    if (durations.size > 256) durations.delete(durations.keys().next().value);
    queueUpdate();
  }

  function onMedia(event) {
    void measure(event.target);
  }

  function affectsVoice(record) {
    const target = record.target.nodeType === Node.TEXT_NODE
      ? record.target.parentElement
      : record.target;
    if (target?.closest?.(VOICE)) return true;
    return Array.from(record.addedNodes).some(node =>
      node.matches?.(VOICE) || node.querySelector?.(VOICE));
  }

  const observer = new MutationObserver(records => {
    if (records.some(affectsVoice)) queueUpdate();
  });

  function dispose() {
    disposed = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    for (const event of MEDIA_EVENTS) document.removeEventListener(event, onMedia, true);
    for (const card of document.querySelectorAll(CARD)) {
      const text = labelNode(card);
      const previous = labels.get(text);
      if (previous && text.data === previous.display) text.data = previous.original;
    }
  }

  window.RochePlugin.register({ id: ID, name: NAME, version: VERSION });
  window.__rocheVoiceDuration = { dispose };
  for (const event of MEDIA_EVENTS) document.addEventListener(event, onMedia, true);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  queueUpdate();
  void measure(document.querySelector(PLAYER));
})();
