/* Native Zotero identifier lookup and metadata-only CSL JSON; no credentials. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZoteroExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const text = value => typeof value === 'string' ? value.trim() : '';
  function arxivId(value) {
    let id = text(value).replace(/^arxiv:\s*/i, '');
    if (/^https?:/i.test(id)) {
      try {
        const url = new URL(id);
        if (!/^(?:www\.|export\.)?arxiv\.org$/i.test(url.hostname)) return '';
        id = decodeURIComponent(url.pathname).replace(/^\/(?:abs|pdf|html)\//, '');
      } catch { return ''; }
    }
    id = id.replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
    return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})$/i.test(id) ? id.toLowerCase() : '';
  }
  function dateParts(value) {
    // Only explicit publication metadata. Never derive a publication day from an ID or crawl date.
    const match = text(value).match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/);
    if (!match) return null;
    const parts = match.slice(1).filter(Boolean).map(Number);
    const [year, month, day] = parts;
    if (year < 1000 || (month !== undefined && (month < 1 || month > 12))) return null;
    if (day !== undefined && (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())) return null;
    return parts;
  }
  function authors(value) {
    // New records keep the original array. Commas in legacy strings were the app's separator.
    const names = Array.isArray(value) ? value : text(value).split(/\s*[,;；\n]\s*/);
    return names.flatMap(name => {
      if (typeof name === 'string') return text(name) ? [{literal: text(name)}] : [];
      if (!name || typeof name !== 'object') return [];
      const literal = text(name.literal || name.name);
      if (literal) return [{literal}];
      const family = text(name.family || name.lastName), given = text(name.given || name.firstName);
      if (!family && !given) return [];
      return [family ? {family, ...(given ? {given} : {})} : {literal: given}];
    });
  }
  function build(papers) {
    if (!Array.isArray(papers)) throw new TypeError('Expected a paper array');
    const unique = new Map(); let skipped = 0, duplicates = 0;
    for (const paper of papers) {
      if (!paper || typeof paper !== 'object') { skipped++; continue; }
      const id = arxivId(paper.id) || arxivId(paper.url);
      if (!id) { skipped++; continue; }
      const candidate = {
        id: `arxiv:${id}`, type: 'article', title: text(paper.title),
        URL: `https://arxiv.org/abs/${id}`, archive: 'arXiv', archive_location: id,
        note: `arXiv: ${id}`, author: authors(paper.authorNames ?? paper.authors),
        abstract: text(paper.abstract) || text(paper.details)
      };
      const issued = [paper.published, paper.publicationDate].map(dateParts).find(Boolean);
      if (issued) candidate.issued = {'date-parts': [issued]};
      if (unique.has(id)) {
        duplicates++;
        const existing = unique.get(id);
        for (const field of ['title', 'abstract', 'issued']) if (!existing[field] && candidate[field]) existing[field] = candidate[field];
        if (!existing.author.length) existing.author = candidate.author;
      } else unique.set(id, candidate);
    }
    const items = [...unique.values()];
    const missing = {title: 0, authors: 0, published: 0, abstract: 0};
    for (const item of items) {
      if (!item.title) { missing.title++; item.title = `arXiv: ${item.archive_location}`; }
      if (!item.author.length) { missing.authors++; delete item.author; }
      if (!item.abstract) { missing.abstract++; delete item.abstract; }
      if (!item.issued) missing.published++;
    }
    // Explicit arXiv prefixes prevent old numeric IDs being interpreted as other identifiers.
    const identifiers = items.map(item => `arXiv:${item.archive_location}`).join('\n');
    return {items, skipped, duplicates, missing, identifiers, content: JSON.stringify(items, null, 2) + '\n'};
  }
  return {arxivId, dateParts, authors, build};
});
