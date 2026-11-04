// Real browser storage boundaries: concurrent writers, invalid backups, and denied storage.
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const KEY = 'paper-radar.reading-list.v1';
const origin = 'https://reading-reliability.test';
async function configure(context) {
  await context.route(`${origin}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({contentType:'text/html; charset=utf-8', body:'<!doctype html><meta charset="utf-8"><div class="header-controls"></div><main></main><script src="/js/zotero-export.js"></script><script src="/js/paper-digest.js"></script><script src="/js/reading-list.js"></script>'});
    return route.fulfill({contentType:'application/javascript; charset=utf-8', body:fs.readFileSync(path.join(root, pathname.slice(1)))});
  });
}
async function mount(page, id, title) {
  await page.evaluate(({id,title}) => {
    const host = document.createElement('div'); document.querySelector('main').append(host);
    ReadingList.mount(host, {id,title,authors:['王小明','A. Author'],abstract:'A hidden-original-abstract keyword.',summary:'中文解读',published:'2026-10-01',tldr:'摘要',AI_status:'success'});
  }, {id,title});
}
(async () => {
  const browser = await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || 'msedge'});
  try {
    const context = await browser.newContext({acceptDownloads:true}); await configure(context);
    const first = await context.newPage(), second = await context.newPage();
    const errors=[]; first.on('pageerror',e=>errors.push(e.message)); second.on('pageerror',e=>errors.push(e.message));
    await Promise.all([first.goto(origin),second.goto(origin)]);
    await mount(first,'2611.12345v2','世界模型甲'); await mount(second,'2611.54321','机器人乙');
    // Hold the real origin-wide lock: neither tab may claim success before it can write.
    await first.evaluate(key => { navigator.locks.request(`${key}.mutation`, () => new Promise(resolve=>{window.releaseWriteGate=resolve;})); }, KEY);
    await first.waitForFunction(()=>typeof window.releaseWriteGate === 'function');
    await Promise.all([first.getByRole('button',{name:'+ 加入待读',exact:true}).click(),second.getByRole('button',{name:'+ 加入待读',exact:true}).click()]);
    assert.equal(await first.evaluate(key=>localStorage.getItem(key),KEY),null);
    assert.equal(await first.locator('[data-reading-id]').getAttribute('aria-busy'),'true');
    await first.evaluate(()=>window.releaseWriteGate());
    await first.waitForFunction(key=>JSON.parse(localStorage.getItem(key)||'{"papers":[]}').papers.length===2,KEY);
    await second.getByRole('button',{name:'✓ 已加入待读',exact:true}).waitFor();
    const saved=JSON.parse(await first.evaluate(key=>localStorage.getItem(key),KEY));
    assert.deepEqual(saved.papers.map(p=>p.id).sort(),['2611.12345','2611.54321']);
    assert.equal(saved.papers.find(p=>p.id==='2611.12345').sourceId,'2611.12345v2');
    await first.locator('#readingListButton').click();
    assert.equal(await first.locator('.rl-entry').filter({hasText:'世界模型甲'}).getByRole('link',{name:'打开 PDF'}).getAttribute('href'),'https://arxiv.org/pdf/2611.12345v2');
    await first.getByRole('searchbox').fill('hidden-original-abstract');
    assert.equal(await first.locator('.rl-entry').count(),2);
    await first.getByRole('searchbox').fill('');
    const rawBefore=await first.evaluate(key=>localStorage.getItem(key),KEY);
    await first.locator('input[type=file]').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,papers:[saved.papers[0],{id:'2611.99999',title:''}]}))});
    await first.waitForFunction(()=>document.querySelector('.rl-toast').textContent.includes('导入失败'));
    assert.equal(await first.evaluate(key=>localStorage.getItem(key),KEY),rawBefore);
    // Re-rendering after removing a row keeps keyboard focus inside the reading list.
    await first.locator('.rl-entry').first().getByRole('button',{name:'移除',exact:true}).click();
    await first.waitForFunction(()=>document.querySelectorAll('.rl-entry').length===1);
    assert(await first.locator('.rl-dialog').evaluate(el=>el.contains(document.activeElement)));
    await first.getByRole('button',{name:'撤销',exact:true}).click();
    await first.waitForFunction(()=>document.querySelectorAll('.rl-entry').length===2);
    // Malformed storage stays intact; backup exports those exact bytes, not an empty list.
    const corrupt='{"version":1,"papers":[{"id":"2611.12345","title":"原始标题"},null]}';
    await first.evaluate(({key,raw})=>localStorage.setItem(key,raw),{key:KEY,raw:corrupt});
    await second.reload(); await second.locator('#readingListButton').click();
    assert(await second.locator('.rl-storage-notice').isVisible());
    const pendingDownload=second.waitForEvent('download'); await second.getByRole('button',{name:'导出备份',exact:true}).click();
    const download=await pendingDownload;
    assert.equal(fs.readFileSync(await download.path(),'utf8'),corrupt);
    assert.equal(await second.evaluate(key=>localStorage.getItem(key),KEY),corrupt);
    assert.deepEqual(errors,[]); await context.close();

    const denied=await browser.newContext({acceptDownloads:true}); await configure(denied);
    await denied.addInitScript(key=>{
      const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
      Storage.prototype.getItem=function(k){if(k===key)throw new DOMException('Storage denied','SecurityError');return get.call(this,k);};
      Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Storage denied','SecurityError');return set.call(this,k,v);};
    },KEY);
    const page=await denied.newPage(),deniedErrors=[]; page.on('pageerror',e=>deniedErrors.push(e.message));
    let downloads=0;page.on('download',()=>downloads++); await page.goto(origin);
    await mount(page,'2611.11111','无法保存的论文');
    await page.getByRole('button',{name:'+ 加入待读',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.rl-toast').textContent.includes('保存失败'));
    assert.equal(await page.locator('[data-reading-id]').innerText(),'+ 加入待读');
    await page.locator('#readingListButton').click();
    await page.getByRole('button',{name:'导出备份',exact:true}).click();
    assert((await page.locator('.rl-storage-notice').innerText()).includes('备份没有生成'));
    assert.equal(downloads,0); assert.deepEqual(deniedErrors,[]);
    await denied.close();
    console.log('PASS: concurrent tab saves, versioned PDF, original-abstract search, atomic invalid import, keyboard focus, corrupt raw backup, denied storage feedback');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
