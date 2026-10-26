// npm install --no-save playwright; npx playwright install chromium
// Optional: BROWSER_CHANNEL=msedge (or chrome) for an installed browser.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const KEY = 'paper-radar.reading-list.v1';
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  try {
    const context = await browser.newContext({acceptDownloads:true});
    await context.route('https://reading.test/**', route => {
      const file = new URL(route.request().url()).pathname.slice(1);
      if (file) return route.fulfill({body:fs.readFileSync(path.join(root,file)),contentType:'application/javascript; charset=utf-8'});
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><div class="header-controls"></div><div id="cards"></div><script src="/js/zotero-export.js"></script><script src="/js/reading-list.js"></script>'});
    });
    const page = await context.newPage(); const errors = []; page.on('pageerror',e=>errors.push(e.message));
    await page.goto('https://reading.test/');
    await page.evaluate(() => {
      const paper = {id:'2610.12345v2',title:'世界模型：中文 α',authors:['王小明', 'Smith, Jr., John'],details:'完整原始摘要\n第二段',summary:'AI 总结',published:'2026-10-01',date:'2026-10-26'};
      ReadingList.mount(document.querySelector('#cards'),paper);
    });
    await page.getByRole('button',{name:'+ 加入待读',exact:true}).click();
    await page.reload(); await page.locator('#readingListButton').click();
    async function download(name) {
      const pending = page.waitForEvent('download'); await page.getByRole('button',{name,exact:true}).click();
      const file = await pending;
      return {name:file.suggestedFilename(),data:JSON.parse(fs.readFileSync(await file.path(),'utf8'))};
    }
    const exported = await download('导出到 Zotero');
    assert(exported.name.endsWith('.csl.json')); assert.equal(exported.data[0].title,'世界模型：中文 α');
    assert.equal(exported.data[0].abstract,'完整原始摘要\n第二段');
    assert.equal(exported.data[0].author.length,2);
    assert.deepEqual(exported.data[0].issued,{'date-parts':[[2026,10,1]]});
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async value=>{window.copiedBibliography=value;}}}));
    await page.getByRole('button',{name:'复制到 Zotero',exact:true}).click();
    assert.deepEqual(JSON.parse(await page.evaluate(()=>window.copiedBibliography)),exported.data);
    assert((await page.locator('.rl-toast').innerText()).includes('已复制 1 篇'));
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async()=>{throw new Error('Denied')}}}));
    await page.getByRole('button',{name:'复制到 Zotero',exact:true}).click();
    const copyArea = page.getByLabel('待复制的 Zotero 文献信息');
    assert(await copyArea.isVisible());
    assert.deepEqual(JSON.parse(await copyArea.inputValue()),exported.data);
    assert(await copyArea.evaluate(el=>el.readOnly && el.selectionStart===0 && el.selectionEnd===el.value.length));
    await page.getByRole('button',{name:'收起复制文本',exact:true}).click();
    assert.equal(await copyArea.isVisible(),false);
    const backup = await download('导出备份');
    assert.equal(backup.data.version,1); assert.equal(backup.data.papers[0].published,'2026-10-01');
    assert.deepEqual(backup.data.papers[0].authorNames,['王小明','Smith, Jr., John']);
    // Import a legacy backup containing a second, already read paper. Re-import must not duplicate.
    const legacy = {version:1,papers:[{id:'2610.54321',title:'Legacy record',authors:'Alice, Bob',summary:'AI text',date:'2026-10-26',status:'read',savedAt:1}]};
    for (let i=0;i<2;i++) await page.locator('input[type=file]').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});
    await page.getByLabel('Zotero 导出范围').selectOption('all');
    const all = (await download('导出到 Zotero')).data; assert.equal(all.length,2);
    assert.equal(all[1].issued,undefined); assert.equal(all[1].abstract,undefined);
    await page.getByLabel('Zotero 导出范围').selectOption('pending');
    assert.equal((await download('导出到 Zotero')).data.length,1);
    await page.getByRole('button',{name:'已读 (1)',exact:true}).click();
    await page.getByLabel('Zotero 导出范围').selectOption('visible');
    assert.equal((await download('导出到 Zotero')).data[0].title,'Legacy record');
    await page.getByRole('searchbox').fill('absent');
    let downloaded=false; page.on('download',()=>{downloaded=true;});
    await page.getByRole('button',{name:'导出到 Zotero',exact:true}).click();
    assert((await page.locator('.rl-toast').innerText()).includes('没有可导出')); assert.equal(downloaded,false);
    await page.getByRole('button',{name:'复制到 Zotero',exact:true}).click();
    assert((await page.locator('.rl-toast').innerText()).includes('剪贴板未更新'));
    assert.equal(await copyArea.isVisible(),false);
    assert.equal(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),KEY)).papers.length,2);
    // Restore original JSON backup into an empty browser store; bibliography metadata survives.
    await page.evaluate(key=>localStorage.removeItem(key),KEY); await page.reload();
    await page.locator('#readingListButton').click();
    await page.locator('input[type=file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup.data))});
    assert.deepEqual((await download('导出到 Zotero')).data,exported.data);
    assert.deepEqual(errors,[]);
    console.log('PASS: browser downloads, UTF-8, metadata persistence, legacy backup, merge dedup, scopes, empty results, JSON restore');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
