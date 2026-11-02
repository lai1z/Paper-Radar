// Saved-paper navigation and explicit reading state, independent of the daily feed.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.route('https://saved.test/**',route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/css/reading-list.css"><link rel="stylesheet" href="/css/paper-digest.css"><div class="header-controls"></div><main></main><script src="/js/zotero-export.js"></script><script src="/js/paper-digest.js"></script><script src="/js/reading-list.js"></script></html>'});
      return route.fulfill({body:fs.readFileSync(path.join(root,pathname.slice(1))),contentType:pathname.endsWith('.css')?'text/css':'application/javascript'});
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('https://saved.test/');
    await page.evaluate(()=>{
      const original={title:'世界模型甲',id:'2610.12345v2',authorNames:['王小明','Alice'],authors:'王小明, Alice',published:'2026-10-01',date:'2026-11-02',abstract:'Latency decreased by 38% on benchmark A.',tldr:'用门控降低生成代价。',AI_status:'success',digest_version:2,core_method:'按需生成未来。',key_results:[{finding:'延迟降低38%。',setting:'benchmark A',evidence_quote:'Latency decreased by 38% on benchmark A.'}]};
      const main=document.querySelector('main');
      for(const paper of [original,{...original,id:'2610.54321',title:'机器人策略乙'}]){
        const host=document.createElement('div');main.append(host);ReadingList.mount(host,paper);host.querySelector('button').click();
      }
    });
    await page.locator('#readingListButton').click();
    await page.locator('.rl-title').first().click();
    const reader=page.locator('.digest-saved-dialog');
    assert.equal(await reader.locator('h2').innerText(),'机器人策略乙');
    assert(await reader.getByRole('button',{name:'上一篇',exact:true}).isDisabled());
    await reader.getByRole('button',{name:'下一篇',exact:true}).click();
    assert.equal(await reader.locator('h2').innerText(),'世界模型甲');
    assert(await reader.getByRole('button',{name:'下一篇',exact:true}).isDisabled());
    assert.equal(await reader.locator('.digest-arxiv').getAttribute('href'),'https://arxiv.org/abs/2610.12345v2');
    assert.equal(await reader.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await reader.getByRole('button',{name:'标记已读',exact:true}).click();
    await page.keyboard.press('Escape');
    assert.equal(await reader.count(),0);
    assert.equal(await page.locator('.rl-title').count(),1);
    assert.equal(await page.locator('.rl-dialog').evaluate(el=>el.contains(document.activeElement)),true);
    await page.getByRole('button',{name:'已读 (1)',exact:true}).click();
    await page.getByRole('button',{name:'阅读解读',exact:true}).click();
    assert.equal(await reader.locator('h2').innerText(),'世界模型甲');
    await reader.getByRole('button',{name:'放回待读',exact:true}).click();
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('paper-radar.reading-list.v1')).papers.find(paper=>paper.id==='2610.12345'));
    assert.equal(saved.status,'pending');assert.equal(saved.sourceId,'2610.12345v2');
    assert.equal(saved.abstract,'Latency decreased by 38% on benchmark A.');
    assert.equal(saved.published,'2026-10-01');assert.deepEqual(saved.authorNames,['王小明','Alice']);
    assert.deepEqual(errors,[]);
    console.log('PASS: saved selection navigation, manual read/unread, focus return, versioned source, original metadata, mobile width');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
