/* Shared, evidence-aware reading view for the feed and saved papers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaperDigest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const text = value => typeof value === 'string' ? value.trim() : '';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const list = value => Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).slice(0, 4) : [];
  function ready(paper) {
    return !['failed', 'raw'].includes(paper.AI_status) && !!text(paper.tldr);
  }
  // Availability check only: matching a number does not verify its units,
  // baseline, direction, or the scientific validity of a claim.
  function numericValues(value) {
    const content = text(value), values = new Set();
    for (const match of content.matchAll(/(?<![A-Za-z0-9_.])[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
      const prefix = content.slice(0, match.index), suffix = content.slice(match.index + match[0].length);
      if (/[A-Za-z][A-Za-z0-9_]*[-.]$/.test(prefix)) continue;
      if (/^[A-Za-z]/.test(suffix) && !/^(?:ms|s|fps|hz|khz|mhz|ghz|kb|mb|gb|tb|mm|cm|m|km|w|kw|x)(?![A-Za-z])/i.test(suffix)) continue;
      const normalized = match[0].replaceAll(',', '').replace('−', '-').toLowerCase();
      const sign = normalized.startsWith('-') ? '-' : '';
      const [coefficient, exponent = '0'] = normalized.replace(/^[+-]/, '').split('e');
      const fractionLength = (coefficient.split('.')[1] || '').length;
      let digits = coefficient.replace('.', '').replace(/^0+/, '');
      if (!digits) { values.add('0'); continue; }
      const zeros = (digits.match(/0+$/) || [''])[0].length;
      digits = zeros ? digits.slice(0, -zeros) : digits;
      values.add(`${sign}${digits}e${Number(exponent) - fractionLength + zeros}`);
    }
    return values;
  }
  function results(paper) {
    const abstract = text(paper.abstract || paper.details);
    const sourceNumbers = numericValues(abstract);
    return (Array.isArray(paper.key_results) ? paper.key_results : []).filter(row => {
      if (!row || !text(row.finding) || text(row.evidence_quote).length < 12 || !abstract.includes(text(row.evidence_quote))) return false;
      const quoteNumbers = numericValues(row.evidence_quote);
      return [...numericValues(row.finding)].every(value => quoteNumbers.has(value)) && [...numericValues(row.setting)].every(value => sourceNumbers.has(value));
    }).slice(0, 3);
  }
  function tags(paper) {
    return list(paper.research_topics).map(topic => `<span class="digest-topic">${escape(topic)}</span>`).join('');
  }
  function arxivId(paper) {
    const raw = text(paper.sourceId) || text(paper.id) || text(paper.url);
    const id = raw.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i, '').replace(/\.pdf$/i, '');
    return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(id) ? id : '';
  }
  function sourceMetadata(paper) {
    const id = arxivId(paper);
    const authors = Array.isArray(paper.authorNames) ? paper.authorNames.join(', ') : Array.isArray(paper.authors) ? paper.authors.join(', ') : text(paper.authors);
    const categories = Array.isArray(paper.category) ? paper.category.join(' · ') : text(paper.category);
    const submitted = text(paper.published || paper.publicationDate);
    const sourceDate = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(submitted) ? submitted.slice(0, 10) : submitted;
    return `<section class="digest-bibliography" aria-label="原始文献信息">
      <p class="digest-authors">${escape(authors || '作者信息未收录，请以 arXiv 为准')}</p>
      <div class="digest-bibliography-row">${id ? `<a class="digest-arxiv" href="https://arxiv.org/abs/${escape(id)}" target="_blank" rel="noopener noreferrer">arXiv:${escape(id)} <span aria-hidden="true">↗</span></a>` : ''}${categories ? `<span>${escape(categories)}</span>` : ''}</div>
      <div class="digest-dates"><span>${sourceDate ? `arXiv 提交：${escape(sourceDate)}` : '提交日期未收录，可在 arXiv 查看'}</span>${paper.date ? `<span>本站收录：${escape(paper.date)}</span>` : ''}</div>
    </section>`;
  }
  function card(paper) {
    if (!ready(paper)) return `<div class="digest-state">${paper.AI_status === 'failed' ? '解读待重试' : '暂无 AI 解读'} · 可查看原始摘要</div>`;
    const findings = results(paper);
    const method = text(paper.core_method || paper.method);
    const result = findings.length ? findings.slice(0, 2).map(row => `${text(row.setting) ? row.setting + '：' : ''}${row.finding}`).join('；') : paper.digest_version >= 2 ? '' : text(paper.result);
    return `<div class="digest-card"><div class="digest-labels"><span class="digest-source">AI 摘要解读</span>${tags(paper)}</div>
      ${method ? `<div class="digest-card-method"><strong>核心方法</strong><p>${escape(method)}</p></div>` : ''}
      ${result ? `<div class="digest-card-result"><strong>关键结果 · 作者报告</strong><p>${escape(result)}</p></div>` : '<p class="digest-muted">尚无结构化结果，请查看摘要。</p>'}</div>`;
  }
  function section(title, content, name = '', className = '') {
    return text(content) ? `<section class="digest-section ${className}" ${name ? `data-digest-section="${name}" tabindex="-1"` : ''}><h3>${title}</h3><p>${escape(content)}</p></section>` : '';
  }
  function details(paper) {
    const abstract = text(paper.abstract || paper.details);
    const findings = results(paper);
    const available = ready(paper);
    const limits = list(paper.limitations);
    const resultHtml = findings.length ? `<div class="digest-results">${findings.map((row, index) => `<article class="digest-result">
      <div class="digest-result-heading"><span class="digest-result-number" aria-label="结果 ${index + 1}">${String(index + 1).padStart(2, '0')}</span><p class="digest-finding">${escape(row.finding)}</p></div>
      <p class="digest-setting"><strong>评测条件 / 对照</strong>${escape(text(row.setting) || '摘要未报告')}</p>
      <details class="digest-evidence"><summary>查看摘要依据</summary><blockquote>${escape(row.evidence_quote)}</blockquote></details>
      </article>`).join('')}</div>` : paper.digest_version >= 2
        ? '<p>摘要中尚未提取到附原句依据的关键结果，请展开原始摘要核对。</p>'
        : `<p>${escape(text(paper.result) || '摘要中尚未提取到可核对的结果。')}</p><p class="digest-muted">旧版解读未逐条关联摘要原句，请结合原始摘要核对。</p>`;
    const jumps = available ? [['overview', '速读'], ...(text(paper.core_method || paper.method) ? [['method', '核心方法']] : []), ['results', '关键结果'], ...(abstract ? [['abstract', '原始摘要']] : [])] : [];
    return `<div class="paper-details digest-details">${sourceMetadata(paper)}
      <div class="digest-labels"><span class="digest-source">AI 解读 · 依据作者摘要</span>${tags(paper)}</div>
      <p class="digest-provenance">结果为作者报告，未作全文或独立实验核验。${findings.length ? '关键结果附有摘要原句，可展开核对。' : '需要确认细节时，可展开原始摘要或查看原文。'}</p>
      ${jumps.length ? `<nav class="digest-nav" aria-label="论文解读导航">${jumps.map(([name, label]) => `<button type="button" data-digest-jump="${name}">${label}</button>`).join('')}</nav>` : ''}
      ${available ? `${section('一句话看懂', paper.tldr, 'overview', 'digest-overview')}
        <div class="digest-method-grid">${section('解决什么问题', paper.motivation, 'problem')}${section('核心方法', paper.core_method || paper.method, 'method')}</div>
        ${paper.core_method && paper.method && paper.core_method !== paper.method ? `<details class="digest-more"><summary>展开方法细节</summary><p>${escape(paper.method)}</p></details>` : ''}
        <section class="digest-section digest-key-results" data-digest-section="results" tabindex="-1"><h3>关键结果 <span>作者报告</span></h3>${resultHtml}</section>
        <section class="digest-section digest-limits"><h3>阅读边界与待核实</h3>${limits.length ? `<ul>${limits.map(v => `<li>${escape(v)}</li>`).join('')}</ul>` : `<p>${paper.digest_version >= 2 ? '本次解读未提取到明确的实验边界。' : '旧版解读未单独提取实验边界。'}复现或比较方法前，仍需核对原文的实验条件与局限。</p>`}<p class="digest-muted">“摘要未报告”表示当前材料没有提供，不代表论文没有做。</p></section>
        ${paper.conclusion ? `<details class="digest-more"><summary>研究启示 <span class="digest-muted">AI 整理</span></summary><p>${escape(paper.conclusion)}</p></details>` : ''}`
        : `<p class="digest-state">${paper.AI_status === 'failed' ? '这篇论文的 AI 解读尚未成功，已保留待重试。' : '这条记录尚无完整的速读解读。'}</p>${!abstract && paper.summary ? section('已保存的摘要', paper.summary) : ''}`}
      ${abstract ? `<details class="digest-abstract" data-digest-section="abstract" tabindex="-1" ${available ? '' : 'open'}><summary>原始摘要 <span class="digest-muted">arXiv 原文</span></summary><p class="original-abstract">${escape(abstract)}</p></details>` : ''}
      <details class="digest-pdf"><summary>需要核实时：加载 PDF 原文</summary><div class="digest-pdf-host"></div></details>
    </div>`;
  }
  function pdfUrl(paper) {
    const id = arxivId(paper);
    return id ? `https://arxiv.org/pdf/${id}` : '';
  }
  function attach(host, paper) {
    host.querySelectorAll('[data-digest-jump]').forEach(control => control.addEventListener('click', () => {
      const target = host.querySelector(`[data-digest-section="${control.dataset.digestJump}"]`);
      if (!target) return;
      if (target.tagName === 'DETAILS') target.open = true;
      target.focus({preventScroll:true});
      target.scrollIntoView({block:'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    }));
    const preview = host.querySelector('.digest-pdf');
    if (!preview) return;
    preview.addEventListener('toggle', () => {
      if (!preview.open || preview.dataset.loaded) return;
      const url = pdfUrl(paper);
      if (!url) { preview.querySelector('.digest-pdf-host').textContent = '无法识别论文地址，请使用原文链接。'; return; }
      const frame = document.createElement('iframe');
      frame.title = `${text(paper.title) || '论文'} PDF 原文`;
      frame.src = url; frame.className = 'digest-pdf-frame';
      preview.querySelector('.digest-pdf-host').append(frame);
      preview.dataset.loaded = 'true';
    });
  }
  return {escape, ready, results, card, details, attach, pdfUrl, arxivId};
});
