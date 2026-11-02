const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const digest=require('../js/paper-digest.js');
const paper={id:'2610.39367',title:'方法 <img src=x onerror=alert(1)>',tldr:'减少不必要的生成',AI_status:'success',abstract:'Latency decreased by 38% on benchmark A.',method:'按需生成',result:'延迟降低 38%',key_results:[{finding:'延迟降低 38%',setting:'benchmark A',evidence_quote:'Latency decreased by 38% on benchmark A.'}],limitations:['摘要未报告硬件']};
test('supported result exposes exact source; unmatched evidence is excluded',()=>{
  assert.equal(digest.results(paper).length,1);
  assert(digest.details(paper).includes('Latency decreased by 38%'));
  assert.equal(digest.results({...paper,key_results:[{finding:'提升 999%',evidence_quote:'Invented quote'}]}).length,0);
});
test('legacy summaries remain useful and failed placeholders never look successful',()=>{
  assert(digest.card({...paper,key_results:[]}).includes('延迟降低 38%'));
  const failed={...paper,AI_status:'failed',tldr:'AI summary unavailable; retry pending.'};
  assert(!digest.details(failed).includes(failed.tldr));
  assert(digest.details(failed).includes('待重试'));
  assert(digest.details({summary:'旧备份摘要'}).includes('旧备份摘要'));
});
test('HTML content is escaped and PDFs load only after a user action',()=>{
  const html=digest.details({...paper,tldr:paper.title});
  assert(!html.includes('<img')); assert(html.includes('&lt;img'));
  assert(!html.includes('<iframe')); assert(!/<[^>]+\ssrc=/.test(html));
  assert.equal(digest.pdfUrl({url:'javascript:alert(1)'}),'');
  assert.equal(digest.pdfUrl({id:'hep-th/9901001v2'}),'https://arxiv.org/pdf/hep-th/9901001v2');
});
test('actual feed parser handles old, structured and failed AI records',()=>{
  const app=fs.readFileSync(require.resolve('../js/app.js'),'utf8');
  const context=vm.createContext({console,PaperDigest:digest});
  for(const name of ['parseJsonlData','highlightMatches']){
    const start=app.indexOf('function '+name+'('), end=app.indexOf('\nfunction ',start+1);
    vm.runInContext(app.slice(start,end),context);
  }
  const row={id:paper.id,summary:paper.abstract,categories:['cs.RO'],AI:paper,AI_status:'failed'};
  let parsed=context.parseJsonlData(JSON.stringify(row),'2026-11-02')['cs.RO'][0];
  assert.equal(parsed.hasAi,false);assert.equal(parsed.method,'');
  parsed=context.parseJsonlData(JSON.stringify({...row,AI_status:'success'}),'2026-11-02')['cs.RO'][0];
  assert.equal(parsed.key_results[0].setting,'benchmark A');
  assert.equal(context.highlightMatches('A <img> V-JEPA',['<img>','V-JEPA']), 'A <span class="highlight-match">&lt;img&gt;</span> <span class="highlight-match">V-JEPA</span>');
  assert.equal(context.highlightMatches('x (a+b)',['(a+b)']), 'x <span class="highlight-match">(a+b)</span>');
});
