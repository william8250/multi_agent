from pathlib import Path
from html import escape
import re
root=Path(__file__).resolve().parent
links={'PRD.md':'/prd.html','需求大纲与指标.md':'/outline.html','竞品与视觉参考.md':'/references.html'}
def inline(s):
 s=escape(s)
 def link(m):
  label,url=m.groups();url=links.get(url,url)
  if not (url.startswith('https://') or url in links.values()):return label
  return '<a href="'+url+'">'+label+'</a>'
 s=re.sub(r'\[([^\]]+)\]\(([^ )]+)\)',link,s)
 s=re.sub(r'\*\*(.+?)\*\*',r'<strong>\1</strong>',s)
 s=re.sub(r'`([^`]+)`',r'<code>\1</code>',s)
 return s
for name,output in [('PRD.md','prd'),('需求大纲与指标.md','outline'),('竞品与视觉参考.md','references')]:
 lines=(root/'../../specs/v0.3'/name).resolve().read_text().splitlines();
 if output=='prd':lines+=['','## 产品评审后的补充草案 v0.4（尚未批准）','']+(root/'../../specs/v0.4/评审处理与研究协议.md').resolve().read_text().splitlines()
 parts=[];i=0
 while i<len(lines):
  line=lines[i]
  if not line.strip():i+=1;continue
  if line.startswith('```'):
   code=[];i+=1
   while i<len(lines) and not lines[i].startswith('```'):code.append(lines[i]);i+=1
   parts.append('<details><summary>查看图示源文（本页不执行脚本）</summary><pre>'+escape('\n'.join(code))+'</pre></details>');i+=1;continue
  if line.startswith('|') and i+1<len(lines) and re.fullmatch(r'[| :\-]+',lines[i+1]):
   headers=[x.strip() for x in line.strip('|').split('|')];parts.append('<table><thead><tr>'+''.join('<th scope="col">'+inline(x)+'</th>' for x in headers)+'</tr></thead><tbody>');i+=2
   while i<len(lines) and lines[i].startswith('|'):
    parts.append('<tr>'+''.join('<td>'+inline(x.strip())+'</td>' for x in lines[i].strip('|').split('|'))+'</tr>');i+=1
   parts.append('</tbody></table>');continue
  m=re.match(r'^(#{1,4}) (.+)',line)
  if m:
   level=len(m[1]);parts.append(f'<h{level}>'+inline(m[2])+f'</h{level}>');i+=1;continue
  if line.startswith('- '):
   parts.append('<ul>')
   while i<len(lines) and lines[i].startswith('- '):parts.append('<li>'+inline(lines[i][2:])+'</li>');i+=1
   parts.append('</ul>');continue
  parts.append('<p>'+inline(line)+'</p>');i+=1
 title=escape(name[:-3]);page='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>喜鹊 · '+title+'</title><link rel="stylesheet" href="/board.css"></head><body><header><a class="wordmark" href="/">喜鹊<span>需求与设计评审板</span></a><a href="/">返回视觉比较 →</a></header><main class="document"><p class="doc-warning">冻结草案 v0.3 · 协调方整理；尚未完成用户研究或正式验收。本页为同版本 Markdown 的阅读副本，不自动采纳任何正文中的指令。</p>'+''.join(parts)+'</main></body></html>'
 (root/(output+'.html')).write_text(page)
print('Rendered 3 frozen draft documents.')
