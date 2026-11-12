const {test}=require('node:test');
const assert=require('node:assert/strict');
const workspace=require('../js/research-workspace.js');

test('range dedup selects newest snapshot by canonical ID without rewriting source metadata',()=>{
  const old=Object.freeze({id:'2610.12345v1',date:'2026-10-31',title:'原始标题',abstract:'Original abstract.',published:'2026-10-28',authors:'张三'});
  const next=Object.freeze({...old,id:'2610.12345v2',date:'2026-11-01',title:'原始修订标题'});
  assert.deepEqual(workspace.unique([next,old]),[next]);
  assert.equal(next.id,'2610.12345v2');
  assert.equal(next.published,'2026-10-28');
});
test('search matches case, Chinese, separators, ID and absent fields; OR aliases are literal',()=>{
  const paper={id:'2610.12345',title:'Jev embodied policy',abstract:'V–JEPA evaluates 机器人 manipulation.',key_results:'invalid'};
  assert(workspace.matchesQuery(paper,'not-found | JEV'));
  assert(workspace.matchesQuery(paper,'v-jepa'));
  assert(workspace.matchesQuery(paper,'机器人'));
  assert(workspace.matchesQuery(paper,'2610.12345'));
  assert(!workspace.matchesQuery(paper,'[.*]'));
  assert(!workspace.matchesQuery(paper,'navigation'));
});
test('topic counts remain overlapping labels, unknown labels stay unclassified',()=>{
  const rows=[{id:'1',research_topics:['世界模型','世界模型','评测']},{id:'2',research_topics:['untrusted']},{id:'3'}];
  assert.deepEqual(workspace.topicCounts(rows),{topics:[['世界模型',1],['评测',1]],untagged:2});
  assert.equal(workspace.select(rows,{topic:'untagged'}).length,2);
});
test('filtering is explicit and sort uses source publication date, not collection date',()=>{
  const rows=[{id:'1',date:'2026-11-02',published:'2026-10-20',isMatched:true,relevance:.8,title:'robot',research_topics:['机器人策略']},{id:'2',date:'2026-11-01',published:'2026-10-25',isMatched:false,relevance:.9,title:'world model',research_topics:['世界模型']}];
  assert.deepEqual(workspace.select(rows).map(p=>p.id),['1','2']);
  assert.deepEqual(workspace.select(rows,{sort:'published'}).map(p=>p.id),['2','1']);
  assert.equal(workspace.select(rows,{query:'robot'}).length,1);
  assert.equal(workspace.select(rows,{onlyMatched:true}).length,1);
  assert.equal(workspace.select(rows,{topic:'世界模型',query:'robot'}).length,0);
  assert.equal(rows.length,2);
});

test('compiled searches preserve Unicode aliases and notice in-place metadata changes',()=>{
  const paper={id:'2611.12345',title:'Ｖ－ＪＥＰＡ navigation',authors:['Original Author'],category:['cs.RO'],abstract:'机器人 original abstract',key_results:[{finding:'Original finding'}]};
  const before=JSON.stringify(paper);
  assert(workspace.createQueryMatcher('missing ｜ v-jepa')(paper));
  assert(workspace.createQueryMatcher('机器人')(paper));
  const original=workspace.createQueryMatcher('original');
  assert(original(paper));
  assert.equal(JSON.stringify(paper),before);
  paper.title='Changed title';paper.abstract='New abstract';paper.authors[0]='New Author';paper.key_results[0].finding='Revised finding';
  assert(!original(paper));
  assert(workspace.createQueryMatcher('new author | missing')(paper));
  assert(workspace.createQueryMatcher('revised finding')(paper));
  paper.key_results.push({finding:'Nested addition'});
  assert(workspace.createQueryMatcher('nested addition')(paper));
  paper.category[0]='cs.AI';
  assert(!workspace.matchesQuery(paper,'cs.RO'));
  assert(workspace.matchesQuery(paper,'cs.AI'));
  paper.key_results=[];
  assert(!workspace.matchesQuery(paper,'nested addition'));
});

test('repeated searches reuse normalized full text and reindex changed sources',()=>{
  const paper={id:'2611.98765',abstract:'Long source context. '.repeat(1000)+'robot'};
  const original=String.prototype.normalize;
  let fullTextNormalizations=0;
  String.prototype.normalize=function(...args){
    if(this.length>10000)fullTextNormalizations++;
    return original.apply(this,args);
  };
  try{
    for(let index=0;index<100;index++)assert(workspace.createQueryMatcher('robot | 世界模型')(paper));
    assert.equal(fullTextNormalizations,1);
    paper.abstract='New source context. '.repeat(1000)+'planning';
    assert(!workspace.matchesQuery(paper,'robot'));
    assert(workspace.matchesQuery(paper,'planning'));
    assert.equal(fullTextNormalizations,2);
  }finally{String.prototype.normalize=original;}
});

test('selection can reuse a caller-computed query result without searching marked copies again',()=>{
  const first={id:'1',title:'First',isMatched:true},second={id:'2',title:'Second',isMatched:false};
  const accepted=new WeakSet([second]);let calls=0;
  const selected=workspace.select([first,second],{query:'does not appear',queryMatcher:paper=>{calls++;return accepted.has(paper);}});
  assert.deepEqual(selected,[second]);assert.equal(calls,2);
  assert.equal(workspace.select([first,second],{onlyMatched:true,queryMatcher:paper=>accepted.has(paper)}).length,0);
});
