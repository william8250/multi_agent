import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';
const o='http://127.0.0.1:8771',checks=[];
for(const [path,status,method]of [['/',200,'GET'],['/board.css',200,'GET'],['/board.js',200,'GET'],['/prd.html',200,'GET'],['/outline.html',200,'GET'],['/references.html',200,'GET'],['/server.mjs',404,'GET'],['/config/credentials.local.json',404,'GET'],['/unknown',404,'GET'],['/',405,'POST']]){
 const r=await fetch(o+path,{method});assert.equal(r.status,status,path);assert.equal(r.headers.get('permissions-policy'),'geolocation=(), microphone=(), camera=()');assert.match(r.headers.get('content-security-policy'),/connect-src 'none'/);const body=await r.text();if(path==='/prd.html')assert.match(body,/产品评审后的补充草案 v0.4/);checks.push({path,status:r.status,method});
}
writeFileSync(new URL('http-verification.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),scope:'local-static-design-board-smoke-not-product-tests',checks},null,2)+'\n');console.log('10 static HTTP boundary checks passed.');
