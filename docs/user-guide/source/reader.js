(()=>{"use strict";
document.documentElement.classList.add("js");
const chapters=[...document.querySelectorAll(".chapter")],nav=document.querySelector(".toc-nav"),toggle=document.querySelector("#toc-toggle"),input=document.querySelector("#guide-search"),results=document.querySelector("#search-results"),status=document.querySelector("#search-status"),list=document.querySelector("#result-list"),clear=document.querySelector("#clear-search"),mobile=matchMedia("(max-width:900px)");
let lastQuery="";
const stop=new Set(["how","to","the","a","an","do","i","is","for","and","my","can"]);
function mobileMenu(open){nav.hidden=mobile.matches?!open:false;toggle.setAttribute("aria-expanded",String(!nav.hidden))}
mobileMenu(false);mobile.addEventListener("change",()=>mobileMenu(false));
toggle.addEventListener("click",()=>mobileMenu(nav.hidden));
document.querySelector(".mobile-contents").addEventListener("click",()=>{mobileMenu(true);requestAnimationFrame(()=>toggle.focus({preventScroll:true}))});
function cleanMarks(){document.querySelectorAll("mark[data-search]").forEach(m=>{const p=m.parentNode;m.replaceWith(...m.childNodes);p.normalize()})}
function words(q){return q.toLocaleLowerCase().trim().split(/\s+/).filter(x=>x&&!stop.has(x))}
const index=chapters.map(s=>({section:s,id:s.id,title:s.querySelector("h2").textContent,text:s.textContent.replace(/\s+/g," ").trim(),keywords:s.dataset.keywords}));
function focusChapter(id,term){const section=document.getElementById(id);if(!section)return;mobileMenu(false);cleanMarks();section.querySelector("h2")?.focus({preventScroll:true});if(term){const walker=document.createTreeWalker(section,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest("mark,script,style")?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});let n;while(n=walker.nextNode()){const at=n.data.toLocaleLowerCase().indexOf(term);if(at<0)continue;const range=document.createRange();range.setStart(n,at);range.setEnd(n,at+term.length);const mark=document.createElement("mark");mark.dataset.search="true";range.surroundContents(mark);break}}}
function search(){const q=input.value.trim();lastQuery=q;clear.hidden=!q;list.replaceChildren();cleanMarks();if(!q){results.hidden=true;status.textContent="";return}
const terms=words(q);const effective=terms.length?terms:[q.toLocaleLowerCase()];const found=index.filter(x=>effective.every(t=>(x.title+" "+x.text+" "+x.keywords).toLocaleLowerCase().includes(t)));
results.hidden=false;status.textContent=found.length?(found.length+" matching chapter"+(found.length===1?"":"s")):"No matching chapters. Try a shorter term.";
found.slice(0,8).forEach(x=>{const a=document.createElement("a");a.href="#"+x.id;const title=document.createElement("span");title.className="result-title";title.textContent=x.title;const snippet=document.createElement("span");snippet.className="result-snippet";const at=x.text.toLocaleLowerCase().indexOf(effective[0]);const from=Math.max(0,at-45);snippet.textContent=(from?"…":"")+x.text.slice(from,from+145)+(x.text.length>from+145?"…":"");a.append(title,snippet);a.addEventListener("click",()=>requestAnimationFrame(()=>focusChapter(x.id,effective[0])));list.append(a)})}
input.addEventListener("input",search);clear.addEventListener("click",()=>{input.value="";search();input.focus()});
// Sandboxed readers cannot submit forms. Handle Enter without requesting form submission.
input.addEventListener("keydown",e=>{if(e.key!=="Enter")return;e.preventDefault();const first=list.querySelector("a");if(first){location.hash=first.hash;focusChapter(first.hash.slice(1),words(lastQuery)[0])}});
document.querySelector("#search-form").addEventListener("submit",e=>{e.preventDefault();const first=list.querySelector("a");if(first){location.hash=first.hash;focusChapter(first.hash.slice(1),words(lastQuery)[0])}});
document.addEventListener("keydown",e=>{const typing=e.target.closest("input,textarea,select,[contenteditable]");if(e.key==="/"&&!typing&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();input.focus()}if(e.key==="Escape"){if(input.value){input.value="";search();input.focus()}else if(mobile.matches&&!nav.hidden){mobileMenu(false);toggle.focus()}}});
document.querySelector("#print-guide").addEventListener("click",()=>{cleanMarks();window.print()});
document.querySelectorAll(".toc-link,.quick-jumps a").forEach(a=>a.addEventListener("click",()=>requestAnimationFrame(()=>focusChapter(a.hash.slice(1)))));
function active(id){document.querySelectorAll(".toc-link").forEach(a=>{if(a.hash==="#"+id)a.setAttribute("aria-current","location");else a.removeAttribute("aria-current")})}
active(location.hash.slice(1)||chapters[0].id);
if("IntersectionObserver" in window){const observer=new IntersectionObserver(entries=>{entries.filter(e=>e.isIntersecting).forEach(e=>active(e.target.id))},{rootMargin:"-10% 0px -75% 0px",threshold:0});chapters.forEach(s=>observer.observe(s))}
window.addEventListener("hashchange",()=>{const id=location.hash.slice(1);if(document.getElementById(id)?.classList.contains("chapter"))active(id)});
})();
