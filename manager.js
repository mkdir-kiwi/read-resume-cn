const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let windowId = Number(params.get('window')) || undefined;
let projects = [];
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result.data;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text; // 标题与 URL 都按纯文本处理。
  if (className) node.className = className;
  return node;
}
async function run(action) {
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  $('status').textContent = '正在处理…';
  try { await action(); }
  catch (error) { $('status').textContent = error.message; }
  finally { document.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}
function show(selection) {
  $('selection').hidden = !selection;
  $('history').hidden = selection;
  $('show-history').className = selection ? 'secondary' : '';
  $('show-select').className = selection ? '' : 'secondary';
}
async function loadTabs() {
  if (!windowId) windowId = (await chrome.windows.getCurrent()).id;
  const tabs = await send({ type: 'LIST_TABS', windowId });
  $('tabs').replaceChildren();
  for (const tab of tabs) {
    const row = element('label', undefined, 'tab-row');
    const box = element('input'); box.type = 'checkbox'; box.value = tab.id; box.checked = true;
    const text = element('span'); text.append(element('strong', tab.title), element('small', tab.url));
    row.append(box, text); $('tabs').append(row);
  }
  if (!tabs.length) $('tabs').append(element('p', '这个窗口暂时没有可保存的普通网页。', 'empty'));
}
async function loadProjects() {
  projects = await send({ type: 'LIST_PROJECTS' });
  $('projects').replaceChildren();
  for (const project of projects) {
    const card = element('article', undefined, 'card');
    const positions = project.tabs.filter(t => t.position).length;
    card.append(element('h3', project.name), element('p', `${new Date(project.createdAt).toLocaleString('zh-CN')} · ${project.tabs.length} 个网页 · ${positions} 个阅读位置`, 'meta'));
    const actions = element('div', undefined, 'actions');
    const restore = element('button', '在新窗口继续阅读');
    restore.onclick = () => run(async () => {
      const result = await send({ type: 'RESTORE_PROJECT', id: project.id });
      $('status').textContent = `已打开 ${result.opened} 页${result.failed ? `，${result.failed} 页打开失败` : ''}。各网页会尝试恢复位置，链接打开成功不代表位置一定恢复。`;
    });
    const remove = element('button', '删除', 'secondary danger');
    remove.onclick = () => {
      if (!confirm(`删除“${project.name}”？原网页不会被关闭。`)) return;
      run(async () => { await send({ type: 'DELETE_PROJECT', id: project.id }); await loadProjects(); $('status').textContent = '已删除存档。'; });
    };
    actions.append(restore, remove); card.append(actions);
    const details = element('details'), list = element('ul');
    details.append(element('summary', '查看包含的网页'));
    for (const tab of project.tabs) {
      const item = element('li');
      const link = element('a', tab.title); link.href = tab.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      item.append(link, document.createTextNode(` · ${tab.position ? '包含位置' : '仅网址'}`)); list.append(item);
    }
    details.append(list); card.append(details); $('projects').append(card);
  }
  if (!projects.length) $('projects').append(element('p', '还没有阅读存档。打开几个网页，点击右下角“续”，保存你的第一个项目。', 'empty'));
}
$('show-history').onclick = () => run(async () => { show(false); await loadProjects(); $('status').textContent = ''; });
$('show-select').onclick = () => run(async () => { show(true); await loadTabs(); $('status').textContent = ''; });
$('refresh-tabs').onclick = () => run(async () => { await loadTabs(); $('status').textContent = '列表已刷新。'; });
$('toggle-all').onclick = () => {
  const boxes = [...$('tabs').querySelectorAll('input')];
  const checked = !boxes.every(box => box.checked); boxes.forEach(box => { box.checked = checked; });
};
$('save-selected').onclick = () => run(async () => {
  const ids = [...$('tabs').querySelectorAll('input:checked')].map(box => Number(box.value));
  if (!ids.length) throw new Error('请至少选择一个网页。');
  const result = await send({ type: 'SAVE_SELECTED', tabIds: ids, name: $('name').value });
  await loadProjects(); show(false);
  $('status').textContent = `已保存 ${result.total} 页，${result.positions} 页包含位置，${result.total - result.positions} 页仅网址。`;
});
$('export').onclick = () => run(async () => {
  const data = await send({ type: 'LIST_PROJECTS' });
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'read-resume-v1', projects: data }, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = `read-resume-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000); $('status').textContent = '已发起备份下载。备份含网页地址和定位用的短文本，请妥善保存。';
});
// 导入只接收已知字段和 HTTP(S) 地址，不信任备份中的 ID、HTML 或代码。
function validateBackup(value) {
  if (value?.format !== 'read-resume-v1' || !Array.isArray(value.projects) || value.projects.length > 500) throw new Error('备份格式不正确，或项目超过 500 个。');
  return value.projects.map(project => {
    if (!Array.isArray(project.tabs) || project.tabs.length < 1 || project.tabs.length > 500) throw new Error('每个项目必须包含 1–500 个网页。');
    const tabs = project.tabs.map(tab => {
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('备份包含不支持的网页地址。');
      let position = null;
      if (tab.position && tab.position.url === url.href) {
        const p = tab.position;
        const number = n => Number.isFinite(n) && n >= 0 && n < 1e9;
        if (!number(p.x) || !number(p.y) || !number(p.ratio) || p.ratio > 1) throw new Error('备份中的阅读位置无效。');
        position = { url: url.href, x: p.x, y: p.y, ratio: p.ratio, capturedAt: Number(p.capturedAt) || 0, anchor: null };
        if (typeof p.anchor?.text === 'string' && p.anchor.text.length > 0 && p.anchor.text.length <= 160 && number(p.anchor.offset)) position.anchor = { text: p.anchor.text, offset: p.anchor.offset };
      }
      return { url: url.href, title: String(tab.title || url.href).slice(0, 500), pinned: tab.pinned === true, position };
    });
    return { id: crypto.randomUUID(), version: 1, name: String(project.name || '导入的存档').slice(0, 100), createdAt: Number.isFinite(project.createdAt) && project.createdAt > 0 ? project.createdAt : Date.now(), tabs };
  });
}
$('import').onchange = () => run(async () => {
  const file = $('import').files[0];
  try {
    if (!file) { $('status').textContent = ''; return; }
    if (file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MB 的 JSON 备份。');
    const data = validateBackup(JSON.parse(await file.text()));
    if (!confirm(`将新增 ${data.length} 个存档，不覆盖已有数据。继续导入？`)) { $('status').textContent = '已取消导入。'; return; }
    await chrome.storage.local.set(Object.fromEntries(data.map(p => [`project:${p.id}`, p])));
    await loadProjects(); $('status').textContent = `已导入 ${data.length} 个项目。`;
  } finally { $('import').value = ''; }
});
run(async () => { show(params.get('select') === '1'); await Promise.all([loadProjects(), loadTabs()]); $('status').textContent = ''; });
