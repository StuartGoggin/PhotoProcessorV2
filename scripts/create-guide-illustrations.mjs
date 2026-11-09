// Editable diagram sources for the manual. All artwork is original; no user photographs.
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const out=fileURLToPath(new URL('../docs/user-guide/source/',import.meta.url));
await mkdir(out,{recursive:true});
const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
const text=(x,y,lines,size=19,fill='#bfd0d9')=>lines.map((line,i)=>`<text x="${x}" y="${y+i*27}" fill="${fill}" font-size="${size}">${escape(line)}</text>`).join('');
const head=(title,subtitle,height=410)=>`<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="${height}" viewBox="0 0 1240 ${height}" role="img"><title>${escape(title)}</title><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#182d39"/><stop offset="1" stop-color="#0b1720"/></linearGradient><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="m0 0 7 4-7 4" fill="#cfad6d"/></marker></defs><rect width="1240" height="${height}" rx="24" fill="url(#bg)"/><g font-family="Segoe UI,Arial,sans-serif">${text(38,57,[title],30,'#f5f0e5')}${text(38,91,[subtitle],18)}<path d="M38 114H1202" stroke="#344b58"/>`;
const end='</g></svg>';
const card=(x,y,w,n,title,lines,color='#dfbd7f')=>`<rect x="${x}" y="${y}" width="${w}" height="151" rx="15" fill="#203744" stroke="#49606c"/><circle cx="${x+27}" cy="${y+30}" r="15" fill="${color}"/><text x="${x+27}" y="${y+36}" text-anchor="middle" font-size="16" font-weight="700" fill="#182a35">${n}</text>${text(x+22,y+72,[title],22,'#fff')}${text(x+22,y+104,lines,17)}`;
const arrow=(x1,y,x2)=>`<path d="M${x1} ${y}H${x2}" stroke="#cfad6d" stroke-width="2" marker-end="url(#arrow)"/>`;
const note=(value,y=366)=>`<rect x="38" y="${y-24}" width="1164" height="42" rx="9" fill="#152b36"/>${text(55,y+3,[value],18,'#e4ca99')}`;
const flow=(title,subtitle,items,footer)=>head(title,subtitle)+items.map((item,i)=>card(38+i*296,148,276,i+1,item[0],item.slice(1))+(i<3?arrow(316+i*296,223,330+i*296):'')).join('')+note(footer)+end;
const assets={
 'photo-workflow.svg':flow('From camera card to a collection worth keeping','A clear path, with your originals preserved along the way.',[
 ['Import','Copy from the card.','Verify the saved bytes.'],['Create versions','Enhanced and B&W each','start from the original.'],['Curate in Lightbox','Rate, crop and choose','exact versions to share.'],['Share and archive','Upload your selections.','Verify the archive copy.']
 ],'Stage keeps your working library and decisions. A selective archive contains only the files you choose.'),
 'raw-paths.svg':flow('JPEG first. RAW when you want more.','A RAW alternative is a deliberate creative choice for one photograph or a batch.',[
 ['Camera JPEG','The normal view for a','verified RAW + JPEG pair.'],['Develop RAW','Preview a separate finish.','Your RAW stays untouched.'],['Choose the view','Inspect Camera JPEG or','your developed alternative.'],['Select exact files','Choose the versions for','Google Photos and archive.']
 ],'Viewing a RAW alternative does not silently change ratings, crops or existing Google Photos selections.'),
 'video-workflow.svg':flow('Prepare the picture. Then finish the story.','Keep expensive picture preparation separate from titles, scorecards and music.',[
 ['Build the sequence','Choose clips and order.','Set picture filters.'],['Prepare and review','Stabilise the clips.','Approve the picture.'],['Titles and graphics','Name YouTube chapters.','Add visible cards if wanted.'],['Finish and export','Set camera sound/music.','Create the updated final.']
 ],'Graphics and music edits can reuse valid prepared clips. Picture or source changes can require preparation again.'),
 'archive-proof.svg':flow('Copying is only the beginning.','Archive confidence comes from checking the destination and recording what was verified.',[
 ['Review the plan','Choose originals, generated','versions and exclusions.'],['Copy safely','Bounded adaptive workers.','Protect existing files.'],['Read destination','Calculate its checksum.','Compare with the source.'],['Record the result','Keep the MD5 register','and per-run manifest.']
 ],'A transfer is verified after independently reading destination bytes. Review errors before treating it as a backup.'),
 'snapshot-time.svg':flow('A photograph is a moment in the original video.','Preview quickly; export the selected source frame at its full available resolution.',[
 ['Open the original','Confirm shooting time','and the UTC offset.'],['Find the moment','Scrub or step by frame.','Choose the exact frame.'],['Add to Photo Tray','Set the name and optional','photo enhancements.'],['Export photographs','Source-frame resolution.','Review the output receipt.']
 ],'Photo timestamp = confirmed video shooting start + frame time. Right-clicking a preview saves a small preview.'),
};
assets['version-family.svg']=head('One original. Independent creative versions.','The original stays intact. Choose and share each physical version deliberately.',460)
 +card(445,140,350,'1','Camera JPEG original',['Unchanged master photograph.'],'#91d4c6')
 +'<path d="M620 291V314M214 314H1026M214 314V333M620 314V333M1026 314V333" fill="none" stroke="#cfad6d" stroke-width="2"/>'
 +[[54,'B&W','Reads the original.'],[460,'Enhanced','Reads the original.'],[866,'_crop family','New JPEG + its own versions.']].map(([x,title,desc])=>`<rect x="${x}" y="334" width="320" height="84" rx="13" fill="#203744" stroke="#49606c"/>${text(x+22,368,[title],23,'#fff')}${text(x+22,398,[desc],17)}`).join('')+end;
for(const [name,svg] of Object.entries(assets))await writeFile(out+name,svg);
console.log('Created '+Object.keys(assets).length+' original guide illustrations.');
