/* Feed selection helpers. Source metadata is never rewritten by a view/filter. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ResearchWorkspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const TOPICS = ['机器人策略', '感知与导航', '操作与运动', '世界模型', '规划与推理', '数据与仿真', '评测', '效率与部署'];
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\u2010-\u2015_-]/g, ' ').replace(/\s+/g, ' ').trim();
  const SEARCH_FIELDS = ['id', 'title', 'authors', 'category', 'abstract', 'details', 'summary', 'core_method', 'motivation', 'method', 'result', 'conclusion'];
  let searchIndex = new WeakMap(), indexedPapers = 0, indexedCharacters = 0;
  const MAX_INDEXED_PAPERS = 2048, MAX_INDEXED_CHARACTERS = 8 * 1024 * 1024;
  function identity(paper) {
    return String(paper.id || paper.url || '').replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
  }
  function unique(papers) {
    const selected = new Map();
    papers.forEach((paper, index) => {
      const key = identity(paper) || `missing:${index}`;
      const existing = selected.get(key);
      if (!existing || String(paper.date || '') > String(existing.date || '')) selected.set(key, paper);
    });
    return [...selected.values()];
  }
  function topics(paper) {
    return Array.isArray(paper.research_topics) ? [...new Set(paper.research_topics.filter(topic => TOPICS.includes(topic)))] : [];
  }
  function topicCounts(papers) {
    const counts = new Map(TOPICS.map(topic => [topic, 0]));
    let untagged = 0;
    unique(papers).forEach(paper => {
      const labels = topics(paper);
      if (!labels.length) untagged++;
      labels.forEach(topic => counts.set(topic, counts.get(topic) + 1));
    });
    return {topics: [...counts].filter(([, count]) => count > 0), untagged};
  }
  function searchableText(paper) {
    // Keep a cheap dependency snapshot so even in-place edits of author/category
    // arrays and result findings cannot leave the index showing outdated text.
    // Joining these small fields is cheaper than normalizing whole abstracts
    // and method descriptions on every key press.
    const parts = SEARCH_FIELDS.map(field => String(paper[field] ?? ''));
    if (Array.isArray(paper.key_results)) parts.push(...paper.key_results.map(row => String(row?.finding || '')));
    const cached = searchIndex.get(paper);
    if (cached && cached.parts.length === parts.length && parts.every((value, index) => value === cached.parts[index])) return cached.haystack;
    const haystack = normalize(parts.join(' '));
    // Weak keys avoid retaining abandoned feeds. These additional limits also
    // bound index overhead while a large date range remains reachable.
    if (haystack.length > MAX_INDEXED_CHARACTERS) {
      if (cached) { searchIndex.delete(paper); indexedPapers--; indexedCharacters -= cached.haystack.length; }
      return haystack;
    }
    let replacing = !!cached;
    if ((!cached && indexedPapers >= MAX_INDEXED_PAPERS) || indexedCharacters - (cached?.haystack.length || 0) + haystack.length > MAX_INDEXED_CHARACTERS) {
      searchIndex = new WeakMap(); indexedPapers = 0; indexedCharacters = 0; replacing = false;
    }
    indexedCharacters += haystack.length - (replacing ? cached.haystack.length : 0);
    if (!replacing) indexedPapers++;
    searchIndex.set(paper, {parts, haystack});
    return haystack;
  }
  function createQueryMatcher(query) {
    const terms = String(query || '').split(/[|｜]/).map(normalize).filter(Boolean);
    if (!terms.length) return () => true;
    return paper => {
      const haystack = searchableText(paper);
      return terms.some(term => haystack.includes(term));
    };
  }
  function matchesQuery(paper, query) {
    return createQueryMatcher(query)(paper);
  }
  function select(papers, {topic = 'all', query = '', onlyMatched = false, sort = 'relevance', queryMatcher} = {}) {
    const matches = typeof queryMatcher === 'function' ? queryMatcher : createQueryMatcher(query);
    return unique(papers).filter(paper =>
      (topic === 'all' || (topic === 'untagged' ? !topics(paper).length : topics(paper).includes(topic))) &&
      matches(paper) && (!onlyMatched || paper.isMatched)
    ).sort((a, b) => {
      if (sort === 'published') {
        const dateA = Date.parse(a.published || '') || 0, dateB = Date.parse(b.published || '') || 0;
        return dateB - dateA || (b.relevance || 0) - (a.relevance || 0);
      }
      return Number(!!b.isMatched) - Number(!!a.isMatched) || (b.relevance || 0) - (a.relevance || 0);
    });
  }
  return {TOPICS, identity, unique, topics, topicCounts, createQueryMatcher, matchesQuery, select};
});
