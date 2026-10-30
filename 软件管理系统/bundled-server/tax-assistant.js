const crypto=require('node:crypto');
const sources=require('./tax-reference-sources');
const fingerprint=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validPeriod=period=>{if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period||''))throw Object.assign(new Error('请选择有效月份'),{status:400});return period;};
const active=row=>row.status!=='voided';
const month=(value,period)=>String(value||'').startsWith(period+'-');
const links=invoice=>Array.isArray(invoice.allocations)&&invoice.allocations.length?invoice.allocations.map(r=>r.projectId):[invoice.projectId].filter(Boolean);
const sum=rows=>Math.round(rows.filter(active).reduce((n,r)=>n+Number(r.amount||0),0)*100)/100;
const selected=(row,keys)=>Object.fromEntries(keys.map(key=>[key,row[key]??'']));

function buildReport(input,period){
 validPeriod(period);
 const {projects=[],invoices=[],payments=[],receipts=[],expenses=[],filesByProject={},reviews=[]}=input;
 const tasks=[],projectMap=new Map(projects.map(p=>[p.id,p]));
 const paid=payments.filter(p=>month(p.paymentDate,period)),received=receipts.filter(r=>month(r.receiptDate,period));
 const bills=invoices.filter(i=>month(i.invoiceDate,period)),costs=expenses.filter(e=>month(e.date,period));
 const ids=new Set(projects.filter(p=>[p.contractDate,p.deliveryDate,p.invoiceDate,p.paymentDate].some(d=>month(d,period))).map(p=>p.id));
 for(const row of [...paid,...received])if(row.projectId)ids.add(row.projectId);
 for(const bill of bills)for(const id of links(bill))ids.add(id);
 const periodProjects=projects.filter(p=>ids.has(p.id));
 const files=periodProjects.flatMap(p=>(filesByProject[p.id]||[]).filter(f=>/^(发票|合同)(?:\/|$)/.test(f.relativePath||'')).map(f=>({...f,projectId:p.id,projectName:p.name||''})));
 for(const bill of bills)for(const attachment of bill.attachments||[]){
  const file=Object.values(filesByProject).flat().find(f=>f.archivePath===attachment.relativePath);
  if(file&&!files.some(f=>f.archivePath===file.archivePath))files.push({...file,projectId:attachment.projectId||bill.projectId||'',projectName:projectMap.get(attachment.projectId||bill.projectId)?.name||''});
 }
 function add(id,group,title,detail,facts,projectId='',action='files'){
  const version=fingerprint(facts),review=reviews.find(r=>r.period===period&&r.taskId===id);
  tasks.push({id,group,title,detail,projectId,projectName:projectMap.get(projectId)?.name||'',action,fingerprint:version,reviewVersion:fingerprint(review||null),done:!!review?.done&&review.fingerprint===version,stale:!!review?.done&&review.fingerprint!==version,evidence:review?.evidence||'',reviewedBy:review?.reviewedBy||'',reviewedAt:review?.updatedAt||''});
 }
 const originalExists=bill=>(bill.attachments||[]).some(a=>Object.values(filesByProject).some(list=>list.some(f=>f.archivePath===a.relativePath)));
 for(const p of projects){
  const sales=invoices.filter(i=>active(i)&&i.direction==='customer'&&links(i).includes(p.id));
  const items=(p.supplierItems||[]).filter(i=>Number(i.payable||0)>0||i.itemName);
  const accepted=p.accepted===true||(items.length>0&&items.every(i=>i.accepted===true));
  if(!p.paid&&accepted&&!p.invoiced&&!sales.length)add('issue:'+p.id,'invoice','交付已确认，核对开票安排','从项目收付款进入；开票时点和要求由会计结合合同确认。此清单包含跨月未处理项目。',[p.id,p.accepted,p.invoiced,p.paid,p.receivable,p.supplierItems],p.id,'money');
  if(p.invoiced&&!sales.length&&ids.has(p.id))add('legacy-invoice:'+p.id,'invoice','历史开票状态缺少票据登记','已有“已开票”状态，不提示再次开票；请核对原发票登记和文件。',[p.id,p.invoiceDate,p.invoiced],p.id);
 }
 for(const bill of bills.filter(active))if(!originalExists(bill))add('original:'+bill.id,bill.direction==='supplier'?'supplier':'invoice','已登记发票，未见关联原件','发票登记不等于已保存原件；请核对并在项目文件中归档，不自动重新开票。',[bill.id,bill.invoiceNumber,bill.invoiceDate,bill.partyName,bill.amount,bill.direction,links(bill),bill.attachments],links(bill)[0]||'');
 for(const payment of paid.filter(active)){
  const bill=invoices.find(i=>i.id===payment.invoiceId&&i.direction==='supplier'&&active(i)&&links(i).includes(payment.projectId));
  if(!bill){
   const candidates=invoices.filter(i=>i.direction==='supplier'&&active(i)&&links(i).includes(payment.projectId)&&i.partyName===payment.supplierName);
   add('payment-invoice:'+payment.id,'supplier',candidates.length?'本期付款有候选票据，尚未确认关联':'本期付款未关联供应商票据',candidates.length?'请会计核对候选票据与采购明细，不重复录入或自动匹配。':'请核对供应商提供的票据及业务凭证；不据此判定税务违法或抵扣资格。',[payment.id,payment.projectId,payment.supplierName,payment.supplierItemId,payment.paymentDate,payment.amount,payment.invoiceId,candidates.map(i=>[i.id,i.amount])],payment.projectId);
  }
  const contracts=(filesByProject[payment.projectId]||[]).filter(f=>/^合同(?:\/|$)/.test(f.relativePath||''));
  if(!contracts.length)add('contract:'+payment.projectId,'supplier','本期付款项目未见合同或订单附件','请确认该业务是否需要合同、订单或其他证明，再按实际情况归档。',[payment.projectId,paid.filter(p=>active(p)&&p.projectId===payment.projectId).map(p=>[p.id,p.amount,p.paymentDate])],payment.projectId);
 }
 // Several payments may share one project-level check.
 const unique=new Map(tasks.map(task=>[task.id,task]));tasks.splice(0,tasks.length,...unique.values());
 const monthly={
  projects:periodProjects.map(p=>selected(p,['id','name','customer','contractDate','deliveryDate','invoiceDate','receivable','invoiced','paid'])),
  invoices:bills.map(i=>({...selected(i,['id','direction','invoiceNumber','invoiceDate','amount','partyName','projectId','status','invoiceKind','taxRate','taxAmount']),allocations:(i.allocations||[]).map(row=>selected(row,['projectId','amount']))})),
  payments:paid.map(p=>selected(p,['id','projectId','supplierName','supplierItemId','amount','paymentDate','invoiceId','status'])),
  receipts:received.map(r=>selected(r,['id','projectId','amount','receiptDate','invoiceId','status'])),
  expenses:costs.map(e=>selected(e,['id','name','category','date','amount','remark']))
 };
 const monthFacts=fingerprint(monthly);
 for(const [id,title,detail] of [
  ['period','核对本月业务是否完整','对照公司实际业务核对项目、收付款和费用；没有记录不代表没有业务。'],
  ['originals','会计核对票据和费用凭证','逐笔核对票据原件、购销方、金额和业务关联；普通项目文件不自动当作某张发票的原件。'],
  ['tax-treatment','会计确认票据用途和税务处理','结合企业纳税人身份、所在地及真实业务判断，不由软件判定税率、抵扣或优惠。'],
  ['filing-date','会计确认所属期和办税安排','通过所在地电子税务局或12366核对本期办税项目及日期；本月资料分类不是税款所属期判断。']
 ])add('accountant:'+id,'accountant',title,detail,[period,monthFacts,id,files.map(f=>[f.archivePath,f.size,f.updatedAt])],'','review');
 const attachmentFiles=[...new Map(files.map(f=>[f.archivePath,f])).values()].map(f=>selected(f,['name','archivePath','size','updatedAt','projectId','projectName']));
 const exportFingerprint=fingerprint({period,monthly,files:attachmentFiles,tasks:tasks.map(t=>[t.id,t.fingerprint,t.done,t.evidence])});
 return {period,scope:'月度资料按记录日期归集；开票提醒包含跨月未处理项目，不代表税款所属期或应纳税额。',tasks,monthly,attachmentFiles,summary:{invoice:tasks.filter(t=>t.group==='invoice'&&!t.done).length,supplier:tasks.filter(t=>t.group==='supplier'&&!t.done).length,accountant:tasks.filter(t=>t.group==='accountant'&&!t.done).length,receipts:sum(received),payments:sum(paid),expenses:sum(costs)},sources,exportFingerprint};
}

function csv(headers,rows){const cell=value=>{let s=String(value??'');if(typeof value==='string'&&/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return '\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';}
function exportEntries(report){
 const m=report.monthly;
 const tables=[
  ['项目.csv',['项目编号','项目','客户','下单日期','交货日期','开票日期','应收金额'],m.projects.map(p=>[p.id,p.name,p.customer,p.contractDate,p.deliveryDate,p.invoiceDate,p.receivable])],
  ['发票登记.csv',['票据编号','方向','票号','开票日期','金额','往来单位','项目编号','多项目分配','状态','票种','记录税率','记录税额'],m.invoices.map(i=>[i.id,i.direction,i.invoiceNumber,i.invoiceDate,i.amount,i.partyName,i.projectId,i.allocations.map(a=>(m.projects.find(p=>p.id===a.projectId)?.name||a.projectId)+': '+a.amount).join('；'),i.status,i.invoiceKind,i.taxRate,i.taxAmount])],
  ['供应商付款.csv',['流水编号','项目编号','供应商','付款日期','金额','关联发票','状态'],m.payments.map(p=>[p.id,p.projectId,p.supplierName,p.paymentDate,p.amount,p.invoiceId,p.status])],
  ['客户回款.csv',['流水编号','项目编号','回款日期','金额','关联发票','状态'],m.receipts.map(r=>[r.id,r.projectId,r.receiptDate,r.amount,r.invoiceId,r.status])],
  ['费用.csv',['编号','名称','分类','日期','金额','备注'],m.expenses.map(e=>[e.id,e.name,e.category,e.date,e.amount,e.remark])],
  ['资料文件索引.csv',['文件','项目','归档相对路径','字节数'],report.attachmentFiles.map(f=>[f.name,f.projectName,f.archivePath,f.size])],
  ['会计核对清单.csv',['分组','事项','项目','说明','已核对','资料已变化','核对说明','核对人','核对时间'],report.tasks.map(t=>[t.group,t.title,t.projectName,t.detail,t.done?'是':'否',t.stale?'是':'否',t.evidence,t.reviewedBy,t.reviewedAt])]
 ];
 return [...tables.map(([name,headers,rows])=>({name,content:Buffer.from(csv(headers,rows))})),{name:'月度业务摘要.json',content:Buffer.from(JSON.stringify({period:report.period,scope:report.scope,...m},null,2))},{name:'官方参考.json',content:Buffer.from(JSON.stringify(report.sources,null,2))},{name:'使用说明.txt',content:Buffer.from('这是本地会计资料包，不是纳税申报表或完整数据备份。\n'+report.scope+'\n含冲销记录，请结合状态核对；财税判断由会计确认。\n包内不含账号密码或登录会话。公司自行选择保存位置和交付对象，软件不自动发送。\n')}];
}
module.exports={buildReport,validPeriod,fingerprint,exportEntries,csv};
