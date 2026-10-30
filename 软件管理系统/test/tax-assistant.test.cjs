const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {buildReport,exportEntries,csv}=require('../bundled-server/tax-assistant');
const {writeZip}=require('../bundled-server/local-zip');
const period='2026-10';
function fixture(){return {projects:[{id:'p',name:'印刷项目',customer:'客户',contractDate:'2026-10-02',accepted:true,receivable:500},{id:'old',name:'旧项目',contractDate:'2026-09-01',accepted:true,invoiced:true},{id:'multi',name:'合票项目',accepted:true}],invoices:[{id:'i',direction:'customer',invoiceDate:'2026-10-03',amount:500,allocations:[{projectId:'p',amount:300},{projectId:'multi',amount:200}]}],payments:[{id:'paid',projectId:'p',supplierName:'甲',amount:80,paymentDate:'2026-10-04'},{id:'void',projectId:'p',amount:20,paymentDate:'2026-10-04',status:'voided'}],filesByProject:{p:[{name:'普通票.pdf',relativePath:'发票/普通票.pdf',archivePath:'p/发票/普通票.pdf',size:10,updatedAt:'2026-10-01'}]}};}
test('合票关联项目不重复提示开票；普通票据不冒充关联原件；冲销付款不触发检查',()=>{
 const input=fixture(),before=JSON.stringify(input),r=buildReport(input,period);
 assert.equal(JSON.stringify(input),before);assert.equal(r.tasks.some(t=>t.id.startsWith('issue:')),false);
 assert.ok(r.tasks.some(t=>t.id==='original:i'));assert.ok(r.tasks.some(t=>t.id==='payment-invoice:paid'));
 assert.equal(r.tasks.some(t=>t.id==='payment-invoice:void'),false);assert.equal(r.summary.payments,80);
 assert.equal(r.monthly.projects.length,2);
 input.invoices[0].attachments=[{relativePath:'p/发票/普通票.pdf'}];
 assert.equal(buildReport(input,period).tasks.some(t=>t.id==='original:i'),false);
});
test('跨月待开票提醒和历史开票核对有明确范围，历史状态不产生重复开票',()=>{
 const r=buildReport({projects:[{id:'a',accepted:true,contractDate:'2026-09-01'},{id:'b',accepted:true,invoiced:true,invoiceDate:'2026-10-01'},{id:'c',accepted:true,paid:true}]},period);
 assert.ok(r.tasks.some(t=>t.id==='issue:a'));assert.ok(r.tasks.some(t=>t.id==='legacy-invoice:b'));
 assert.equal(r.tasks.filter(t=>t.id.startsWith('issue:')).length,1);assert.throws(()=>buildReport({},'2026-13'));
});
test('已核对记录在业务资料或供应商变更后失效；不同月份分别保留',()=>{
 const input=fixture(),task=buildReport(input,period).tasks.find(t=>t.id==='payment-invoice:paid');
 input.reviews=[{period,taskId:task.id,fingerprint:task.fingerprint,done:true,evidence:'会计已核对'}];
 assert.equal(buildReport(input,period).tasks.find(t=>t.id===task.id).done,true);
 input.payments[0].supplierName='另一供应商';const changed=buildReport(input,period).tasks.find(t=>t.id===task.id);
 assert.equal(changed.done,false);assert.equal(changed.stale,true);assert.equal(changed.evidence,'会计已核对');
 assert.equal(buildReport(input,'2026-09').tasks.some(t=>t.done),false);
});
test('月度资料严格投影字段，CSV阻止公式注入，保留数值负数',()=>{
 const input=fixture();input.projects[0].password='DO-NOT-EXPORT';input.projects[0].name='=HYPERLINK("test")';
 const entries=exportEntries(buildReport(input,period));assert.equal(entries.length,10);
 const all=entries.map(e=>e.content.toString()).join('');assert.equal(all.includes('DO-NOT-EXPORT'),false);
 const text=csv(['列'],[['=SUM(1)'],[' @evil'],[-12],['正常,"文本"']]);
 assert.match(text,/"'=SUM\(1\)"/);assert.match(text,/"' @evil"/);assert.match(text,/"-12"/);assert.match(text,/正常,""文本""/);
});
test('ZIP能由系统解压器读取中文名、CRC和摘要，失败清理且不覆盖已有文件',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'epm-local-zip-')),zip=path.join(root,'资料.zip'),file=path.join(root,'附件.txt');
 try{
  fs.writeFileSync(file,'真实附件');await writeZip([{name:'项目.csv',content:Buffer.from('中文数据')},{name:'附件/原件.txt',file}],zip);
  // Windows PowerShell uses the independent .NET ZIP implementation to validate archive interoperability.
  const script='Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($args[0]); try { $rows=@(); foreach($e in $z.Entries){$s=$e.Open();$m=New-Object IO.MemoryStream;try{$s.CopyTo($m);$rows+=@{name=$e.FullName;base64=[Convert]::ToBase64String($m.ToArray())}}finally{$s.Dispose();$m.Dispose()}}; ConvertTo-Json -InputObject $rows -Compress }finally{$z.Dispose()}';
  const ps=path.join(root,'read.ps1');fs.writeFileSync(ps,script);
  const rows=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',ps,zip],{encoding:'utf8'}).replace(/^\uFEFF/,''));
  const content=Object.fromEntries(rows.map(r=>[r.name,Buffer.from(r.base64,'base64')]));
  assert.equal(content['附件/原件.txt'].toString(),'真实附件');
  for(const entry of JSON.parse(content['文件校验清单.json']))assert.equal(crypto.createHash('sha256').update(content[entry.name]).digest('hex'),entry.sha256);
  await assert.rejects(writeZip([{name:'../bad',content:Buffer.from('bad')}],path.join(root,'bad.zip')));assert.equal(fs.existsSync(path.join(root,'bad.zip')),false);
  await assert.rejects(writeZip([{name:'missing',file:path.join(root,'missing')}],path.join(root,'missing.zip')));assert.equal(fs.existsSync(path.join(root,'missing.zip')),false);
  const original=fs.readFileSync(zip);await assert.rejects(writeZip([],zip));assert.deepEqual(fs.readFileSync(zip),original);
  await assert.rejects(writeZip([{name:'Same',content:Buffer.alloc(0)},{name:'same',content:Buffer.alloc(0)}],path.join(root,'duplicate.zip')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
