(() => {
  'use strict';

  const ID = 'roche-screen-awake';
  const NAME = '亮屏守护';
  if (typeof window.RochePlugin?.register !== 'function') return;
  window.__rocheScreenAwake?.dispose();

  const wakeLock = navigator.wakeLock;
  const messages = {
    off: ['未开启', '打开后，Roche 留在屏幕上时可防止自动熄屏。'],
    requesting: ['正在申请', '正在向系统申请亮屏。'],
    active: ['正在亮屏', '切换 App 或手动锁屏时，系统会释放亮屏锁。'],
    paused: ['已暂停', '回到 Roche 后会重新申请。'],
    released: ['系统已释放', '继续亮屏可点「重新申请」。'],
    denied: ['系统暂未允许', '低电量模式可能限制亮屏，调整后可重新申请。'],
    unsupported: ['当前环境不支持', '主屏幕版 Roche 需要 iOS 18.4 或更新版本。'],
  };

  let requested = false;
  let inFlight = false;
  let lock = null;
  let revision = 0;
  let disposed = false;
  let render = null;
  let status = wakeLock ? 'off' : 'unsupported';

  function show(nextStatus) {
    status = nextStatus;
    render?.();
  }

  function canAcquire() {
    return wakeLock && requested && !disposed && document.visibilityState === 'visible';
  }

  function release() {
    const current = lock;
    lock = null;
    if (current && !current.released) void current.release().catch(() => {});
  }

  async function acquire() {
    if (!canAcquire() || inFlight || (lock && !lock.released)) return;

    const attempt = revision;
    inFlight = true;
    show('requesting');
    try {
      const candidate = await wakeLock.request('screen');
      if (attempt !== revision || !canAcquire()) {
        if (!candidate.released) await candidate.release();
        return;
      }
      if (candidate.released) {
        show('released');
        return;
      }

      lock = candidate;
      lock.addEventListener('release', () => {
        if (lock !== candidate) return;
        lock = null;
        show(document.visibilityState === 'visible' ? 'released' : 'paused');
      }, { once: true });
      show('active');
    } catch {
      if (attempt === revision && canAcquire()) show('denied');
    } finally {
      inFlight = false;
      if (attempt !== revision && canAcquire()) void acquire();
    }
  }

  function setRequested(value) {
    requested = value;
    revision++;
    if (requested) {
      if (inFlight) show('requesting');
      void acquire();
    } else {
      release();
      show('off');
    }
  }

  function pause() {
    revision++;
    release();
    if (requested) show('paused');
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') void acquire();
    else pause();
  }

  function dispose() {
    disposed = true;
    requested = false;
    revision++;
    release();
    render = null;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', onVisibility);
    if (window.__rocheScreenAwake?.dispose === dispose) delete window.__rocheScreenAwake;
  }

  function mount(element) {
    const panel = document.createElement('section');
    panel.className = 'roche-awake';
    panel.innerHTML = `
      <style>
        .roche-awake {
          color-scheme: light dark;
          --surface: light-dark(#fff,#1d1c23);
          --ink: light-dark(#17171a,#f0eff2);
          --secondary: light-dark(#555560,#c2c0cb);
          --line: light-dark(#dddde2,#494952);
          --rail: light-dark(#c7c7d0,#696871);
          --on: light-dark(#24232b,#e5e3eb);
          --thumb-on: light-dark(#fff,#24232b);
          box-sizing: border-box; max-width: 31rem; margin: 0 auto; padding: 2rem 1.375rem;
          color: var(--ink); background: var(--surface);
          font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        .roche-awake h1 { font-size: 1.5rem; line-height: 1.2; font-weight: 740; margin: 0 0 1.25rem; }
        .roche-awake .awake-row {
          display: flex; align-items: center; justify-content: space-between; gap: .75rem;
          padding: .625rem 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
        }
        .roche-awake .awake-label { font-size: 1.0625rem; font-weight: 650; }
        .roche-awake button { font: inherit; color: inherit; touch-action: manipulation; cursor: pointer; }
        .roche-awake button:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
        .roche-awake .awake-switch {
          border: 0; background: none; border-radius: 999px; padding: 0;
          min-height: 48px; min-width: 52px; display: inline-grid; place-items: center; flex-shrink: 0;
        }
        .roche-awake .awake-switch[disabled] { cursor: default; opacity: .55; }
        .roche-awake .awake-rail { display: block; width: 48px; height: 28px; border-radius: 999px; background: var(--rail); }
        .roche-awake .awake-rail::after {
          content: ""; display: block; width: 20px; height: 20px; margin: 4px;
          background: #fff; border-radius: 50%; transition: transform 160ms ease-out;
        }
        .roche-awake [aria-checked="true"] .awake-rail { background: var(--on); }
        .roche-awake [aria-checked="true"] .awake-rail::after { transform: translateX(20px); background: var(--thumb-on); }
        .roche-awake .awake-status { margin: 1.125rem 0 .3125rem; font-size: .9375rem; font-weight: 670; }
        .roche-awake .awake-help { margin: 0; color: var(--secondary); font-size: .875rem; line-height: 1.65; font-weight: 520; }
        .roche-awake .awake-retry {
          margin-top: .75rem; min-height: 44px; padding: 0 .875rem;
          border-radius: 999px; border: 1px solid var(--line); background: transparent; font-weight: 615; font-size: .875rem;
        }
        .roche-awake .awake-retry:hover { border-color: var(--ink); }
        @media (prefers-reduced-motion: reduce) { .roche-awake .awake-rail::after { transition: none; } }
      </style>
      <h1>亮屏守护</h1>
      <div class="awake-row">
        <span class="awake-label" id="roche-awake-label">保持屏幕亮起</span>
        <button type="button" class="awake-switch" role="switch" aria-labelledby="roche-awake-label">
          <span class="awake-rail" aria-hidden="true"></span>
        </button>
      </div>
      <div role="status" aria-live="polite">
        <p class="awake-status"></p>
        <p class="awake-help"></p>
      </div>
      <button type="button" class="awake-retry" hidden>重新申请</button>
    `;
    element.replaceChildren(panel);

    const toggle = panel.querySelector('.awake-switch');
    const retry = panel.querySelector('.awake-retry');
    const label = panel.querySelector('.awake-status');
    const help = panel.querySelector('.awake-help');
    toggle.disabled = !wakeLock;
    toggle.onclick = () => setRequested(!requested);
    retry.onclick = () => void acquire();
    render = () => {
      toggle.setAttribute('aria-checked', String(requested));
      [label.textContent, help.textContent] = messages[status];
      retry.hidden = status !== 'released' && status !== 'denied';
    };
    render();
  }

  window.__rocheScreenAwake = { dispose };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', onVisibility);
  window.RochePlugin.register({
    id: ID,
    name: NAME,
    version: '0.1.0',
    apps: [{
      id: ID + '-app',
      name: NAME,
      icon: 'light_mode',
      mount,
      unmount(element) {
        render = null;
        element?.replaceChildren();
      },
    }],
  });
})();
