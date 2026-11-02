/* Feed selection helpers. Source metadata is never rewritten by a view/filter. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ResearchWorkspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const TOPICS = ['机器人策略', '感知与导航', '操作与运动', '世界模型', '规划与推理', '数据与仿真', '评测', '效率与部署'];
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\u2010-\u2015_-]/g, ' ').replace(/\s+/g, ' ').trim();
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
  function matchesQuery(paper, query) {
    const terms = String(query || '').split(/[|｜]/).map(normalize).filter(Boolean);
    if (!terms.length) return true;
    const findings = Array.isArray(paper.key_results) ? paper.key_results.map(row => row?.finding || '') : [];
    const haystack = normalize([paper.id, paper.title, paper.authors, paper.category, paper.abstract, paper.details, paper.summary, paper.core_method, paper.motivation, paper.method, paper.result, paper.conclusion, ...findings].join(' '));
    return terms.some(term => haystack.includes(term));
  }
  function select(papers, {topic = 'all', query = '', onlyMatched = false, sort = 'relevance'} = {}) {
    return unique(papers).filter(paper =>
      (topic === 'all' || (topic === 'untagged' ? !topics(paper).length : topics(paper).includes(topic))) &&
      matchesQuery(paper, query) && (!onlyMatched || paper.isMatched)
    ).sort((a, b) => {
      if (sort === 'published') {
        const dateA = Date.parse(a.published || '') || 0, dateB = Date.parse(b.published || '') || 0;
        return dateB - dateA || (b.relevance || 0) - (a.relevance || 0);
      }
      return Number(!!b.isMatched) - Number(!!a.isMatched) || (b.relevance || 0) - (a.relevance || 0);
    });
  }
  return {TOPICS, identity, unique, topics, topicCounts, matchesQuery, select};
});
