/* Personal reading list: independent of the daily feed and its filters. */
(() => {
  'use strict';
  const KEY = 'paper-radar.reading-list.v1';
  const normalizeId = value => {
    const id = String(value || '').replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//, '').replace(/\.pdf$/, '').replace(/v\d+$/, '');
    if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i.test(id)) throw new Error('论文 ID 无效');
    return id;
  };
  const clean = value => {
    const id = normalizeId(value.id || value.url);
    if (typeof value.title !== 'string' || !value.title.trim()) throw new Error('论文标题缺失');
    return {id, title: value.title.slice(0, 2000), summary: String(value.summary || '').slice(0, 30000),
      authors: (Array.isArray(value.authors) ? value.authors.join(', ') : String(value.authors || '')).slice(0, 5000),
      authorNames: Array.isArray(value.authorNames) ? value.authorNames : Array.isArray(value.authors) ? value.authors : undefined,
      abstract: typeof value.abstract === 'string' ? value.abstract : typeof value.details === 'string' ? value.details : '',
      published: typeof value.published === 'string' && value.published ? value.published : typeof value.publicationDate === 'string' ? value.publicationDate : '',
      date: String(value.date || '').slice(0, 40), status: value.status === 'read' ? 'read' : 'pending',
      savedAt: Number.isFinite(value.savedAt) ? value.savedAt : Date.now()};
  };
  function read() {
    const data = JSON.parse(localStorage.getItem(KEY) || '{"version":1,"papers":[]}');
    if (data.version !== 1 || !Array.isArray(data.papers)) throw new Error('备份格式不支持');
    return data.papers.map(clean);
  }
  let papers = [], dialog, list, search, tabs, opener, toast, returnFocus;
  let view = 'pending';
  function notify(message, action) {
    toast.replaceChildren(document.createTextNode(message));
    if (action) {
      const button = element('button', '撤销');
      button.onclick = () => { action(); };
      toast.append(button);
    }
    const dismiss = element('button', '关闭提示');
    dismiss.onclick = () => toast.replaceChildren();
    toast.append(dismiss);
  }
  function commit(update) {
    try {
      const next = update(read()); // Merge against the latest state from other tabs.
      localStorage.setItem(KEY, JSON.stringify({version: 1, papers: next}));
      papers = next;
      refresh();
      return true;
    } catch (error) {
      notify('保存失败：浏览器存储不可用、已满或数据损坏。请先导出备份。');
      return false;
    }
  }
  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, action) {
    const el = element('button', text, 'rl-button');
    el.type = 'button'; el.onclick = action;
    return el;
  }
  function open() {
    returnFocus = document.activeElement;
    render(); dialog.showModal(); search.focus();
  }
  function mount(host, paper) {
    let id;
    try { id = normalizeId(paper.id || paper.url); } catch { return; }
    const control = button('', event => {
      event.stopPropagation();
      if (papers.some(p => p.id === id)) { open(); return; }
      if (commit(items => items.some(p => p.id === id) ? items : [clean({...paper, id, status: 'pending', savedAt: Date.now()}), ...items])) {
        notify('已加入待读。可从顶部「待读」继续阅读。');
      }
    });
    control.dataset.readingId = id;
    host.append(control); updateButton(control);
  }
  function updateButton(control) {
    const saved = papers.find(p => p.id === control.dataset.readingId);
    control.textContent = saved ? (saved.status === 'read' ? '✓ 已读 · 查看清单' : '✓ 已加入待读') : '+ 加入待读';
    control.setAttribute('aria-label', control.textContent);
    control.classList.toggle('rl-saved', !!saved);
  }
  function refreshButtons() {
    document.querySelectorAll('[data-reading-id]').forEach(updateButton);
  }
  function refresh() {
    if (!opener) return;
    opener.textContent = `待读 (${papers.filter(p => p.status === 'pending').length})`;
    refreshButtons();
    if (dialog.open) render();
  }
  function visiblePapers() {
    const query = search.value.trim().toLowerCase();
    return papers.filter(p => p.status === view && `${p.title} ${p.authors} ${p.summary} ${p.id}`.toLowerCase().includes(query))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  function render() {
    list.replaceChildren();
    tabs.querySelectorAll('button').forEach(tab => {
      tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
      const count = papers.filter(p => p.status === tab.dataset.view).length;
      tab.textContent = `${tab.dataset.view === 'pending' ? '待读' : '已读'} (${count})`;
    });
    const query = search.value.trim().toLowerCase();
    const selected = visiblePapers();
    if (!selected.length) list.append(element('p', query ? '没有匹配的论文，试试标题、作者或 arXiv ID。' : view === 'pending' ? '待读清单是空的。在论文卡片上点「加入待读」，下次就能从这里继续。' : '还没有已读论文。读完后可以手动标记。', 'rl-empty'));
    selected.forEach(paper => {
      const card = element('article', '', 'rl-entry');
      const title = element('a', paper.title, 'rl-title');
      title.href = `https://arxiv.org/abs/${paper.id}`; title.target = '_blank'; title.rel = 'noopener noreferrer';
      const meta = element('p', `${paper.authors}\n加入于 ${new Date(paper.savedAt).toLocaleDateString()} · ${paper.id}`, 'rl-meta');
      const details = element('details');
      details.append(element('summary', '查看摘要'), element('p', paper.summary || '暂无摘要'));
      const actions = element('div', '', 'rl-actions');
      const pdf = element('a', '打开 PDF', 'rl-button');
      pdf.href = `https://arxiv.org/pdf/${paper.id}`; pdf.target = '_blank'; pdf.rel = 'noopener noreferrer';
      actions.append(pdf, button(view === 'pending' ? '标记已读' : '放回待读', () => {
        const before = paper.status;
        if (commit(items => items.map(p => p.id === paper.id ? {...p, status: before === 'read' ? 'pending' : 'read'} : p))) {
          notify(before === 'read' ? '已放回待读' : '已标记为已读', () => {
            if (commit(items => items.map(p => p.id === paper.id ? {...p, status: before} : p))) notify('已撤销');
          });
        }
      }), button('移除', () => {
        if (commit(items => items.filter(p => p.id !== paper.id))) notify('已移出清单', () => {
          if (commit(items => items.some(p => p.id === paper.id) ? items : [paper, ...items])) notify('已恢复');
        });
      }));
      card.append(title, meta, details, actions); list.append(card);
    });
  }
  function init() {
    const header = document.querySelector('.header-controls');
    if (!header) return;
    toast = element('div', '', 'rl-toast'); toast.setAttribute('role', 'status');
    document.body.append(toast);
    try { papers = read(); } catch { notify('无法读取待读清单，请保留当前数据并尝试导出备份。'); }
    opener = button('待读 (0)', open); opener.id = 'readingListButton'; header.prepend(opener);
    dialog = element('dialog', '', 'rl-dialog'); dialog.setAttribute('aria-labelledby', 'readingListTitle');
    const heading = element('div', '', 'rl-heading');
    const title = element('h2', '我的阅读清单'); title.id = 'readingListTitle';
    heading.append(title, button('关闭', () => dialog.close()));
    dialog.addEventListener('close', () => returnFocus?.focus());
    dialog.addEventListener('keydown', e => e.stopPropagation());
    search = element('input'); search.type = 'search'; search.placeholder = '搜索标题、作者、摘要'; search.setAttribute('aria-label', '搜索阅读清单'); search.oninput = render;
    tabs = element('div', '', 'rl-actions');
    for (const status of ['pending', 'read']) {
      const tab = button('', () => { view = status; render(); }); tab.dataset.view = status; tabs.append(tab);
    }
    const backups = element('div', '', 'rl-actions');
    backups.append(button('导出备份', () => {
      const raw = localStorage.getItem(KEY) || JSON.stringify({version: 1, papers: []});
      const url = URL.createObjectURL(new Blob([raw], {type: 'application/json'}));
      const link = element('a'); link.href = url; link.download = `paper-radar-reading-${new Date().toISOString().slice(0, 10)}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    const file = element('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    file.onchange = async () => {
      try {
        if (!file.files[0]) return;
        if (file.files[0].size > 10 * 1024 * 1024) throw new Error('文件太大');
        const data = JSON.parse(await file.files[0].text());
        if (data.version !== 1 || !Array.isArray(data.papers)) throw new Error('格式错误');
        const imported = data.papers.map(clean);
        if (commit(items => {
          const map = new Map(items.map(p => [p.id, p]));
          for (const paper of imported) if (!map.has(paper.id)) map.set(paper.id, paper);
          return [...map.values()];
        })) notify('备份已合并，已有论文和阅读状态已保留。');
      } catch { notify('导入失败，请选择有效的 Paper Radar 阅读清单备份（不超过 10 MB）。'); }
      finally { file.value = ''; }
    };
    backups.append(button('导入备份', () => file.click()), file);
    const zotero = element('div', '', 'rl-actions');
    const scope = element('select', '', 'rl-button');
    scope.setAttribute('aria-label', 'Zotero 导出范围');
    for (const [value, label] of [['visible', '当前标签和搜索结果'], ['pending', '全部待读'], ['all', '整个阅读清单']]) {
      const option = element('option', label); option.value = value; scope.append(option);
    }
    zotero.append(scope, button('导出到 Zotero', () => {
      try {
        papers = read(); // Include changes saved in other tabs before exporting.
        const selected = scope.value === 'all' ? papers : scope.value === 'pending' ? papers.filter(p => p.status === 'pending') : visiblePapers();
        const result = window.ZoteroExport.build(selected);
        if (!result.items.length) { notify('没有可导出的论文，请调整范围或搜索条件。'); return; }
        const url = URL.createObjectURL(new Blob([result.content], {type: 'application/json;charset=utf-8'}));
        const link = element('a'); link.href = url; link.download = `paper-radar-zotero-${scope.value}-${new Date().toISOString().slice(0, 10)}.csl.json`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        const missing = result.missing;
        notify(`已导出 ${result.items.length} 篇；合并重复 ${result.duplicates} 篇，跳过无效 ID ${result.skipped} 篇。缺失字段：标题 ${missing.title}、作者 ${missing.authors}、发布日期 ${missing.published}、原始摘要 ${missing.abstract}。缺失日期留空，未使用抓取日期。`);
      } catch { notify('Zotero 导出失败，请刷新页面或先导出 JSON 备份。'); }
    }));
    list = element('div', '', 'rl-list');
    dialog.append(heading, element('p', '跨日期保存 · 最新加入在前 · 打开论文不会自动标记已读', 'rl-meta'), search, tabs, list,
      zotero, element('p', '在 Zotero 中选择「文件 → 导入 → 文件」，打开 .csl.json。重复导入可能产生重复条目；此导出不包含 PDF、Better Notes 笔记或阅读状态，备份请使用下方 JSON 功能。', 'rl-meta'),
      element('p', '保存在当前浏览器，关闭后仍保留；清理网站数据或无痕窗口关闭会丢失。换设备请导出并导入备份。', 'rl-meta'), backups);
    // Keep announcements and undo reachable inside the modal's focus boundary.
    const relocateToast = () => (dialog.open ? dialog : document.body).append(toast);
    const observer = new MutationObserver(relocateToast); observer.observe(dialog, {attributes: true, attributeFilter: ['open']});
    document.body.append(dialog); refresh();
    window.addEventListener('storage', event => {
      if (event.key === KEY || event.key === null) {
        try { papers = read(); refresh(); } catch { notify('其他窗口的清单数据无法读取。'); }
      }
    });
  }
  window.ReadingList = {mount, open};
  document.addEventListener('DOMContentLoaded', init);
})();
