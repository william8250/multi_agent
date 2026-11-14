// Fixed, versioned capabilities, not live login/model verification. Never load
// arbitrary executables or adapter code from user configuration.
const registry=Object.freeze({
 Codex:Object.freeze({id:'codex-cli-v1',platform:'Codex',mode:'managed',automaticExecution:true,automaticReview:true,transport:'official-cli',requiresAuthentication:true,cancelScope:'managed-process',modelIdentity:'unverified',limit:'只读任务与冻结包文本评审；正式应用和验收另走门禁'}),
 WorkBuddy:Object.freeze({id:'workbuddy-relay-v1',platform:'WorkBuddy',mode:'application-relay',automaticExecution:false,automaticReview:false,transport:'application-relay',requiresAuthentication:true,cancelScope:'tracking-only',modelIdentity:'unverified',limit:'CLI认证、实际模型与成果协议尚待核验；不可按帮助命令成功开启自动执行'}),
 '豆包':Object.freeze({id:'doubao-relay-v1',platform:'豆包',mode:'application-relay',automaticExecution:false,automaticReview:false,transport:'application-relay',requiresAuthentication:true,cancelScope:'tracking-only',modelIdentity:'unverified',limit:'宿主插件与模型API是独立接入方式；本期保留应用接力'})
});
export function platformAdapter(platform){if(typeof platform!=='string'||!Object.hasOwn(registry,platform))throw Error('Unsupported scheduled platform');return registry[platform];}
export function platformCapabilities(){return {schemaVersion:'1.0',scope:'configured-capabilities-not-live-health',platforms:Object.values(registry).map(x=>({...x})),excludedPlatforms:['Claude Code'],extensionStatus:'fixed-reviewed-registry; new adapters require implementation and verification'};}
export function codexReviewArgs(model){if(typeof model!=='string'||!/^gpt-[a-z0-9][a-z0-9.-]{0,99}$/.test(model))throw Error('Execution model unmapped');return ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--disable','shell_tool','--disable','view_image','-c','web_search="disabled"','--model',model,'--json','-'];}
export const workbuddyBundledEntry='/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
export function workbuddyTextProbeArgs(){return [workbuddyBundledEntry,'-p','这是只读连通性探测。不要使用工具，不读取或修改文件，只回复 WB_HEADLESS_CONNECTIVITY_OK。','--output-format','json','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--max-turns','1'];}
export function verifyWorkbuddyTextProbe(result){let parsed;try{parsed=JSON.parse(result.stdout)}catch{for(const line of result.stdout.split('\n')){try{const item=JSON.parse(line);if(item.type==='result')parsed=item}catch{}}}const answer=typeof parsed?.result==='string'?parsed.result:typeof parsed?.content==='string'?parsed.content:null;return !result.failure&&result.code===0&&parsed?.type==='result'&&parsed?.subtype==='success'&&parsed?.is_error===false&&answer?.trim()==='WB_HEADLESS_CONNECTIVITY_OK';}
// Lifecycle facade: scheduler does not choose executables or permission flags.
// A future platform must implement this facade and pass capability tests before
// its automaticExecution flag can be enabled.
export function executionAdapter(platform,{executions}){
 const capabilities=platformAdapter(platform);
 const requireAutomatic=()=>{if(!capabilities.automaticExecution)throw Error('Platform requires application handoff');};
 return {capabilities,
  find:packageId=>capabilities.automaticExecution?executions.list().find(j=>j.packageId===packageId):null,
  start:(taskId,options)=>{requireAutomatic();return executions.start(taskId,options);},
  get:id=>{requireAutomatic();return executions.get(id);},
  cancel:id=>{requireAutomatic();return executions.cancel(id);},
  collect:id=>{requireAutomatic();return executions.collect(id);}
 };
}
