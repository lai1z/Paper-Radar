/* Personal reading list: independent of the daily feed and its filters. */
(() => {
  'use strict';
  const KEY = 'paper-radar.reading-list.v1';
  const LOCK = `${KEY}.mutation`;
  const normalizeId = value => {
    const id = String(value || '').trim().replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
    if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i.test(id)) throw new Error('论文 ID 无效');
    return id;
  };
  const clean = value => {
    if (!value || typeof value !== 'object') throw new Error('论文记录无效');
    const id = normalizeId(value.id || value.url);
    const originalId = String(value.sourceId || value.id || value.url || '').trim().replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i, '').replace(/\.pdf$/i, '');
    const sourceId = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(originalId) && normalizeId(originalId).toLowerCase() === id.toLowerCase() ? originalId : id;
    if (typeof value.title !== 'string' || !value.title.trim()) throw new Error('论文标题缺失');
    return {id, sourceId, title: value.title.slice(0, 2000), summary: String(value.summary || '').slice(0, 30000),
      authors: (Array.isArray(value.authors) ? value.authors.join(', ') : String(value.authors || '')).slice(0, 5000),
      authorNames: Array.isArray(value.authorNames) ? value.authorNames : Array.isArray(value.authors) ? value.authors : undefined,
      abstract: typeof value.abstract === 'string' ? value.abstract : typeof value.details === 'string' ? value.details : '',
      published: typeof value.published === 'string' && value.published ? value.published : typeof value.publicationDate === 'string' ? value.publicationDate : '',
      tldr: typeof value.tldr === 'string' ? value.tldr : '',
      AI_status: typeof value.AI_status === 'string' ? value.AI_status : '',
      digest_version: Number.isInteger(value.digest_version) ? value.digest_version : 1,
      motivation: typeof value.motivation === 'string' ? value.motivation : '',
      method: typeof value.method === 'string' ? value.method : '',
      result: typeof value.result === 'string' ? value.result : '',
      conclusion: typeof value.conclusion === 'string' ? value.conclusion : '',
      core_method: typeof value.core_method === 'string' ? value.core_method : '',
      research_topics: Array.isArray(value.research_topics) ? value.research_topics.slice(0, 4) : [],
      key_results: Array.isArray(value.key_results) ? value.key_results.slice(0, 3) : [],
      limitations: Array.isArray(value.limitations) ? value.limitations.slice(0, 3) : [],
      category: value.category || [],
      date: String(value.date || '').slice(0, 40), status: value.status === 'read' ? 'read' : 'pending',
      savedAt: Number.isFinite(value.savedAt) ? value.savedAt : Date.now()};
  };
  function read() {
    const data = JSON.parse(localStorage.getItem(KEY) || '{"version":1,"papers":[]}');
    if (data.version !== 1 || !Array.isArray(data.papers)) throw new Error('备份格式不支持');
    return data.papers.map(clean);
  }
  let papers = [], paperById = new Map(), dialog, list, search, tabs, opener, toast, returnFocus, storageNotice;
  let mutationQueue = Promise.resolve(), pendingWrites = 0;
  let pendingUpgrades = new Map(), upgradeScheduled = false;
  let pendingListFocus = null;
  let view = 'pending';
  function setPapers(next) {
    papers = next;
    paperById = new Map();
    // Keep the same first-record behavior as Array.find for legacy duplicates.
    for (const paper of papers) if (!paperById.has(paper.id)) paperById.set(paper.id, paper);
  }
  const needsUpgrade = (saved, incoming) => !!incoming.tldr &&
    (!saved.tldr || (!saved.key_results.length && incoming.key_results?.length));
  function flushUpgrades() {
    if (!pendingUpgrades.size) { upgradeScheduled = false; return; }
    const batch = pendingUpgrades; pendingUpgrades = new Map(); upgradeScheduled = false;
    commit(items => {
      let changed = false;
      const next = items.map(saved => {
        const incoming = batch.get(saved.id);
        // Recheck the latest record inside the lock. A removed paper stays
        // removed, and an already-upgraded snapshot is never overwritten.
        if (!incoming || !needsUpgrade(saved, incoming)) return saved;
        changed = true;
        return clean({...saved, ...incoming, sourceId:incoming.sourceId || incoming.id || incoming.url,
          status:saved.status, savedAt:saved.savedAt});
      });
      return changed ? next : items;
    });
  }
  function scheduleUpgrade(id, paper) {
    pendingUpgrades.set(id, paper);
    if (upgradeScheduled) return;
    upgradeScheduled = true;
    queueMicrotask(flushUpgrades);
  }
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
  function setStorageNotice(message = '') {
    if (!storageNotice) return;
    storageNotice.textContent = message;
    storageNotice.hidden = !message;
  }
  function commit(update) {
    pendingWrites++;
    const transaction = async () => {
      const write = () => {
        const current = read(); // Read again while holding the cross-tab lock.
        const next = update(current);
        if (next !== current) localStorage.setItem(KEY, JSON.stringify({version: 1, papers: next}));
        setPapers(next);
        setStorageNotice(); refresh();
        return true;
      };
      try {
        // localStorage read-modify-write alone is not atomic across tabs.
        // Serialize cooperating tabs; the local queue also supports older browsers.
        if (!navigator.locks?.request) return write();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try { return await navigator.locks.request(LOCK, {signal: controller.signal}, write); }
        finally { clearTimeout(timeout); }
      } catch (error) {
        const message = error.name === 'AbortError'
          ? '另一窗口正在保存清单，本次尚未保存。请稍后重试。'
          : '保存失败：浏览器存储不可用、已满或数据损坏。当前清单未被覆盖，请先尝试导出备份。';
        setStorageNotice(message); notify(message);
        return false;
      } finally { pendingWrites--; }
    };
    mutationQueue = mutationQueue.then(transaction, transaction);
    return mutationQueue;
  }
  function element(tag, text, className) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, action) {
    const el = element('button', text, 'rl-button');
    el.type = 'button';
    el.onclick = event => {
      const result = action(event);
      if (result && typeof result.then === 'function') {
        const wasDisabled = el.disabled;
        const hadFocus = document.activeElement === el;
        const entry = hadFocus && el.closest('.rl-entry');
        if (entry) pendingListFocus = {control:el, id:entry.querySelector('[data-saved-open]')?.dataset.savedOpen, index:[...list.children].indexOf(entry)};
        el.disabled = true; el.setAttribute('aria-busy', 'true');
        result.catch(() => notify('操作未完成，请重试或先导出备份。')).finally(() => {
          el.disabled = wasDisabled; el.removeAttribute('aria-busy');
          if (pendingListFocus?.control === el) pendingListFocus = null;
          if (hadFocus && document.activeElement === document.body && el.isConnected && el.getClientRects().length) el.focus();
        });
      }
    };
    return el;
  }
  function open() {
    returnFocus = document.activeElement;
    try { setPapers(read()); setStorageNotice(); }
    catch { setStorageNotice('清单暂时无法读取，原始数据仍保留。请尝试「导出备份」，不要清理网站数据。'); }
    render(); dialog.showModal(); search.focus();
  }
  function mount(host, paper) {
    let id;
    try { id = normalizeId(paper.id || paper.url); } catch { return; }
    const saved = paperById.get(id);
    if (saved && needsUpgrade(saved, paper)) scheduleUpgrade(id, paper);
    const control = button('', async event => {
      event.stopPropagation();
      if (paperById.has(id)) { open(); return; }
      if (await commit(items => items.some(p => p.id === id) ? items : [clean({...paper, id, sourceId:paper.sourceId || paper.id || paper.url, status: 'pending', savedAt: Date.now()}), ...items])) {
        notify('已加入待读。可从顶部「待读」继续阅读。');
      }
    });
    control.dataset.readingId = id;
    host.append(control); updateButton(control);
  }
  function updateButton(control) {
    const saved = paperById.get(control.dataset.readingId);
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
    window.dispatchEvent(new CustomEvent('reading-list-change'));
  }
  function visiblePapers() {
    const query = search.value.trim().toLowerCase();
    return papers.filter(p => p.status === view && `${p.title} ${p.authors} ${p.summary} ${p.abstract} ${p.core_method} ${p.id}`.toLowerCase().includes(query))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  function openSaved(paper) {
    if (!window.PaperDigest) { notify('解读组件未加载，请刷新页面后重试。'); return; }
    const trigger = document.activeElement;
    const snapshots = new Map(visiblePapers().map(item => [item.id, item]));
    if (!snapshots.has(paper.id)) snapshots.set(paper.id, paper);
    const sequence = [...snapshots.keys()];
    let position = sequence.indexOf(paper.id);
    const savedDialog = element('dialog', '', 'digest-saved-dialog');
    savedDialog.setAttribute('aria-labelledby', 'savedDigestTitle');
    const heading = element('div', '', 'rl-heading');
    const title = element('h2'); title.id = 'savedDigestTitle';
    heading.append(title, button('返回清单', () => savedDialog.close()));
    const state = element('p', '', 'digest-saved-state'); state.setAttribute('role', 'status');
    const body = element('div');
    const actions = element('div', '', 'digest-saved-actions');
    const positionLabel = element('span', '', 'digest-saved-position');
    const navigation = element('div', '', 'rl-actions');
    const previous = button('上一篇', () => { position--; show(); });
    const next = button('下一篇', () => { position++; show(); });
    const mark = button('', async () => {
      const current = paperById.get(sequence[position]);
      if (!current) { state.textContent = '这篇论文已从清单移除，当前仍可查看保存时的解读。'; mark.disabled = true; return; }
      const nextStatus = current.status === 'read' ? 'pending' : 'read';
      if (await commit(items => items.map(item => item.id === current.id ? {...item, status:nextStatus} : item))) {
        if (sequence[position] !== current.id) { show(); return; }
        updateState(nextStatus);
        state.textContent = nextStatus === 'read' ? '已标记为已读。可继续查看，或前往下一篇。' : '已放回待读清单。';
      } else state.textContent = '状态保存失败，请返回清单导出备份后重试。';
    });
    function updateState(status) {
      mark.textContent = status === 'read' ? '放回待读' : '标记已读';
      mark.setAttribute('aria-label', mark.textContent);
      state.textContent = status === 'read' ? '已读 · 可随时放回待读' : '待读 · 阅读后可手动标记已读';
    }
    function show() {
      const saved = paperById.get(sequence[position]);
      const current = saved || snapshots.get(sequence[position]);
      title.textContent = current.title;
      updateState(current.status);
      mark.disabled = !saved;
      if (!saved) state.textContent = '这篇论文已从清单移除，当前仍可查看保存时的解读。';
      PaperDigest.detach(body);
      body.innerHTML = PaperDigest.details(current); PaperDigest.attach(body, current);
      previous.disabled = position === 0; next.disabled = position === sequence.length - 1;
      positionLabel.textContent = `${position + 1} / ${sequence.length} · 本次清单`;
      savedDialog.scrollTop = 0;
    }
    navigation.append(previous, next, mark); actions.append(positionLabel, navigation);
    savedDialog.append(heading, state, body, actions); document.body.append(savedDialog);
    savedDialog.addEventListener('keydown', e => e.stopPropagation());
    savedDialog.addEventListener('close', () => {
      PaperDigest.detach(body);
      savedDialog.remove();
      const target = trigger?.isConnected ? trigger : list.querySelector(`[data-saved-open="${sequence[position]}"]`) || search;
      target?.focus({preventScroll: true});
    }, {once:true});
    show();
    savedDialog.showModal();
  }
  function render() {
    const focusedEntry = document.activeElement?.closest('.rl-entry');
    const bookmark = document.activeElement === document.body ? pendingListFocus : null;
    const focusedId = focusedEntry?.querySelector('[data-saved-open]')?.dataset.savedOpen || bookmark?.id;
    const oldPosition = focusedEntry ? [...list.children].indexOf(focusedEntry) : bookmark?.index ?? -1;
    pendingListFocus = null;
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
      const title = button(paper.title, () => openSaved(paper)); title.className = 'rl-title'; title.dataset.savedOpen = paper.id;
      const meta = element('p', `${paper.authors}\n加入于 ${new Date(paper.savedAt).toLocaleDateString()} · ${paper.id}`, 'rl-meta');
      const details = element('details');
      details.append(element('summary', '查看摘要'), element('p', paper.summary || '暂无摘要'));
      const actions = element('div', '', 'rl-actions');
      const pdf = element('a', '打开 PDF', 'rl-button');
      pdf.href = `https://arxiv.org/pdf/${paper.sourceId || paper.id}`; pdf.target = '_blank'; pdf.rel = 'noopener noreferrer';
      actions.append(button('阅读解读', () => openSaved(paper)), pdf, button(view === 'pending' ? '标记已读' : '放回待读', async () => {
        const before = paper.status;
        if (await commit(items => items.map(p => p.id === paper.id ? {...p, status: before === 'read' ? 'pending' : 'read'} : p))) {
          notify(before === 'read' ? '已放回待读' : '已标记为已读', async () => {
            if (await commit(items => items.map(p => p.id === paper.id ? {...p, status: before} : p))) notify('已撤销');
          });
        }
      }), button('移除', async () => {
        if (await commit(items => items.filter(p => p.id !== paper.id))) notify('已移出清单', async () => {
          if (await commit(items => items.some(p => p.id === paper.id) ? items : [paper, ...items])) notify('已恢复');
        });
      }));
      card.append(title, meta, details, actions); list.append(card);
    });
    if (focusedId && dialog.open) {
      const entries = [...list.querySelectorAll('[data-saved-open]')];
      const target = entries.find(entry => entry.dataset.savedOpen === focusedId) || entries[Math.min(oldPosition, entries.length - 1)] || search;
      target.focus();
    }
  }
  function init() {
    const header = document.querySelector('.header-controls');
    if (!header) return;
    toast = element('div', '', 'rl-toast'); toast.setAttribute('role', 'status');
    document.body.append(toast);
    try { setPapers(read()); } catch { notify('无法读取待读清单，请保留当前数据并尝试导出备份。'); }
    opener = button('待读 (0)', open); opener.id = 'readingListButton'; header.prepend(opener);
    dialog = element('dialog', '', 'rl-dialog'); dialog.setAttribute('aria-labelledby', 'readingListTitle');
    storageNotice = element('p', '', 'rl-storage-notice'); storageNotice.hidden = true; storageNotice.setAttribute('role', 'status');
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
    backups.append(button('导出备份', async () => {
      flushUpgrades();
      await mutationQueue;
      try {
        // Preserve the exact stored bytes, even if a malformed record prevents reading.
        const raw = localStorage.getItem(KEY) || JSON.stringify({version: 1, papers: []});
        const url = URL.createObjectURL(new Blob([raw], {type: 'application/json'}));
        const link = element('a'); link.href = url; link.download = `paper-radar-reading-${new Date().toISOString().slice(0, 10)}.json`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        const message = '无法访问浏览器存储，备份没有生成。请恢复此网站的存储权限后重试，不要清理网站数据。';
        setStorageNotice(message); notify(message);
      }
    }));
    const file = element('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    file.onchange = async () => {
      try {
        if (!file.files[0]) return;
        if (file.files[0].size > 10 * 1024 * 1024) throw new Error('文件太大');
        const data = JSON.parse(await file.files[0].text());
        if (data.version !== 1 || !Array.isArray(data.papers)) throw new Error('格式错误');
        const imported = data.papers.map(clean);
        if (await commit(items => {
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
    const manualCopy = element('div'); manualCopy.hidden = true;
    const copyText = element('textarea'); copyText.readOnly = true; copyText.rows = 6;
    copyText.style.width = '100%'; copyText.setAttribute('aria-label', '待复制的 Zotero 文献信息');
    const copyHelp = element('p', '', 'rl-meta');
    manualCopy.append(copyHelp,
      copyText, button('全选复制内容', () => { copyText.focus(); copyText.select(); }),
      button('收起复制文本', () => { manualCopy.hidden = true; copyText.value = ''; }));
    function exportSelection() {
      setPapers(read());
      const selected = scope.value === 'all' ? papers : scope.value === 'pending' ? papers.filter(p => p.status === 'pending') : visiblePapers();
      return window.ZoteroExport.build(selected);
    }
    async function copySelection(withPDF) {
      flushUpgrades();
      await mutationQueue;
      manualCopy.hidden = true; copyText.value = '';
      let result;
      try { result = exportSelection(); }
      catch { notify('无法读取文献信息，请刷新页面后重试。'); return; }
      if (!result.items.length) { notify('没有可复制的论文。剪贴板未更新，请勿导入上一次的内容。'); return; }
      const content = withPDF ? result.identifiers : result.content;
      const instructions = withPDF
        ? '到 Zotero 点击工具栏魔棒「通过标识符添加条目」，粘贴并按 Enter。Zotero 将联网获取文献信息和 PDF；请等待附件下载完成。不要使用「从剪贴板导入」。'
        : '到 Zotero「文件 → 从剪贴板导入」。此次仅导入文献信息，不含 PDF。';
      try {
        await navigator.clipboard.writeText(content);
        notify(`已复制 ${result.items.length} 篇${withPDF ? '的 arXiv ID' : '的文献信息'}。${instructions}`);
      } catch {
        copyText.setAttribute('aria-label', withPDF ? '待复制的 arXiv ID' : '待复制的 Zotero 文献信息');
        copyHelp.textContent = `自动复制不可用。请按 Ctrl+C（Mac：⌘C）复制下方文本，然后${instructions}`;
        copyText.value = content; manualCopy.hidden = false; copyText.focus(); copyText.select();
        notify('浏览器未允许自动复制，请在文本框中手动复制。');
      }
    }
    zotero.append(scope, button('复制 arXiv ID（获取 PDF）', () => copySelection(true)));
    const metadata = element('details');
    metadata.append(element('summary', '仅导出文献信息（不含 PDF）'));
    const metadataActions = element('div', '', 'rl-actions');
    metadataActions.append(button('复制文献信息', () => copySelection(false)), button('下载 CSL JSON', async () => {
      flushUpgrades();
      await mutationQueue;
      try {
        const result = exportSelection();
        if (!result.items.length) { notify('没有可导出的论文，请调整范围或搜索条件。'); return; }
        const url = URL.createObjectURL(new Blob([result.content], {type: 'application/json;charset=utf-8'}));
        const link = element('a'); link.href = url; link.download = `paper-radar-zotero-${scope.value}-${new Date().toISOString().slice(0, 10)}.csl.json`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        const missing = result.missing;
        notify(`已导出 ${result.items.length} 篇；合并重复 ${result.duplicates} 篇，跳过无效 ID ${result.skipped} 篇。缺失字段：标题 ${missing.title}、作者 ${missing.authors}、发布日期 ${missing.published}、原始摘要 ${missing.abstract}。缺失日期留空，未使用抓取日期。`);
      } catch { notify('Zotero 导出失败，请刷新页面或先导出 JSON 备份。'); }
    }));
    metadata.append(metadataActions);
    list = element('div', '', 'rl-list');
    const zoteroHelp = element('details', '', 'rl-export-help');
    zoteroHelp.append(element('summary', 'PDF、重复条目与导入说明'),
      element('p', '文献信息和 PDF 由 Zotero 从 arXiv 获取；下载完成后，展开条目可查看 PDF 附件。Paper Radar 无法确认 Zotero 的下载结果。若没有 PDF：检查 Zotero「设置 → 常规」中的自动附加相关 PDF 选项及 arXiv 网络访问；也可打开论文原文页，用 Zotero Connector 保存。重复添加可能产生重复条目，请在 Zotero「重复条目」中检查。此操作不改变待读状态或 Better Notes 笔记。', 'rl-meta'));
    dialog.append(heading, storageNotice, element('p', '跨日期保存 · 最新加入在前 · 打开论文不会自动标记已读', 'rl-meta'), search, tabs, list,
      element('h3', '批量导入 Zotero', 'rl-export-title'), zotero,
      element('p', '复制 ID → Zotero 工具栏魔棒「通过标识符添加条目」→ 粘贴并按 Enter，等待 PDF 下载。', 'rl-meta'), zoteroHelp,
      metadata, manualCopy,
      element('p', '保存在当前浏览器，关闭后仍保留；清理网站数据或无痕窗口关闭会丢失。换设备请导出并导入备份。', 'rl-meta'), backups);
    // Keep announcements and undo reachable inside the modal's focus boundary.
    const relocateToast = () => (dialog.open ? dialog : document.body).append(toast);
    const observer = new MutationObserver(relocateToast); observer.observe(dialog, {attributes: true, attributeFilter: ['open']});
    document.body.append(dialog); refresh();
    window.addEventListener('storage', event => {
      if (event.key === KEY || event.key === null) {
        try { setPapers(read()); setStorageNotice(); refresh(); }
        catch { setStorageNotice('其他窗口的清单数据无法读取。已保留本页内容，请尝试导出原始备份。'); notify('其他窗口的清单数据无法读取。'); }
      }
    });
    window.addEventListener('beforeunload', event => {
      if (pendingWrites) { event.preventDefault(); event.returnValue = ''; }
    });
  }
  function status(value) {
    try { return paperById.get(normalizeId(value))?.status || ''; }
    catch { return ''; }
  }
  window.ReadingList = {mount, open, status};
  document.addEventListener('DOMContentLoaded', init);
})();
