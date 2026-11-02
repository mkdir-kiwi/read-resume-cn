// 后台负责标签页和存储。网页脚本负责浮球和阅读位置。
const PROJECT = 'project:';
const webURL = url => /^https?:\/\//i.test(url || '');
const checkpointKey = id => `checkpoint:${id}`;
const pendingKey = id => `pending:${id}`;

function withTimeout(promise, ms = 1800) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('页面未响应')), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function positionFor(tab) {
  try {
    const position = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE' }, { frameId: 0 }));
    if (position?.url === tab.url) return { ...position, fromCache: false };
  } catch { /* 休眠或未加载内容脚本：读取上次浏览时的记录。 */ }
  const key = checkpointKey(tab.id);
  const cached = (await chrome.storage.session.get(key))[key];
  return cached?.url === tab.url ? { ...cached, fromCache: true } : null;
}

async function saveTabs(tabs, name) {
  const supported = tabs.filter(tab => webURL(tab.url) && !tab.incognito);
  if (!supported.length) throw new Error('没有可保存的 HTTP/HTTPS 网页。请先打开普通网页。');
  // 每次保存独立项目，避免两次保存互相覆盖。
  const entries = [];
  for (let offset = 0; offset < supported.length; offset += 8) {
    entries.push(...await Promise.all(supported.slice(offset, offset + 8).map(async tab => ({
      url: tab.url, title: tab.title || tab.url, windowId: tab.windowId,
      index: tab.index, pinned: !!tab.pinned, active: !!tab.active,
      position: await positionFor(tab)
    }))));
  }
  const project = {
    id: crypto.randomUUID(), version: 1, createdAt: Date.now(),
    name: String(name || '').trim().slice(0, 100) || `阅读存档 · ${new Date().toLocaleString('zh-CN')}`,
    tabs: entries
  };
  await chrome.storage.local.set({ [PROJECT + project.id]: project });
  return {
    total: entries.length, positions: entries.filter(t => t.position).length,
    cached: entries.filter(t => t.position?.fromCache).length,
    skipped: tabs.length - entries.length
  };
}

async function restoreProject(id) {
  const key = PROJECT + id;
  const project = (await chrome.storage.local.get(key))[key];
  if (!project) throw new Error('找不到这个存档。');
  const entries = project.tabs.filter(t => webURL(t.url));
  if (!entries.length) throw new Error('存档没有可恢复的网页。');
  // 在新窗口恢复，保留当前浏览现场。第一版将原来的多个窗口合并。
  const win = await chrome.windows.create({ url: 'about:blank', focused: true });
  let opened = 0;
  const failures = [];
  for (const entry of entries) {
    let tab;
    try {
      tab = opened === 0 ? win.tabs[0] : await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false });
      if (entry.position) {
        // 先写恢复任务，再导航，避免网页加载比任务注册更快。
        await chrome.storage.session.set({ [pendingKey(tab.id)]: {
          url: entry.url, position: entry.position, expiresAt: Date.now() + 300000
        }});
      }
      await chrome.tabs.update(tab.id, { url: entry.url, pinned: entry.pinned });
      opened++;
    } catch {
      failures.push(entry.title);
      if (tab) await chrome.storage.session.remove(pendingKey(tab.id));
    }
  }
  return { opened, failed: failures.length };
}

async function handle(message, sender) {
  const type = message?.type;
  const fromExtension = !!sender.url?.startsWith(chrome.runtime.getURL(''));
  const fromPage = !fromExtension && !!sender.tab;
  // 内容脚本只能提交自己的位置，或发起浮球上的几个操作。
  const pageAllowed = ['CHECKPOINT', 'RESTORE_GET', 'RESTORE_DONE', 'SAVE_CURRENT', 'SAVE_WINDOW', 'SAVE_ALL', 'OPEN_MANAGER'];
  if (fromPage && (!pageAllowed.includes(type) || sender.frameId !== 0)) throw new Error('不支持的网页请求。');
  if (!fromPage && !fromExtension) throw new Error('不支持的请求来源。');

  if (type === 'CHECKPOINT') {
    if (!sender.tab || !webURL(message.position?.url) || message.position.url !== sender.tab.url) return null;
    await chrome.storage.session.set({ [checkpointKey(sender.tab.id)]: message.position });
    return null;
  }
  if (type === 'RESTORE_GET') {
    if (!sender.tab) return null;
    const key = pendingKey(sender.tab.id);
    const pending = (await chrome.storage.session.get(key))[key];
    if (pending?.expiresAt < Date.now()) { await chrome.storage.session.remove(key); return null; }
    return pending?.url === sender.tab.url ? pending : null;
  }
  if (type === 'RESTORE_DONE') {
    if (sender.tab) await chrome.storage.session.remove(pendingKey(sender.tab.id));
    return null;
  }
  if (type === 'OPEN_MANAGER') {
    const windowId = sender.tab?.windowId ?? message.windowId;
    await chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html?window=${windowId ?? ''}&select=${message.select ? '1' : '0'}`) });
    return null;
  }
  if (type === 'LIST_TABS') {
    const tabs = await chrome.tabs.query({ windowId: message.windowId });
    return tabs.filter(t => webURL(t.url) && !t.incognito).map(t => ({ id: t.id, title: t.title, url: t.url }));
  }
  if (['SAVE_CURRENT', 'SAVE_WINDOW', 'SAVE_ALL', 'SAVE_SELECTED'].includes(type)) {
    let tabs;
    if (type === 'SAVE_CURRENT') tabs = [sender.tab || await chrome.tabs.get(message.tabId)];
    if (type === 'SAVE_WINDOW') tabs = await chrome.tabs.query({ windowId: sender.tab?.windowId ?? message.windowId });
    if (type === 'SAVE_ALL') tabs = await chrome.tabs.query({});
    if (type === 'SAVE_SELECTED') {
      const ids = new Set(message.tabIds);
      tabs = (await chrome.tabs.query({})).filter(t => ids.has(t.id));
    }
    return saveTabs(tabs, message.name);
  }
  if (type === 'LIST_PROJECTS') {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([key]) => key.startsWith(PROJECT)).map(([, p]) => p).sort((a, b) => b.createdAt - a.createdAt);
  }
  if (type === 'DELETE_PROJECT') { await chrome.storage.local.remove(PROJECT + message.id); return null; }
  if (type === 'RESTORE_PROJECT') return restoreProject(message.id);
  throw new Error('未知操作。');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true; // 保持异步消息通道，直到存储操作结束。
});
chrome.tabs.onRemoved.addListener(id => {
  chrome.storage.session.remove([checkpointKey(id), pendingKey(id)]).catch(() => {});
});
