// Diagnostic contact sheet of owned mask alpha over its exact base frames.
// This is a visual inspection aid, not automatic acceptance or edited media.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {chromium} from 'playwright';
const directory=resolve(process.argv[2]||'');
if(!directory.startsWith(resolve('test-output')+'\\'))throw new Error('Choose a retained test-output sample directory.');
const frames=[0,25,50,75,99],data=await readFile(join(directory,'masks.partial/masks.pgmask'));
assert.ok(data.length<=64*1024*1024);assert.equal(data.subarray(0,8).toString(),'PGMSK001');
const width=data.readUInt32LE(8),height=data.readUInt32LE(12),count=data.readUInt32LE(16);
assert.ok(width>0&&width<=1024&&height>0&&height<=1024);assert.equal(count,100);
const table=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc=bytes=>{let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;};
function chunk(type,payload){const tag=Buffer.from(type),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(payload.length);tail.writeUInt32BE(crc(Buffer.concat([tag,payload])));return Buffer.concat([head,tag,payload,tail]);}
function png(alpha){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
 const raw=Buffer.alloc(height*(1+width*4));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=y*(1+width*4)+1+x*4;raw[p]=230;raw[p+1]=181;raw[p+2]=46;raw[p+3]=Math.round(alpha[y*width+x]*.38);}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
let offset=20,previous;const rows=[],metrics=[];
for(let frame=0;frame<count;frame++){
 assert.ok(offset+4<=data.length);const bytes=data.readUInt32LE(offset);offset+=4;assert.ok(bytes>0&&bytes%5===0&&offset+bytes<=data.length);
 const alpha=Buffer.alloc(width*height);let pixel=0;
 for(let p=offset;p<offset+bytes;p+=5){const run=data.readUInt32LE(p);assert.ok(run>0&&pixel+run<=alpha.length);alpha.fill(data[p+4],pixel,pixel+run);pixel+=run;}
 assert.equal(pixel,alpha.length);offset+=bytes;
 let occupied=0,change=0;for(let p=0;p<alpha.length;p++){occupied+=alpha[p]>0?1:0;if(previous)change+=Math.abs(alpha[p]-previous[p])/255;}
 metrics.push({frame,coverage:occupied/alpha.length,alphaChange:previous?change/alpha.length:null});previous=alpha;
 if(!frames.includes(frame))continue;
 const [base,finished]=await Promise.all(['base','finished'].map(name=>readFile(join(directory,`${name}-${frame}.png`))));
 rows.push(`<section><h2>Frame ${frame} · ${(frame/50).toFixed(2)} s</h2><div class="row"><figure><img src="data:image/png;base64,${base.toString('base64')}"><figcaption>Exact normalized base</figcaption></figure><figure class="overlay"><img src="data:image/png;base64,${base.toString('base64')}"><img class="mask" src="data:image/png;base64,${png(alpha).toString('base64')}"><figcaption>Gold = affected pixels; background excluded</figcaption></figure><figure><img src="data:image/png;base64,${finished.toString('base64')}"><figcaption>Conservative subject detail · 20%</figcaption></figure></div></section>`);
}
assert.equal(offset,data.length);
await writeFile(join(directory,'inspection-metrics.json'),JSON.stringify({schema:1,metrics,subjectQualityAccepted:false,meaning:'Mask coverage/change are descriptive, not correctness or confidence scores.'},null,2));
const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:14px;background:#0c1521;color:#dfebf8;font:13px Segoe UI}h1{font-size:19px;margin:0 0 12px}h2{font-size:12px;color:#d9bb7b;margin:14px 0 5px}.row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}figure{margin:0;position:relative}img{width:100%;display:block}figcaption{margin-top:4px;color:#aabbce;font-size:11px}.mask{position:absolute;top:0;left:0}</style><h1>${directory.split(/[\\/]/).at(-1)} · representative mask/finishing inspection</h1><p>Not full-clip or continuous playback acceptance. Frames use the same exact excerpt base; no original media modified.</p>${rows.join('')}`;
await writeFile(join(directory,'inspection.html'),html);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.setContent(html);await page.locator('img').first().waitFor();await page.screenshot({path:join(directory,'inspection.png'),fullPage:true});}
finally{await browser.close();}
console.log(JSON.stringify({directory,count,frames,subjectQualityAccepted:false}));
