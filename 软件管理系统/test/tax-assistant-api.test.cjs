const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createServer}=require('node:net');
const {createHash}=require('node:crypto');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('税务助手默认关闭、主账号权限、并发核对、导出范围和重启持久化',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'epm-tax-assistant-')),data=path.join(root,'data'),files=path.join(root,'files');
 fs.mkdirSync(data);fs.mkdirSync(files);const save=(name,value)=>fs.writeFileSync(path.join(data,name),JSON.stringify(value));
 save('settings.json',{archiveRoot:files,archiveRootAliases:[]});save('projects.json',[{id:'p',name:'测试项目',customer:'测试客户',contractDate:'2026-10-01',accepted:true,receivable:500}]);
 save('supplier-payments.json',[{id:'pay',projectId:'p',supplierName:'供货商',amount:100,paymentDate:'2026-10-02'}]);
 const projectFolder=path.join(files,'2026年','10月','测试客户','测试项目');
 for(const category of ['发票','合同','制作']){fs.mkdirSync(path.join(projectFolder,category),{recursive:true});fs.writeFileSync(path.join(projectFolder,category,category+'.txt'),category+'测试文件');}
 const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'private.txt'),'OUTSIDE-SECRET');
 fs.symlinkSync(outside,path.join(projectFolder,'发票','链接'),'junction');
 const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 let child;const base='http://127.0.0.1:'+port;
 async function start(){child=spawn(process.execPath,[path.join(__dirname,'../bundled-server/server.js')],{env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PROJECT_DATA_DIR:data,PROJECT_ARCHIVE_DIR:files},stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch(base+'/api/status')).ok)return;}catch{}await pause(80);}throw Error('Server did not start');}
 async function stop(){const exited=once(child,'exit');child.kill();await exited;}
 let cookie='';const req=(url,options={})=>fetch(base+url,{...options,headers:{'Content-Type':'application/json',Cookie:cookie,...options.headers}});
 const endpoint='/api/tax-assistant/report?period=2026-10';
 const feature=async(enabled,version)=>(await req('/api/features',{method:'PUT',headers:{'If-Match':version},body:JSON.stringify({taxAssistant:enabled})}));
 try{
  await start();assert.equal((await req(endpoint)).status,401);
  const setup=await req('/api/auth/setup',{method:'POST',body:JSON.stringify({username:'admin',password:'test-only-password',displayName:'会计测试'})});cookie=setup.headers.get('set-cookie').split(';')[0];
  const initial=await(await req('/api/features')).json();assert.equal(initial.taxAssistant,false);assert.equal((await req(endpoint)).status,403);
  const enabled=await feature(true,initial.version);assert.equal(enabled.status,200);
  assert.equal((await feature(false,initial.version)).status,409);
  const sub=await req('/api/users',{method:'POST',body:JSON.stringify({username:'staff',password:'test-only-password',permissions:['files','payments']})});assert.equal(sub.status,200);
  const login=await req('/api/auth/login',{method:'POST',body:JSON.stringify({username:'staff',password:'test-only-password'})});const subCookie=login.headers.get('set-cookie').split(';')[0];
  for(const url of ['/api/features',endpoint,'/api/tax-assistant/export-preview?period=2026-10'])assert.equal((await req(url,{headers:{Cookie:subCookie}})).status,403);
  assert.equal((await req('/api/tax-assistant/report?period=2026-99')).status,400);
  const names=['projects.json','invoices.json','supplier-payments.json','customer-receipts.json','expenses.json'],before=Object.fromEntries(names.map(f=>[f,digest(path.join(data,f))]));
  const report=await(await req(endpoint)).json();assert.ok(report.tasks.some(t=>t.id==='issue:p'));assert.equal(report.attachmentFiles.length,2);assert.ok(report.fileWarnings.length);
  const task=report.tasks.find(t=>t.id==='accountant:period');
  const review=body=>req('/api/tax-assistant/review?period=2026-10',{method:'POST',body:JSON.stringify(body)});
  const body={taskId:task.id,fingerprint:task.fingerprint,reviewVersion:task.reviewVersion,done:true,evidence:'已与会计逐笔核对'};
  assert.equal((await review({...body,evidence:''})).status,400);assert.equal((await review(body)).status,200);assert.equal((await review(body)).status,409);
  const reviewed=await(await req(endpoint)).json();assert.equal(reviewed.tasks.find(t=>t.id===task.id).done,true);
  const preview=await(await req('/api/tax-assistant/export-preview?period=2026-10')).json();assert.equal(preview.files.length,0);assert.equal(preview.attachmentBytes,0);
  const withFiles=await(await req('/api/tax-assistant/export-preview?period=2026-10&attachments=1')).json();assert.equal(withFiles.files.length,2);
  const response=await req('/api/tax-assistant/export?'+new URLSearchParams({period:'2026-10',attachments:'1',fingerprint:withFiles.fingerprint}));assert.equal(response.status,200);const zip=Buffer.from(await response.arrayBuffer());assert.equal(zip.readUInt32LE(),0x04034b50);
  for(const forbidden of ['OUTSIDE-SECRET','制作测试文件','test-only-password','enterprise_session'])assert.equal(zip.includes(Buffer.from(forbidden)),false,forbidden);
  assert.ok(zip.includes(Buffer.from('合同测试文件')));assert.ok(zip.includes(Buffer.from('发票测试文件')));
  assert.deepEqual(Object.fromEntries(names.map(f=>[f,digest(path.join(data,f))])),before);
  save('expenses.json',[{id:'new',name:'新增费用',date:'2026-10-02',amount:30}]);
  assert.equal((await req('/api/tax-assistant/export?'+new URLSearchParams({period:'2026-10',fingerprint:preview.fingerprint}))).status,409);
  assert.equal((await review({...body,reviewVersion:reviewed.tasks.find(t=>t.id===task.id).reviewVersion})).status,409);
  assert.equal((await(await req(endpoint)).json()).tasks.find(t=>t.id===task.id).stale,true);
  const reviewsHash=digest(path.join(data,'tax-assistant-reviews.json'));const state=await(await req('/api/features')).json();assert.equal((await feature(false,state.version)).status,200);
  assert.equal(digest(path.join(data,'tax-assistant-reviews.json')),reviewsHash);await stop();await start();
  assert.equal((await(await req('/api/features')).json()).taxAssistant,false);assert.equal(digest(path.join(data,'tax-assistant-reviews.json')),reviewsHash);
  assert.equal(fs.readdirSync(path.join(data,'backups')).some(name=>name.startsWith('tax-export-')),false);
 }finally{if(child?.exitCode===null)await stop();fs.rmSync(root,{recursive:true,force:true});}
});
