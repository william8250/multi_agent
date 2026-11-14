// Validate a vendor artifact envelope before it can be considered for result import.
// This parser does not fetch links, execute content or create an accepted receipt.
export function parseWorkBuddyArtifacts(raw,expectedSessionId){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>512*1024)throw Error('WorkBuddy artifact response too large');
 if(typeof expectedSessionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(expectedSessionId))throw Error('WorkBuddy session id invalid');
 let payload;try{payload=JSON.parse(raw);}catch{throw Error('WorkBuddy artifact JSON invalid');}
 const d=payload?.data;
 if(payload?.code!==0||d?.sessionId!==expectedSessionId||!Array.isArray(d.artifacts)||d.artifacts.length>100)throw Error('WorkBuddy artifact session or envelope invalid');
 const seen=new Set(),artifacts=[];
 for(const entry of d.artifacts){
  const a=entry?.artifact;
  if(entry?.sessionId!==expectedSessionId||!a||!['created','updated','deleted'].includes(entry.event)||!['plan','tasks','media','overview'].includes(a.type)||typeof a.uri!=='string'||a.uri.length>2048||seen.has(a.uri))throw Error('WorkBuddy artifact entry invalid');
  seen.add(a.uri);
  // Preserve text as inert data, never render vendor HTML or follow file/media URLs.
  if(a.text!==undefined&&(typeof a.text!=='string'||Buffer.byteLength(a.text)>256*1024))throw Error('WorkBuddy artifact text invalid');
  artifacts.push({type:a.type,uri:a.uri,event:entry.event,...(entry.event!=='deleted'&&typeof a.text==='string'?{text:a.text}:{})});
 }
 if(typeof d.pagination?.hasMore!=='boolean')throw Error('WorkBuddy artifact pagination invalid');
 return {sessionId:expectedSessionId,artifacts,complete:!d.pagination.hasMore,identityVerified:false,applied:false};
}
