/* Browser-local reading preferences. Editing never changes the crawler scope. */
(() => {
  'use strict';
  const groups = [
    {key: 'preferredKeywords', container: 'selectedKeywords', input: 'keywordInput', add: 'addKeyword', copy: 'copyKeywords', label: '关键词'},
    {key: 'preferredAuthors', container: 'selectedAuthors', input: 'authorInput', add: 'addAuthor', copy: 'copyAuthors', label: '作者'}
  ];
  let snapshot = {}, dirty = false, editRevision = 0;
  const SAVE_LOCK = 'paper-radar.preferences.mutation';
  const normalize = value => value.normalize('NFKC').trim().toLowerCase();
  const values = group => [...document.getElementById(group.container).querySelectorAll('[data-value]')].map(tag => tag.dataset.value);
  function notice(message, error = false) {
    const host = document.getElementById('preferencesStatus');
    host.textContent = message;
    host.classList.toggle('preferences-error', error);
  }
  function changed() { editRevision++; dirty = true; notice('有未保存的更改。点击“保存偏好”后应用到论文工作台。'); }
  function empty(group) {
    const host = document.getElementById(group.container);
    if (!host.children.length) {
      const message = document.createElement('p'); message.className = 'empty-tag-message';
      message.textContent = `尚未添加${group.label}。`; host.append(message);
    }
  }
  function add(group, value, edited = true) {
    if (typeof value !== 'string' || !value.trim()) return;
    value = value.trim();
    const host = document.getElementById(group.container);
    const duplicate = [...host.querySelectorAll('[data-value]')].find(tag => normalize(tag.dataset.value) === normalize(value));
    if (duplicate) { duplicate.querySelector('button').focus(); return; }
    host.querySelector('.empty-tag-message')?.remove();
    const tag = document.createElement('span'); tag.className = 'category-button'; tag.dataset.value = value;
    tag.append(document.createTextNode(value + ' '));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-tag';
    remove.textContent = '×'; remove.setAttribute('aria-label', `删除${group.label}：${value}`);
    remove.onclick = () => { tag.remove(); empty(group); changed(); document.getElementById(group.input).focus(); };
    tag.append(remove); host.append(tag); if (edited) changed();
  }
  function collectInput(group) {
    const input = document.getElementById(group.input);
    input.value.split(/[,，\n]/).forEach(value => add(group, value)); input.value = '';
  }
  function load() {
    let unreadable = false;
    editRevision++;
    groups.forEach(group => {
      const host = document.getElementById(group.container); host.replaceChildren();
      snapshot[group.key] = undefined;
      try {
        snapshot[group.key] = localStorage.getItem(group.key);
        const saved = JSON.parse(snapshot[group.key] || '[]');
        if (!Array.isArray(saved)) throw new Error('Invalid preferences');
        for (const value of saved) {
          if (typeof value === 'string' && value.trim()) add(group, value, false);
          else unreadable = true;
        }
      } catch (_) { unreadable = true; }
      empty(group);
    });
    dirty = false;
    notice(unreadable ? '部分偏好无法读取，原始记录未被改动。请核对当前编辑内容后再保存。' : '偏好保存在本浏览器；支持逗号分组和 | 同义词。', unreadable);
  }
  async function save() {
    groups.forEach(collectInput);
    if (groups.some(group => snapshot[group.key] === undefined)) {
      notice('部分原始偏好尚未读取，本次未保存。请先复制编辑内容，再点“重新载入”，以免覆盖已有偏好。', true); return false;
    }
    const expected = {...snapshot}, revision = editRevision;
    const next = Object.fromEntries(groups.map(group => [group.key, JSON.stringify(values(group))]));
    function transaction() {
      const before = {}, written = [];
      if (editRevision !== revision) {
        notice('等待保存时编辑内容发生了变化，本次未写入。请核对后再次保存。', true); return false;
      }
      try {
        for (const group of groups) {
          before[group.key] = localStorage.getItem(group.key);
          if (before[group.key] !== expected[group.key]) {
            notice('其他标签页已修改偏好。请点“重新载入”查看最新内容后再保存。', true); return false;
          }
        }
        for (const group of groups) { localStorage.setItem(group.key, next[group.key]); written.push(group.key); }
        snapshot = {...next}; dirty = false; notice('偏好已保存，返回论文工作台即可使用。'); return true;
      } catch (_) {
        // Roll back a partial write only while it still contains our own value.
        for (const key of written.reverse()) {
          try {
            if (localStorage.getItem(key) === next[key]) {
              if (before[key] === null) localStorage.removeItem(key); else localStorage.setItem(key, before[key]);
            }
          } catch (_) { /* Keep the editor intact even if storage is unavailable. */ }
        }
        notice('保存未完成：浏览器存储不可用或已满。编辑内容仍在，请先复制备份，再重试。', true); return false;
      }
    }
    const control = document.getElementById('saveSettings');
    control.disabled = true; control.setAttribute('aria-busy', 'true');
    notice('正在保存偏好…');
    try {
      if (!navigator.locks?.request) return transaction();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try { return await navigator.locks.request(SAVE_LOCK, {signal: controller.signal}, transaction); }
      finally { clearTimeout(timeout); }
    } catch (error) {
      notice(error.name === 'AbortError' ? '另一窗口正在保存偏好，本次尚未保存，请稍后重试。' : '保存未完成，请复制编辑内容后重试。', true); return false;
    } finally {
      control.disabled = false; control.removeAttribute('aria-busy');
    }
  }
  async function copy(group) {
    collectInput(group);
    const text = values(group).join(',');
    if (!text) { notice(`没有可复制的${group.label}。`); return; }
    try { await navigator.clipboard.writeText(text); notice(`${group.label}已复制。`); }
    catch (_) {
      const dialog = document.createElement('dialog'); dialog.className = 'preferences-copy-dialog';
      const heading = document.createElement('p'); heading.textContent = '自动复制不可用，请选中文字后手动复制。';
      const area = document.createElement('textarea'); area.value = text; area.readOnly = true; area.setAttribute('aria-label', `${group.label}备份`);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'button'; close.textContent = '关闭'; close.onclick = () => dialog.close();
      dialog.append(heading, area, close); document.body.append(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal(); area.focus(); area.select();
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    load();
    groups.forEach(group => {
      document.getElementById(group.add).onclick = () => collectInput(group);
      document.getElementById(group.input).addEventListener('input', changed);
      document.getElementById(group.input).addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); collectInput(group); }
      });
      document.getElementById(group.copy).onclick = () => copy(group);
    });
    document.getElementById('saveSettings').onclick = save;
    document.getElementById('reloadPreferences').onclick = () => { groups.forEach(group => { document.getElementById(group.input).value = ''; }); load(); };
    document.getElementById('resetSettings').onclick = () => {
      groups.forEach(group => { document.getElementById(group.container).replaceChildren(); document.getElementById(group.input).value = ''; empty(group); });
      editRevision++; dirty = true; notice('已清空编辑内容，点击“保存偏好”后才会应用。');
    };
    window.addEventListener('storage', event => {
      if (event.key !== null && !groups.some(group => group.key === event.key)) return;
      if (dirty) notice('其他标签页已修改偏好。当前编辑仍保留，可点“重新载入”查看最新内容。', true);
      else load();
    });
    fetch(`https://api.github.com/repos/${DATA_CONFIG.repoOwner}/${DATA_CONFIG.repoName}`).then(response => {
      if (!response.ok) throw new Error('Statistics unavailable'); return response.json();
    }).then(data => { document.getElementById('starCount').textContent = data.stargazers_count; document.getElementById('forkCount').textContent = data.forks_count; }).catch(() => {});
  });
})();
