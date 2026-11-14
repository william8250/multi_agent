export const stops=[
 {id:'bridge',name:'湖畔起点',subtitle:'看见水面与城市',latitude:0,longitude:0,tag:'观察',minutes:10,story:'找一个不妨碍通行的位置，先看看水面的光，再看看远处的城市轮廓。你可以选择慢慢观察，或直接前往下一站。',photo:'尽量站在步道内侧，先观察光线，避开人流；不要为拍照跨越护栏。'},
 {id:'lane',name:'树荫小径',subtitle:'换一种步行节奏',latitude:0.001,longitude:0.001,tag:'漫步',minutes:15,story:'这一站尝试放慢脚步，听听周围的声音。想安静时，可以关闭朗读，继续看文字。此处为演示内容，不是实际景点史实。',photo:'以树影和步道为背景即可，不采摘、不进入封闭区域。'},
 {id:'rest',name:'休息打卡点',subtitle:'留一段自己的记录',latitude:0.002,longitude:0.0015,tag:'记录',minutes:10,story:'到这里可以先休息一下，再写下刚才最喜欢的一个细节。记录保存在你的浏览器，不会上传或公开。',photo:'拍下一个喜欢的细节，比拥挤地抢占同一机位更轻松。'}
];
export const route={name:'杭州 · 湖畔慢行体验线',version:'xique-v2-synthetic-1',coordinateSystem:'WGS84',pois:stops};
export function readNotes(storage){
 let data;try{data=JSON.parse(storage.getItem('xique.v2.notes')||'[]');}catch{throw Error('本地记录暂时无法读取，请保留浏览器数据，勿继续覆盖保存');}
 if(!Array.isArray(data)||data.length>100||data.some(x=>!x||typeof x.id!=='string'||typeof x.stopId!=='string'||typeof x.text!=='string'||x.text.length>2000||!Number.isFinite(Date.parse(x.createdAt))))throw Error('本地记录格式异常，原数据已保留，请先备份后处理');
 return data;
}
export function noteId(provider=globalThis.crypto){
 if(typeof provider?.randomUUID==='function')return provider.randomUUID();
 if(typeof provider?.getRandomValues==='function')return [...provider.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');
 throw Error('当前浏览器不支持安全保存，请使用受支持浏览器或HTTPS访问');
}
export function writeNote(storage,notes,{stopId,text},now=Date.now()){
 if(!stops.some(p=>p.id===stopId)||typeof text!=='string'||!text.trim()||text.length>2000)throw Error('请选择站点并填写 1–2000 字记录');
 if(notes.length>=100)throw Error('已达到100条记录，请先导出备份并自行整理后再保存');
 const next=[{id:noteId(),stopId,text:text.trim(),createdAt:new Date(now).toISOString()},...notes];storage.setItem('xique.v2.notes',JSON.stringify(next));return next;
}

export function exportNotes(storage,notes,{damaged=false,now=Date.now()}={}){
 if(damaged){const raw=storage.getItem('xique.v2.notes');if(typeof raw!=='string')throw Error('未能读取原始记录，请保留浏览器数据后重试');return {content:raw,type:'text/plain;charset=utf-8',name:'喜鹊-原始记录备份.txt'};}
 return {content:JSON.stringify({product:'喜鹊V2',exportedAt:new Date(now).toISOString(),notes},null,2),type:'application/json',name:'喜鹊-我的记录.json'};
}
