const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createServer}=require('node:net');
const http=require('node:http');

test('五个客户端同时保存不覆盖旧版本，并发收付款不突破余额',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'epm-local-team-')),data=path.join(root,'data'),files=path.join(root,'files');
 fs.mkdirSync(data);fs.mkdirSync(files);
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({archiveRoot:files,archiveRootAliases:[]}));
 fs.writeFileSync(path.join(data,'customers.json'),JSON.stringify([{id:'customer',company:'并发测试公司',contact:'原联系人'}]));
 fs.writeFileSync(path.join(data,'projects.json'),JSON.stringify([{id:'project',name:'并发测试项目',customer:'并发测试公司',receivable:300,supplierItems:[{id:'item',supplier:'测试供应商',payable:300}]}]));
 const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 const child=spawn(process.execPath,[path.join(__dirname,'../bundled-server/server.js')],{env:{...process.env,PORT:String(port),BIND_HOST:'127.0.0.1',PROJECT_DATA_DIR:data,PROJECT_ARCHIVE_DIR:files},stdio:'ignore'});
 const base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/status')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.equal(ready,true);
  const auth={username:'team-admin',displayName:'并发管理员',password:'isolated-test-only-123'};
  assert.equal((await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(auth)})).status,200);
  const cookies=[];for(let i=0;i<5;i++){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(auth)});assert.equal(r.status,200);cookies.push(r.headers.get('set-cookie').split(';')[0]);}
  const request=(i,url,body,headers={})=>fetch(base+url,{method:body?'POST':'GET',headers:{Cookie:cookies[i],'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  const original=(await(await request(0,'/api/customers')).json()).find(r=>r.id==='customer');
  const edits=await Promise.all(cookies.map((cookie,i)=>fetch(base+'/api/customers/customer',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json','If-Match':original._version},body:JSON.stringify({...original,contact:'客户端'+i})})));
  assert.deepEqual(edits.map(r=>r.status).sort(),[200,409,409,409,409]);
  const saved=(await(await request(0,'/api/customers')).json()).find(r=>r.id==='customer');assert.match(saved.contact,/^客户端[0-4]$/);
  const payments=await Promise.all(cookies.map((_,i)=>request(i,'/api/supplier-payments',{projectId:'project',supplierItemId:'item',amount:100,paymentDate:'2026-10-14'})));
  assert.equal(payments.filter(r=>r.status===200).length,3);assert.equal(payments.filter(r=>r.status===400).length,2);
  const receipts=await Promise.all(cookies.map((_,i)=>request(i,'/api/customer-receipts',{projectId:'project',amount:100,receiptDate:'2026-10-14'})));
  assert.equal(receipts.filter(r=>r.status===200).length,3);assert.equal(receipts.filter(r=>r.status===400).length,2);
  for(const file of ['supplier-payments.json','customer-receipts.json'])assert.equal(JSON.parse(fs.readFileSync(path.join(data,file))).reduce((sum,r)=>sum+r.amount,0),300);
  const integrity=await(await request(0,'/api/audit/integrity')).json();assert.equal(integrity.ok,true);
  const upload='/api/files/upload?projectId=project&category=other&fileName=abort-proof.bin';
  const first=await fetch(base+upload,{method:'POST',headers:{Cookie:cookies[0],'Content-Type':'application/octet-stream'},body:'original attachment'});
  assert.equal(first.status,200);const originalFile=await first.json();
  await new Promise(resolve=>{
   const aborted=http.request(base+upload,{method:'POST',headers:{Cookie:cookies[0],'Content-Type':'application/octet-stream','Content-Length':1024*1024}});
   aborted.on('error',()=>resolve());aborted.write('incomplete replacement');setTimeout(()=>aborted.destroy(new Error('intentional disconnect')),25);
  });
  await new Promise(r=>setTimeout(r,100));
  const downloaded=await fetch(base+'/api/files/download?path='+encodeURIComponent(originalFile.relativePath),{headers:{Cookie:cookies[0]}});
  assert.equal(await downloaded.text(),'original attachment');
  const paths=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?paths(path.join(dir,e.name)):[path.join(dir,e.name)]);
  assert.equal(paths(files).some(file=>file.endsWith('.tmp')),false);
  const backup=await request(0,'/api/backup/full');assert.equal(backup.status,200);assert.ok((await backup.arrayBuffer()).byteLength>0);
 }finally{child.kill();}
});
