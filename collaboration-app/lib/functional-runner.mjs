import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';

// Fixed local profile: no package scripts, dependency install, network or writes.
export function runFunctionalTests(directory,files,{shouldStop=()=>false,onSpawn=()=>{},timeout=15000,maxOutput=65536,profile='offline-v1'}={}) {
  if(!['offline-v1','loopback-http-v1'].includes(profile))return Promise.resolve({ok:false,reason:'unsupported_test_profile',output:''});
  try{if(shouldStop())return Promise.resolve({ok:false,reason:'basis_or_control_changed',output:''});}catch{return Promise.resolve({ok:false,reason:'basis_or_control_changed',output:''});}
  if(process.platform!=='darwin')return Promise.resolve({ok:false,reason:'restricted_runner_unavailable',output:''});
  const root=realpathSync(directory),node=realpathSync(process.execPath);
  if(!files.length||files.some(path=>!/^([\w.-]+\/)*[\w.-]+\.(mjs|cjs|js)$/.test(path)||path.split('/').some(p=>p.startsWith('.'))))return Promise.resolve({ok:false,reason:'unsupported_test_paths',output:''});
  // Node permissions restrict ordinary JS reads to root. They are not a hostile
  // code security boundary; this prototype is for inspected code only and is
  // requires a recorded inspection declaration before product dispatch.
  const sandboxProfile='(version 1)(allow default)(deny network*)(deny file-write*)(deny process-fork)'+(profile==='loopback-http-v1'?'(allow network-bind (local ip \"localhost:*\"))(allow network-inbound (local ip \"localhost:*\"))(allow network-outbound (remote ip \"localhost:*\"))':'');
  return new Promise(resolveRun=>{
    let bytes=0,captured=0,reason=null,closed=false;const chunks=[];
    const child=spawn('/usr/bin/sandbox-exec',['-p',sandboxProfile,node,'--permission',...(profile==='loopback-http-v1'?['--allow-net']:[]),'--allow-fs-read='+root,'--no-addons','--max-old-space-size=256','--test','--test-isolation=none','--test-reporter=tap',...files.map(path=>'./'+path)],{cwd:root,env:{},stdio:['ignore','pipe','pipe'],shell:false});
    const stop=why=>{if(!closed){reason??=why;child.kill('SIGKILL');}};
    const collect=chunk=>{bytes+=chunk.length;const part=chunk.subarray(0,Math.max(0,maxOutput-captured));if(part.length){chunks.push(part);captured+=part.length;}if(bytes>maxOutput)stop('output_limit');};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const timer=setTimeout(()=>stop('timeout'),timeout);
    const monitor=setInterval(()=>{try{if(shouldStop())stop('basis_or_control_changed');}catch{stop('basis_or_control_changed');}},100);
    child.once('spawn',()=>{Promise.resolve().then(()=>onSpawn(child.pid)).catch(()=>stop('process_checkpoint_failed'));});
    child.once('error',()=>{reason??='runner_start_failed';});
    child.once('close',(code,signal)=>{closed=true;clearTimeout(timer);clearInterval(monitor);const output=Buffer.concat(chunks,captured).toString('utf8'),match=output.match(/^# tests (\d+)$/m),count=match?Number(match[1]):0;resolveRun({ok:!reason&&code===0&&count>0,exitCode:code,signal,reason:reason??(code!==0?'test_or_runner_failed':count===0?'no_tests_reported':null),reportedTests:count,capturedBytes:captured,output});});
  });
}
