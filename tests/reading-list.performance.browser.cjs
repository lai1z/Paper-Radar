const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),key='paper-radar.reading-list.v1';
const saved=Array.from({length:100},(_,i)=>({id:`2611.${String(i).padStart(5,'0')}`,title:`Saved paper ${i}`,authors:'Original Author',abstract:'Original source abstract.',summary:'Old summary',status:i%2?'pending':'read',savedAt:1000+i}));
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 try{
  const context=await browser.newContext();
  await context.addInitScript(({key,saved})=>{
   if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:1,papers:saved}));
   const set=Storage.prototype.setItem;window.listWrites=0;
   Storage.prototype.setItem=function(name,value){if(name===key)window.listWrites++;return set.call(this,name,value);};
  },{key,saved});
  await context.route('https://reading-perf.test/**',route=>{
   const name=new URL(route.request().url()).pathname;
   if(name==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div class="header-controls"></div><main></main><script src="/js/zotero-export.js"></script><script src="/js/paper-digest.js"></script><script src="/js/reading-list.js"></script>'});
   return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,name.slice(1)))});
  });
  const page=await context.newPage(),other=await context.newPage(),errors=[];
  for(const target of [page,other])target.on('pageerror',error=>errors.push(error.message));
  await page.goto('https://reading-perf.test/');await other.goto('https://reading-perf.test/');
  const mount=async(start,end)=>page.evaluate(({start,end})=>{
   for(let i=start;i<end;i++){
    const host=document.createElement('div');document.querySelector('main').append(host);
    ReadingList.mount(host,{id:`2611.${String(i).padStart(5,'0')}v2`,title:`Saved paper ${i}`,authors:'Original Author',abstract:'Original source abstract.',tldr:`Upgraded ${i}`,AI_status:'success',digest_version:2,key_results:[{finding:'Source result',evidence_quote:'Original source abstract.'}]});
   }
  },{start,end});
  await mount(0,50);
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).papers[49].tldr==='Upgraded 49',key);
  let result=await page.evaluate(key=>({writes:window.listWrites,rows:JSON.parse(localStorage.getItem(key)).papers}),key);
  assert.equal(result.writes,1,'50 automatic upgrades must produce a single full-list write');
  assert.equal(result.rows.length,100);
  for(let i=0;i<100;i++){
   const row=result.rows[i];assert.equal(row.status,saved[i].status);assert.equal(row.savedAt,saved[i].savedAt);
   assert.equal(row.abstract,saved[i].abstract);assert.equal(row.authors,saved[i].authors);
   if(i<50){assert.equal(row.tldr,`Upgraded ${i}`);assert.equal(row.sourceId,`${saved[i].id}v2`);}
   else assert(!row.tldr);
  }
  await mount(0,50);await page.evaluate(()=>new Promise(resolve=>queueMicrotask(resolve)));
  assert.equal(await page.evaluate(()=>window.listWrites),1,'Remounting upgraded records must not write again');
  assert.equal(await page.evaluate(()=>ReadingList.status('2611.00000v3')),'read');
  // Hold the origin lock while stale snapshots queue upgrades. Another tab
  // removes one record, changes reading state and supplies a newer digest.
  await other.evaluate(()=>{
   navigator.locks.request('paper-radar.reading-list.v1.mutation',async()=>{
    window.lockHeld=true;await new Promise(resolve=>window.unlockList=resolve);
   });
  });
  await other.waitForFunction(()=>window.lockHeld);
  await mount(50,100);
  assert.equal(await page.evaluate(()=>window.listWrites),1,'An upgrade must wait for the held lock');
  await other.evaluate(key=>{
   const data=JSON.parse(localStorage.getItem(key));
   data.papers=data.papers.filter(p=>p.id!=='2611.00050');
   data.papers.find(p=>p.id==='2611.00051').status='read';
   Object.assign(data.papers.find(p=>p.id==='2611.00052'),{tldr:'Newer saved digest',key_results:[{finding:'New result'}],sourceId:'2611.00052v3'});
   data.papers.push({id:'2611.00110',title:'Added in another tab',status:'pending',savedAt:9999});
   localStorage.setItem(key,JSON.stringify(data));
  },key);
  // Observe the storage event while the upgrade still waits. The queued
  // incoming snapshots predate the removal and must be rechecked on commit.
  await page.waitForFunction(()=>ReadingList.status('2611.00050')===''&&ReadingList.status('2611.00051')==='read'&&ReadingList.status('2611.00110')==='pending');
  await other.evaluate(()=>window.unlockList());
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).papers.find(p=>p.id==='2611.00099').tldr==='Upgraded 99',key);
  result=await page.evaluate(key=>({writes:window.listWrites,rows:JSON.parse(localStorage.getItem(key)).papers}),key);
  assert.equal(result.writes,2);assert.equal(result.rows.length,100);
  const byId=new Map(result.rows.map(row=>[row.id,row]));
  assert(!byId.has('2611.00050'),'A removed record must not be resurrected by automatic upgrades');
  assert.equal(byId.get('2611.00051').status,'read');assert.equal(byId.get('2611.00051').savedAt,1051);
  assert.equal(byId.get('2611.00052').tldr,'Newer saved digest');assert.equal(byId.get('2611.00052').sourceId,'2611.00052v3');
  assert.equal(byId.get('2611.00110').title,'Added in another tab');
  assert.equal(await page.evaluate(()=>ReadingList.status('2611.00050')),'');
  assert.equal(await page.evaluate(()=>ReadingList.status('2611.00051')),'read');
  // A backup requested in the same task as a mount includes the scheduled
  // batch, even before its coalescing microtask has run.
  await page.locator('#readingListButton').click();
  const downloading=page.waitForEvent('download');
  await page.evaluate(()=>{
   const host=document.createElement('div');document.querySelector('main').append(host);
   ReadingList.mount(host,{id:'2611.00110v2',title:'Added in another tab',tldr:'Upgrade before backup',key_results:[{finding:'Saved result'}]});
   [...document.querySelectorAll('.rl-dialog button')].find(button=>button.textContent==='导出备份').click();
  });
  const download=await downloading,backup=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  assert.equal(backup.papers.length,100);assert.equal(backup.papers.find(p=>p.id==='2611.00110').tldr,'Upgrade before backup');
  assert.equal(backup.papers.find(p=>p.id==='2611.00110').savedAt,9999);
  assert.deepEqual(errors,[]);
  console.log('PASS: 100 saved papers / 50 upgrades use one write; indexed status; remount no-op; lock-time recheck preserves removals, reading state and newer digests');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
