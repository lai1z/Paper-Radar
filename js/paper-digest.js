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
  function results(paper) {
    const abstract = text(paper.abstract || paper.details);
    return (Array.isArray(paper.key_results) ? paper.key_results : []).filter(row =>
      row && text(row.finding) && text(row.evidence_quote).length >= 12 && abstract.includes(text(row.evidence_quote))).slice(0, 3);
  }
  function tags(paper) {
    return list(paper.research_topics).map(topic => `<span class="digest-topic">${escape(topic)}</span>`).join('');
  }
  function card(paper) {
    if (!ready(paper)) return `<div class="digest-state">${paper.AI_status === 'failed' ? '解读待重试' : '暂无 AI 解读'} · 可查看原始摘要</div>`;
    const findings = results(paper);
    const method = text(paper.core_method || paper.method);
    const result = findings.length ? findings.slice(0, 2).map(row => `${text(row.setting) ? row.setting + '：' : ''}${row.finding}`).join('；') : paper.digest_version >= 2 ? '' : text(paper.result);
    return `<div class="digest-card"><div class="digest-labels"><span class="digest-source">摘要速读</span>${tags(paper)}</div>
      ${method ? `<div class="digest-card-method"><strong>核心方法</strong><p>${escape(method)}</p></div>` : ''}
      ${result ? `<div class="digest-card-result"><strong>关键结果 · 作者报告</strong><p>${escape(result)}</p></div>` : '<p class="digest-muted">尚无结构化结果，请查看摘要。</p>'}</div>`;
  }
  function section(title, content) {
    return text(content) ? `<section class="digest-section"><h3>${title}</h3><p>${escape(content)}</p></section>` : '';
  }
  function details(paper) {
    const abstract = text(paper.abstract || paper.details);
    const findings = results(paper);
    const available = ready(paper);
    const limits = list(paper.limitations);
    const resultHtml = findings.length ? `<div class="digest-results">${findings.map(row => `<article class="digest-result">
      <p class="digest-finding">${escape(row.finding)}</p>
      <p class="digest-muted">评测条件 / 对照：${escape(text(row.setting) || '摘要未报告')}</p>
      <details class="digest-evidence"><summary>查看摘要依据</summary><blockquote>${escape(row.evidence_quote)}</blockquote></details>
      </article>`).join('')}</div>` : paper.digest_version >= 2
        ? '<p>摘要中尚未提取到附原句依据的关键结果，请展开原始摘要核对。</p>'
        : `<p>${escape(text(paper.result) || '摘要中尚未提取到可核对的结果。')}</p>`;
    const meta = [paper.authors, Array.isArray(paper.category) ? paper.category.join(' · ') : paper.category, paper.date ? `收录日期：${paper.date}` : ''].filter(Boolean).map(escape).join('<br>');
    return `<div class="paper-details digest-details"><p class="digest-meta">${meta}</p>
      <div class="digest-labels"><span class="digest-source">依据：作者摘要</span>${tags(paper)}</div>
      <p class="digest-muted">结果为作者报告，未作全文或独立实验核验。展开摘要依据可查看对应原句。</p>
      ${available ? `${section('一句话看懂', paper.tldr)}
        <div class="digest-method-grid">${section('解决什么问题', paper.motivation)}${section('核心方法', paper.core_method || paper.method)}</div>
        ${paper.core_method && paper.method && paper.core_method !== paper.method ? `<details class="digest-more"><summary>展开方法细节</summary><p>${escape(paper.method)}</p></details>` : ''}
        <section class="digest-section digest-key-results"><h3>关键结果 · 作者报告</h3>${resultHtml}</section>
        <section class="digest-section digest-limits"><h3>边界与待核实</h3>${limits.length ? `<ul>${limits.map(v => `<li>${escape(v)}</li>`).join('')}</ul>` : `<p>${paper.digest_version >= 2 ? '本次解读未提取到明确的实验边界。' : '旧版解读未单独提取实验边界。'}复现或比较方法前，仍需核对原文的实验条件与局限。</p>`}</section>
        ${paper.conclusion ? `<details class="digest-more"><summary>研究启示</summary><p>${escape(paper.conclusion)}</p></details>` : ''}`
        : `<p class="digest-state">${paper.AI_status === 'failed' ? '这篇论文的 AI 解读尚未成功，已保留待重试。' : '这条记录尚无完整的速读解读。'}</p>${!abstract && paper.summary ? section('已保存的摘要', paper.summary) : ''}`}
      ${abstract ? `<details class="digest-abstract" ${available ? '' : 'open'}><summary>原始摘要</summary><p class="original-abstract">${escape(abstract)}</p></details>` : ''}
      <details class="digest-pdf"><summary>需要核实时：加载 PDF 原文</summary><div class="digest-pdf-host"></div></details>
    </div>`;
  }
  function pdfUrl(paper) {
    const raw = text(paper.id) || text(paper.url);
    const id = raw.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i, '').replace(/\.pdf$/i, '');
    return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(id) ? `https://arxiv.org/pdf/${id}` : '';
  }
  function attach(host, paper) {
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
  return {escape, ready, results, card, details, attach, pdfUrl};
});
