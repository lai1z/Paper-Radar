let currentDate = '';
let availableDates = [];
let currentView = 'grid'; // 'grid' 或 'list'
let currentCategory = 'all';
let urlCategoryParam = null; // 从URL参数中获取的category
let urlJsonParam = null; // 从URL参数中获取的json（API模式）
let urlAuthorParam = null; // 从URL参数中获取的author
let urlKeywordsParam = null; // 从URL参数中获取的keywords
let paperData = {};
let flatpickrInstance = null;
let isRangeMode = false;
let activeKeywords = []; // 存储激活的关键词
let userKeywords = []; // 存储用户的关键词
let activeAuthors = []; // 存储激活的作者
let userAuthors = []; // 存储用户的作者
let currentPaperIndex = 0; // 当前查看的论文索引
let currentFilteredPapers = []; // 当前过滤后的论文列表
let currentTopic = 'all';
let paperSort = 'relevance';
let onlyMatched = false;
let modalReturnFocus = null;
let paperLoadSequence = 0;
let feedLoadState = 'idle';
let feedLoadController = null;
let datePickerReturnFocus = null;
let feedUpdateStatus = null;
let textSearchQuery = ''; // 实时文本搜索查询
let previousActiveKeywords = null; // 文本搜索激活时，暂存之前的关键词激活集合
let previousActiveAuthors = null; // 文本搜索激活时，暂存之前的作者激活集合

async function fetchFeedText(url, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  try {
    const response = await fetch(url, {cache: 'no-store', signal: controller.signal});
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`); error.status = response.status; throw error;
    }
    return await response.text();
  } catch (error) {
    if (timedOut) throw new Error('连接超时，请重试。');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
  }
}

function showFeedNotice(message, retry, detail = '') {
  const container = document.getElementById('paperContainer');
  const notice = document.createElement('div'); notice.className = 'loading-container feed-notice';
  notice.setAttribute('role', 'status');
  const paragraph = document.createElement('p'); paragraph.textContent = message; notice.append(paragraph);
  if (detail) { const hint = document.createElement('p'); hint.textContent = detail; notice.append(hint); }
  if (retry) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'workspace-button'; button.textContent = '重新加载'; button.onclick = retry;
    notice.append(button);
  }
  container.replaceChildren(notice);
  container.setAttribute('aria-busy', String(feedLoadState === 'loading'));
}

function beginPaperLoad(label) {
  feedLoadController?.abort(); feedLoadController = new AbortController();
  const sequence = ++paperLoadSequence;
  feedLoadState = 'loading'; paperData = {}; currentFilteredPapers = [];
  if (document.getElementById('paperModal').classList.contains('active')) closeModal();
  renderCategoryFilter({sortedCategories: [], categoryCounts: {}});
  updateResearchWorkspace([], [], []);
  document.getElementById('workspaceDate').textContent = `正在加载 ${label} 收录…`;
  document.getElementById('resultSummary').textContent = '正在读取论文';
  showFeedNotice(`正在加载 ${label} 的论文…`);
  return {sequence, signal: feedLoadController.signal};
}

function failPaperLoad(label, retry, error) {
  feedLoadState = 'error'; paperData = {}; currentFilteredPapers = [];
  document.getElementById('workspaceDate').textContent = `${label} 收录加载失败`;
  document.getElementById('resultSummary').textContent = '数据尚未加载';
  showFeedNotice('暂时无法读取所选日期的论文。', retry,
    error?.code === 'INVALID_PAPER_DATA' ? '论文数据暂不完整，请重新加载；若仍失败，可选择其他收录日期。' :
    error?.status === 404 ? '该日期的数据文件暂不可用，可重试或选择其他日期。' : '请检查网络后重试，或选择其他收录日期。');
}

function readPreferenceList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
  } catch (_) { return []; }
}

function initResearchWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem('paper-radar.workspace.v1') || '{}');
    currentView = saved.layout === 'compact' ? 'compact' : 'grid';
    paperSort = saved.sort === 'published' ? 'published' : 'relevance';
  } catch (_) { /* A blocked or invalid preference never prevents reading. */ }
  const saveView = () => {
    try { localStorage.setItem('paper-radar.workspace.v1', JSON.stringify({layout: currentView, sort: paperSort})); } catch (_) {}
  };
  document.getElementById('paperSort').value = paperSort;
  document.getElementById('paperSort').addEventListener('change', event => {
    paperSort = event.target.value; saveView(); renderPapers();
  });
  document.querySelectorAll('[data-layout]').forEach(button => {
    button.addEventListener('click', () => { currentView = button.dataset.layout; saveView(); renderPapers(); });
  });
  document.getElementById('onlyMatched').addEventListener('change', event => { onlyMatched = event.target.checked; renderPapers(); });
  document.getElementById('researchTopics').addEventListener('click', event => {
    const button = event.target.closest('[data-topic]');
    if (!button) return;
    currentTopic = button.dataset.topic; renderPapers();
    document.querySelector(`#researchTopics [data-topic="${CSS.escape(currentTopic)}"]`)?.focus();
  });
  document.getElementById('resetPaperFilters').addEventListener('click', () => {
    currentTopic = 'all'; textSearchQuery = ''; onlyMatched = false;
    document.getElementById('textSearchInput').value = '';
    document.getElementById('textSearchClear').style.display = 'none';
    filterByCategory('all');
  });
  const moveDate = delta => {
    const index = availableDates.indexOf(currentDate);
    const date = availableDates[index + delta];
    if (index >= 0 && date) loadPapersByDate(date);
  };
  document.getElementById('previousDate').addEventListener('click', () => moveDate(1));
  document.getElementById('nextDate').addEventListener('click', () => moveDate(-1));
  document.getElementById('latestDate').addEventListener('click', () => { if (availableDates[0]) loadPapersByDate(availableDates[0]); });
  document.getElementById('previousPaper').addEventListener('click', navigateToPreviousPaper);
  document.getElementById('nextPaper').addEventListener('click', navigateToNextPaper);
  window.addEventListener('reading-list-change', () => {
    const all = ResearchWorkspace.unique(Object.values(paperData).flat());
    updateWorkspaceStats(all);
  });
}

function updateWorkspaceStats(papers) {
  const summarized = papers.filter(paper => paper.hasAi).length;
  const pending = papers.filter(paper => window.ReadingList?.status?.(paper.id || paper.url) === 'pending').length;
  document.getElementById('workspaceStats').textContent = `${papers.length} 篇论文 · ${summarized} 篇 AI 解读${pending ? ` · ${pending} 篇待读` : ''}`;
}

function updateResearchWorkspace(allPapers, categoryPapers, visiblePapers) {
  const latest = availableDates[0] || '';
  document.getElementById('workspaceHeading').textContent = currentDate === latest ? '每日论文工作台' : '历史论文工作台';
  document.getElementById('workspaceDate').textContent = `${currentDate.replace(' to ', ' 至 ')} 收录${currentDate === latest ? ' · 当前最新一期' : ''}`;
  updateWorkspaceStats(allPapers);
  const dateIndex = availableDates.indexOf(currentDate);
  document.getElementById('previousDate').disabled = dateIndex < 0 || dateIndex >= availableDates.length - 1;
  document.getElementById('nextDate').disabled = dateIndex <= 0;
  document.getElementById('latestDate').disabled = currentDate === latest;
  document.querySelectorAll('[data-layout]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layout === currentView)));
  document.getElementById('onlyMatched').checked = onlyMatched;
  const counts = ResearchWorkspace.topicCounts(categoryPapers);
  const topicItems = [['all', categoryPapers.length], ...counts.topics];
  if (counts.untagged) topicItems.push(['untagged', counts.untagged]);
  if (!topicItems.some(([topic]) => topic === currentTopic)) topicItems.push([currentTopic, 0]);
  document.getElementById('researchTopics').innerHTML = topicItems.map(([topic, count]) => `<button type="button" class="workspace-topic" data-topic="${PaperDigest.escape(topic)}" aria-pressed="${topic === currentTopic}">${topic === 'all' ? '全部主题' : topic === 'untagged' ? '未标注主题' : PaperDigest.escape(topic)}<span>${count}</span></button>`).join('');
  const hasFilter = currentCategory !== 'all' || currentTopic !== 'all' || !!textSearchQuery || onlyMatched;
  const matched = categoryPapers.filter(paper => paper.isMatched).length;
  document.getElementById('resultSummary').textContent = `显示 ${visiblePapers.length} / ${allPapers.length} 篇${!textSearchQuery && (activeAuthors.length || activeKeywords.length) ? ` · ${matched} 篇匹配偏好` : ''}${currentView === 'compact' ? ' · 速览' : ''}`;
  document.getElementById('resetPaperFilters').hidden = !hasFilter;
  renderFeedUpdateStatus();
}

async function fetchFeedUpdateStatus() {
  try {
    const response = await fetch(DATA_CONFIG.getDataUrl('assets/update-status.json'), {cache: 'no-store'});
    if (!response.ok) return;
    const value = await response.json();
    if (value && value.schema_version === 1 && typeof value.checked_at === 'string' && Number.isFinite(Date.parse(value.checked_at))) feedUpdateStatus = value;
  } catch (_) { /* Older data branches do not have an update-status file. */ }
  renderFeedUpdateStatus();
}

function renderFeedUpdateStatus() {
  let host = document.getElementById('workspaceFreshness');
  if (!host) {
    host = document.createElement('p'); host.id = 'workspaceFreshness'; host.className = 'workspace-freshness';
    document.querySelector('.workspace-overview').after(host);
  }
  if (!feedUpdateStatus) {
    host.textContent = availableDates[0] ? `最新收录：${availableDates[0]}。该日期不等同于 arXiv 发布日期。` : '';
    return;
  }
  const checked = new Date(feedUpdateStatus.checked_at).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false});
  host.textContent = `最近成功检查：${checked}（本地时间） · 最新收录：${feedUpdateStatus.latest_publication_date || availableDates[0] || '暂无'}`;
  if (Number.isInteger(feedUpdateStatus.pending_paper_count) && feedUpdateStatus.pending_paper_count > 0) {
    host.append(` · 还有 ${feedUpdateStatus.pending_paper_count} 篇等待后续处理`);
  }
  try {
    const url = new URL(feedUpdateStatus.run_url);
    if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.includes('/actions/runs/')) {
      const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看运行'; host.append(' · ', link);
    }
  } catch (_) {}
}

function trapModalFocus(event, modal) {
  const nodes = [...modal.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, summary, [tabindex="0"]')].filter(node => node.getClientRects().length);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
}

// 加载用户的关键词设置
function loadUserKeywords() {
  userKeywords = readPreferenceList('preferredKeywords');
  activeKeywords = [...userKeywords];
  
  // renderKeywordTags();
  renderFilterTags();
}

// 加载用户的作者设置
function loadUserAuthors() {
  userAuthors = readPreferenceList('preferredAuthors');
  activeAuthors = [...userAuthors];
  
  renderFilterTags();
}

// 渲染过滤标签（作者和关键词）
function renderFilterTags() {
  const filterTagsElement = document.getElementById('filterTags');
  const filterContainer = document.querySelector('.filter-label-container');
  
  // 如果没有作者和关键词，仅隐藏标签区域，保留容器（以显示搜索按钮）
  if ((!userAuthors || userAuthors.length === 0) && (!userKeywords || userKeywords.length === 0)) {
    filterContainer.style.display = 'flex';
    if (filterTagsElement) {
      filterTagsElement.style.display = 'none';
      filterTagsElement.innerHTML = '';
    }
    return;
  }
  
  filterContainer.style.display = 'flex';
  if (filterTagsElement) {
    filterTagsElement.style.display = 'flex';
  }
  filterTagsElement.innerHTML = '';
  
  // 先添加作者标签
  if (userAuthors && userAuthors.length > 0) {
    userAuthors.forEach(author => {
      const tagElement = document.createElement('button');
      tagElement.type = 'button';
      tagElement.className = `category-button author-button ${activeAuthors.includes(author) ? 'active' : ''}`;
      tagElement.textContent = author;
      tagElement.dataset.author = author;
      tagElement.title = "匹配作者姓名";
      tagElement.setAttribute('aria-pressed', String(activeAuthors.includes(author)));
      
      tagElement.addEventListener('click', () => {
        toggleAuthorFilter(author);
      });
      
      filterTagsElement.appendChild(tagElement);
      
      // 添加出现动画后移除动画类
      if (!activeAuthors.includes(author)) {
        tagElement.classList.add('tag-appear');
        setTimeout(() => {
          tagElement.classList.remove('tag-appear');
        }, 300);
      }
    });
  }
  
  // 再添加关键词标签
  if (userKeywords && userKeywords.length > 0) {
    userKeywords.forEach(keyword => {
      const tagElement = document.createElement('button');
      tagElement.type = 'button';
      tagElement.className = `category-button keyword-button ${activeKeywords.includes(keyword) ? 'active' : ''}`;
      tagElement.textContent = keyword;
      tagElement.dataset.keyword = keyword;
      tagElement.title = "匹配标题和摘要中的关键词";
      tagElement.setAttribute('aria-pressed', String(activeKeywords.includes(keyword)));
      
      tagElement.addEventListener('click', () => {
        toggleKeywordFilter(keyword);
      });
      
      filterTagsElement.appendChild(tagElement);
      
      // 添加出现动画后移除动画类
      if (!activeKeywords.includes(keyword)) {
        tagElement.classList.add('tag-appear');
        setTimeout(() => {
          tagElement.classList.remove('tag-appear');
        }, 300);
      }
    });
  }
}

// 切换关键词过滤
function toggleKeywordFilter(keyword) {
  const index = activeKeywords.indexOf(keyword);
  
  if (index === -1) {
    // 激活该关键词
    activeKeywords.push(keyword);
  } else {
    // 取消激活该关键词
    activeKeywords.splice(index, 1);
  }
  
  // 更新关键词标签UI
  const keywordTags = document.querySelectorAll('[data-keyword]');
  keywordTags.forEach(tag => {
    if (tag.dataset.keyword === keyword) {
      // 先移除上一次可能的高亮动画
      tag.classList.remove('tag-highlight');
      
      // 添加/移除激活状态
      tag.classList.toggle('active', activeKeywords.includes(keyword));
      tag.setAttribute('aria-pressed', String(activeKeywords.includes(keyword)));
      
      // 添加高亮动画
      setTimeout(() => {
        tag.classList.add('tag-highlight');
      }, 10);
      
      // 移除高亮动画
      setTimeout(() => {
        tag.classList.remove('tag-highlight');
      }, 1000);
    }
  });
  
  // 重新渲染论文列表
  renderPapers();
}


// 切换作者过滤
function toggleAuthorFilter(author) {
  const index = activeAuthors.indexOf(author);
  
  if (index === -1) {
    // 激活该作者
    activeAuthors.push(author);
  } else {
    // 取消激活该作者
    activeAuthors.splice(index, 1);
  }
  
  // 更新作者标签UI
  const authorTags = document.querySelectorAll('[data-author]');
  authorTags.forEach(tag => {
    if (tag.dataset.author === author) {
      // 先移除上一次可能的高亮动画
      tag.classList.remove('tag-highlight');
      
      // 添加/移除激活状态
      tag.classList.toggle('active', activeAuthors.includes(author));
      tag.setAttribute('aria-pressed', String(activeAuthors.includes(author)));
      
      // 添加高亮动画
      setTimeout(() => {
        tag.classList.add('tag-highlight');
      }, 10);
      
      // 移除高亮动画
      setTimeout(() => {
        tag.classList.remove('tag-highlight');
      }, 1000);
    }
  });
  
  // 重新渲染论文列表
  renderPapers();
}

// 从URL参数中获取category
function getUrlCategory() {
  const params = new URLSearchParams(window.location.search);
  const category = params.get('category');
  return category ? decodeURIComponent(category) : null;
}

// 从URL参数中获取json（API模式）
function getJsonParam() {
  const params = new URLSearchParams(window.location.search);
  const json = params.get('json');
  return json ? decodeURIComponent(json) : null;
}

// 从URL参数中获取author
function getUrlAuthor() {
  const params = new URLSearchParams(window.location.search);
  const author = params.get('author');
  return author ? decodeURIComponent(author).split(',').map(k => k.trim()).filter(k => k) : null;
}

// 从URL参数中获取keywords
function getUrlKeywords() {
  const params = new URLSearchParams(window.location.search);
  const keywords = params.get('keywords');
  return keywords ? decodeURIComponent(keywords).split(',').map(k => k.trim()).filter(k => k) : null;
}

// 检查是否以JSON模式运行
function isJsonMode() {
  return getJsonParam() !== null;
}

// 输出JSON格式的论文数据
function outputJsonData(papers, category) {
  const jsonData = {
    category: category,
    author: urlAuthorParam || null,
    keywords: urlKeywordsParam || null,
    count: papers.length,
    papers: papers.map(p => ({
      id: p.id,
      title: p.title,
      authors: p.authors,
      categories: p.category,
      summary: p.summary,
      date: p.date,
      url: p.url,
      reason: p.matchReason
    }))
  };

  // 清空页面内容
  document.body.innerHTML = '';
  document.head.innerHTML = '';

  // 设置JSON内容
  document.body.textContent = JSON.stringify(jsonData, null, 2);
}

// 根据category获取论文（复用现有逻辑）
function getPapersByCategory(paperData, category) {
  return ResearchWorkspace.unique(Object.values(paperData).flat())
    .filter(paper => category === 'all' || paper.category.includes(category))
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
}

// ===== 关键词匹配（纯文本“包含”筛选）=====
// Pages 上的关键词只是浏览用的字面筛选：输入 world model，就只看标题/摘要里含这个词的论文。
// 比较时忽略大小写、空格、连字符和下划线，所以 V-JEPA 也能命中 VJEPA。
// 每日抓取该收哪些论文由 Jev 语义闸门决定，与这里的设置无关。

function normalizeMatchText(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase();
}

// 去掉分隔符后的形式，用于 V-JEPA / VJEPA、world model / world-model 这类写法
function squashMatchText(value) {
  return normalizeMatchText(value).replace(/[\s\-_/]+/g, '');
}

// 仍然支持 "A | B" 的或写法
function getKeywordAliases(keyword) {
  return String(keyword == null ? '' : keyword)
    .split('|')
    .map(part => part.trim())
    .filter(Boolean);
}

function keywordMatchesText(keyword, text) {
  const aliases = getKeywordAliases(keyword);
  if (aliases.length === 0) return false;
  const raw = normalizeMatchText(text);
  const squashed = squashMatchText(text);
  return aliases.some(alias => {
    const needle = normalizeMatchText(alias);
    if (!needle) return false;
    return raw.includes(needle) || squashed.includes(squashMatchText(alias));
  });
}

function getPaperKeywordText(paper) {
  const categories = Array.isArray(paper.category) ? paper.category.join(' ') : (paper.category || '');
  return [paper.title || '', paper.summary || '', paper.details || '', categories].join(' ');
}

function paperMatchesKeyword(paper, keyword) {
  if (!keyword) return false;
  return keywordMatchesText(keyword, getPaperKeywordText(paper));
}

function paperMatchesAuthor(paper, author) {
  if (!author) return false;
  const authorsText = normalizeMatchText(paper.authors || '');
  if (!authorsText) return false;
  return getKeywordAliases(author).some(alias => authorsText.includes(normalizeMatchText(alias)));
}

function filterMatchedKeywords(paper, keywords) {
  return (keywords || []).filter(keyword => paperMatchesKeyword(paper, keyword));
}

// 高亮时使用原始写法（保留连字符），否则 "v jepa" 匹配不到正文里的 "V-JEPA"
function expandKeywordsForHighlight(keywords) {
  const terms = [];
  (keywords || []).forEach(keyword => {
    getKeywordAliases(keyword).forEach(alias => {
      if (terms.indexOf(alias) === -1) terms.push(alias);
    });
  });
  return terms;
}

// 根据keywords匹配论文（复用现有逻辑：关键词之间是"或"关系）
function matchPapersByKeywords(papers, keywords) {
  if (!keywords || keywords.length === 0) return papers.map(p => ({ ...p, isMatched: false, matchReason: null }));

  return papers.map(paper => {
    const matches = keywords.some(keyword => paperMatchesKeyword(paper, keyword));

    if (matches) {
      const matchedKeywords = filterMatchedKeywords(paper, keywords);
      return {
        ...paper,
        isMatched: true,
        matchReason: matchedKeywords.length > 0 ? `关键词: ${matchedKeywords.join(', ')}` : null
      };
    }
    return { ...paper, isMatched: false, matchReason: null };
  });
}

// 根据author匹配论文（复用现有逻辑）
function matchPapersByAuthor(papers, query_authors) {
  if (!query_authors) return papers.map(p => ({ ...p, isMatched: false, matchReason: null }));

  return papers.map(paper => {
    const matches = query_authors.some(author => paperMatchesAuthor(paper, author));

    if (matches) {
      const matchedAuthors = query_authors.filter(author => paperMatchesAuthor(paper, author));
      return {
        ...paper,
        isMatched: true,
        matchReason: matchedAuthors.length > 0 ? `作者: ${matchedAuthors.join(', ')}` : null
      };
    }
    return { ...paper, isMatched: false, matchReason: null };
  });
}

// 组合keywords和author匹配（复用现有逻辑：关键词和作者是"或"关系）
function matchPapersByKeywordsOrAuthor(papers, keywords, author) {
  // 先获取关键词匹配结果
  const keywordResults = matchPapersByKeywords(papers, keywords);

  // 再获取作者匹配结果
  const authorResults = matchPapersByAuthor(papers, author);

  // 合并：关键词或作者匹配都算
  return papers.map((paper, index) => {
    const keywordMatch = keywordResults[index];
    const authorMatch = authorResults[index];

    const isMatched = keywordMatch.isMatched || authorMatch.isMatched;
    const matchReasons = [];
    if (keywordMatch.isMatched && keywordMatch.matchReason) {
      matchReasons.push(keywordMatch.matchReason);
    }
    if (authorMatch.isMatched && authorMatch.matchReason) {
      matchReasons.push(authorMatch.matchReason);
    }

    return {
      ...paper,
      isMatched: isMatched,
      matchReason: matchReasons.length > 0 ? matchReasons.join(' | ') : null
    };
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  initResearchWorkspace();
  fetchFeedUpdateStatus();

  // 加载用户关键词
  loadUserKeywords();

  // 加载用户作者
  loadUserAuthors();

  // 解析URL中的category、json、author和keywords参数
  urlCategoryParam = getUrlCategory();
  currentCategory = urlCategoryParam || 'all';
  urlJsonParam = getJsonParam();
  urlAuthorParam = getUrlAuthor();
  urlKeywordsParam = getUrlKeywords();

  loadLatestFeed();
  window.addEventListener('storage', event => {
    if (urlJsonParam !== null || urlKeywordsParam || urlAuthorParam) return;
    if (event.key === 'preferredKeywords' || event.key === null) {
      const allActive = userKeywords.every(value => activeKeywords.includes(value)) && activeKeywords.every(value => userKeywords.includes(value));
      userKeywords = readPreferenceList('preferredKeywords');
      activeKeywords = allActive ? [...userKeywords] : activeKeywords.filter(value => userKeywords.includes(value));
    }
    if (event.key === 'preferredAuthors' || event.key === null) {
      const allActive = userAuthors.every(value => activeAuthors.includes(value)) && activeAuthors.every(value => userAuthors.includes(value));
      userAuthors = readPreferenceList('preferredAuthors');
      activeAuthors = allActive ? [...userAuthors] : activeAuthors.filter(value => userAuthors.includes(value));
    }
    if (['preferredKeywords', 'preferredAuthors', null].includes(event.key)) { renderFilterTags(); renderPapers(); }
  });
});

async function fetchGitHubStats() {
  try {
    const response = await fetch(`https://api.github.com/repos/${DATA_CONFIG.repoOwner}/${DATA_CONFIG.repoName}`);
    const data = await response.json();
    const starCount = data.stargazers_count;
    const forkCount = data.forks_count;
    
    document.getElementById('starCount').textContent = starCount;
    document.getElementById('forkCount').textContent = forkCount;
  } catch (error) {
    console.error('获取GitHub统计数据失败:', error);
    document.getElementById('starCount').textContent = '?';
    document.getElementById('forkCount').textContent = '?';
  }
}

function initEventListeners() {
  // 日期选择器相关的事件监听
  const calendarButton = document.getElementById('calendarButton');
  calendarButton.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDatePicker();
  });
  
  const datePickerModal = document.querySelector('.date-picker-modal');
  datePickerModal.addEventListener('click', (event) => {
    if (event.target === datePickerModal) {
      toggleDatePicker();
    }
  });
  
  const datePickerContent = document.querySelector('.date-picker-content');
  datePickerContent.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.getElementById('dateRangeMode').addEventListener('change', toggleRangeMode);
  document.getElementById('closeDatePicker').addEventListener('click', toggleDatePicker);
  
  // 其他原有的事件监听器
  document.getElementById('closeModal').addEventListener('click', closeModal);
  
  document.querySelector('.paper-modal').addEventListener('click', (event) => {
    const modal = document.querySelector('.paper-modal');
    const pdfContainer = modal.querySelector('.pdf-container');
    
    // 如果点击的是模态框背景
    if (event.target === modal) {
      // 检查PDF是否处于放大状态
      if (pdfContainer && pdfContainer.classList.contains('expanded')) {
        // 如果PDF是放大的，先将其恢复正常大小
        const expandButton = modal.querySelector('.pdf-expand-btn');
        if (expandButton) {
          togglePdfSize(expandButton);
        }
        // 阻止事件继续传播，防止关闭整个模态框
        event.stopPropagation();
      } else {
        // 如果PDF不是放大状态，则关闭整个模态框
        closeModal();
      }
    }
  });
  
  // 添加键盘事件监听 - Esc 键关闭模态框，左右箭头键切换论文，R 键显示随机论文
  document.addEventListener('keydown', (event) => {
    // 检查是否有输入框或文本区域处于焦点状态
    const activeElement = document.activeElement;
    const isInputFocused = activeElement && (
      activeElement.tagName === 'INPUT' || 
      activeElement.tagName === 'TEXTAREA' || 
      activeElement.isContentEditable
    );
    
    if (event.key === 'Escape') {
      const paperModal = document.getElementById('paperModal');
      const datePickerModal = document.getElementById('datePickerModal');
      
      // 关闭论文模态框
      if (paperModal.classList.contains('active')) {
        closeModal();
      }
      // 关闭日期选择器模态框
      else if (datePickerModal.classList.contains('active')) {
        toggleDatePicker();
      }
    }
    // 左右箭头键导航论文（仅在论文模态框打开时）
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const paperModal = document.getElementById('paperModal');
      if (paperModal.classList.contains('active') && !isInputFocused && !document.activeElement?.matches('select, summary, iframe')) {
        event.preventDefault(); // 防止页面滚动
        
        if (event.key === 'ArrowLeft') {
          navigateToPreviousPaper();
        } else if (event.key === 'ArrowRight') {
          navigateToNextPaper();
        }
      }
    }
    if (event.key === 'Tab') {
      const modal = document.getElementById('paperModal');
      if (modal.classList.contains('active')) trapModalFocus(event, modal);
      else if (document.getElementById('datePickerModal').classList.contains('active')) trapModalFocus(event, document.getElementById('datePickerModal'));
    }
  });

  // 添加鼠标滚轮横向滚动支持
  const categoryScroll = document.querySelector('.category-scroll');
  const keywordScroll = document.querySelector('.keyword-scroll');
  const authorScroll = document.querySelector('.author-scroll');
  
  // 为类别滚动添加鼠标滚轮事件
  if (categoryScroll) {
    categoryScroll.addEventListener('wheel', function(e) {
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.scrollLeft += e.deltaY;
      }
    });
  }
  
  // 为关键词滚动添加鼠标滚轮事件
  if (keywordScroll) {
    keywordScroll.addEventListener('wheel', function(e) {
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.scrollLeft += e.deltaY;
      }
    });
  }
  
  // 为作者滚动添加鼠标滚轮事件
  if (authorScroll) {
    authorScroll.addEventListener('wheel', function(e) {
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.scrollLeft += e.deltaY;
      }
    });
  }

  // 其他事件监听器...
  const categoryButtons = document.querySelectorAll('.category-button');
  categoryButtons.forEach(button => {
    button.addEventListener('click', () => {
      const category = button.dataset.category;
      filterByCategory(category);
    });
  });

  // 回到顶部按钮：滚动显示/隐藏 + 点击回到顶部
  const backToTopButton = document.getElementById('backToTop');
  if (backToTopButton) {
    const updateBackToTopVisibility = () => {
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
      if (scrollTop > 300) {
        backToTopButton.classList.add('visible');
      } else {
        backToTopButton.classList.remove('visible');
      }
    };

    // 初始判断一次（防止刷新在中部时不显示）
    updateBackToTopVisibility();
    window.addEventListener('scroll', updateBackToTopVisibility, { passive: true });

    backToTopButton.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // 文本搜索：放大镜切换显示输入框
  const searchToggle = document.getElementById('textSearchToggle');
  const searchWrapper = document.querySelector('#textSearchContainer .search-input-wrapper');
  const searchInput = document.getElementById('textSearchInput');
  const searchClear = document.getElementById('textSearchClear');

  if (searchToggle && searchWrapper && searchInput && searchClear) {
    searchToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      searchWrapper.style.display = 'flex';
      searchInput.focus();
    });

    const handleInput = () => {
      textSearchQuery = searchInput.value.trim();
      searchClear.style.display = textSearchQuery ? 'inline-flex' : 'none';
      renderPapers();
    };
    searchInput.addEventListener('input', handleInput);
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      handleInput();
      searchInput.focus();
    });

    // 点击其他地方不隐藏输入框（需求4），因此不添加blur隐藏逻辑
  }
}

// Function to detect preferred language based on browser settings
function getPreferredLanguage() {
  const browserLang = navigator.language || navigator.userLanguage;
  // Check if browser is set to Chinese variants
  if (browserLang.startsWith('zh')) {
    return 'Chinese';
  }
  // Default to Chinese for all other languages
  return 'Chinese';
}

// Function to select the best available language for a date
function selectLanguageForDate(date, preferredLanguage = null) {
  const availableLanguages = window.dateLanguageMap?.get(date) || [];
  
  if (availableLanguages.length === 0) {
    return 'Chinese'; // fallback
  }
  
  // Use provided preference or detect from browser
  const preferred = preferredLanguage || getPreferredLanguage();
  
  // If preferred language is available, use it
  if (availableLanguages.includes(preferred)) {
    return preferred;
  }
  
  // Fallback: prefer Chinese if available, otherwise use the first available
  return availableLanguages.includes('Chinese') ? 'Chinese' : availableLanguages[0];
}

async function loadLatestFeed() {
  const request = beginPaperLoad('最新');
  try {
    await fetchAvailableDates(request.signal);
    if (request.sequence !== paperLoadSequence) return;
    if (availableDates.length) await loadPapersByDate(availableDates[0]);
    else {
      feedLoadState = 'empty';
      document.getElementById('workspaceDate').textContent = '暂无可用收录';
      document.getElementById('resultSummary').textContent = '暂未发布论文数据';
      showFeedNotice('尚未找到已发布的论文数据。', loadLatestFeed, '可稍后重试，或查看最近一次工作流。');
    }
  } catch (error) {
    if (request.sequence !== paperLoadSequence) return;
    failPaperLoad('收录目录', loadLatestFeed, error);
  }
}

async function fetchAvailableDates(signal) {
  const text = await fetchFeedText(DATA_CONFIG.getDataUrl('assets/file-list.txt'), signal);
  const dateRegex = /^(\d{4}-\d{2}-\d{2})_AI_enhanced_(English|Chinese)\.jsonl$/;
  const dateLanguageMap = new Map();
  text.trim().split('\n').forEach(file => {
    const match = file.trim().match(dateRegex);
    if (!match) return;
    const [, date, language] = match;
    if (!dateLanguageMap.has(date)) dateLanguageMap.set(date, []);
    dateLanguageMap.get(date).push(language);
  });
  window.dateLanguageMap = dateLanguageMap;
  availableDates = [...dateLanguageMap.keys()].sort().reverse();
  initDatePicker();
  return availableDates;
}

function initDatePicker() {
  const datepickerInput = document.getElementById('datepicker');
  
  if (flatpickrInstance) {
    flatpickrInstance.destroy();
  }
  if (typeof flatpickr !== 'function') {
    datepickerInput.hidden = true;
    flatpickrInstance = null;
    initFallbackDatePicker();
    return;
  }
  
  // 创建可用日期的映射，用于禁用无效日期
  const enabledDatesMap = {};
  availableDates.forEach(date => {
    enabledDatesMap[date] = true;
  });
  
  // 配置 Flatpickr
  flatpickrInstance = flatpickr(datepickerInput, {
    inline: true,
    dateFormat: "Y-m-d",
    defaultDate: availableDates[0],
    enable: [
      function(date) {
        // 只启用有效日期
        const dateStr = date.getFullYear() + "-" +
                        String(date.getMonth() + 1).padStart(2, '0') + "-" +
                        String(date.getDate()).padStart(2, '0');
        return isRangeMode
          ? dateStr <= availableDates[0] && dateStr >= availableDates[availableDates.length - 1]
          : !!enabledDatesMap[dateStr];
      }
    ],
    onChange: function(selectedDates, dateStr) {
      if (isRangeMode && selectedDates.length === 2) {
        // 处理日期范围选择
        const startDate = formatDateForAPI(selectedDates[0]);
        const endDate = formatDateForAPI(selectedDates[1]);
        loadPapersByDateRange(startDate, endDate);
        toggleDatePicker();
      } else if (!isRangeMode && selectedDates.length === 1) {
        // 处理单个日期选择
        const selectedDate = formatDateForAPI(selectedDates[0]);
        // if (availableDates.includes(selectedDate)) {
          loadPapersByDate(selectedDate);
          toggleDatePicker();
        // }
      }
    }
  });
  
  // 隐藏日期输入框
  const inputElement = document.querySelector('.flatpickr-input');
  if (inputElement) {
    inputElement.style.display = 'none';
  }
}

function initFallbackDatePicker() {
  document.getElementById('fallbackDatePicker')?.remove();
  const fallback = document.createElement('div'); fallback.id = 'fallbackDatePicker';
  fallback.className = 'fallback-date-picker';
  const help = document.createElement('p'); help.textContent = '选择已收录日期'; fallback.append(help);
  const createSelect = (label, id) => {
    const host = document.createElement('label'); host.textContent = label;
    const select = document.createElement('select'); select.id = id;
    availableDates.forEach(date => { const option = document.createElement('option'); option.value = date; option.textContent = date; select.append(option); });
    host.append(select); fallback.append(host); return select;
  };
  const start = createSelect('开始日期', 'fallbackStartDate');
  const end = createSelect('结束日期', 'fallbackEndDate');
  end.parentElement.hidden = !isRangeMode;
  const submit = document.createElement('button'); submit.type = 'button'; submit.className = 'workspace-button'; submit.textContent = '查看论文';
  submit.disabled = !availableDates.length;
  submit.onclick = () => {
    if (isRangeMode) loadPapersByDateRange(start.value, end.value);
    else loadPapersByDate(start.value);
    toggleDatePicker();
  };
  fallback.append(submit);
  document.querySelector('.flatpickr-container').append(fallback);
}

function formatDateForAPI(date) {
  return date.getFullYear() + "-" + 
         String(date.getMonth() + 1).padStart(2, '0') + "-" + 
         String(date.getDate()).padStart(2, '0');
}

function toggleRangeMode() {
  isRangeMode = document.getElementById('dateRangeMode').checked;
  
  if (flatpickrInstance) {
    flatpickrInstance.set('mode', isRangeMode ? 'range' : 'single');
  }
  const fallbackEnd = document.getElementById('fallbackEndDate');
  if (fallbackEnd) fallbackEnd.parentElement.hidden = !isRangeMode;
}

async function loadPapersByDate(date) {
  currentDate = date;
  const request = beginPaperLoad(date);
  const container = document.getElementById('paperContainer');
  document.getElementById('currentDate').textContent = formatDate(date);
  if (flatpickrInstance) flatpickrInstance.setDate(date, false);
  try {
    const selectedLanguage = selectLanguageForDate(date);
    const text = await fetchFeedText(DATA_CONFIG.getDataUrl(`data/${date}_AI_enhanced_${selectedLanguage}.jsonl`), request.signal);
    if (request.sequence !== paperLoadSequence) return;
    if (!text.trim()) {
      feedLoadState = 'empty';
      updateResearchWorkspace([], [], []);
      showFeedNotice('这个收录日期暂无论文。', () => loadPapersByDate(date));
      return;
    }
    paperData = parseJsonlData(text, date);
    feedLoadState = 'ready';
    container.setAttribute('aria-busy', 'false');

    const categories = getAllCategories(paperData);

    renderCategoryFilter(categories);

    // 如果URL中有category、json、author或keywords参数，直接返回JSON
    // 只有显式带上 ?json= 才进入 API 模式；?category=cs.AI 这类链接正常渲染页面
    const hasJsonParams = urlJsonParam !== null;
    if (hasJsonParams) {
      // 获取基础论文列表（按category或all）
      const targetCategory = urlCategoryParam || urlJsonParam || 'all';
      let papers = getPapersByCategory(paperData, targetCategory);

      // 应用keywords和author匹配（"或"关系）
      if (urlKeywordsParam || urlAuthorParam) {
        papers = matchPapersByKeywordsOrAuthor(papers, urlKeywordsParam, urlAuthorParam);
      }

      // JSON模式：只返回匹配的论文
      if (urlKeywordsParam || urlAuthorParam) papers = papers.filter(p => p.isMatched);

      outputJsonData(papers, targetCategory);
      return;
    }

    renderPapers();
  } catch (error) {
    if (request.sequence !== paperLoadSequence) return;
    failPaperLoad(date, () => loadPapersByDate(date), error);
  }
}

function parseJsonlData(jsonlText, date) {
  const result = {};
  
  const lines = jsonlText.split('\n');
  
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const paper = JSON.parse(line);
      
      if (!paper.categories) {
        return;
      }
      
      let allCategories = Array.isArray(paper.categories) ? paper.categories : [paper.categories];
      
      const primaryCategory = allCategories[0];
      
      if (!result[primaryCategory]) {
        result[primaryCategory] = [];
      }
      
      // 只有真正做过 AI 总结的论文才有 TL;DR；仅收录的论文不要再把摘要塞进 TL;DR（会重复显示）
      const hasAi = !['failed', 'raw'].includes(paper.AI_status) && !!(paper.AI && paper.AI.tldr);
      const abstract = paper.summary || '';
      const shortAbstract = abstract.length > 240 ? abstract.slice(0, 240).trimEnd() + ' …' : abstract;
      
      result[primaryCategory].push({
        title: paper.title,
        url: paper.abs || paper.pdf || `https://arxiv.org/abs/${paper.id}`,
        authors: Array.isArray(paper.authors) ? paper.authors.join(', ') : paper.authors,
        authorNames: Array.isArray(paper.authors) ? paper.authors : undefined,
        published: paper.published || paper.publicationDate || '',
        abstract: paper.summary || '',
        category: allCategories,
        summary: hasAi ? paper.AI.tldr : shortAbstract,
        tldr: hasAi ? paper.AI.tldr : '',
        hasAi: hasAi,
        AI_status: paper.AI_status || (hasAi ? 'success' : 'raw'),
        digest_version: hasAi ? paper.AI.digest_version || 1 : 0,
        research_topics: hasAi ? paper.AI.research_topics || [] : [],
        core_method: hasAi ? paper.AI.core_method || '' : '',
        key_results: hasAi ? paper.AI.key_results || [] : [],
        limitations: hasAi ? paper.AI.limitations || [] : [],
        relevance: typeof paper.relevance === 'number' ? paper.relevance : 0,
        details: paper.summary || '',
        date: date,
        id: paper.id,
        motivation: hasAi && paper.AI.motivation ? paper.AI.motivation : '',
        method: hasAi && paper.AI.method ? paper.AI.method : '',
        result: hasAi && paper.AI.result ? paper.AI.result : '',
        conclusion: hasAi && paper.AI.conclusion ? paper.AI.conclusion : '',
        code_url: paper.code_url || '',
        code_stars: paper.code_stars || 0,
        code_last_update: paper.code_last_update || ''
      });
    } catch (error) {
      const invalidData = new Error(`论文数据解析失败：${date}，第 ${index + 1} 行。`);
      invalidData.code = 'INVALID_PAPER_DATA';
      throw invalidData;
    }
  });

  // 每个分类内部按相关度从高到低排序（老数据没有分数时保持原顺序）
  Object.values(result).forEach(list => {
    list.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
  });
  
  return result;
}

// 获取所有类别并按偏好排序
function getAllCategories(data) {
  const counts = {};
  ResearchWorkspace.unique(Object.values(data).flat()).forEach(paper => {
    [...new Set(paper.category)].forEach(category => { counts[category] = (counts[category] || 0) + 1; });
  });
  return {sortedCategories: Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b)), categoryCounts: counts};
}

function renderCategoryFilter(categories) {
  const container = document.querySelector('.category-scroll');
  const { sortedCategories, categoryCounts } = categories;
  
  const totalPapers = ResearchWorkspace.unique(Object.values(paperData).flat()).length;

  container.innerHTML = `
    <button class="category-button ${currentCategory === 'all' ? 'active' : ''}" data-category="all">全部<span class="category-count">${totalPapers}</span></button>
  `;
  
  sortedCategories.forEach(category => {
    const count = categoryCounts[category];
    const button = document.createElement('button');
    button.className = `category-button ${category === currentCategory ? 'active' : ''}`;
    button.innerHTML = `${PaperDigest.escape(category)}<span class="category-count">${count}</span>`;
    button.dataset.category = category;
    button.addEventListener('click', () => {
      filterByCategory(category);
    });
    
    container.appendChild(button);
  });
  
  document.querySelector('.category-button[data-category="all"]').addEventListener('click', () => {
    filterByCategory('all');
  });
}

function filterByCategory(category) {
  currentCategory = category;

  // 如果不是JSON模式，才更新URL参数
  if (!isJsonMode()) {
    const url = new URL(window.location);
    if (category === 'all') {
      url.searchParams.delete('category');
    } else {
      url.searchParams.set('category', category);
    }
    // 使用replaceState更新URL，不刷新页面
    window.history.replaceState({}, '', url);
  }

  document.querySelectorAll('.category-scroll .category-button').forEach(button => {
    button.classList.toggle('active', button.dataset.category === category);
  });

  // 保持当前激活的过滤标签
  renderFilterTags();

  // 重置页面滚动条到顶部
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
  
  renderPapers();
}

// 帮助函数：高亮文本中的匹配内容
function highlightMatches(text, terms, className = 'highlight-match') {
  const value = String(text || '');
  const words = [...new Set((terms || []).filter(v => typeof v === 'string' && v))].sort((a,b) => b.length-a.length);
  if (!words.length) return PaperDigest.escape(value);
  const pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let result = '', last = 0;
  for (const match of value.matchAll(pattern)) {
    result += PaperDigest.escape(value.slice(last, match.index)) + '<span class="' + PaperDigest.escape(className) + '">' + PaperDigest.escape(match[0]) + '</span>';
    last = match.index + match[0].length;
  }
  return result + PaperDigest.escape(value.slice(last));
}

// 帮助函数：格式化作者列表（用于论文卡片显示）
// 规则：≤4个作者全部显示，>4个作者显示前2+后2，中间用省略号
function formatAuthorsForCard(authorsString, authorTerms = []) {
  if (!authorsString) {
    return '';
  }
  
  // 将作者字符串解析为数组（处理逗号分隔的情况）
  const authorsArray = authorsString.split(',').map(author => author.trim()).filter(author => author.length > 0);
  
  if (authorsArray.length === 0) {
    return '';
  }
  
  // 如果不超过4个作者，全部显示
  if (authorsArray.length <= 4) {
    return authorsArray.map(author => {
      // 对每个作者应用高亮
      const highlightedAuthor = authorTerms.length > 0 
        ? highlightMatches(author, authorTerms, 'author-highlight')
        : PaperDigest.escape(author);
      return `<span class="author-item">${highlightedAuthor}</span>`;
    }).join(', ');
  }
  
  // 超过4个作者：显示前2个、省略号、后2个
  const firstTwo = authorsArray.slice(0, 2);
  const lastTwo = authorsArray.slice(-2);
  
  const result = [];
  
  // 前2个作者
  firstTwo.forEach(author => {
    const highlightedAuthor = authorTerms.length > 0 
      ? highlightMatches(author, authorTerms, 'author-highlight')
      : PaperDigest.escape(author);
    result.push(`<span class="author-item">${highlightedAuthor}</span>`);
  });
  
  // 省略号
  result.push('<span class="author-ellipsis">...</span>');
  
  // 后2个作者
  lastTwo.forEach(author => {
    const highlightedAuthor = authorTerms.length > 0 
      ? highlightMatches(author, authorTerms, 'author-highlight')
      : PaperDigest.escape(author);
    result.push(`<span class="author-item">${highlightedAuthor}</span>`);
  });
  
  return result.join(', ');
}

function renderPapers() {
  if (!['idle', 'ready'].includes(feedLoadState)) return;
  const container = document.getElementById('paperContainer');
  container.innerHTML = '';
  container.className = `paper-container ${currentView === 'compact' ? 'compact-view' : ''}`;
  
  const allPapers = ResearchWorkspace.unique(Object.values(paperData).flat());
  const papers = allPapers.filter(paper => currentCategory === 'all' || paper.category.includes(currentCategory));
  const markedPapers = papers.map(paper => {
    const keywords = activeKeywords.filter(keyword => paperMatchesKeyword(paper, keyword));
    const authors = activeAuthors.filter(author => paperMatchesAuthor(paper, author));
    const reasons = [];
    if (keywords.length) reasons.push(`关键词: ${keywords.join(', ')}`);
    if (authors.length) reasons.push(`作者: ${authors.join(', ')}`);
    if (textSearchQuery && ResearchWorkspace.matchesQuery(paper, textSearchQuery)) reasons.push(`搜索: ${textSearchQuery}`);
    return {...paper, isMatched: reasons.length > 0, matchReason: reasons};
  });
  const filteredPapers = ResearchWorkspace.select(markedPapers, {topic: currentTopic, query: textSearchQuery, onlyMatched, sort: paperSort});
  updateResearchWorkspace(allPapers, markedPapers, filteredPapers);

  // 存储当前过滤后的论文列表，用于箭头键导航
  currentFilteredPapers = [...filteredPapers];
  
  if (filteredPapers.length === 0) {
    container.innerHTML = `
      <div class="loading-container">
        <p>没有符合当前条件的论文。</p><p>可清除筛选，或选择其他收录日期。</p>
      </div>
    `;
    return;
  }
  
  filteredPapers.forEach((paper, index) => {
    const paperCard = document.createElement('div');
    // 添加匹配高亮类
    paperCard.className = `paper-card ${paper.isMatched ? 'matched-paper' : ''}`;
    paperCard.dataset.id = paper.id || paper.url;
    paperCard.tabIndex = 0;
    paperCard.setAttribute('role', 'article');
    paperCard.setAttribute('aria-label', paper.title);
    paperCard.addEventListener('keydown', event => {
      if (event.target === paperCard && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); currentPaperIndex = index; showPaperDetails(paper, index + 1); }
    });
    
    if (paper.isMatched) {
      // 添加匹配原因提示
      paperCard.title = `匹配: ${paper.matchReason.join(' | ')}`;
    }
    
    const categoryTags = paper.category ? 
      paper.category.map(cat => `<span class="category-tag">${PaperDigest.escape(cat)}</span>`).join('') : 
      `<span class="category-tag">${PaperDigest.escape(paper.category)}</span>`;
    
    // 组合需要高亮的词：关键词 + 文本搜索
    const titleSummaryTerms = [];
    if (activeKeywords.length > 0) {
      titleSummaryTerms.push(...expandKeywordsForHighlight(activeKeywords));
    }
    if (textSearchQuery && textSearchQuery.trim().length > 0) {
      titleSummaryTerms.push(...getKeywordAliases(textSearchQuery));
    }

    // 高亮标题和摘要（关键词与文本搜索）
    const highlightedTitle = titleSummaryTerms.length > 0 
      ? highlightMatches(paper.title, titleSummaryTerms, 'keyword-highlight') 
      : PaperDigest.escape(paper.title);
    const highlightedSummary = titleSummaryTerms.length > 0 
      ? highlightMatches(paper.summary, titleSummaryTerms, 'keyword-highlight') 
      : PaperDigest.escape(paper.summary);

    // 高亮作者（作者过滤 + 文本搜索）
    const authorTerms = [];
    if (activeAuthors.length > 0) authorTerms.push(...activeAuthors);
    if (textSearchQuery && textSearchQuery.trim().length > 0) authorTerms.push(textSearchQuery.trim());
    
    // 格式化作者列表（应用截断规则和高亮）
    const formattedAuthors = formatAuthorsForCard(paper.authors, authorTerms);
    
    // 构建 GitHub 按钮 HTML
    // let githubHtml = '';
    // if (paper.code_url) {
    //   const stars = paper.code_stars ? `<span class="github-stars">★ ${paper.code_stars}</span>` : '';
    //   const isHot = paper.code_stars > 100;
      
    //   githubHtml = `
    //     <a href="${paper.code_url}" target="_blank" class="github-link" title="View Code" onclick="event.stopPropagation()">
    //       <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: text-bottom; margin-right: 4px;">
    //         <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
    //       </svg>
    //       Code ${stars}
    //       ${isHot ? '<span class="hot-icon">🔥</span>' : ''}
    //     </a>
    //   `;
    // }

    paperCard.innerHTML = `
      <div class="paper-card-index">${index + 1}</div>
      ${paper.isMatched ? '<div class="match-badge" title="匹配您的搜索条件"></div>' : ''}
      <div class="paper-card-header">
        <h3 class="paper-card-title">${highlightedTitle}</h3>
        <p class="paper-card-authors" title="${PaperDigest.escape(paper.authors)}">${formattedAuthors}</p>
        <p class="paper-card-provenance">${PaperDigest.escape(paper.id || '')}${paper.published ? ` · 发布 ${PaperDigest.escape(paper.published.slice(0, 10))}` : ''}</p>
        <div class="paper-card-categories">
          ${categoryTags}
          ${paper.relevance ? `<span class="paper-card-score" title="与关注方向的相关度，仅用于排序，不代表论文质量">相关度 ${paper.relevance.toFixed(2)}</span>` : ''}
        </div>
      </div>
      <div class="paper-card-body">
        <p class="paper-card-summary-label">${paper.hasAi ? 'AI 一句话解读' : '作者摘要节选'}</p>
        <p class="paper-card-summary">${highlightedSummary}</p>
        ${PaperDigest.card(paper)}
        <div class="paper-card-footer">
          <div class="footer-left">
            <span class="paper-card-date">收录于 ${formatDate(paper.date)}</span>
          </div>
          <span class="paper-card-link">阅读解读 →</span>
        </div>
      </div>
    `;
    
    if (window.ReadingList) ReadingList.mount(paperCard.querySelector('.paper-card-footer'), paper);
    paperCard.addEventListener('click', () => {
      currentPaperIndex = index; // 记录当前点击的论文索引
      showPaperDetails(paper, index + 1);
    });
    
    container.appendChild(paperCard);
  });
}

function showPaperDetails(paper, paperIndex) {
  const readingActions = document.querySelector('.paper-modal-buttons');
  readingActions.querySelector('[data-reading-id]')?.remove();
  if (window.ReadingList) ReadingList.mount(readingActions, paper);
  const modal = document.getElementById('paperModal');
  const wasOpen = modal.classList.contains('active');
  if (!wasOpen) modalReturnFocus = document.activeElement;
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const paperLink = document.getElementById('paperLink');
  const pdfLink = document.getElementById('pdfLink');
  const htmlLink = document.getElementById('htmlLink');
  
  // 重置模态框的滚动位置
  modalBody.scrollTop = 0;
  
  // 组合高亮词：关键词 + 文本搜索
  const modalTitleTerms = [];
  if (activeKeywords.length > 0) modalTitleTerms.push(...expandKeywordsForHighlight(activeKeywords));
  if (textSearchQuery && textSearchQuery.trim().length > 0) modalTitleTerms.push(...getKeywordAliases(textSearchQuery));
  // 高亮标题
  const highlightedTitle = modalTitleTerms.length > 0 
    ? highlightMatches(paper.title, modalTitleTerms, 'keyword-highlight') 
    : PaperDigest.escape(paper.title);
  
  // 在标题前添加索引号
  modalTitle.innerHTML = paperIndex ? `<span class="paper-index-badge">${paperIndex}</span> ${highlightedTitle}` : highlightedTitle;
  
  const modalContent = PaperDigest.details(paper);

  // Update modal content
  document.getElementById('modalBody').innerHTML = modalContent;
  PaperDigest.attach(modalBody, paper);
  const sourcePdf = PaperDigest.pdfUrl(paper);
  const sourceAbs = sourcePdf ? sourcePdf.replace('/pdf/', '/abs/') : '';
  [[paperLink, sourceAbs], [pdfLink, sourcePdf], [htmlLink, sourcePdf ? sourcePdf.replace('/pdf/', '/html/') : '']].forEach(([link, url]) => {
    if (url) { link.href = url; link.removeAttribute('aria-disabled'); }
    else { link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true'); }
  });
  
  // --- GitHub Button Logic ---
  const githubLink = document.getElementById('githubLink');
  
  if (/^https:\/\//i.test(paper.code_url)) {
    githubLink.href = paper.code_url;
    githubLink.style.display = 'flex'; 
    githubLink.title = "View Code on GitHub";
  } else {
    githubLink.style.display = 'none';
  }
  // ---------------------------

  // 提示词来自：https://papers.cool/
  const prompt = `请你阅读这篇文章${sourcePdf || paper.url},总结一下这篇文章解决的问题、相关工作、研究方法、做了什么实验及其结果、结论，最后整体总结一下这篇文章的内容`
  document.getElementById('kimiChatLink').href = `https://www.kimi.com/_prefill_chat?prefill_prompt=${encodeURIComponent(prompt)}&system_prompt=你是一个学术助手，后面的对话将围绕着以下论文内容进行，已经通过链接给出了论文的PDF和论文已有的FAQ。用户将继续向你咨询论文的相关问题，请你作出专业的回答，不要出现第一人称，当涉及到分点回答时，鼓励你以markdown格式输出。&send_immediately=true&force_search=true`;
  
  // 更新论文位置信息
  const paperPosition = document.getElementById('paperPosition');
  if (paperPosition && currentFilteredPapers.length > 0) {
    paperPosition.textContent = `${currentPaperIndex + 1} / ${currentFilteredPapers.length}`;
  }
  
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (!wasOpen) document.getElementById('closeModal').focus();
}

function closeModal() {
  const modal = document.getElementById('paperModal');
  const modalBody = document.getElementById('modalBody');
  
  // 重置模态框的滚动位置
  modalBody.scrollTop = 0;
  
  modal.classList.remove('active');
  document.body.style.overflow = '';
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

// 导航到上一篇论文
function navigateToPreviousPaper() {
  if (currentFilteredPapers.length === 0) return;
  
  currentPaperIndex = currentPaperIndex > 0 ? currentPaperIndex - 1 : currentFilteredPapers.length - 1;
  const paper = currentFilteredPapers[currentPaperIndex];
  showPaperDetails(paper, currentPaperIndex + 1);
}

// 导航到下一篇论文
function navigateToNextPaper() {
  if (currentFilteredPapers.length === 0) return;
  
  currentPaperIndex = currentPaperIndex < currentFilteredPapers.length - 1 ? currentPaperIndex + 1 : 0;
  const paper = currentFilteredPapers[currentPaperIndex];
  showPaperDetails(paper, currentPaperIndex + 1);
}

// 显示随机论文
function showRandomPaper() {
  // 检查是否有可用的论文
  if (currentFilteredPapers.length === 0) {
    console.log('No papers available to show random paper');
    return;
  }
  
  // 生成随机索引
  const randomIndex = Math.floor(Math.random() * currentFilteredPapers.length);
  const randomPaper = currentFilteredPapers[randomIndex];
  
  // 更新当前论文索引
  currentPaperIndex = randomIndex;
  
  // 显示随机论文
  showPaperDetails(randomPaper, currentPaperIndex + 1);
  
  // 显示随机论文指示器
  showRandomPaperIndicator();
  
  console.log(`Showing random paper: ${randomIndex + 1}/${currentFilteredPapers.length}`);
}

// 显示随机论文指示器
function showRandomPaperIndicator() {
  // 移除已存在的指示器
  const existingIndicator = document.querySelector('.random-paper-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }
  
  // 创建新的指示器
  const indicator = document.createElement('div');
  indicator.className = 'random-paper-indicator';
  indicator.textContent = 'Random Paper';
  
  // 添加到页面
  document.body.appendChild(indicator);
  
  // 3秒后自动移除
  setTimeout(() => {
    if (indicator && indicator.parentNode) {
      indicator.remove();
    }
  }, 3000);
}

function toggleDatePicker() {
  const datePicker = document.getElementById('datePickerModal');
  if (!datePicker.classList.contains('active')) datePickerReturnFocus = document.activeElement;
  datePicker.classList.toggle('active');
  
  if (datePicker.classList.contains('active')) {
    document.body.style.overflow = 'hidden';
    
    // 重新初始化日期选择器以确保它反映最新的可用日期
    if (flatpickrInstance) {
      const selection = currentDate.split(' to ');
      flatpickrInstance.setDate(isRangeMode ? selection : selection[0], false);
    }
    document.getElementById('closeDatePicker').focus();
  } else {
    document.body.style.overflow = '';
    datePickerReturnFocus?.focus();
  }
}

function toggleView() {
  currentView = currentView === 'grid' ? 'list' : 'grid';
  document.getElementById('paperContainer').classList.toggle('list-view', currentView === 'list');
}

function formatDate(dateString) {
  // Collection filenames are calendar dates; never reinterpret them in a timezone.
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateString)) ? dateString : '';
}

async function loadPapersByDateRange(startDate, endDate) {
  const normalizedStartDate = startDate <= endDate ? startDate : endDate;
  const normalizedEndDate = startDate <= endDate ? endDate : startDate;
  const validDatesInRange = availableDates.filter(date => date >= normalizedStartDate && date <= normalizedEndDate);
  currentDate = `${normalizedStartDate} to ${normalizedEndDate}`;
  const label = `${normalizedStartDate} 至 ${normalizedEndDate}`;
  const request = beginPaperLoad(label);
  const container = document.getElementById('paperContainer');
  document.getElementById('currentDate').textContent = label;
  if (!validDatesInRange.length) {
    feedLoadState = 'empty';
    updateResearchWorkspace([], [], []);
    showFeedNotice('所选范围没有已收录的论文，请选择其他日期。');
    return;
  }
  try {
    const allPaperData = {};
    // Four requests at a time; publish the selected range only after all succeed.
    for (let offset = 0; offset < validDatesInRange.length; offset += 4) {
      const batch = validDatesInRange.slice(offset, offset + 4);
      const sources = await Promise.all(batch.map(async date => {
        const language = selectLanguageForDate(date);
        return [date, await fetchFeedText(DATA_CONFIG.getDataUrl(`data/${date}_AI_enhanced_${language}.jsonl`), request.signal)];
      }));
      if (request.sequence !== paperLoadSequence) return;
      sources.forEach(([date, text]) => {
        const dataPapers = parseJsonlData(text, date);
        Object.keys(dataPapers).forEach(category => {
          allPaperData[category] = (allPaperData[category] || []).concat(dataPapers[category]);
        });
      });
      document.getElementById('resultSummary').textContent = `已读取 ${Math.min(offset + 4, validDatesInRange.length)} / ${validDatesInRange.length} 期`;
    }
    paperData = allPaperData;
    feedLoadState = 'ready';
    container.setAttribute('aria-busy', 'false');

    const categories = getAllCategories(paperData);

    renderCategoryFilter(categories);

    // 如果URL中有category、json、author或keywords参数，直接返回JSON
    // 只有显式带上 ?json= 才进入 API 模式；?category=cs.AI 这类链接正常渲染页面
    const hasJsonParams = urlJsonParam !== null;
    if (hasJsonParams) {
      // 获取基础论文列表（按category或all）
      const targetCategory = urlCategoryParam || urlJsonParam || 'all';
      let papers = getPapersByCategory(paperData, targetCategory);

      // 应用keywords和author匹配（"或"关系）
      if (urlKeywordsParam || urlAuthorParam) {
        papers = matchPapersByKeywordsOrAuthor(papers, urlKeywordsParam, urlAuthorParam);
      }

      // JSON模式：只返回匹配的论文
      if (urlKeywordsParam || urlAuthorParam) papers = papers.filter(p => p.isMatched);

      outputJsonData(papers, targetCategory);
      return;
    }

    renderPapers();
  } catch (error) {
    if (request.sequence !== paperLoadSequence) return;
    feedLoadController.abort();
    failPaperLoad(label, () => loadPapersByDateRange(startDate, endDate), error);
  }
}

// 清除所有激活的关键词
function clearAllKeywords() {
  activeKeywords = [];
  // renderKeywordTags();
  // 重新渲染论文列表，移除关键词匹配的高亮和优先排序
  renderPapers();
}

// 清除所有作者过滤
function clearAllAuthors() {
  activeAuthors = [];
  renderFilterTags();
  // 重新渲染论文列表，移除作者匹配的高亮和优先排序
  renderPapers();
}

// 切换PDF预览器大小
function togglePdfSize(button) {
  const pdfContainer = button.closest('.pdf-preview-section').querySelector('.pdf-container');
  const iframe = pdfContainer.querySelector('iframe');
  const expandIcon = button.querySelector('.expand-icon');
  const collapseIcon = button.querySelector('.collapse-icon');
  
  if (pdfContainer.classList.contains('expanded')) {
    // 恢复正常大小
    pdfContainer.classList.remove('expanded');
    iframe.style.height = '800px';
    expandIcon.style.display = 'block';
    collapseIcon.style.display = 'none';
    
    // 移除遮罩层
    const overlay = document.querySelector('.pdf-overlay');
    if (overlay) {
      overlay.remove();
    }
  } else {
    // 放大显示
    pdfContainer.classList.add('expanded');
    iframe.style.height = '90vh';
    expandIcon.style.display = 'none';
    collapseIcon.style.display = 'block';
    
    // 添加遮罩层
    const overlay = document.createElement('div');
    overlay.className = 'pdf-overlay';
    document.body.appendChild(overlay);
    
    // 点击遮罩层时收起PDF
    overlay.addEventListener('click', () => {
      togglePdfSize(button);
    });
  }
}
