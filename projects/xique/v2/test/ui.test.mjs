import test from 'node:test';import assert from 'node:assert/strict';
class Element {
 constructor(){this.children=[];this.value='';this.disabled=false;this.hidden=false;this.attrs={};this.classList={add(){}};}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(k,v){this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}insertAdjacentElement(position,node){this.adjacent=node;}click(){this.onclick?.();}
}
test('actual application handlers preserve navigation state and stop location/audio on pause, end and hide',async()=>{
 const saved=new Map(),events={},nodes=new Map(),storage=new Map();let watchCalls=0,clears=0,cancels=0,timer;
 const set=(key,value)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});};
 const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
 const pages=['tour','route','notes','settings'].map(id=>Object.assign(get(id),{id})),links=pages.map(p=>Object.assign(new Element(),{hash:'#'+p.id}));
 get('interest').value='history';get('duration').value='30';get('note-stop').value='bridge';
 try{
  set('document',{hidden:false,getElementById:get,createElement:()=>new Element(),createElementNS:()=>new Element(),querySelectorAll:s=>s==='.page'?pages:links,addEventListener:(t,f)=>events[t]=f});
  set('window',{speechSynthesis:{cancel:()=>cancels++},addEventListener:(t,f)=>events[t]=f});
  set('navigator',{geolocation:{watchPosition(){watchCalls++;return 0;},clearWatch(id){assert.equal(id,0);clears++;}}});
  set('localStorage',{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)});set('Option',class{constructor(text,value){this.text=text;this.value=value;}});set('location',{hash:'#tour'});set('scrollTo',()=>{});set('isSecureContext',true);set('fetch',async()=>({ok:true,json:async()=>({})}));
  set('setTimeout',()=>{timer=1;return timer;});set('clearTimeout',()=>{});
  await import('../public/app.mjs?ui-regression=1');
  assert.equal(watchCalls,0);get('start').click();assert.equal(get('start').disabled,true);get('arrive').click();assert.match(get('session-status').textContent,/已触发 1/);
  get('locate').click();assert.equal(watchCalls,1);get('pause').click();assert.equal(clears,1);assert.ok(cancels>0);assert.equal(get('arrive').disabled,true);get('resume').click();assert.equal(get('arrive').disabled,false);
  location.hash='#notes';events.hashchange();assert.equal(get('notes').hidden,false);assert.equal(get('end').disabled,false);
  document.hidden=true;events.visibilitychange();assert.equal(get('resume').disabled,false);document.hidden=false;get('resume').click();get('end').click();assert.equal(get('arrive').disabled,true);get('locate').click();assert.equal(watchCalls,1);assert.match(get('toast').textContent,/已结束/);
  get('note-text').value='UI regression';get('note-form').onsubmit({preventDefault(){}});assert.match(get('note-result').textContent,/已保存/);assert.equal(JSON.parse(storage.get('xique.v2.notes'))[0].text,'UI regression');
 }finally{for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
