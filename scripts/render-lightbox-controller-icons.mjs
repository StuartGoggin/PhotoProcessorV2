import { readFile, writeFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const { chromium } = await import(process.env.PHOTOGOGO_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PHOTOGOGO_PLAYWRIGHT_PATH).href : "playwright");
const root = new URL("../public/controller/ajazz-akp03e/", import.meta.url);
const source = await readFile(new URL("../src/utils/lightboxCommands.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {lightboxCommands,lightboxCropCommands,shortcutFor} = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
const definitions = [
  {file:"one-star-next",id:"rate-1-next",title:"ONE STAR",symbol:"★",color:"#E9C875"},
  {file:"two-stars-next",id:"rate-2-next",title:"TWO STARS",symbol:"★★",color:"#E9C875"},
  {file:"three-stars-next",id:"rate-3-next",title:"THREE STARS",symbol:"★★★",color:"#E9C875"},
  {file:"trash-next",id:"trash-next",title:"TRASH",symbol:"×",color:"#F49797"},
  {file:"select-next",id:"select-active-next",title:"SELECT",symbol:"✓",color:"#6EE4EF"},
  {file:"skip",id:"next",title:"SKIP",symbol:"→",color:"#D2DCE9"},
];
const xml = value => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
for(const definition of definitions) {
  const key=shortcutFor(definition.id); if(!key)throw Error(`Unknown controller command ${definition.id}`);
  await writeFile(new URL(`${definition.file}.svg`,root),`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="${xml(definition.title)} and next">
<defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="#182C3F"/><stop offset="1" stop-color="#090F1A"/></linearGradient></defs>
<rect x="2" y="2" width="252" height="252" rx="28" fill="url(#bg)" stroke="#3B5067" stroke-width="2"/><path d="M36 30H220" stroke="${definition.color}" stroke-width="4" stroke-linecap="round"/>
<text x="128" y="115" fill="${definition.color}" font-family="Segoe UI Symbol,Segoe UI,sans-serif" font-size="54" text-anchor="middle">${xml(definition.symbol)}</text>
<text x="128" y="155" fill="#fff" font-family="Segoe UI,sans-serif" font-weight="700" font-size="22" text-anchor="middle">${definition.title}</text>
<text x="128" y="183" fill="#BFCEDF" font-family="Segoe UI,sans-serif" font-size="16" text-anchor="middle">${definition.id==="next"?"NEXT PHOTO":"SAVE + NEXT"}</text>
<text x="128" y="223" fill="${definition.color}" font-family="Segoe UI,sans-serif" font-size="14" text-anchor="middle">${xml(key.toUpperCase())}</text></svg>\n`);
}
const reference={format:"photogogo-controller-reference-v1",vendorImportProfile:false,model:"AJAZZ AKP03E",scope:"PhotoGoGo foreground; Photo Lightbox open",buttons:definitions.map((d,i)=>({row:Math.floor(i/3)+1,column:i%3+1,commandId:d.id,keys:shortcutFor(d.id),icon:`${d.file}.png`})),dials:[
  {number:1,left:"previous",right:"next",press:"crop-version"},{number:2,left:"zoom-out",right:"zoom-in",press:"fit"},{number:3,left:"panel-previous",right:"panel-next",press:"select-active"},
].map(d=>({...d,bindings:{left:shortcutFor(d.left),right:shortcutFor(d.right),press:shortcutFor(d.press)}})),commands:[...lightboxCommands,...lightboxCropCommands].map(({id,label,group,keys})=>({id,label,group,keys}))};
await writeFile(new URL("reference-keymap.json",root),JSON.stringify(reference,null,2)+"\n");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  for (const file of (await readdir(root)).filter(file => file.endsWith(".svg"))) {
    const svg = await readFile(new URL(file, root), "utf8");
    const png = await page.evaluate(async svg => {
      const image = new Image(); image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      await image.decode(); const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 256;
      canvas.getContext("2d").drawImage(image, 0, 0, 256, 256); return canvas.toDataURL("image/png").split(",")[1];
    }, svg);
    await writeFile(new URL(file.replace(/\.svg$/, ".png"), root), Buffer.from(png, "base64"));
  }
  console.log("Rendered six controller icons from repo-native SVG sources.");
} finally { await browser.close(); }
