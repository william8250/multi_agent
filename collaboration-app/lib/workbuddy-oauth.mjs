import {randomBytes, timingSafeEqual} from 'node:crypto';
const scopes=['user.task.readable','user.task.invokable'];
const fail=message=>Object.assign(new Error(message),{status:400});
// Tokens remain server-side in memory. Restart requires authorization again.
export class WorkBuddyOAuth {
  #pending=new Map(); #tokens=null;
  constructor({env=process.env,fetchImpl=fetch,now=Date.now}={}){this.env=env;this.fetch=fetchImpl;this.now=now;}
  config(){
    const clientId=this.env.WORKBUDDY_CLIENT_ID||'',secret=this.env.WORKBUDDY_CLIENT_SECRET||'',redirectUri=this.env.WORKBUDDY_REDIRECT_URI||'';
    let validRedirect=false;
    try{const u=new URL(redirectUri);validRedirect=!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/api/platforms/workbuddy/callback'&&u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!!u.port;}catch{}
    return {clientId,secret,redirectUri,ready:!!clientId&&!!secret&&validRedirect};
  }
  status(){const c=this.config();return {configured:c.ready,authorized:!!this.#tokens&&this.#tokens.expiresAt>this.now(),automaticExecution:false,tokenStorage:'server-memory-until-restart',missing:[...(!c.clientId?['clientId']:[]),...(!c.secret?['clientSecret']:[]),...(!c.ready&&c.clientId&&c.secret?['validRegisteredLoopbackRedirect']:[])],requiredScopes:scopes,modelSelectionVerified:false};}
  begin(origin){const c=this.config();if(!c.ready||new URL(c.redirectUri).origin!==origin)throw fail('WorkBuddy OAuth configuration unavailable');
    for(const [key,expires] of this.#pending)if(expires<=this.now())this.#pending.delete(key);
    if(this.#pending.size>=5)throw fail('WorkBuddy authorization already pending');
    const state=randomBytes(32).toString('hex');this.#pending.set(state,this.now()+600000);
    const u=new URL('https://www.workbuddy.cn/openapi/v2/authorize');for(const [k,v] of Object.entries({response_type:'code',client_id:c.clientId,redirect_uri:c.redirectUri,scope:scopes.join(' '),state}))u.searchParams.set(k,v);
    return {authorizationUrl:u.href,expiresIn:600};
  }
  async callback(params){
    const state=params.get('state')||'',code=params.get('code')||'';
    if(params.getAll('state').length!==1||params.getAll('code').length!==1||!/^\w{64}$/.test(state)||!code||code.length>4096)throw fail('WorkBuddy authorization callback invalid');
    const match=[...this.#pending.keys()].find(k=>timingSafeEqual(Buffer.from(k),Buffer.from(state)));
    const expires=match&&this.#pending.get(match);if(match)this.#pending.delete(match);
    if(!expires||expires<=this.now())throw fail('WorkBuddy authorization expired or already used');
    const c=this.config();if(!c.ready)throw fail('WorkBuddy OAuth configuration unavailable');
    let data;
    try{const r=await this.fetch('https://www.workbuddy.cn/openapi/v2/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,client_id:c.clientId,client_secret:c.secret,redirect_uri:c.redirectUri})});if(!r.ok)throw Error();const raw=await r.text();if(raw.length>65536)throw Error();data=JSON.parse(raw);}catch{throw fail('WorkBuddy token exchange failed; authorize again');}
    if(data.token_type!=='Bearer'||typeof data.access_token!=='string'||!data.access_token||!Number.isFinite(data.expires_in)||data.expires_in<=0||!scopes.every(s=>String(data.scope||'').split(' ').includes(s)))throw fail('WorkBuddy token response or scopes invalid');
    this.#tokens={accessToken:data.access_token,expiresAt:this.now()+data.expires_in*1000};
    return this.status();
  }
  async inspectTask(taskId){
    if(typeof taskId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId))throw fail('WorkBuddy task id invalid');
    if(!this.status().authorized)throw fail('WorkBuddy authorization required');
    let data;
    try{const r=await this.fetch('https://www.workbuddy.cn/openapi/v2/tasks/'+encodeURIComponent(taskId),{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+this.#tokens.accessToken,Accept:'application/json'}});if(!r.ok)throw Error();const raw=await r.text();if(raw.length>65536)throw Error();data=JSON.parse(raw);}catch{throw fail('WorkBuddy task query failed');}
    const states=['CREATING','idle','planning','working','pending','completed','failed','archived','deleted'];
    if(data.task_id!==taskId||!states.includes(data.status))throw fail('WorkBuddy task response invalid');
    // Never return sandbox tickets, arbitrary links or unverified result text.
    return {platform:'WorkBuddy',taskId,status:data.status,resultCollected:false,modelIdentityVerified:false,remoteCancellationSupported:false};
  }
  disconnect(){this.#tokens=null;this.#pending.clear();return this.status();}
}
