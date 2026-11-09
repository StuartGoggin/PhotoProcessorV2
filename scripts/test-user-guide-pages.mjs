import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const {chromium}=await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH?pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href:'playwright');
const output='test-output/user-guide-pages',capture=process.argv.includes('--capture');
const demoArt='data:image/svg+xml;base64,'+(await readFile('docs/user-guide/source/demo-artwork.svg')).toString('base64');
await mkdir(output,{recursive:true});
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1467','--strictPort'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let logs='',browser;const checks=[],errors=[];
server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
async function annotate(page,selectors,file){
  await page.evaluate(selectors=>selectors.forEach((selector,i)=>{const node=document.querySelector(selector);if(!node)throw Error('Missing annotation '+selector);const rect=node.getBoundingClientRect(),mark=document.createElement('span');mark.dataset.guideMarker='true';mark.textContent=String(i+1);mark.style.cssText='position:fixed;z-index:10000;display:grid;place-items:center;width:29px;height:29px;border-radius:50%;background:#edc880;color:#132b39;border:2px solid white;font:bold 15px Segoe UI;box-shadow:0 3px 10px #0006;left:'+Math.max(3,rect.left-12)+'px;top:'+Math.max(3,rect.top-10)+'px';document.body.append(mark);}),selectors);
  await page.screenshot({path:'docs/user-guide/source/'+file});await page.locator('[data-guide-marker]').evaluateAll(nodes=>nodes.forEach(n=>n.remove()));
}
const libraryState=()=>JSON.stringify([...window.__controlsLibraries].map(([root,lib])=>({root,tree:lib.tree,flags:[...lib.flags]})));
try{
  for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error(logs);try{if((await fetch('http://127.0.0.1:1467/lightbox-controls-preview.html')).ok)break;}catch{}await delay(250);}
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.__guideTest=true;window.__browseTest=true;window.__controlsManagedController=true;});
  await page.goto('http://127.0.0.1:1467/lightbox-controls-preview.html');
  await page.getByRole('tree').getByText('01-horse.jpg',{exact:true}).click();
  await page.waitForFunction(()=>{const el=document.querySelector('input[aria-label="Upload Original to Google Photos"]');return el&&!el.disabled;});
  const before=await page.evaluate(libraryState);
  await page.getByRole('button',{name:'Read User Guide',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'PhotoGoGo User Guide'}),frame=page.frameLocator('iframe[title="PhotoGoGo User Guide"]');
  await frame.locator('#guide-search').waitFor();
  await page.waitForFunction(()=>window.__controllerSurface?.title==='Reading user guide');
  await page.keyboard.press('m');await page.keyboard.press('Shift+M');await page.keyboard.press('x');await page.keyboard.press('1');await page.keyboard.press('q');await page.keyboard.press('ArrowRight');
  await page.evaluate(()=>{window.__controlsNativeInput({kind:'key',index:1});window.__controlsNativeInput({kind:'dial',index:0,delta:1});window.__controlsNativeInput({kind:'side',index:2});});
  await frame.locator('#guide-search').fill('wind noise');
  assert.equal(await page.evaluate(libraryState),before);
  await page.getByRole('button',{name:'Return to your work',exact:true}).click();
  assert.equal(await page.evaluate(libraryState),before);
  await page.getByRole('tree').getByText('01-horse.jpg',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__controlsReviewWrites.length),0);
  checks.push('Actual Lightbox capture, rating, Trash and upload flags survive guide keyboard/controller input');
  await page.locator('#app-main').focus();await page.keyboard.press('F1');
  await page.getByRole('dialog',{name:/Keyboard.*Controller|Lightbox.*help/i}).waitFor();
  await page.keyboard.press('Escape');
  checks.push('Existing Lightbox F1 reference still opens and closes');
  if(capture){
    await page.getByRole('button',{name:'Read User Guide',exact:true}).evaluate(el=>el.style.visibility='hidden');
    await page.evaluate(art=>{[...document.querySelectorAll('#app-main img')].forEach((img,i)=>{img.src=art;img.style.filter=i===1?'grayscale(1)':i===2?'saturate(1.12) contrast(1.04)':'';});document.querySelectorAll('div[style*="position: fixed"]').forEach(el=>el.style.visibility='hidden');},demoArt);
    await page.getByRole('button',{name:'AKP03E controller',exact:true}).evaluate(el=>el.parentElement.style.display='none');
    await annotate(page,['input[aria-label="Upload Original to Google Photos"]','input[aria-label="Upload B&W to Google Photos"]','input[aria-label="Upload Enhanced to Google Photos"]'],'lightbox-screen.png');
  }
  const hold=await browser.newPage({viewport:{width:1440,height:1000}});hold.setDefaultTimeout(15000);hold.on('pageerror',e=>errors.push(e.message));
  await hold.addInitScript(()=>{window.__guideTest=true;window.__browseTest=true;});
  await hold.goto('http://127.0.0.1:1467/lightbox-controls-preview.html');
  const upload=hold.getByLabel('Upload Original to Google Photos',{exact:true});
  await upload.check();await hold.waitForFunction(()=>window.__controlsSelectionWrites.length===1&&!document.querySelector('input[aria-label="Upload Original to Google Photos"]').disabled);
  await hold.getByRole('group',{name:'Photo quick views'}).getByRole('button',{name:'Google-selected',exact:true}).click();
  await hold.waitForFunction(()=>document.querySelector('[aria-label="Matching photo count"]')?.textContent==='Showing 1 of 3 originals');
  const factsBefore=await hold.evaluate(()=>window.__controlsFactsCalls.length);
  await hold.evaluate(()=>window.__controlsDeferSelection=true);await upload.uncheck();
  await hold.waitForFunction(()=>window.__controlsSelectionWrites.length===2);
  await hold.getByRole('button',{name:'Read User Guide',exact:true}).click();await hold.frameLocator('iframe').locator('#guide-search').waitFor();
  await hold.evaluate(()=>{window.__controlsDeferSelection=false;window.__controlsReleaseSelection();});
  await hold.waitForFunction(()=>![...window.__controlsLibraries.values()][0].flags.get('D:\\Controller photos|01-horse.jpg').selected);
  await hold.waitForFunction(n=>window.__controlsFactsCalls.length>n,factsBefore);
  await hold.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await hold.getByLabel('Matching photo count').textContent(),'Showing 1 of 3 originals');
  await hold.getByRole('tree').getByText('01-horse.jpg',{exact:true}).waitFor();
  await hold.getByRole('button',{name:'Return to your work',exact:true}).click();
  await hold.waitForFunction(()=>document.querySelector('[aria-label="Matching photo count"]')?.textContent==='Showing 0 of 3 originals');
  checks.push('A Google save may complete behind Help, while filtered selection reconciliation waits until returning to work');await hold.close();
  const snap=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});snap.setDefaultTimeout(15000);snap.on('pageerror',e=>errors.push(e.message));
  await snap.addInitScript(()=>{window.__openPaths=['D:/Demo/Arena.mp4'];window.__frameCount=3000;});
  await snap.goto('http://127.0.0.1:1467/snapshots-preview.html?guide=1');
  await snap.getByRole('button',{name:/New session/}).first().click();
  await snap.getByLabel('Session name',{exact:true}).fill('Arena highlights — demo');
  await snap.getByRole('button',{name:'Create session',exact:true}).click();
  await snap.getByRole('button',{name:'＋ Add videos',exact:true}).click();
  const position=snap.getByLabel('Video frame position',{exact:true});await position.waitFor();
  await snap.waitForFunction(()=>document.querySelector('.snapshots-viewer img')?.complete);
  await snap.getByRole('button',{name:'Forward shuttle',exact:true}).click();
  await snap.waitForFunction(()=>Number(document.querySelector('[aria-label="Video frame position"]').value)>5);
  await snap.getByRole('button',{name:'Read User Guide',exact:true}).click();
  await snap.frameLocator('iframe').locator('#guide-search').waitFor();
  const stopped=await position.inputValue();await delay(350);assert.equal(await position.inputValue(),stopped);
  await snap.getByRole('button',{name:'Return to your work',exact:true}).click();await delay(180);assert.equal(await position.inputValue(),stopped);
  checks.push('Actual Snapshot shuttle stops while guide opens and remains on the same frame/session after close');
  if(capture){
    await snap.getByRole('button',{name:'＋ Select photo',exact:true}).click();
    await snap.getByRole('button',{name:'Read User Guide',exact:true}).evaluate(el=>el.style.visibility='hidden');
    await snap.evaluate(art=>document.querySelectorAll('.snapshots-viewer img,.snapshots-photo-thumb img').forEach(img=>img.src=art),demoArt);
    await annotate(snap,['[aria-label="Video frame position"]','.snapshots-capture'],'snapshots-screen.png');
    await snap.locator('.snapshots-tray').screenshot({path:'docs/user-guide/source/snapshots-tray-screen.png'});
    const process=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});process.setDefaultTimeout(15000);
    await process.goto('http://127.0.0.1:1467/photo-process-preview.html');
    await process.getByRole('button',{name:'Preview B&W Conversion',exact:true}).click();
    await process.getByRole('img',{name:'Result photo preview',exact:true}).waitFor();
    await process.evaluate(art=>document.querySelectorAll('img[alt$="photo preview"]').forEach(img=>{img.src=art;img.style.filter=img.alt.startsWith('Result')?'grayscale(1)':'';}),demoArt);
    await annotate(process,['input[aria-label="S-curve strength"]','img[alt="Result photo preview"]'],'photo-process-screen.png');
    await process.close();checks.push('Captured annotated app screens using synthetic media and settings only');
  }
  assert.deepEqual(errors,[]);
  await writeFile(output+'/report.json',JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}catch(e){await writeFile(output+'/failure.json',JSON.stringify({error:e.stack,checks,errors,logs},null,2));console.error(e);process.exitCode=1;}
finally{await browser?.close();server.kill();}
