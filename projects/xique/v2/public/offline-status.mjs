export function observeOfflineRegistration(registration,onStatus){
 const seen=new WeakSet();
 function watch(worker){if(!worker||seen.has(worker))return;seen.add(worker);const update=()=>{if(worker.state==='redundant')onStatus('failed');else if(worker.state==='activated')onStatus('ready');else if(worker.state==='installed')onStatus(registration.active?'update_ready':'ready');};worker.addEventListener('statechange',update);update();}
 if(registration.active)onStatus('ready');else onStatus('preparing');
 watch(registration.installing);watch(registration.waiting);
 registration.addEventListener('updatefound',()=>watch(registration.installing));
}
