const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const record=(id,title)=>({id,title,authors:['王一'],categories:['cs.RO'],summary:'The original robot abstract.',AI_status:'success',AI:{tldr:'机器人方法',motivation:'目标任务',method:'原始方法',result:'作者报告结果',conclusion:'研究结论'}});
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 try{
  const makeContext=async({blocked=false,malformed=false,manifestFailure=false}={})=>{
   const context=await browser.newContext({viewport:{width:1200,height:900}});
   const mode={brokenDate:null,corruptDate:null,slowDate:null,held:null,manifestFailure};
   if(blocked) await context.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}}));
   if(malformed) await context.addInitScript(()=>{localStorage.setItem('preferredKeywords','{"bad":true}');localStorage.setItem('preferredAuthors','[null,42,"王一"]');});
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    const fulfill=(body,type='text/plain',status=200)=>route.fulfill({body,contentType:type,status});
    if(u.pathname.endsWith('file-list.txt'))return fulfill(mode.manifestFailure?'Unavailable':'2026-11-02_AI_enhanced_Chinese.jsonl\n2026-11-01_AI_enhanced_Chinese.jsonl\n2026-10-30_AI_enhanced_Chinese.jsonl','text/plain',mode.manifestFailure?503:200);
    if(u.pathname.endsWith('update-status.json'))return fulfill(JSON.stringify({schema_version:1,checked_at:'2026-11-04T01:30:00Z',latest_publication_date:'2026-11-02',pending_paper_count:4}),'application/json');
    if(u.pathname.endsWith('.jsonl')){
     const date=u.pathname.match(/\d{4}-\d{2}-\d{2}/)[0];
     if(date===mode.slowDate){mode.held=route;return;}
     if(date===mode.brokenDate)return fulfill('Temporarily unavailable','text/plain',503);
     if(date===mode.corruptDate)return fulfill(JSON.stringify(record('2611.00001','Valid first paper'))+'\n  \n{"id":"2611.00099","title":');
     return fulfill(JSON.stringify(date==='2026-11-02'?record('2611.00002','Latest robot paper'):record('2611.00001','Earlier robot paper')));
    }
    if(u.hostname==='api.github.com')return fulfill('{}','application/json');
    if(u.pathname.endsWith('/auth.js'))return fulfill('window.Auth={requireAuth(){},isPasswordEnabled(){return false},logout(){}};','application/javascript');
    if(u.hostname!=='radar.test')return fulfill('',u.pathname.endsWith('flatpickr')?'application/javascript':'text/css');
    const file=path.join(root,u.pathname==='/'?'index.html':u.pathname.slice(1));
    return fulfill(fs.readFileSync(file),({'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png'})[path.extname(file)]||'text/plain');
   });
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('https://radar.test/');
   return {context,page,mode,errors};
  };

  const first=await makeContext({malformed:true});const {page,mode,errors}=first;
  await page.waitForSelector('.paper-card');
  assert((await page.locator('#workspaceFreshness').innerText()).includes('4 篇等待后续处理'));
  assert.equal(await page.locator('.paper-card').count(),1);
  // A failed/new request must never reuse a previous day's data through filters.
  mode.brokenDate='2026-11-01';await page.evaluate(()=>loadPapersByDate('2026-11-01'));
  await page.locator('#textSearchInput').fill('robot');
  assert.equal(await page.locator('.paper-card').count(),0);
  assert.deepEqual(await page.evaluate(()=>Object.keys(paperData)),[]);
  assert.equal(await page.locator('#paperContainer').getAttribute('aria-busy'),'false');
  assert(await page.getByRole('button',{name:'重新加载',exact:true}).isVisible());
  mode.brokenDate=null;await page.getByRole('button',{name:'重新加载',exact:true}).click();
  await page.waitForSelector('.paper-card');assert((await page.locator('.paper-card').innerText()).includes('Earlier'));
  // A truncated final JSONL line cannot turn a partial date into a successful feed.
  mode.corruptDate='2026-11-01';await page.evaluate(()=>loadPapersByDate('2026-11-01'));
  assert.equal(await page.locator('.paper-card').count(),0);
  assert.deepEqual(await page.evaluate(()=>Object.keys(paperData)),[]);
  assert.equal(await page.evaluate(()=>feedLoadState),'error');
  assert((await page.locator('#paperContainer').innerText()).includes('论文数据暂不完整'));
  mode.corruptDate=null;await page.getByRole('button',{name:'重新加载',exact:true}).click();
  await page.waitForSelector('.paper-card');assert((await page.locator('.paper-card').innerText()).includes('Earlier'));
  const withBlankLines=' \n'+JSON.stringify(record('2611.00001','Legacy robot paper'))+'\n\t\n';
  assert.equal(await page.evaluate(text=>Object.values(parseJsonlData(text,'2026-11-01')).flat().length,withBlankLines),1);
  mode.slowDate='2026-10-30';await page.evaluate(()=>{window.pendingOld=loadPapersByDate('2026-10-30');});
  await page.waitForFunction(()=>feedLoadState==='loading');
  await page.locator('#textSearchInput').fill('Latest');assert.equal(await page.locator('.paper-card').count(),0);
  await page.evaluate(()=>loadPapersByDate('2026-11-02'));
  if(mode.held)await mode.held.fulfill({body:JSON.stringify(record('2610.99999','Stale response'))}).catch(()=>{});
  await page.evaluate(()=>window.pendingOld);
  assert((await page.locator('.paper-card').innerText()).includes('Latest'));
  assert.equal(await page.evaluate(()=>currentDate),'2026-11-02');
  // Range failures do not silently return only the available dates or stale data.
  mode.slowDate=null;mode.brokenDate='2026-11-01';
  await page.evaluate(()=>loadPapersByDateRange('2026-11-01','2026-11-02'));
  assert.equal(await page.locator('.paper-card').count(),0);
  await page.locator('#textSearchInput').fill('');assert.equal(await page.locator('.paper-card').count(),0);
  mode.brokenDate=null;await page.getByRole('button',{name:'重新加载',exact:true}).click();
  await page.waitForFunction(()=>feedLoadState==='ready');assert.equal(await page.locator('.paper-card').count(),2);
  // A connection that never responds has a bounded wait and a usable retry.
  await page.clock.install(); mode.slowDate='2026-10-30'; mode.held=null;
  await page.evaluate(()=>{window.timeoutLoad=loadPapersByDate('2026-10-30');});
  await page.waitForFunction(()=>feedLoadState==='loading');
  await page.clock.fastForward(16000); await page.evaluate(()=>window.timeoutLoad);
  assert(await page.getByRole('button',{name:'重新加载',exact:true}).isVisible());
  assert.equal(await page.locator('#paperContainer').getAttribute('aria-busy'),'false');
  mode.slowDate=null; if(mode.held)await mode.held.fulfill({body:JSON.stringify(record('2610.99999','Stale timeout response'))}).catch(()=>{});
  // Calendar remains usable when its external script is unavailable.
  await page.locator('#calendarButton').click();await page.locator('#fallbackDatePicker').waitFor({state:'visible'});
  assert.equal(await page.locator('#fallbackStartDate option').count(),3);
  await page.locator('#fallbackStartDate').selectOption('2026-11-01');
  await page.getByRole('button',{name:'查看论文',exact:true}).click();await page.waitForFunction(()=>feedLoadState==='ready');
  assert.equal(await page.evaluate(()=>currentDate),'2026-11-01');
  await page.locator('#calendarButton').click();await page.keyboard.press('Escape');
  assert(await page.locator('#calendarButton').evaluate(el=>document.activeElement===el));
  // Cross-tab preference updates preserve a manually selected subset.
  await page.evaluate(()=>{localStorage.setItem('preferredKeywords','["robot","world"]');window.dispatchEvent(new StorageEvent('storage',{key:'preferredKeywords'}));});
  await page.locator('.workspace-preferences>summary').click();
  await page.locator('[data-keyword="world"]').click();
  await page.evaluate(()=>{localStorage.setItem('preferredKeywords','["robot","world","JEPA"]');window.dispatchEvent(new StorageEvent('storage',{key:'preferredKeywords'}));});
  assert.deepEqual(await page.evaluate(()=>activeKeywords),['robot']);
  assert.equal(await page.locator('[data-keyword="world"]').getAttribute('aria-pressed'),'false');
  assert.deepEqual(errors,[]);await first.context.close();

  const blocked=await makeContext({blocked:true});await blocked.page.waitForSelector('.paper-card');
  assert.equal(await blocked.page.locator('.paper-card').count(),1);assert.deepEqual(blocked.errors,[]);await blocked.context.close();
  const failed=await makeContext({manifestFailure:true});await failed.page.getByRole('button',{name:'重新加载',exact:true}).waitFor();
  failed.mode.manifestFailure=false;await failed.page.getByRole('button',{name:'重新加载',exact:true}).click();
  await failed.page.waitForSelector('.paper-card');assert.deepEqual(failed.errors,[]);await failed.context.close();
  console.log('PASS: failed/racing date loads never mislabel old data; corrupted JSONL rejects partial results and retries; range/manifest retry; blocked/malformed storage; calendar fallback/focus; preference sync; queued-paper status');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
