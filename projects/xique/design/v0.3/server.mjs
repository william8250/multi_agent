import http from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('./',import.meta.url));
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/board.css',['board.css','text/css; charset=utf-8']],['/board.js',['board.js','text/javascript; charset=utf-8']],...['prd','outline','references'].map(n=>['/'+n+'.html',[n+'.html','text/html; charset=utf-8']])]);
http.createServer(async(req,res)=>{
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Permissions-Policy','geolocation=(), microphone=(), camera=()');res.setHeader('Cache-Control','no-store');
 const send=(status,body,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type});res.end(req.method==='HEAD'?'':body);};
 if(req.headers.host!=='127.0.0.1:8771')return send(403,'仅限本机访问');
 if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');return send(405,'仅提供设计文档浏览');}
 const a=assets.get(req.url);if(!a)return send(404,'未找到此设计文档');
 try{const p=root+a[0];if(await realpath(p)!==p)return send(404,'文件不可用');send(200,await readFile(p),a[1]);}catch{return send(404,'文件不可用');}
}).listen(8771,'127.0.0.1',()=>console.log('喜鹊需求与视觉设计板：http://127.0.0.1:8771/（仅本机）'));
