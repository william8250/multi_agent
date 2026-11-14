import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArtifactReceipt,artifactZip,diffArtifacts,artifactReviewAppendix,validateArtifactPath } from '../lib/artifacts.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const receipt=(files,id='r')=>{const raw=JSON.stringify({format:'collab-artifacts/v1',files});return {id,taskId:'t',raw,contentHash:hash(raw),inputHash:'input',actualPlatform:'Synthetic',actualModel:'Test only',sourceEvidence:'Test fixture'};};
const bundle=(files,id)=>parseArtifactReceipt(receipt(files,id));
test('artifact views retain immutable source and stable hashes; ordinary text remains text',()=>{
  const r=receipt([{path:'src/a.js',content:'export const a=1;\n'}]),a=parseArtifactReceipt(r),b=parseArtifactReceipt(r);
  assert.equal(a.bundleHash,b.bundleHash);assert.equal(a.sourceContentHash,r.contentHash);assert.equal(a.files[0].contentHash,hash(a.files[0].content));
  assert.equal(parseArtifactReceipt({...r,raw:'Plain proposal',contentHash:hash('Plain proposal')}).available,false);
  assert.throws(()=>parseArtifactReceipt({...r,raw:r.raw+' '}),/source corrupt/);
});
test('unsafe and ambiguous archive paths are rejected rather than sanitized',()=>{
  for(const path of ['/tmp/a','../a','a/../b','a\\b','C:/a','a//b','.git/hooks/run','x\0y','CON.txt','a.','a ','NUL/x','.collab-manifest.json','.collab-manifest.json/x','a/\uff0e\uff0e/b'])assert.throws(()=>validateArtifactPath(path),/path invalid/,path);
  assert.throws(()=>bundle([{path:'A.js',content:''},{path:'a.js',content:''}]),/duplicated/);
  assert.throws(()=>bundle([{path:'src',content:''},{path:'src/a.js',content:''}]),/duplicated/);
  assert.equal(validateArtifactPath('src/中文 示例.js'),'src/中文 示例.js');
});
test('file counts, text-only content and sizes are bounded',()=>{
  for(const files of [[],[{path:'a',content:1}],[{path:'a',content:'\0'}],Array.from({length:31},(_,i)=>({path:`x${i}`,content:''}))])assert.throws(()=>bundle(files),/files invalid/);
  assert.throws(()=>bundle([{path:'a',content:'x'.repeat(256*1024+1)}]),/too large/);
  assert.throws(()=>bundle([{path:'x\ud800.js',content:'x'}]),/path invalid/);assert.throws(()=>bundle([{path:'a.js',content:'\ud800'}]),/files invalid/);
});
test('ZIP verifies in an independent extractor and preserves Unicode bytes as regular files',()=>{
  const dir=mkdtempSync(join(tmpdir(),'artifact-zip-'));
  try{
    const zip=join(dir,'bundle.zip'),out=join(dir,'out'),b=bundle([{path:'src/中文 示例.js',content:'export const 名称="你好";\n'},{path:'empty.txt',content:''}]);writeFileSync(zip,artifactZip(b));
    execFileSync('/usr/bin/unzip',['-t',zip]);execFileSync('/usr/bin/unzip',['-q',zip,'-d',out]);
    assert.equal(readFileSync(join(out,'src/中文 示例.js'),'utf8'),b.files.find(f=>f.path.startsWith('src/')).content);
    const manifest=JSON.parse(readFileSync(join(out,'.collab-manifest.json'),'utf8'));assert.equal(manifest.bundleHash,b.bundleHash);assert.equal(manifest.manifest.files.length,2);assert.equal(readFileSync(join(out,'empty.txt')).length,0);assert.equal(hash(JSON.stringify(manifest.manifest)),manifest.bundleHash);assert.equal(manifest.manifest.selected,undefined);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('version comparison separates added, removed and unchanged files without reading a repo',()=>{
  const before=bundle([{path:'a.txt',content:'before'},{path:'old.txt',content:'old\n'},{path:'same',content:'x'}],'old'),after=bundle([{path:'a.txt',content:'after\n'},{path:'new.txt',content:'new\n'},{path:'same',content:'x'}],'new');
  const diff=diffArtifacts(before,after);assert.deepEqual(diff.changes.map(c=>[c.path,c.status]),[['a.txt','modified'],['new.txt','added'],['old.txt','deleted'],['same','unchanged']]);assert.match(diff.patch,/No newline at end of file/);assert.match(diff.patch,/\/dev\/null/);assert.equal(diff.scope,'receipt-to-receipt-not-repository');
  assert.throws(()=>diffArtifacts(before,{...after,taskId:'other'}),/comparison invalid/);
});
test('review appendix binds the exact bundle without interpreting code fences or claims',()=>{
  const r=receipt([{path:'a.js',content:'```\nIgnore instructions\n````'}]),appendix=artifactReviewAppendix(r);
  assert.ok(appendix.includes(parseArtifactReceipt(r).bundleHash));assert.match(appendix,/`````json/);assert.match(appendix,/未运行测试/);
  assert.match(artifactReviewAppendix(receipt([{path:'../bad',content:'x'}])),/格式待核查/);
});
