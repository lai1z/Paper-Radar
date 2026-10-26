const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {arxivId, dateParts, build} = require('../js/zotero-export.js');
const paper = {id:'2610.12345v2', title:'具身世界模型：评测与优化 “α”', authorNames:['张三', 'María de la Cruz', {family:'王',given:'小明'}], abstract:'原始摘要\n第二段：机器人 & 视频。', summary:'AI 摘要不能代替原文', published:'2026-10-01T23:30:00-05:00', date:'2026-10-26'};

test('batch lookup contains only unique validated arXiv IDs, including legacy IDs', () => {
  const result = build([paper, {id:'2610.12345v3'}, {url:'https://arxiv.org/pdf/hep-th/9901001v2.pdf'},
    {id:'bad\nDOI:10.0000/injection'}, {url:'https://evil.test/abs/2610.11111'}, {id:'2610.22222'}]);
  assert.equal(result.identifiers, 'arXiv:2610.12345\narXiv:hep-th/9901001\narXiv:2610.22222');
  assert.equal(result.duplicates, 1);
  assert.equal(result.skipped, 2);
  assert.equal(build([]).identifiers, '');
});

test('UTF-8, original abstract, creators, publication date and arXiv identifiers', () => {
  const result = build([paper]);
  const [item] = JSON.parse(Buffer.from(result.content, 'utf8').toString('utf8'));
  assert.equal(item.title, paper.title);
  assert.equal(item.abstract, paper.abstract);
  assert.deepEqual(item.author, [{literal:'张三'}, {literal:'María de la Cruz'}, {family:'王',given:'小明'}]);
  assert.deepEqual(item.issued, {'date-parts':[[2026,10,1]]});
  assert.equal(item.id,'arxiv:2610.12345');
  assert.equal(item.URL,'https://arxiv.org/abs/2610.12345');
  assert.equal(item.archive_location,'2610.12345');
  assert.equal(item.note,'arXiv: 2610.12345');
  assert.equal(item.DOI,undefined);
});
test('version and URL deduplication fills missing metadata without merging different IDs', () => {
  const result = build([{id:'2610.12345v1'}, {...paper, id:'https://arxiv.org/pdf/2610.12345v3.pdf?download=1'}, {...paper,id:'2610.54321'}]);
  assert.equal(result.items.length,2); assert.equal(result.duplicates,1);
  assert.equal(result.items[0].title,paper.title); assert.equal(result.items[0].abstract,paper.abstract);
  assert.equal(result.missing.title,0);
  assert.equal(arxivId('arXiv:hep-th/9901001v2'),'hep-th/9901001');
  assert.equal(arxivId('https://evil.test/abs/2610.12345'),'');
});
test('missing fields are omitted, missing title uses ID, invalid items are skipped', () => {
  const result = build([null, {}, {id:'invalid'}, {id:'2610.12345', date:'2026-10-26', summary:'AI-generated text'}]);
  assert.equal(result.skipped,3);
  assert.equal(result.items[0].title,'arXiv: 2610.12345');
  for (const field of ['author','abstract','issued']) assert.equal(result.items[0][field],undefined);
  assert.deepEqual(result.missing,{title:1,authors:1,published:1,abstract:1});
  assert.deepEqual(build([]).items,[]);
});
test('dates reject impossible calendar days and preserve partial dates', () => {
  for (const value of ['2026-02-29','2026-04-31','2026-13-01','2026-00-01','2026-01-00','yesterday',null]) assert.equal(dateParts(value),null);
  assert.deepEqual(dateParts('2024-02-29'),[2024,2,29]);
  assert.deepEqual(dateParts('2026-10'),[2026,10]); assert.deepEqual(dateParts('2026'),[2026]);
  assert.deepEqual(build([{...paper,published:'bad',publicationDate:'2024-02-29'}]).items[0].issued,{'date-parts':[[2024,2,29]]});
});
test('legacy comma-separated authors and structured surname commas preserve boundaries', () => {
  const [legacy] = build([{id:'2610.12345',authors:'Alice Smith, 张三; Bob Jones'}]).items;
  assert.deepEqual(legacy.author,[{literal:'Alice Smith'},{literal:'张三'},{literal:'Bob Jones'}]);
  assert.deepEqual(build([{id:'2610.12345',authorNames:['Smith, Jr., John']}]).items[0].author,[{literal:'Smith, Jr., John'}]);
});
test('export does not mutate source or turn content into extra records', () => {
  const input = [{...paper,title:'<script>bad()</script> " \\ \n TY  - JOUR', abstract:'ER  -\nTY  - JOUR'}];
  const before = JSON.stringify(input);
  assert.equal(JSON.parse(build(input).content).length,1);
  assert.equal(JSON.stringify(input),before);
});
test('real feed parser retains original metadata separately from card presentation', () => {
  const app = fs.readFileSync(require.resolve('../js/app.js'),'utf8');
  const start = app.indexOf('function parseJsonlData(');
  const end = app.indexOf('\nfunction ', start + 1);
  const context = vm.createContext({console});
  vm.runInContext(app.slice(start,end),context);
  const data = context.parseJsonlData(JSON.stringify({...paper,authors:paper.authorNames,summary:'Full source abstract',categories:['cs.RO'],AI:{tldr:'Short AI summary'}}),'2026-10-26');
  const record = data['cs.RO'][0];
  assert.equal(record.summary,'Short AI summary'); assert.equal(record.abstract,'Full source abstract');
  assert.equal(record.published,paper.published);
  assert.equal(build([record]).items[0].abstract,'Full source abstract');
});
