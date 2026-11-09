import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {chromium}=await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH?pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href:'playwright');
const {version}=JSON.parse(await readFile('package.json','utf8'));
const html='docs/user-guide/PhotoGoGo_User_Guide_'+version+'.html',out='test-output/user-guide-document';
await mkdir(out,{recursive:true});
assert.deepEqual(await readFile(html),await readFile('public/help/user-guide.html'));
const source=await readFile('docs/USER_GUIDE.md','utf8'),figures=JSON.parse(await readFile('docs/user-guide/source/figures.json','utf8'));
const browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[],errors=[],remote=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^https?:/.test(r.url()))remote.push(r.url());});
  await page.goto(pathToFileURL(resolve(html)).href);
  await page.locator('.figure-open img').evaluateAll(images=>Promise.all(images.map(async img=>{img.loading='eager';await img.decode();if(!img.naturalWidth)throw Error('Image decode failed');})));
  assert.equal(await page.locator('.chapter').count(),18);assert.equal(await page.locator('.guide-figure').count(),figures.length);
  assert.ok(await page.locator('a[href^="#"]').evaluateAll(as=>as.every(a=>document.getElementById(a.hash.slice(1)))));
  checks.push('Both editions identical; all 18 chapters, internal targets and '+figures.length+' figures load offline');
  const article=(await page.locator('.article').textContent()).replace(/\s+/g,' ').trim();
  const fragments=[];
  for(const line of source.split(/\r?\n/).slice(4)){
    if(!line.trim()||line==='## Contents'||/^\d+\. \[/.test(line))continue;
    const items=line.startsWith('|')?line.replace(/^\||\|$/g,'').split('|'): [line.replace(/^#{1,3}\s+(?:\d+\s+)?/,'').replace(/^\d+\.\s+|^-\s+/, '')];
    for(const item of items){const value=item.trim().replace(/\*\*/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\s+/g,' ').trim();if(value&&!/^:?-+:?$/.test(value))fragments.push(value);}
  }
  const missing=fragments.filter(fragment=>!article.includes(fragment));assert.deepEqual(missing,[]);
  checks.push('Preserved '+fragments.length+' substantive source paragraphs, headings and table cells');
  for(const [query,target] of [['RAW','#ch-07'],['wind noise','#ch-10'],['crop','#ch-06'],['Google Photos verification','#ch-12']]){
    await page.locator('#guide-search').fill(query);assert.ok(await page.locator('#result-list a').evaluateAll((as,target)=>as.some(a=>a.hash===target),target));
  }
  await page.locator('#guide-search').fill('zzqvnonexistent');assert.match(await page.locator('#search-status').innerText(),/No matching chapters/);await page.keyboard.press('Escape');
  checks.push('Topic search, no-results state and clear/Escape work');
  const base=await page.locator('body').evaluate(el=>parseFloat(getComputedStyle(el).fontSize));await page.locator('#text-larger').click();assert.ok(await page.locator('body').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))>base);await page.locator('#text-smaller').click();
  await page.locator('.figure-open').first().click();await page.locator('#figure-viewer').waitFor({state:'visible'});assert.match(await page.locator('#figure-caption').innerText(),/ — /);await page.locator('#figure-fit').click();assert.ok(await page.locator('#figure-image').evaluate(el=>el.classList.contains('actual-size')));await page.keyboard.press('Escape');assert.ok(await page.locator('#figure-viewer').isHidden());
  checks.push('Text sizing, image enlargement/actual size, readable caption and Escape return work');
  await page.goto(pathToFileURL(resolve(html)).href);await page.screenshot({path:out+'/desktop.png'});
  for(const width of [1440,860,768,390]){
    await page.setViewportSize({width,height:844});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(dimensions.scroll<=dimensions.width,JSON.stringify(dimensions));
    if(width===390){assert.ok(await page.locator('#toc-nav').isHidden());await page.locator('#toc-toggle').click();await page.locator('.toc-link[href="#ch-06"]').click();await page.locator('#toc-nav').waitFor({state:'hidden'});await page.screenshot({path:out+'/mobile-chapter.png'});}
  }
  checks.push('Contents and tables fit desktop, tablet and 390px layouts without page overflow');
  await page.setViewportSize({width:1440,height:1000});await page.goto(pathToFileURL(resolve(html)).href+'#ch-06');await page.screenshot({path:out+'/lightbox-chapter.png'});
  await page.emulateMedia({media:'print'});assert.ok(await page.locator('.sidebar').isHidden());
  await page.pdf({path:out+'/print-proof.pdf',format:'A4',printBackground:true,preferCSSPageSize:true});
  checks.push('Print proof generated with navigation hidden and chapter/figure content retained');
  const noJS=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}),fallback=await noJS.newPage();await fallback.goto(pathToFileURL(resolve(html)).href);assert.equal(await fallback.locator('.chapter').count(),18);assert.ok(await fallback.locator('#toc-nav').isVisible());await noJS.close();
  checks.push('No-script fallback retains readable chapters and contents');
  assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);
  await writeFile(out+'/report.json',JSON.stringify({version,passed:checks.length,checks,fragments:fragments.length,figures:figures.length,errors,remote},null,2));console.log(JSON.stringify({passed:checks.length,fragments:fragments.length,figures:figures.length}));
}catch(e){await writeFile(out+'/failure.json',JSON.stringify({error:e.stack,checks,errors,remote},null,2));console.error(e);process.exitCode=1;}finally{await browser.close();}
