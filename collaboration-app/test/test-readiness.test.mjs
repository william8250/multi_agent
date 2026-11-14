import test from 'node:test';
import assert from 'node:assert/strict';
import { testReadiness } from '../lib/test-readiness.mjs';
const candidate=paths=>({id:'candidate',bundleHash:'bundle',baselineHash:'baseline',files:paths.map(path=>({path}))});
test('test inventory binds candidate hashes but never claims execution',()=>{
  const result=testReadiness(candidate(['src/a.mjs','test/a.test.mjs','__tests__/b.ts','tests/test_c.py','spec/d.js']));
  assert.equal(result.status,'not_run');assert.equal(result.bundleHash,'bundle');assert.equal(result.baselineHash,'baseline');assert.equal(result.testFiles.length,4);assert.ok(result.checks.every(check=>check.status==='pending'));
});
test('missing or misleading test names do not count as passing or full repository coverage',()=>{
  const result=testReadiness(candidate(['src/contest.js','src/latest.js','docs/testing.md']));
  assert.deepEqual(result.testFiles,[]);assert.equal(result.scope,'candidate-files-only-not-full-repository');assert.match(result.checks[0].action,/补充/);assert.equal(result.status,'not_run');
});
