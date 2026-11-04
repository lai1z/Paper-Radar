const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 try {
  async function setup(mode='normal'){
   const context=await browser.newContext({viewport:{width:1100,height:900}});
   await context.route('**/*',route=>{
    const u=new URL(route.request().url());
    const fulfill=(body,type='text/plain')=>route.fulfill({body,contentType:type});
    if(u.hostname==='api.github.com')return fulfill('{"stargazers_count":0,"forks_count":0}','application/json');
    if(u.pathname.endsWith('/auth.js'))return fulfill('window.Auth={requireAuth(){},isPasswordEnabled(){return false},logout(){}};','application/javascript');
    if(u.hostname!=='radar.test')return fulfill('','text/css');
    const file=path.join(root,u.pathname==='/'?'settings.html':u.pathname.slice(1));
    const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png'};
    return fulfill(fs.readFileSync(file),types[path.extname(file)]||'text/plain');
   });
   await context.addInitScript(mode=>{
    localStorage.setItem('preferredKeywords',JSON.stringify(['world model benchmark','机器人×模型']));
    localStorage.setItem('preferredAuthors',JSON.stringify(['Author Original']));
    if(mode==='malformed')localStorage.setItem('preferredKeywords','["合法关键词",null,123]');
    if(mode==='blocked')Storage.prototype.getItem=function(){throw new DOMException('Blocked','SecurityError');};
    if(mode==='transient'){
     const get=Storage.prototype.getItem;let firstRead=true;
     Storage.prototype.getItem=function(key){if(key==='preferredAuthors'&&firstRead){firstRead=false;throw new DOMException('Temporarily blocked','SecurityError');}return get.call(this,key);};
    }
    if(mode==='partial'){
     const set=Storage.prototype.setItem;
     Storage.prototype.setItem=function(key,value){if(key==='preferredAuthors')throw new DOMException('Full','QuotaExceededError');return set.call(this,key,value);};
    }
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('Unavailable');}}});
   },mode);
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('https://radar.test/settings.html');await page.waitForSelector('#preferencesStatus');
   return {context,page,errors};
  }
  const {context,page,errors}=await setup();
  await page.getByLabel('关键词',{exact:true}).fill('world model');await page.locator('#addKeyword').click();
  assert.equal(await page.locator('#selectedKeywords [data-value]').count(),3); // Prefix isn't a duplicate.
  await page.getByRole('button',{name:'删除关键词：world model benchmark',exact:true}).click();
  await page.getByLabel('关键词',{exact:true}).fill('V-JEPA | VJEPA'); // Save includes the unfinished input.
  await page.locator('#saveSettings').click();
  await page.waitForFunction(()=>!document.getElementById('saveSettings').hasAttribute('aria-busy'));
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('preferredKeywords'))),['机器人×模型','world model','V-JEPA | VJEPA']);
  assert((await page.locator('#preferencesStatus').innerText()).includes('已保存'));
  await page.locator('#copyKeywords').click();await page.waitForSelector('.preferences-copy-dialog[open]');
  assert((await page.locator('.preferences-copy-dialog textarea').inputValue()).includes('机器人×模型'));
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('#keywordInput').fill('draft');
  await page.evaluate(()=>{localStorage.setItem('preferredKeywords','["Changed in another tab"]');window.dispatchEvent(new StorageEvent('storage',{key:'preferredKeywords'}));});
  await page.locator('#saveSettings').click();
  await page.waitForFunction(()=>!document.getElementById('saveSettings').hasAttribute('aria-busy'));
  assert((await page.locator('#preferencesStatus').innerText()).includes('其他标签页'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('preferredKeywords')),'["Changed in another tab"]');
  await page.locator('#reloadPreferences').click();
  await page.locator('#resetSettings').click();
  assert.equal(await page.evaluate(()=>localStorage.getItem('preferredKeywords')),'["Changed in another tab"]');
  assert((await page.locator('#preferencesStatus').innerText()).includes('才会应用'));
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{window.scrollTo(0,0);return new Promise(requestAnimationFrame);});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const out=path.resolve(root,'../../reliability-preview');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'settings-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);await context.close();
  for(const mode of ['malformed','blocked','partial','transient']){
   const {context,page,errors}=await setup(mode);
   if(mode==='malformed'){
    assert.equal(await page.locator('#selectedKeywords [data-value]').count(),1);
    assert((await page.locator('#preferencesStatus').innerText()).includes('无法读取'));
   }else{
    await page.locator('#keywordInput').fill('new preference');await page.locator('#saveSettings').click();
    await page.waitForFunction(()=>!document.getElementById('saveSettings').hasAttribute('aria-busy'));
    assert((await page.locator('#preferencesStatus').innerText()).includes(mode==='transient'||mode==='blocked'?'本次未保存':'保存未完成'));
    assert((await page.locator('#selectedKeywords').innerText()).includes('new preference'));
    if(mode==='partial')assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('preferredKeywords'))),['world model benchmark','机器人×模型']);
    if(mode==='transient'){
     assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('preferredKeywords'))),['world model benchmark','机器人×模型']);
     assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('preferredAuthors'))),['Author Original']);
     await page.locator('#reloadPreferences').click();
     assert.equal(await page.locator('#selectedAuthors [data-value]').getAttribute('data-value'),'Author Original');
    }
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  // Two editors may share the same snapshot. Hold the origin lock to make both
  // attempt to save concurrently; one wins and the other must report conflict.
  const concurrent=await setup(), first=concurrent.page;
  const second=await concurrent.context.newPage();await second.goto('https://radar.test/settings.html');
  await first.locator('#keywordInput').fill('alpha draft');await second.locator('#keywordInput').fill('beta draft');
  await first.evaluate(()=>{navigator.locks.request('paper-radar.preferences.mutation',()=>new Promise(resolve=>{window.releasePreferencesGate=resolve;}));});
  await first.waitForFunction(()=>typeof window.releasePreferencesGate==='function');
  await Promise.all([first.locator('#saveSettings').click(),second.locator('#saveSettings').click()]);
  assert.equal(await first.locator('#saveSettings').getAttribute('aria-busy'),'true');
  assert.equal(await second.locator('#saveSettings').getAttribute('aria-busy'),'true');
  await first.evaluate(()=>window.releasePreferencesGate());
  for(const editor of [first,second])await editor.waitForFunction(()=>!document.getElementById('saveSettings').hasAttribute('aria-busy'));
  const messages=await Promise.all([first.locator('#preferencesStatus').innerText(),second.locator('#preferencesStatus').innerText()]);
  assert.equal(messages.filter(message=>message.includes('偏好已保存')).length,1);
  assert.equal(messages.filter(message=>message.includes('其他标签页')).length,1);
  const saved=await first.evaluate(()=>JSON.parse(localStorage.getItem('preferredKeywords')));
  assert.equal(saved.filter(value=>['alpha draft','beta draft'].includes(value)).length,1);
  assert.deepEqual(await first.evaluate(()=>JSON.parse(localStorage.getItem('preferredAuthors'))),['Author Original']);
  assert.deepEqual(concurrent.errors,[]);await concurrent.context.close();
  console.log('PASS: exact tags, pending input, Unicode, clipboard fallback, simultaneous-save conflict, transient storage recovery, unsaved clear, storage errors/rollback, mobile');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
