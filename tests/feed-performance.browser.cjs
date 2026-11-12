// Deterministic cross-date fixture, not a benchmark of arXiv or live network speed.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),baseline=process.argv.includes('--baseline');
const base=path.resolve(root,'../web-perf-base');
const source={id:'2611.10000',title:'World model fixture',authors:['研究者 A'],categories:['cs.RO'],summary:'The original abstract reports a predictive world model. '.repeat(45),AI_status:'success',AI:{tldr:'学习动作条件世界模型。',motivation:'控制需要预测未来。',method:'预测状态并规划动作。',result:'作者报告任务结果。',conclusion:'用于控制。'}};
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 try{
  const context=await browser.newContext({viewport:{width:1365,height:950}});
  await context.route('**/*',route=>{
   const u=new URL(route.request().url()),send=(body,type='text/plain')=>route.fulfill({body,contentType:type});
   if(u.pathname.endsWith('file-list.txt'))return send('2026-11-12_AI_enhanced_Chinese.jsonl');
   if(u.pathname.endsWith('update-status.json'))return send('{}','application/json');
   if(u.pathname.endsWith('.jsonl'))return send(JSON.stringify(source));
   if(u.hostname==='api.github.com')return send('{}','application/json');
   if(u.pathname.endsWith('/auth.js'))return send('window.Auth={requireAuth(){},isPasswordEnabled(){return false}};','application/javascript');
   if(u.hostname!=='feed.test')return send(u.pathname.endsWith('flatpickr')?'window.flatpickr=()=>({setDate(){},destroy(){},set(){}});':'',u.pathname.endsWith('flatpickr')?'application/javascript':'text/css');
   const rel=u.pathname==='/'?'index.html':u.pathname.slice(1),before=path.join(base,rel);
   const file=baseline&&fs.existsSync(before)?before:path.join(root,rel);
   return send(fs.readFileSync(file),{'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png'}[path.extname(file)]||'text/plain');
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('https://feed.test/');await page.locator('.paper-card').waitFor();
  const metrics=await page.evaluate(source=>{
   const rows=Array.from({length:1000},(_,i)=>({...source,id:`2611.${10000+i}`,title:i===999?'Last source 独特目标':`${source.title} ${i}`}));
   paperData=parseJsonlData(rows.map(row=>JSON.stringify(row)).join('\n'),'2026-11-12');
   const begin=performance.now();renderPapers();
   const initialMs=performance.now()-begin,cardCount=document.querySelectorAll('.paper-card').length,nodeCount=document.querySelector('#paperContainer').querySelectorAll('*').length;
   textSearchQuery='world model';renderPapers(); // warm the source search index
   const times=[];
   for(let i=0;i<3;i++){const t=performance.now();renderPapers();times.push(performance.now()-t);}
   textSearchQuery='';renderPapers();
   return {initialMs:Math.round(initialMs),warmSearchMs:Math.round(times.reduce((a,b)=>a+b)/times.length),cardCount,nodeCount,total:currentFilteredPapers.length};
  },source);
  console.log(JSON.stringify({mode:baseline?'baseline':'optimized',...metrics}));
  if(baseline)return;
  assert.equal(metrics.total,1000);assert.equal(metrics.cardCount,50);
  assert((await page.locator('#renderedPaperCount').innerText()).includes('50 / 1000'));
  await page.locator('#loadMorePapers').click();assert.equal(await page.locator('.paper-card').count(),100);
  assert.equal(await page.locator('.paper-card').nth(50).evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.evaluate(()=>currentFilteredPapers.length),1000);
  const input=page.locator('#textSearchInput');
  await input.fill('独特目标');await input.press('Enter');
  assert.equal(await page.locator('.paper-card').count(),1);
  assert((await page.locator('.paper-card-title').innerText()).includes('Last source'));
  await page.locator('.paper-card').click();assert((await page.locator('#modalBody').innerText()).includes('原始摘要'));
  assert.equal(await page.locator('#paperLink').getAttribute('href'),'https://arxiv.org/abs/2611.10999');
  await page.locator('#closeModal').click();
  await page.locator('#textSearchClear').click();assert.equal(await page.locator('.paper-card').count(),50);
  await page.evaluate(()=>{
   const original=renderPapers;window.renderCount=0;renderPapers=(...args)=>{window.renderCount++;return original(...args);};
   const input=document.getElementById('textSearchInput');
   for(const query of ['w','wo','wor','world','world m','world model']){input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));}
  });
  await page.waitForFunction(()=>document.getElementById('paperContainer').dataset.renderedQuery==='world model');
  assert.equal(await page.evaluate(()=>window.renderCount),1);
  // Chinese composition should not filter against unfinished pinyin.
  await page.clock.install();
  await page.evaluate(()=>{
   window.renderCount=0;const input=document.getElementById('textSearchInput');
   input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.value='du';
   input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
  });
  await page.clock.runFor(200);assert.equal(await page.evaluate(()=>window.renderCount),0);
  await page.evaluate(()=>{const input=document.getElementById('textSearchInput');input.value='独特目标';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  await page.clock.runFor(130);assert.equal(await page.locator('.paper-card').count(),1);
  assert.equal(await page.evaluate(()=>window.renderCount),1);
  // Clearing a scheduled search cannot later bring back an obsolete query.
  await input.fill('missing');await page.locator('#textSearchClear').click();await page.clock.runFor(200);
  assert.equal(await page.locator('.paper-card').count(),50);
  await page.evaluate(()=>{currentPaperIndex=49;showPaperDetails(currentFilteredPapers[49],50);navigateToNextPaper();});
  assert.equal(await page.locator('#paperPosition').innerText(),'51 / 1000');
  await page.locator('#closeModal').click();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('PASS: first-batch rendering; full-result search/navigation; more-button focus; coalesced typing; Chinese composition; stale-search cancellation; source link; mobile width');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
