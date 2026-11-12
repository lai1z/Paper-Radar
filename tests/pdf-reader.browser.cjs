// Exercise the real page. PDF transport is a local fixture; no arXiv downloads.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const source={id:'2610.12345v2',title:'World model PDF reading fixture',authors:['Test Author'],categories:['cs.RO'],summary:'Original source abstract.',AI_status:'success',AI:{tldr:'A reading fixture.',method:'Source method.',result:'Source result.',motivation:'Source question.',conclusion:'Source conclusion.'}};
function pdfFixture(){
 const stream='BT /F1 24 Tf 60 700 Td (PDF preview test fixture) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let data='%PDF-1.4\n',offsets=[0];
 objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(data));data+=`${index+1} 0 obj\n${object}\nendobj\n`;});
 const start=Buffer.byteLength(data);data+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');
 return Buffer.from(data+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 try{
  const context=await browser.newContext({viewport:{width:1365,height:950}});
  let requests=0,slow=false,hold=[];
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url()),send=(body,type='text/plain')=>route.fulfill({body,contentType:type});
   if(url.hostname==='arxiv.org'){
    requests++;
    if(slow){await new Promise(resolve=>hold.push(resolve));try{return await send(pdfFixture(),'application/pdf');}catch{return;}}
    return send(pdfFixture(),'application/pdf');
   }
   if(url.pathname.endsWith('file-list.txt'))return send('2026-11-12_AI_enhanced_Chinese.jsonl');
   if(url.pathname.endsWith('update-status.json'))return send('{}','application/json');
   if(url.pathname.endsWith('.jsonl'))return send(JSON.stringify(source)+'\n'+JSON.stringify({...source,id:'2610.54321',title:'Second paper fixture'}));
   if(url.hostname==='api.github.com')return send('{}','application/json');
   if(url.pathname.endsWith('/auth.js'))return send('window.Auth={requireAuth(){},isPasswordEnabled(){return false}};','application/javascript');
   if(url.hostname!=='pdf.test')return send(url.pathname.endsWith('flatpickr')?'window.flatpickr=()=>({setDate(){},destroy(){},set(){}});':'',url.pathname.endsWith('flatpickr')?'application/javascript':'text/css');
   const file=path.join(root,url.pathname==='/'?'index.html':url.pathname.slice(1));
   return send(fs.readFileSync(file),{'.html':'text/html','.css':'text/css','.js':'application/javascript','.png':'image/png'}[path.extname(file)]||'text/plain');
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('https://pdf.test/');await page.locator('.paper-card').first().waitFor();
  await page.locator('.paper-card').first().click();
  const details=page.locator('#modalBody'),reader=page.locator('.digest-pdf-reader');
  assert.equal(await page.locator('iframe').count(),0);assert.equal(requests,0);
  assert.equal(await page.locator('#paperModal').evaluate(el=>getComputedStyle(el).backdropFilter),'none');
  await details.locator('.digest-pdf summary').click();
  assert.equal(requests,0);
  assert.equal(await details.getByRole('link',{name:'独立阅读 PDF ↗'}).getAttribute('href'),'https://arxiv.org/pdf/2610.12345v2');
  const open=()=>details.locator('[data-pdf-preview]').click();
  await open();await reader.locator('iframe').waitFor();
  assert.equal(await reader.locator('iframe').getAttribute('src'),'https://arxiv.org/pdf/2610.12345v2');
  assert.equal(await reader.evaluate(el=>el.scrollHeight<=el.clientHeight+1),true);
  assert.equal(await reader.locator('.digest-pdf-viewport').evaluate(el=>getComputedStyle(el).overflow),'hidden');
  const position=await page.locator('#paperPosition').innerText();
  await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#paperPosition').innerText(),position);
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.digest-pdf-reader')),true);
  // Capture the dedicated reader and its stable viewport, using a generated PDF.
  const output=path.resolve(root,'../../pdf-preview');fs.mkdirSync(output,{recursive:true});
  await page.screenshot({path:path.join(output,'reader-desktop.png')});
  await reader.locator('[data-pdf-close]').focus();await page.keyboard.press('Escape');
  assert.equal(await reader.count(),0);assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.locator('#paperModal.active').count(),1);
  assert.equal(await details.locator('[data-pdf-preview]').evaluate(el=>el===document.activeElement),true);
  await open();await page.evaluate(()=>document.querySelector('#modalBody .digest-pdf').open=false);
  await reader.waitFor({state:'detached'});assert.equal(await page.locator('iframe').count(),0);
  await details.locator('.digest-pdf summary').click();await open();
  await page.evaluate(()=>navigateToNextPaper());await reader.waitFor({state:'detached'});
  assert.equal(await page.locator('iframe').count(),0);
  await details.locator('.digest-pdf summary').click();await open();
  await page.evaluate(()=>closeModal());assert.equal(await reader.count(),0);
  assert.equal(await details.innerHTML(),'');assert.equal(await page.locator('iframe').count(),0);
  // Closing while transport is slow must release the reader and its delayed hint.
  slow=true;await page.clock.install();
  await page.locator('.paper-card').first().click();await details.locator('.digest-pdf summary').click();await open();
  await page.clock.runFor(12010);
  assert((await reader.getByRole('status').innerText()).includes('加载较慢'));
  await reader.locator('[data-pdf-close]').click();
  hold.splice(0).forEach(resolve=>resolve());slow=false;await page.clock.runFor(12010);
  assert.equal(await reader.count(),0);assert.equal(await page.locator('iframe').count(),0);
  // Saved papers use the same reader, retain versioned links, and release it.
  await page.locator('#closeModal').click();
  await page.locator('.paper-card').first().getByRole('button',{name:'+ 加入待读',exact:true}).click();
  await page.waitForFunction(()=>ReadingList.status('2610.12345')==='pending');
  await page.locator('#readingListButton').click();await page.getByRole('button',{name:'阅读解读',exact:true}).click();
  const saved=page.locator('.digest-saved-dialog');await saved.locator('.digest-pdf summary').click();
  await saved.locator('[data-pdf-preview]').click();
  assert.equal(await reader.locator('iframe').getAttribute('src'),'https://arxiv.org/pdf/2610.12345v2');
  await page.setViewportSize({width:390,height:844});await page.clock.runFor(250);
  assert.equal(await reader.evaluate(el=>el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1),true);
  const size=await reader.boundingBox();assert.equal(Math.round(size.width),390);assert.equal(Math.round(size.height),844);
  await page.screenshot({path:path.join(output,'reader-mobile.png')});
  await page.evaluate(()=>document.querySelector('.digest-saved-dialog').close());
  await reader.waitFor({state:'detached'});assert.equal(await page.locator('iframe').count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: zero automatic PDF requests; dedicated viewport; keyboard isolation; collapse/close/navigation cleanup; slow-load recovery; saved version; mobile layout');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
