'use strict';
let artifactViewSequence=0;
async function renderArtifactOutputs(task){
  const seq=++artifactViewSequence,box=$('task-artifacts');if(!box)return;box.replaceChildren();
  if(!task.receipts.length){box.append(text('p','收到规范的代码候选文件包后，可在这里按文件查看、下载和对比。','hint'));return;}
  try{
    const records=await api(`/api/tasks/${task.id}/artifacts`);if(seq!==artifactViewSequence||currentTask?.id!==task.id)return;
    const valid=records.filter(r=>r.available);
    for(const record of records){
      if(!record.available){if(record.reason!=='not_artifact_format')box.append(text('p','一份候选文件包未通过格式检查，原始回执仍保留；请查看原文，由协调方核对路径、大小和内容。','field-error'));continue;}
      const block=text('div','','receipt');block.append(text('strong',`${record.files.length} 个候选文件 · ${record.selected?'当前选用':'历史/未选用'} · ${record.isPrimary?'主执行':'配合执行'}`),text('p',`结果 ${record.receiptId}；产物摘要 ${record.bundleHash}`,'hint'),text('p','未写入项目仓库；下载、查看和模型回复都不表示测试或验收通过。','hint'));
      const download=text('a','下载候选文件 ZIP','button');download.href=`/api/tasks/${task.id}/receipts/${record.receiptId}/artifacts/download`;download.download=`code-${record.receiptId}.zip`;block.append(download);
      let cached;
      for(const file of record.files){const detail=document.createElement('details');detail.append(text('summary',`${file.path} · ${file.bytes} 字节`));detail.ontoggle=async()=>{if(!detail.open||detail.dataset.loaded)return;try{cached??=await api(`/api/tasks/${task.id}/receipts/${record.receiptId}/artifacts`);const value=cached.files.find(f=>f.path===file.path);detail.append(text('pre',value.content));detail.dataset.loaded='true';}catch{detail.append(text('p','文件读取失败，关闭后可重试。','field-error'));}};block.append(detail);}
      box.append(block);
    }
    if(!valid.length){box.append(text('p','当前回复是文本方案，没有规范的代码文件包。可继续评审原文；新任务可选择“生成代码候选文件”。','hint'));return;}
    if(valid.length<2)return;
    const form=document.createElement('form'),before=document.createElement('select'),after=document.createElement('select'),aLabel=text('label','对比前的回执'),bLabel=text('label','对比后的回执'),button=text('button','查看这两版的文件差异'),out=text('div','');
    before.id='artifact-before';after.id='artifact-after';aLabel.htmlFor=before.id;bLabel.htmlFor=after.id;optionsInto(before,valid.map(r=>[r.receiptId,r.receiptId]));optionsInto(after,valid.map(r=>[r.receiptId,r.receiptId]),valid.at(-1).receiptId);button.type='submit';form.append(text('h3','回执版本对比'),text('p','比较两份候选文件，不代表与本地仓库比较。未选用版本仍保留，不能自动进入当前评审。','hint'),aLabel,before,bLabel,after,button,out);form.onsubmit=e=>{e.preventDefault();busy(button,async()=>{const result=await api(`/api/tasks/${task.id}/artifacts/compare`,{beforeReceiptId:before.value,afterReceiptId:after.value});out.replaceChildren();const names={added:'新增',deleted:'删除',modified:'修改',unchanged:'未变化'};for(const change of result.changes)out.append(text('p',`${names[change.status]} · ${change.path}`));out.append(text('pre',result.patch||'两个版本内容相同。'));});};box.append(form);
  }catch{if(seq===artifactViewSequence&&currentTask?.id===task.id)box.append(text('p','产物列表暂不可读取，请刷新任务重试。原始回执仍保留。','field-error'));}
}
