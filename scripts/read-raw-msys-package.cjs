// Read only package metadata. Never load or execute a downloaded DLL.
const fs=require('fs'),cp=require('child_process'),zlib=require('zlib');
const [tar,request,out]=process.argv.slice(2);
if(!tar||!request||!out)throw Error('Expected tar, request JSON, output JSON');
const pkg=JSON.parse(fs.readFileSync(request,'utf8').replace(/^\uFEFF/,''));
function extract(name){return cp.execFileSync('C:\\Program Files\\7-Zip\\7z.exe',['x','-so',tar,name],{maxBuffer:16*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});}
let bytes=extract('.MTREE');if(bytes[0]===0x1f&&bytes[1]===0x8b)bytes=zlib.gunzipSync(bytes);
const lines=bytes.toString('utf8').split('\n');
const checks=pkg.dlls.map(d=>{const line=lines.find(l=>l.startsWith('./ucrt64/bin/'+d.file+' '));const hash=line?.match(/sha256digest=([a-f0-9]{64})/)?.[1];return {file:d.file,expected:d.hash,packageHash:hash,match:hash===d.hash};});
const info=extract('.PKGINFO').toString('utf8');const value=k=>info.match(new RegExp('^'+k+' = (.+)$','m'))?.[1];
fs.writeFileSync(out,JSON.stringify({matched:checks.every(c=>c.match),checks,name:value('pkgname'),base:value('pkgbase'),version:value('pkgver'),buildDate:value('builddate'),packager:value('packager'),licenses:info.split('\n').filter(l=>l.startsWith('license = ')).map(l=>l.slice(10))},null,2));
