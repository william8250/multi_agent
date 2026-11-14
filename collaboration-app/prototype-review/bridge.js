(()=>{
 const origin='http://127.0.0.1:8766';let selectionBox=null,selecting=false,clearSelection=()=>{};
 function resetSelection(){clearSelection();selectionBox?.remove();selectionBox=null;getSelection()?.removeAllRanges();}
 document.addEventListener('keydown',e=>{if(e.key==='Escape')resetSelection();});
 function send(a){parent.postMessage({type:'prototype-anchor',anchor:{...a,page:location.pathname+location.hash}},origin)}
 function capture(){if(selecting)return;const s=getSelection();if(!s||s.isCollapsed||!s.toString().trim())return;const n=s.anchorNode.parentElement;if(n.closest('textarea,input'))return;selectionBox?.remove();send({quote:s.toString().slice(0,400),elementId:n.closest('[id]')?.id||'',kind:'text'});}
 document.addEventListener('mouseup',capture);document.addEventListener('selectionchange',capture);
 addEventListener('message',e=>{
  if(e.origin!==origin||e.source!==parent)return;
  if(e.data?.type==='clear-region'){resetSelection();return;}
  if(e.data?.type!=='pick-region')return;
  clearSelection();selectionBox?.remove();selecting=true;getSelection()?.removeAllRanges();
  const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:999998;background:rgba(15,23,20,.38);cursor:crosshair;touch-action:none;user-select:none';
  const box=document.createElement('div');box.style.cssText='position:fixed;display:none;z-index:999999;border:2px solid #7764dc;box-sizing:border-box;pointer-events:none;background:transparent;box-shadow:0 0 0 100vmax rgba(15,23,20,.38)';
  const label=document.createElement('span');label.style.cssText='position:absolute;left:0;top:6px;background:#fff;color:#26342e;border:1px solid #d5d9d6;border-radius:5px;padding:4px 8px;font:12px sans-serif;white-space:nowrap';box.append(label);
  document.body.append(overlay,box);selectionBox=box;let start=null,pointer=null;
  const bounds=e=>{const x=Math.min(start[0],Math.max(0,Math.min(innerWidth,e.clientX))),y=Math.min(start[1],Math.max(0,Math.min(innerHeight,e.clientY)));return {x,y,w:Math.abs(Math.max(0,Math.min(innerWidth,e.clientX))-start[0]),h:Math.abs(Math.max(0,Math.min(innerHeight,e.clientY))-start[1])}};
  const draw=r=>{box.style.display='block';Object.assign(box.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'});label.textContent=Math.round(r.w)+' × '+Math.round(r.h);};
  const cleanup=()=>{overlay.remove();document.removeEventListener('keydown',cancel);selecting=false;};
  const cancel=e=>{if(e.key==='Escape'){cleanup();box.remove();}};
  clearSelection=()=>{cleanup();box.remove();};document.addEventListener('keydown',cancel);
  overlay.onpointerdown=e=>{if(start||e.button!==0)return;e.preventDefault();start=[e.clientX,e.clientY];pointer=e.pointerId;overlay.setPointerCapture(pointer);overlay.style.background='transparent';draw({x:start[0],y:start[1],w:0,h:0});};
  overlay.onpointermove=e=>{if(start&&e.pointerId===pointer)draw(bounds(e));};
  overlay.onpointercancel=()=>{cleanup();box.remove();};
  overlay.onpointerup=e=>{if(!start||e.pointerId!==pointer)return;const r=bounds(e);cleanup();if(r.w<10||r.h<10){box.remove();return;}draw(r);box.style.position='absolute';box.style.top=(r.y+scrollY)+'px';box.style.left=(r.x+scrollX)+'px';box.style.boxShadow='0 0 0 100vmax rgba(15,23,20,.18)';label.textContent+=' · 已选区域';const n=document.elementFromPoint(r.x+r.w/2,r.y+r.h/2);send({kind:'region',elementId:n?.closest('[id]')?.id||'',quote:(n?.innerText||'区域').slice(0,400),rect:{x:r.x/innerWidth,y:(r.y+scrollY)/document.documentElement.scrollHeight,width:r.w/innerWidth,height:r.h/document.documentElement.scrollHeight}});};
 });
})();
