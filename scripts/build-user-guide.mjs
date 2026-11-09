// One content source, two byte-identical offline manuals. No renderer or network dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = await readFile(path.join(root, 'docs/USER_GUIDE.md'), 'utf8');
const {version} = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const assetRoot = path.join(root, 'docs/user-guide/source');
const css = await readFile(path.join(assetRoot, 'reader.css'), 'utf8') + '\n' + await readFile(path.join(assetRoot, 'illustrated.css'), 'utf8');
const js = await readFile(path.join(assetRoot, 'reader.js'), 'utf8') + '\n' + await readFile(path.join(assetRoot, 'embedded-reader.js'), 'utf8');
const figures = JSON.parse(await readFile(path.join(assetRoot, 'figures.json'), 'utf8'));
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function inline(text) {
  return text.split(/(\*\*.*?\*\*|\[[^\]]+\]\([^)]+\))/).map(part => {
    if (part.startsWith('**') && part.endsWith('**')) return '<strong>'+esc(part.slice(2,-2))+'</strong>';
    const match = /^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/.exec(part);
    return match ? '<a href="'+esc(match[2])+'" target="_blank" rel="noopener noreferrer">'+esc(match[1])+'</a>' : esc(part);
  }).join('');
}
const figureHtml = new Map();
for (const figure of figures) {
  if (!/^[a-z0-9-]+\.(svg|png)$/.test(figure.file)) throw Error('Invalid local figure path');
  const bytes = await readFile(path.join(assetRoot, figure.file));
  const mime = figure.file.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  if(mime==='image/png'&&bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid PNG figure');
  const width=mime==='image/png'?bytes.readUInt32BE(16):figure.width,height=mime==='image/png'?bytes.readUInt32BE(20):figure.height;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw Error('Figure dimensions required');
  const html = '<figure class="guide-figure"><button type="button" class="figure-open" aria-label="Enlarge '+esc(figure.title)+'"><img src="data:'+mime+';base64,'+bytes.toString('base64')+'" alt="'+esc(figure.alt)+'" width="'+width+'" height="'+height+'" loading="lazy"></button><figcaption><strong>'+esc(figure.title)+'</strong><span>'+esc(figure.caption)+'</span><small>Click the illustration to enlarge</small></figcaption></figure>';
  figureHtml.set(figure.chapter, (figureHtml.get(figure.chapter)||'')+html);
}
const aliases={3:'sd card import duplicate md5 event rename',5:'post process enhance enhanced black white bw b&w s curve',6:'review light box lightbox crop cropping keyboard selections favourite',7:'raw cr3 dark muddy bright pop noise denoise',8:'stabilizer stabiliser stabilization stabilisation tripod wobble rotation render',9:'score card scorecard chapter titles overlay youtube heading',10:'wind noise rumble hiss audio music soundtrack missing clips 31 51 cache reuse',11:'snapshot snapshots still frame photo export resolution small tiny thumbnail session scrolling',12:'google photos upload publish error verification favourite oauth sign in gps',13:'archive transfer backup nas wifi network md5 verify checksum',14:'job jobs retry resume pause abort error log history',15:'akp03e ajazz ajaz keyboard shortcuts streamdock controller dial',16:'cleanup trash collect face matching ai optional',17:'error failure failed slow missing disabled greyed grayed'};
const lines=source.split(/\r?\n/), chapters=[], parts=[];
let i=lines.findIndex(line=>line.startsWith('## 1 ')), chapter;
if(i<0) throw Error('Missing chapter 1');
while(i<lines.length) {
  const line=lines[i];
  if(!line.trim()){i++;continue;}
  if(line.startsWith('## ')) {
    if(chapter)parts.push('</section>');
    const match=/^## (\d+) (.+)$/.exec(line); if(!match)throw Error('Invalid chapter');
    const number=Number(match[1]), id='ch-'+String(number).padStart(2,'0');
    chapter={id,number,title:match[2]};chapters.push(chapter);
    parts.push('<section class="chapter" id="'+id+'" aria-labelledby="'+id+'-title" data-keywords="'+esc(aliases[number]||'')+'"><p class="chapter-kicker">Chapter '+String(number).padStart(2,'0')+'</p><h2 id="'+id+'-title" tabindex="-1">'+esc(chapter.title)+'</h2>'+(figureHtml.get(number)||''));i++;continue;
  }
  if(line.startsWith('### ')) {
    const title=line.slice(4), id=chapter.id+'-'+title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    parts.push('<h3 id="'+id+'">'+esc(title)+'</h3>');i++;continue;
  }
  if(line.startsWith('|')) {
    const rows=[];
    while(i<lines.length&&lines[i].startsWith('|')) {
      const row=lines[i].trim().replace(/^\||\|$/g,'').split('|').map(s=>s.trim());
      if(!row.every(s=>/^:?-+:?$/.test(s)))rows.push(row);i++;
    }
    parts.push('<div class="table-wrap" tabindex="0" role="region" aria-label="'+esc(chapter.title)+' reference table"><table><thead><tr>'+rows[0].map(s=>'<th scope="col">'+inline(s)+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(1).map(row=>'<tr><th scope="row">'+inline(row[0])+'</th>'+row.slice(1).map(s=>'<td>'+inline(s)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue;
  }
  if(/^\d+\. /.test(line)||line.startsWith('- ')) {
    const ordered=/^\d+\. /.test(line),items=[];
    while(i<lines.length) {
      const match=ordered?/^\d+\. (.*)$/.exec(lines[i]):/^- (.*)$/.exec(lines[i]);
      if(!match)break;items.push(match[1]);i++;
    }
    const tag=ordered?'ol':'ul';parts.push('<'+tag+'>'+items.map(s=>'<li>'+inline(s)+'</li>').join('')+'</'+tag+'>');continue;
  }
  parts.push('<p>'+inline(line)+'</p>');i++;
}
parts.push('</section>');
if(chapters.length!==18||chapters.some((c,i)=>c.number!==i+1))throw Error('Guide must contain all 18 ordered chapters');
const intro=lines.slice(4,lines.indexOf('## Contents')).filter(l=>l.trim());
const toc=chapters.map(c=>'<a class="toc-link" href="#'+c.id+'"><span class="toc-number">'+String(c.number).padStart(2,'0')+'</span><span>'+esc(c.title)+'</span></a>').join('');
const icon = kind => '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="12" stroke="currentColor" stroke-width="1.5"/>'+({photo:'<rect x="12" y="14" width="24" height="20" rx="3" stroke="currentColor" stroke-width="2"/><path d="m12 29 7-7 7 7 4-4 6 6" stroke="currentColor" stroke-width="2"/><circle cx="30" cy="20" r="2" fill="currentColor"/>',video:'<path d="m20 16 13 8-13 8V16Z" fill="currentColor"/>',snapshot:'<path d="M13 18h6l2-4h8l2 4h4v17H13V18Z" stroke="currentColor" stroke-width="2"/><circle cx="24" cy="26" r="5" stroke="currentColor" stroke-width="2"/>'}[kind])+'</svg>';
const cards=[['photo','ch-01','Your photo workflow','Import, develop and review. Share your best photographs and archive with confidence.'],['video','ch-08','Create a finished video','Build your sequence, stabilise the picture, add graphics and finish the sound.'],['snapshot','ch-11','Find the perfect frame','Browse original video, choose the moment and export a full-resolution photograph.']].map(([kind,id,title,description])=>'<a class="task-card" href="#'+id+'">'+icon(kind)+'<strong>'+title+'</strong><span>'+description+'</span><small>Explore the workflow <b aria-hidden="true">↗</b></small></a>').join('');
const output=`<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none';"><meta name="description" content="The illustrated offline PhotoGoGo user guide"><title>PhotoGoGo User Guide ${esc(version)}</title><style>${css}</style></head><body>
<a class="skip" href="#guide-main">Skip to the guide</a><div class="shell"><aside class="sidebar" id="guide-navigation" aria-label="Guide navigation"><a class="brand" href="#top">Photo<span class="brand-dot">GoGo</span><span class="brand-book">Field guide</span></a><p class="guide-label">Your creative companion · ${esc(version)}</p><button type="button" class="toc-toggle js-only" id="toc-toggle" aria-controls="toc-nav" aria-expanded="true">Chapters</button><div class="search-panel"><form id="search-form" role="search"><label class="search-label" for="guide-search">What would you like to do?</label><div class="search-line"><input type="search" id="guide-search" autocomplete="off" placeholder="Try RAW, crop, wind noise…" aria-describedby="search-hint"><button type="button" id="clear-search" class="clear-search" aria-label="Clear search" hidden>×</button></div><p class="search-hint" id="search-hint">Press / to search · Ctrl+F also works</p></form><div class="search-results" id="search-results" hidden><p id="search-status" class="search-status" role="status" aria-live="polite"></p><div id="result-list"></div></div></div><nav class="toc-nav" id="toc-nav" aria-label="Chapters"><p class="toc-caption">Explore the guide</p>${toc}</nav><div class="sidebar-footer">18 chapters · illustrated workflows<br>Included with PhotoGoGo. Yours offline.</div></aside>
<main class="main" id="guide-main" tabindex="-1"><div class="reading-tools"><span class="desktop-edition"><strong>Your PhotoGoGo guide</strong> · ${esc(version)}</span><a class="mobile-contents" href="#guide-navigation">Contents &amp; search</a><div class="reader-actions"><button type="button" class="text-size js-only" id="text-smaller" aria-label="Decrease text size">A−</button><button type="button" class="text-size js-only" id="text-larger" aria-label="Increase text size">A+</button><button type="button" class="print-button js-only" id="print-guide">Print / save PDF</button></div></div><article class="article"><header class="hero" id="top"><p class="eyebrow">Create. Curate. Keep.</p><h1>A home for every<br><span>great moment.</span></h1><p class="edition">PhotoGoGo User Guide · Version ${esc(version)} · Windows</p><p class="hero-intro">${inline(intro[0])}</p><div class="task-cards" aria-label="Quick starts">${cards}</div><details class="guide-intro"><summary>About this guide and version scope</summary>${intro.slice(1).map(l=>'<p>'+inline(l)+'</p>').join('')}</details></header><noscript><p>All chapters and contents links work without JavaScript. Use your browser’s Find command to search.</p></noscript>${parts.join('\n')}<p class="endnote"><a href="#top">Back to the start</a> · PhotoGoGo ${esc(version)} · Made to travel with your library.</p></article></main></div>
<dialog id="figure-viewer" aria-labelledby="figure-caption"><div class="figure-tools"><button type="button" id="figure-fit">Actual size</button><button type="button" id="figure-close">Close image ×</button></div><div class="figure-stage"><img id="figure-image" alt=""></div><p id="figure-caption"></p></dialog><script>${js}</script></body></html>`;
const destinations=['public/help/user-guide.html','docs/user-guide/PhotoGoGo_User_Guide_'+version+'.html'];
for(const destination of destinations){await mkdir(path.dirname(path.join(root,destination)),{recursive:true});await writeFile(path.join(root,destination),output);}
const manifest={version,chapters:18,figures:figures.length,bytes:Buffer.byteLength(output),sha256:createHash('sha256').update(output).digest('hex'),sourceSha256:createHash('sha256').update(source).digest('hex'),outputs:destinations};
await writeFile(path.join(root,'public/help/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
