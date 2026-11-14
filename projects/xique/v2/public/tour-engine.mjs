// Provider-independent geofence logic. This does not acquire location or audio.
const coordinate=p=>p&&Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180;
export function distanceMeters(a,b){
  const rad=value=>value*Math.PI/180,dLat=rad(b.latitude-a.latitude),dLon=rad(b.longitude-a.longitude);
  const h=Math.sin(dLat/2)**2+Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLon/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}
export class TourEngine{
  constructor({mode='live',enterMeters=60,exitMeters=100,dwellMs=8000,cooldownMs=1200000,maxAccuracyMeters=50,maxAgeMs=15000,maxGapMs=10000}={}){
    if(!['live','demo'].includes(mode))throw Error('Invalid mode');
    for(const v of [enterMeters,exitMeters,dwellMs,cooldownMs,maxAccuracyMeters,maxAgeMs,maxGapMs])if(!Number.isFinite(v)||v<=0)throw Error('Invalid trigger configuration');
    if(exitMeters<=enterMeters)throw Error('Exit radius must exceed entry radius');
    Object.assign(this,{mode,enterMeters,exitMeters,dwellMs,cooldownMs,maxAccuracyMeters,maxAgeMs,maxGapMs});this.state='idle';this.route=null;this.usedRouteVersions=new Set();this.visits=new Map();this.lastFixAt=null;this.lastProcessedAt=null;
  }
  setRoute({version,coordinateSystem,pois}){
    if(typeof version!=='string'||!version.trim()||!['WGS84','GCJ02','BD09'].includes(coordinateSystem)||!Array.isArray(pois)||!pois.length)throw Error('Invalid route');
    const ids=new Set();for(const p of pois){if(typeof p.id!=='string'||!p.id.trim()||ids.has(p.id)||!coordinate(p))throw Error('Invalid route POI');ids.add(p.id);}
    // Version is an immutable identity. Changes must receive a new version.
    if(this.usedRouteVersions.has(version))throw Error('Route version already used');
    this.usedRouteVersions.add(version);this.route={version,coordinateSystem,pois:pois.map(p=>({id:p.id,latitude:p.latitude,longitude:p.longitude}))};this.resetDwell();this.lastFixAt=null;
  }
  start(){if(this.state!=='idle'||!this.route)throw Error('Cannot start tour');this.state='active';}
  pause(){if(this.state!=='active')throw Error('Cannot pause tour');this.state='paused';this.resetDwell();}
  resume(){if(this.state!=='paused')throw Error('Cannot resume tour');this.state='active';this.lastFixAt=null;}
  end(){this.state='ended';this.resetDwell();}
  resetDwell(){for(const v of this.visits.values()){v.enteredAt=null;v.inside=false;}}
  process(fix,now){
    const reject=reason=>({accepted:false,reason,events:[]});
    if(this.state!=='active')return reject('tour_not_active');
    if(!Number.isFinite(now)||(this.lastProcessedAt!==null&&now<this.lastProcessedAt))return reject('clock_moved_backwards');
    this.lastProcessedAt=now;
    if(!coordinate(fix)||!Number.isFinite(fix.timestamp)||!Number.isFinite(fix.accuracy)||fix.accuracy<0){this.resetDwell();return reject('invalid_fix');}
    if(fix.coordinateSystem!==this.route.coordinateSystem){this.resetDwell();return reject('coordinate_conversion_required');}
    if((this.mode==='live'&&!['gps','browser'].includes(fix.source))||(this.mode==='demo'&&fix.source!=='demo')){this.resetDwell();return reject('incompatible_location_source');}
    if(fix.timestamp>now||now-fix.timestamp>this.maxAgeMs){this.resetDwell();return reject('stale_or_future_fix');}
    if(fix.accuracy>this.maxAccuracyMeters){this.resetDwell();return reject('low_accuracy');}
    if(this.lastFixAt!==null&&fix.timestamp<=this.lastFixAt)return reject('no_new_fix');
    if(this.lastFixAt!==null&&fix.timestamp-this.lastFixAt>this.maxGapMs)this.resetDwell();this.lastFixAt=fix.timestamp;
    const events=[];
    for(const p of this.route.pois){
      const visit=this.visits.get(p.id)??{enteredAt:null,inside:false,lastTriggeredAt:null};this.visits.set(p.id,visit);const distance=distanceMeters(fix,p);
      if(distance>this.exitMeters){visit.inside=false;visit.enteredAt=null;visit.spokenDuringVisit=false;continue;}
      if(distance<=this.enterMeters){if(visit.enteredAt===null)visit.enteredAt=fix.timestamp;visit.inside=true;}
      else if(!visit.inside){visit.enteredAt=null;continue;}
      if(visit.enteredAt!==null&&fix.timestamp-visit.enteredAt>=this.dwellMs&&(visit.lastTriggeredAt===null||fix.timestamp-visit.lastTriggeredAt>=this.cooldownMs)){
        // Staying at one POI does not replay merely because cooldown expires.
        if(visit.spokenDuringVisit)continue;
        visit.lastTriggeredAt=fix.timestamp;visit.spokenDuringVisit=true;events.push({type:'poi_entered',poiId:p.id,routeVersion:this.route.version,mode:this.mode,occurredAt:fix.timestamp});
      }
    }
    return {accepted:true,reason:null,events};
  }
}
