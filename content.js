(() => {
  if (globalThis.__readResumeLoaded) return;
  globalThis.__readResumeLoaded = true;
  const host = document.createElement('read-resume-widget');
  host.style.cssText = 'all:initial!important;position:fixed!important;right:22px!important;bottom:28px!important;z-index:2147483647!important;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host{font-family:system-ui,sans-serif;color:#183c37}*{box-sizing:border-box}
      button{font:inherit;cursor:pointer}#ball{width:50px;height:50px;border:1px solid #b5d8cf;border-radius:50%;background:#164e44;color:white;box-shadow:0 5px 22px #102b3833;font-size:20px;touch-action:none}
      #ball:focus-visible,button:focus-visible{outline:3px solid #e8ad45;outline-offset:2px}
      #panel{position:absolute;right:0;bottom:62px;width:260px;padding:16px;border:1px solid #cddbd5;border-radius:18px;background:#fffef9;box-shadow:0 12px 45px #102b3833;font-size:13px;line-height:1.6}
      h2{margin:0;font-size:18px}p{margin:4px 0 12px;color:#63736e}#panel button{display:block;width:100%;text-align:left;border:0;border-radius:8px;background:#edf4ee;color:#183c37;margin:6px 0;padding:9px 12px}#panel button:hover{background:#dcebe2}button:disabled{opacity:.55;cursor:wait}
      #status{display:block;margin-top:10px;white-space:pre-wrap}#toast{position:absolute;right:0;bottom:62px;width:245px;padding:12px;background:#183c37;color:white;border-radius:12px;font-size:13px;line-height:1.6}[hidden]{display:none!important}
    </style>
    <section id="panel" hidden aria-label="继续读菜单">
      <h2>继续读</h2><p>把现在读到的地方留给下次。</p>
      <button data-action="SAVE_CURRENT">保存当前网页</button>
      <button data-action="OPEN_MANAGER" data-select="1">选择网页保存…</button>
      <button data-action="SAVE_WINDOW">保存当前窗口全部网页</button>
      <button data-action="SAVE_ALL">保存所有窗口的网页</button>
      <button data-action="OPEN_MANAGER">查看历史项目</button>
      <button id="hide">本页暂时隐藏悬浮球</button>
      <span id="status" role="status" aria-live="polite"></span>
    </section>
    <div id="toast" role="status" hidden></div>
    <button id="ball" aria-label="继续读：打开保存菜单" aria-expanded="false" title="继续读 · 点击展开，拖动调整高度">续</button>`;
  document.documentElement.append(host);
  const ball = root.getElementById('ball'), panel = root.getElementById('panel');
  const status = root.getElementById('status'), toast = root.getElementById('toast');
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '扩展连接已断开，请刷新网页。');
    return result.data;
  }
  function notice(text) { toast.textContent = text; toast.hidden = false; setTimeout(() => { toast.hidden = true; }, 4500); }
  function toggle() { panel.hidden = !panel.hidden; toast.hidden = true; ball.setAttribute('aria-expanded', String(!panel.hidden)); }
  let drag;
  ball.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { y: event.clientY, bottom: innerHeight - host.getBoundingClientRect().bottom, moved: false };
    ball.setPointerCapture(event.pointerId);
  });
  ball.addEventListener('pointermove', event => {
    if (!drag) return;
    const delta = drag.y - event.clientY;
    if (Math.abs(delta) > 5) drag.moved = true;
    if (drag.moved) host.style.setProperty('bottom', `${Math.max(20, Math.min(innerHeight - 400, drag.bottom + delta))}px`, 'important');
  });
  ball.addEventListener('pointerup', () => { if (drag && !drag.moved) toggle(); drag = null; });
  ball.addEventListener('pointercancel', () => { drag = null; });
  ball.addEventListener('click', event => { if (event.detail === 0) toggle(); });
  root.addEventListener('keydown', event => { if (event.key === 'Escape') { panel.hidden = true; ball.setAttribute('aria-expanded', 'false'); ball.focus(); } });
  root.getElementById('hide').onclick = () => host.remove();
  for (const button of root.querySelectorAll('[data-action]')) {
    button.onclick = async () => {
      const buttons = [...root.querySelectorAll('[data-action]')];
      buttons.forEach(b => { b.disabled = true; });
      status.textContent = '正在处理，请稍候…';
      try {
        const result = await send({ type: button.dataset.action, select: button.dataset.select === '1' });
        status.textContent = result ? `已保存 ${result.total} 页；${result.positions} 页包含阅读位置，${result.total - result.positions} 页仅网址。${result.cached ? `其中 ${result.cached} 页使用最近记录。` : ''}${result.skipped ? `跳过 ${result.skipped} 个特殊页面。` : ''}` : '已打开项目管理。';
      } catch (error) { status.textContent = error.message; }
      finally { buttons.forEach(b => { b.disabled = false; }); }
    };
  }

  // 第一版只记录主页面滚动。嵌套滚动容器、PDF、视频进度不在支持范围。
  function capture() {
    const height = document.documentElement.scrollHeight - innerHeight;
    const candidates = [...document.querySelectorAll('h1,h2,h3,p,li')].slice(0, 2000);
    const visible = candidates.find(el => {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim();
      return rect.height > 0 && rect.top >= 0 && rect.top < innerHeight * .7 && text.length >= 12 && text.length < 1500;
    });
    return {
      url: location.href, x: scrollX, y: scrollY, ratio: height > 0 ? scrollY / height : 0,
      anchor: visible ? { text: visible.textContent.trim().slice(0, 160), offset: visible.getBoundingClientRect().top } : null,
      capturedAt: Date.now()
    };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'CAPTURE') respond(capture());
  });
  let restoring = true, timer;
  function checkpoint() {
    if (!restoring) send({ type: 'CHECKPOINT', position: capture() }).catch(() => {});
  }
  document.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(checkpoint, 800); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) checkpoint(); });

  async function restore() {
    const pending = await send({ type: 'RESTORE_GET' });
    if (!pending) return;
    let cancelled = false;
    const stop = () => { cancelled = true; };
    const keyStop = event => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) stop(); };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('pointerdown', stop, { passive: true });
    window.addEventListener('keydown', keyStop);
    const position = pending.position;
    let matched = false, target = 0, stable = 0, lastHeight = -1;
    try {
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
        const height = document.documentElement.scrollHeight;
        stable = height === lastHeight ? stable + 1 : 0;
        lastHeight = height;
        const anchor = position.anchor && [...document.querySelectorAll('h1,h2,h3,p,li')].slice(0, 2000)
          .find(el => el.getBoundingClientRect().height > 0 && (el.textContent || '').trim().startsWith(position.anchor.text));
        matched = !!anchor;
        target = anchor ? scrollY + anchor.getBoundingClientRect().top - position.anchor.offset : position.y;
        // 页面高度不够时继续等待图片/正文加载，不提前判定恢复成功。
        window.scrollTo({ left: position.x || 0, top: target, behavior: 'instant' });
        if (attempt >= 5 && stable >= 3 && Math.abs(scrollY - Math.max(0, target)) < 8) break;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!cancelled) notice(matched ? '已定位到上次阅读的段落附近。' : '已尝试恢复滚动位置；请核对，页面内容可能已变化。');
    } finally {
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('pointerdown', stop);
      window.removeEventListener('keydown', keyStop);
      await send({ type: 'RESTORE_DONE' });
    }
  }
  restore().catch(() => {}).finally(() => { restoring = false; checkpoint(); });
})();
