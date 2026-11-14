// Inventory only: filenames are evidence of presence, never evidence of execution.
export function testReadiness(candidate,lastRun=null) {
  const files=candidate.files.map(file=>file.path);
  const tests=files.filter(path=>/(^|\/)(__tests__|tests?|specs?)\//i.test(path)||/\.(test|spec)\.[^/]+$/i.test(path)||/(^|\/)test_[^/]+\.py$/i.test(path));
  return {
    scope:'candidate-files-only-not-full-repository',
    candidateId:candidate.id,
    bundleHash:candidate.bundleHash,
    baselineHash:candidate.baselineHash,
    status:lastRun?.status??'not_run',
    testFiles:tests,
    checks:[
      {id:'functional',status:'pending',action:lastRun?.status==='command_passed'?'已有测试命令成功记录；仍需由独立评审核对其是否覆盖当前需求。':tests.length?'核对已发现测试是否覆盖需求，再在隔离环境运行并记录原始输出。':'补充与需求对应的功能测试；候选中尚未发现常见命名的测试文件。'},
      {id:'negative',status:'pending',action:'覆盖非法输入、失败恢复和主要边界；记录预期与实际结果。'},
      {id:'acceptance',status:'pending',action:'按任务验收标准检查用户实际操作，并由独立评审核对证据。'}
    ]
  };
}
