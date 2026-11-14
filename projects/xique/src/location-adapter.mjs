// Construction does not request permission; start() is called by explicit UI action.
export class BrowserLocationAdapter{
  constructor({geolocation,onFix,onState=()=>{},intervalMs=5000,setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}){
    if(typeof onFix!=='function'||!Number.isFinite(intervalMs)||intervalMs<3000||intervalMs>5000)throw Error('Invalid location adapter configuration');
    Object.assign(this,{geolocation,onFix,onState,intervalMs,setIntervalFn,clearIntervalFn});this.running=false;this.latest=null;this.watchId=null;this.timer=null;this.generation=0;
  }
  start(){
    if(this.running)return false;
    if(!this.geolocation||typeof this.geolocation.watchPosition!=='function'||typeof this.geolocation.clearWatch!=='function'){this.onState('unsupported');return false;}
    this.running=true;this.latest=null;const generation=++this.generation;this.onState('locating');
    try{
      const id=this.geolocation.watchPosition(position=>{
        if(!this.running||this.generation!==generation)return;
        const c=position?.coords,timestamp=position?.timestamp;
        if(!c||!Number.isFinite(c.latitude)||Math.abs(c.latitude)>90||!Number.isFinite(c.longitude)||Math.abs(c.longitude)>180||!Number.isFinite(c.accuracy)||c.accuracy<0||!Number.isFinite(timestamp)){this.latest=null;this.onState('invalid_fix');return;}
        if(this.latest&&timestamp<=this.latest.timestamp)return;
        this.latest={latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy,timestamp,coordinateSystem:'WGS84',source:'browser'};this.onState('fix_available');
      },error=>{
        if(!this.running||this.generation!==generation)return;
        this.latest=null;const state=error?.code===1?'permission_denied':error?.code===3?'timeout':'position_unavailable';if(state==='permission_denied')this.stop();this.onState(state);
      },{enableHighAccuracy:true,maximumAge:0,timeout:10000});
      // Some test/runtime adapters can synchronously deny permission.
      if(!this.running||generation!==this.generation){this.geolocation.clearWatch(id);return false;}
      this.watchId=id;this.timer=this.setIntervalFn(()=>{if(this.running&&generation===this.generation&&this.latest)this.onFix({...this.latest});},this.intervalMs);return true;
    }catch{this.stop();this.onState('position_unavailable');return false;}
  }
  stop(){this.running=false;this.generation++;this.latest=null;if(this.watchId!==null){this.geolocation.clearWatch(this.watchId);this.watchId=null;}if(this.timer!==null){this.clearIntervalFn(this.timer);this.timer=null;}}
}

export function normalizeAmapIpHint(data,{queriedAt}={}){
  if(!data||String(data.status)!=='1'||String(data.infocode)!=='10000'||!Number.isFinite(queriedAt))throw Error('IP hint unavailable');
  const field=value=>typeof value==='string'?value.trim():'';
  const country=field(data.country),location=field(data.location),parts=location.split(',').map(Number);let regionCenter=null;
  if(parts.length===2&&parts.every(Number.isFinite)&&location.split(',').every(p=>p.trim())&&Math.abs(parts[0])<=180&&Math.abs(parts[1])<=90&&country){regionCenter={longitude:parts[0],latitude:parts[1],coordinateSystem:country==='中国'?'GCJ02':'WGS84'};}
  return {kind:'region-hint',source:'amap-ip',canTriggerPoi:false,queriedAt,country,province:field(data.province),city:field(data.city),district:field(data.district),adcode:field(data.adcode),regionCenter};
}
