const status = document.getElementById('status');
let activeTab;
const ready = chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => { activeTab = tabs[0]; });
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '操作失败');
  return response.data;
}
async function run(action) {
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  status.textContent = '正在处理，请等待保存完成…';
  try { await ready; await action(); }
  catch (error) { status.textContent = error.message; }
  finally { document.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}
for (const button of document.querySelectorAll('[data-action]')) {
  button.onclick = () => run(async () => {
    const result = await send({ type: button.dataset.action, tabId: activeTab?.id, windowId: activeTab?.windowId, name: document.getElementById('name').value });
    status.textContent = `已保存 ${result.total} 页，${result.positions} 页包含阅读位置，${result.total - result.positions} 页仅网址。${result.cached ? `其中 ${result.cached} 页使用最近记录。` : ''}${result.skipped ? `跳过 ${result.skipped} 个特殊页面。` : ''}`;
  });
}
for (const id of ['select', 'history']) {
  document.getElementById(id).onclick = () => run(async () => {
    await send({ type: 'OPEN_MANAGER', windowId: activeTab?.windowId, select: id === 'select' });
    window.close();
  });
}
