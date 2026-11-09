// Optional illustration controls and a deliberately tiny host contract.
(() => {
  'use strict';
  const embedded = new URLSearchParams(location.search).get('embedded') === '1' && parent !== window;
  const send = (type, extra = {}) => {if(embedded)parent.postMessage({scope:'photogogo-guide',version:1,type,...extra},'*');};
  const viewer=document.querySelector('#figure-viewer'),picture=document.querySelector('#figure-image');
  const search=document.querySelector('#guide-search'),nav=document.querySelector('#toc-nav');
  let trigger=null,textSize=17;
  function closeImage(){viewer.close();trigger?.focus({preventScroll:true});}
  document.querySelectorAll('.figure-open').forEach(button=>button.addEventListener('click',()=>{
    trigger=button;const image=button.querySelector('img');picture.src=image.src;picture.alt=image.alt;
    const caption=button.closest('figure').querySelector('figcaption');
    document.querySelector('#figure-caption').textContent=caption.querySelector('strong').textContent+' — '+caption.querySelector('span').textContent;
    picture.classList.remove('actual-size');document.querySelector('#figure-fit').textContent='Actual size';viewer.showModal();document.querySelector('#figure-close').focus();
  }));
  document.querySelector('#figure-close').addEventListener('click',closeImage);
  viewer.addEventListener('cancel',e=>{e.preventDefault();closeImage();});
  document.querySelector('#figure-fit').addEventListener('click',e=>{picture.classList.toggle('actual-size');e.currentTarget.textContent=picture.classList.contains('actual-size')?'Fit image':'Actual size';});
  function size(delta){textSize=Math.max(14,Math.min(22,textSize+delta));document.documentElement.style.setProperty('--reading-size',textSize+'px');document.querySelector('#text-smaller').disabled=textSize===14;document.querySelector('#text-larger').disabled=textSize===22;}
  document.querySelector('#text-smaller').addEventListener('click',()=>size(-1));document.querySelector('#text-larger').addEventListener('click',()=>size(1));
  document.querySelectorAll('.task-card').forEach(a=>a.addEventListener('click',()=>requestAnimationFrame(()=>document.getElementById(a.hash.slice(1))?.querySelector('h2')?.focus({preventScroll:true}))));
  document.querySelectorAll('a[href^="https://"]').forEach(a=>a.addEventListener('click',e=>{if(embedded){e.preventDefault();send('external',{url:a.href});}}));
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      if(viewer.open){e.preventDefault();e.stopImmediatePropagation();closeImage();}
      else if(!search.value&&!(matchMedia('(max-width:900px)').matches&&!nav.hidden)&&embedded){e.preventDefault();e.stopImmediatePropagation();send('close');}
    }
    if(e.key==='Tab'&&embedded&&!viewer.open){
      const nodes=[...document.querySelectorAll('button:not(:disabled),input,a[href],summary,[tabindex="0"]')].filter(node=>node.getClientRects().length&&!node.closest('#figure-viewer'));
      if((e.shiftKey&&document.activeElement===nodes[0])||(!e.shiftKey&&document.activeElement===nodes.at(-1))){e.preventDefault();send('focus-return');}
    }
  },true);
  const initial=location.hash.slice(1);
  const intro=document.querySelector('.guide-intro');let introWasOpen=false;
  window.addEventListener('beforeprint',()=>{introWasOpen=intro.open;intro.open=true;});
  window.addEventListener('afterprint',()=>{intro.open=introWasOpen;});
  if(/^ch-\d{2}$/.test(initial))requestAnimationFrame(()=>{const section=document.getElementById(initial);section?.scrollIntoView({block:'start'});section?.querySelector('h2')?.focus({preventScroll:true});});
  send('ready');
})();
