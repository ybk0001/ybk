import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.data', 'desktop-smoke', randomUUID());
const userData = join(output, 'user-data');
const dataDir = join(userData, 'business-data');
mkdirSync(dataDir, { recursive: true });
const checks = [];
const productionTest=true;
const appArgs=process.env.EPM_APP_DIR?[resolve(process.env.EPM_APP_DIR)]:[];
const exe = process.env.EPM_DESKTOP_EXE || (appArgs.length?resolve(root,'../enterprise-project-manager-4/node_modules/electron/dist/electron.exe'):join(root, 'dist', JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version, 'win-x64', '企业项目收付款管理 本地版.exe'));
const originalExe = process.env.EPM_REFERENCE_FILE ? resolve(process.env.EPM_REFERENCE_FILE) : join(root, 'bundled-server/public/index.html');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const originalHash = hash(originalExe);
function freePort() {
  return new Promise((accept, reject) => {
    const s = createServer(); s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : accept(p)); });
  });
}
const pause = ms => new Promise(r => setTimeout(r, ms));
const port = await freePort();
const debugPort = await freePort();
writeFileSync(join(userData, 'desktop-settings.json'), JSON.stringify({ mode: 'local', host: '127.0.0.1', port }), 'utf8');
const today = new Date().toLocaleDateString('sv-SE');
const future = new Date(Date.now() + 10 * 86400000).toLocaleDateString('sv-SE');
const project = (id, name, extra = {}) => ({ id, name, customer: '测试客户', customerContact: '测试联系人', contractDate: today, deliveryDate: future, receivable: 1000, supplierItems: [{ id: 'item-' + id, itemName: '测试印刷品', supplier: '测试供应商', quantity: 100, saleUnitPrice: 10, payable: 300, unit: '份' }], ...extra });
const fixture = [
  project('making', '名片制作'),
  project('confirm', '画册待确认', { shipped: true }),
  project('invoice', '礼盒待开票', { shipped: true, accepted: true }),
  project('payment', '海报待回款', { customer: '另一客户', invoiced: true, invoiceDate: today, supplierItems: [{ id: 'item-payment', itemName: '海报', supplier: '乙供应商', quantity: 100, saleUnitPrice: 10, payable: 300, unit: '份' }] }),
  project('closed', '已完成项目', { paid: true, paymentDate: today })
];
writeFileSync(join(dataDir, 'projects.json'), JSON.stringify(fixture), 'utf8');
const initialDataHash = hash(join(dataDir, 'projects.json'));
const child = spawn(exe, [...appArgs, '--epm-background-smoke', `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
const stderr = [];
child.stderr.on('data', b => stderr.push(String(b)));
let socket;
let nextId = 0;
const pending = new Map();
const errors = [];
let foreignRequests=0;
const foreignServer=createHttpServer((req,res)=>{foreignRequests++;res.writeHead(200,{'Access-Control-Allow-Origin':'*'});res.end('not-company-server');});
await new Promise(resolve=>foreignServer.listen(0,'127.0.0.1',resolve));
const foreignPort=foreignServer.address().port;
async function waitUntil(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (child.exitCode !== null) throw new Error('进程提前退出：' + child.exitCode);
    await pause(80);
  }
  throw new Error('等待超时：' + label);
}
const call = (method, params = {}) => new Promise((accept, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)); }, 15000);
  pending.set(id, { accept: v => { clearTimeout(timer); accept(v); }, reject: e => { clearTimeout(timer); reject(e); } });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const screenshot = async name => {
  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
};
try {
  let page;
  await waitUntil(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      page = pages.find(p => p.type === 'page' && p.url.startsWith(`http://127.0.0.1:${port}`));
      return !!page;
    } catch { return false; }
  }, '本机页面启动', 25000);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener('message', e => {
    const packet = JSON.parse(String(e.data));
    if (packet.id) { const p = pending.get(packet.id); pending.delete(packet.id); if (p) packet.error ? p.reject(new Error(JSON.stringify(packet.error))) : p.accept(packet.result); }
    if (packet.method === 'Runtime.exceptionThrown') errors.push(packet.params.exceptionDetails);
  });
  await new Promise((accept, reject) => { socket.addEventListener('open', accept, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  await call('Runtime.enable'); await call('Page.enable');
  await waitUntil(() => evaluate(`document.querySelector('#authForm')?.dataset.setup === 'true'`), '显示创建试用账号');
  assert.equal(await evaluate('document.title'),'企业项目收付款管理 本地版');
  const duplicate = spawn(exe, [...appArgs, `--user-data-dir=${userData}`], { cwd: root, windowsHide: true, stdio: 'ignore' });
  await new Promise((accept, reject) => { const timer = setTimeout(() => { duplicate.kill(); reject(new Error('重复实例没有退出')); }, 8000); duplicate.once('exit', code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error('重复实例退出异常：'+code)); }); });
  assert.equal(child.exitCode, null);
  const openPages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  assert.equal(openPages.filter(p=>p.url.startsWith(`http://127.0.0.1:${port}`)).length, 1);
  checks.push('本地版标题正确，重复启动仅保留一个实例；后台验收不唤起窗口');
  await evaluate(`document.querySelector('#authUsername').value='preview-admin'; document.querySelector('#authPassword').value='preview-smoke-only'; document.querySelector('#authDisplayName').value='测试账号'; document.querySelector('#authForm').requestSubmit();`);
  await waitUntil(() => evaluate(`document.querySelector('#authGate').classList.contains('hidden') && document.querySelector('#projectRows').innerText.includes('名片制作')`), '加载测试账本');
  await pause(1100);
  assert.equal(await evaluate(`fetch('http://127.0.0.1:${foreignPort}/probe').then(()=>false,()=>true)`),true);
  assert.equal(foreignRequests,0);
  assert.equal(await evaluate(`fetch('/api/status').then(r=>r.status)`),200);
  checks.push('真实桌面拦截非公司服务请求，同一公司服务正常；无须厂商云登录');
  assert.equal(await evaluate(`document.body.classList.contains('view-projects')`),true);
  await evaluate(`document.querySelector('#dashboardPageBtn').click();`);
  assert.equal(await evaluate(`document.querySelector('#operationsDialog').open`), false);
  checks.push('有风险项目启动时不弹出执行中心遮住页面');
  const nav = await evaluate(`[...document.querySelectorAll('.layout-primary button')].filter(n=>!n.hidden).map(n=>n.textContent.slice(1))`);
  assert.deepEqual(nav, ['工作台', '项目管理', '收付款', '往来资料', '经营报表', '系统设置']);
  assert.equal(await evaluate(`document.querySelector('.minimal-overview').open || document.querySelector('.minimal-todo').open`), false);
  checks.push('六个一级模块；新建不占一级导航；首页默认收起重复概览和待办表单');
  assert.equal(await evaluate(`document.querySelector('#collectionSummary button strong').textContent`), '1 个');
  checks.push('已结单项目不重复进入待开票提醒');
  await screenshot('01-workbench');
  await evaluate(`window.__deliveryDates=projects.map(p=>[p.id,p.deliveryDate]);projects.find(p=>p.id==='making').deliveryDate='2000-01-01';renderDeliveryBoard();document.querySelector('#deliveryAlertTitle').click();`);
  assert.equal(await evaluate(`document.querySelector('#deliveryBoardDialog').open`),true);
  assert.equal(await evaluate(`document.querySelector('#layoutPageTitle').textContent`),'交付跟进');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#deliveryList .delivery-project strong')].map(n=>n.textContent)`),['名片制作']);
  assert.equal(await evaluate(`document.querySelector('#deliveryAlertAction').textContent`),'查看逾期项目');
  await screenshot('11-overdue-followup');
  await evaluate(`document.querySelector('#deliveryList .row-actions button').click();`);
  assert.equal(await evaluate(`window.projectWorkspace.id`),'making');
  assert.equal(await evaluate(`document.querySelector('#mergedProgressPanel').classList.contains('hidden')`),false);
  await evaluate(`document.querySelector('#dashboardPageBtn').click();document.querySelector('#cashflowAlertAction').click();`);
  assert.equal(await evaluate(`document.querySelector('#collectionBoardDialog').open`),true);
  assert.equal(await evaluate(`document.querySelector('#layoutPageTitle').textContent`),'开票与回款');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#collectionList .delivery-project strong')].map(n=>n.textContent).sort()`),['海报待回款','礼盒待开票'].sort());
  await screenshot('12-collection-followup');
  await evaluate(`document.querySelector('#collectionSummary button').click();document.querySelector('#collectionList .row-actions button').click();`);
  assert.equal(await evaluate(`window.projectWorkspace.id`),'invoice');
  assert.equal(await evaluate(`document.querySelector('#mergedMoneyPanel').classList.contains('hidden')`),false);
  assert.equal(await evaluate(`document.querySelector('#collectionBoardDialog').open`),false);
  await evaluate(`for(const [id,date] of window.__deliveryDates)projects.find(p=>p.id===id).deliveryDate=date;delete window.__deliveryDates;document.querySelector('#dashboardPageBtn').click();renderDeliveryBoard();`);
  assert.equal(hash(join(dataDir,'projects.json')),initialDataHash);
  checks.push('提醒卡片跳转到逾期清单，交付进入该项目进度；开票回款清单说明下一步并进入该项目收付款；浏览不写账本');
  await evaluate(`document.querySelector('.layout-primary [data-module=contacts]').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#customerDialog').open`),'客户二级页面');
  assert.equal(await evaluate(`document.querySelector('#customerDialog').matches(':modal')`),false);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.layout-secondary button')].map(n=>n.textContent)`),['客户','供应商','库存','常用工艺']);
  await screenshot('05-customer-page');
  await evaluate(`document.querySelector('.layout-secondary [data-route=supplierManagerBtn]').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#supplierDialog').open && !document.querySelector('#customerDialog').open`),'供应商二级切换');
  await screenshot('08-supplier-page');
  checks.push('往来资料二级导航能切换客户/供应商，无模态遮罩且只打开一个模块页面');
  assert.equal(await evaluate(`document.querySelector('#supplierMasterForm').closest('details').open`),false);
  await evaluate(`document.querySelector('.layout-secondary [data-route=customerManagerBtn]').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#customerDialog').open`),'返回客户页');
  await evaluate(`editCustomer(customers[0].id);`);
  assert.equal(await evaluate(`document.querySelector('#customerForm').closest('details').open`),true);
  assert.equal(hash(join(dataDir, 'projects.json')),initialDataHash);
  for(const [module, routes] of Object.entries({money:{paymentsBtn:'paymentDialog',settlementBatchBtn:'settlementBatchDialog',expenseBtn:'expenseDialog'},reports:{annualSalesBtn:'annualSalesDialog'},settings:{accountManagerBtn:'accountDialog',archiveSettingsBtn:'archiveSettingsDialog',themeBtn:'themeDialog',layoutBackupBtn:'layoutBackupDialog'},projects:{fileCenterBtn:'fileDialog',operationsBtn:'operationsDialog'}})) {
    await evaluate(`document.querySelector('.layout-primary [data-module=${module}]').click();`);
    for(const [button, dialog] of Object.entries(routes)) {
      await evaluate(`document.getElementById(${JSON.stringify(button)}).click();`);
      await waitUntil(()=>evaluate(`document.getElementById(${JSON.stringify(dialog)}).open`),dialog);
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(dialog)}).matches(':modal')`),false);
      assert.equal(await evaluate(`document.querySelectorAll('dialog.layout-module-page[open]').length`),1);
    }
  }
  await evaluate(`document.querySelector('.layout-primary [data-module=contacts]').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#customerDialog').open`),'窄窗口客户页');
  await call('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
  assert.ok(await evaluate(`(()=>{const sidebar=document.querySelector('.layout-sidebar').getBoundingClientRect(), page=document.querySelector('#customerDialog').getBoundingClientRect();return page.left>=sidebar.right && page.right<=innerWidth && page.bottom<=innerHeight && page.top>=98;})()`));
  await screenshot('09-customer-1024');
  const overflow=await evaluate(`(()=>{const page=document.querySelector('#customerDialog'),right=page.getBoundingClientRect().right;return {width:page.clientWidth,scroll:page.scrollWidth,overflow:[...page.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>right+1).map(n=>({tag:n.tagName,id:n.id,cls:n.className,width:n.clientWidth,right:n.getBoundingClientRect().right})).slice(0,12)};})()`);
  assert.ok(overflow.scroll<=overflow.width+1,'客户页不应水平裁切表单：'+JSON.stringify(overflow));
  await call('Emulation.clearDeviceMetricsOverride');
  checks.push('所有模块页面可切换且无叠加遮罩；客户编辑展开原表单；1024 宽度导航与内容不重叠且表单不水平裁切');
  await evaluate(`window.__mainUser=currentUser;currentUser={...currentUser,role:'sub',permissions:['customers']};applyAccountUi();document.querySelector('.layout-primary [data-module=contacts]').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('.layout-primary [data-module=money]').hidden`),'权限刷新');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.layout-secondary button')].map(n=>n.textContent)`),['客户']);
  await evaluate(`document.querySelector('.layout-primary [data-module=settings]').click();`);
  assert.equal(await evaluate(`document.querySelector('.layout-secondary [data-route=layoutBackupBtn]')===null`),true);
  await evaluate(`currentUser=window.__mainUser;delete window.__mainUser;applyAccountUi();document.querySelector('#clearProjectFiltersBtn').click();`);
  checks.push('新导航沿用功能权限；仅客户权限时不显示收付款/其他往来工具及完整备份入口');
  await evaluate(`document.querySelector('#projectsPageBtn').click();`);
  const stages = { '待确认': '画册待确认', '待开票': '礼盒待开票', '待回款': '海报待回款', '已结单': '已完成项目', delivery: '名片制作' };
  for (const [stage, expected] of Object.entries(stages)) {
    const result = await evaluate(`document.querySelector('#stageFilter').value=${JSON.stringify(stage)}; document.querySelector('#stageFilter').dispatchEvent(new Event('change')); [...document.querySelectorAll('#projectRows tr:not(.month-divider)')].map(n=>n.querySelector('.project-name').textContent);`);
    assert.deepEqual(result, [expected]);
  }
  checks.push('五种项目阶段能准确筛选');
  await evaluate(`document.querySelector('#stageFilter').value='all'; document.querySelector('#stageFilter').dispatchEvent(new Event('change'));`);
  await screenshot('02-project-ledger');
  await evaluate(`document.querySelector('#search').value='海报'; document.querySelector('#customerFilter').value='另一客户'; document.querySelector('#monthFilter').value=${JSON.stringify(today.slice(0,7))}; document.querySelector('#stageFilter').value='待回款'; document.querySelector('#projectSupplierFilter').value='乙供应商'; renderRows();`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#projectRows .project-name')].map(n=>n.textContent)`), ['海报待回款']);
  assert.ok(await evaluate(`toCsv(filteredProjects()).includes('海报待回款') && !toCsv(filteredProjects()).includes('礼盒待开票')`));
  await evaluate(`document.querySelector('#projectOwnerFilter').value=currentUser.id; document.querySelector('#projectOwnerFilter').dispatchEvent(new Event('change'));`);
  assert.equal(await evaluate(`document.querySelectorAll('#projectRows .project-name').length`),0);
  await evaluate(`document.querySelector('#clearProjectFiltersBtn').click();`);
  assert.equal(await evaluate(`document.querySelectorAll('#projectRows .project-name').length`),5);
  checks.push('关键词、客户、月份、阶段、供应商、负责人组合筛选准确；导出使用同一结果；清除恢复列表');
  assert.equal(hash(join(dataDir, 'projects.json')), initialDataHash);
  checks.push('查找、筛选、首页浏览均不修改原业务数据');
  await evaluate(`document.querySelector('.minimal-more').open=true; document.querySelector('#annualSalesBtn').click();`);
  await waitUntil(() => evaluate(`document.querySelector('#annualSalesDialog').open`), '年度报表打开');
  await evaluate(`editProjectFromDrilldown('making');`);
  assert.equal(await evaluate(`document.querySelector('#annualSalesDialog').open`), false);
  assert.equal(await evaluate(`document.querySelector('#projectId').value`), 'making');
  assert.equal(hash(join(dataDir, 'projects.json')), initialDataHash);
  checks.push('年度报表进入编辑正确关闭父报表，未保存不改数据');
  assert.equal(await evaluate(`document.querySelector('.minimal-stock').open`), false);
  await screenshot('06-order-form');
  await evaluate(`document.querySelector('#projectsPageBtn').click(); document.querySelector('#search').value='名片'; renderRows(); window.__listFilters={search:document.querySelector('#search').value,stage:document.querySelector('#stageFilter').value,supplier:document.querySelector('#projectSupplierFilter').value}; handleExecutionProject('making');`);
  await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=order]').click(); document.querySelector('#remark').value='未保存切换测试'; document.querySelector('#remark').dispatchEvent(new Event('input')); document.querySelector('#mergedProjectTabs [data-tab=progress]').click(); document.querySelector('#mergedProjectTabs [data-tab=order]').click();`);
  assert.equal(await evaluate(`document.querySelector('#remark').value`),'未保存切换测试');
  assert.equal(await evaluate(`document.querySelectorAll('#projectForm').length`),1);
  assert.equal(hash(join(dataDir, 'projects.json')),initialDataHash);
  await evaluate(`document.querySelector('#remark').value=''; document.querySelector('#mergedProjectTabs [data-tab=files]').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#fileProjectId').value==='making' && document.querySelector('#fileProjectSelect').disabled && !document.querySelector('#fileDialog').open`),'文件嵌入同一项目详情');
  const folderMetadata=await evaluate(`apiJson('/api/files?projectId=making')`);
  const archiveSettings=JSON.parse(readFileSync(join(dataDir,'settings.json'),'utf8'));
  const folderTarget=resolve(archiveSettings.archiveRoot,folderMetadata.archiveFolder);
  assert.ok(folderTarget.startsWith(resolve(userData)));
  assert.ok(folderTarget.includes('测试客户') && folderTarget.includes('名片制作'));
  assert.ok(folderTarget.includes(`${new Date(today).getFullYear()}年`));
  assert.equal(await evaluate(`document.querySelector('#fileUploadForm').closest('#mergedFilesPanel')!==null`),true);
  await screenshot('07-merged-project-files');
  await evaluate(`window.__folderRequest=null;window.__savedApi=apiJson;apiJson=async(url,options)=>{if(url.startsWith('/api/files/open-folder')){window.__folderRequest={id:new URL(url,location.origin).searchParams.get('projectId'),method:options.method};return {ok:true,openedOnHost:true};}return window.__savedApi(url,options);};document.querySelector('#mergedOpenFolderBtn').click();`);
  await waitUntil(()=>evaluate(`window.__folderRequest!==null`),'详情打开文件夹请求');
  assert.deepEqual(await evaluate(`window.__folderRequest`),{id:'making',method:'POST'});
  await evaluate(`apiJson=window.__savedApi;delete window.__savedApi;document.querySelector('#mergedProjectTabs [data-tab=order]').click(); document.querySelector('#remark').value='合并详情保存测试'; document.querySelector('#projectForm').requestSubmit();`);
  await waitUntil(()=>JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).find(p=>p.id==='making').remark==='合并详情保存测试','详情内保存订单');
  assert.equal(JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).length,5);
  const savedOrder=JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).find(p=>p.id==='making');
  assert.equal(savedOrder.customer,'测试客户');
  assert.equal(savedOrder.customerContact,'测试联系人');
  assert.equal(savedOrder.receivable,1000);
  assert.ok(existsSync(folderTarget));
  writeFileSync(join(folderTarget,'从文件夹新增.txt'),'isolated preview file','utf8');
  await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=files]').click();`);
  await waitUntil(()=>evaluate(`currentProjectFiles.some(file=>file.name==='从文件夹新增.txt')`),'文件夹新增资料切回文件标签可见');
  await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=order]').click();`);
  assert.equal(await evaluate(`document.querySelector('#projectForm').closest('#mergedOrderPanel')!==null`),true);
  checks.push('同一详情内切换订单、进度和文件；未保存内容保留；保存不新增重复项目；文件锁定当前项目；文件夹按钮绑定正确ID');
  await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=progress]').click();`);
  await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=money]').click();document.querySelector('#mergedSupplierPaymentDetails').open=true;`);
  assert.equal(await evaluate(`document.querySelector('#paymentList').closest('#mergedSupplierPayments')!==null`),true);
  assert.equal(await evaluate(`document.querySelectorAll('#paymentList .supplier-master-row').length`),1);
  if(productionTest){
    await evaluate(`document.querySelector('#payment-amount-making-item-making').value='125';saveSupplierPayment('making','item-making');`);
    await waitUntil(()=>JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).find(p=>p.id==='making').supplierItems[0].paidAmount===125,'部分付款保留真实流水');
    await waitUntil(()=>evaluate(`supplierPayments.length===1 && document.querySelector('#payment-amount-making-item-making')!==null`),'付款流水刷新');
    await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=money]').click();document.querySelector('#payment-amount-making-item-making').value='175';saveSupplierPayment('making','item-making');`);
  }else{
    await evaluate(`document.querySelector('#payment-status-making-item-making').value='yes'; document.querySelector('#payment-date-making-item-making').value=${JSON.stringify(today)}; document.querySelector('#mergedSupplierPayments #paymentList .supplier-master-row button').click();`);
  }
  await waitUntil(()=>JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).find(p=>p.id==='making').supplierItems[0].paid===true,'详情内保存供应商付款');
  checks.push('供应商付款并入同一项目详情，仅显示并更新当前项目明细');
  if(productionTest){const payments=JSON.parse(readFileSync(join(dataDir,'supplier-payments.json'),'utf8'));assert.deepEqual(payments.map(p=>p.amount).sort((a,b)=>a-b),[125,175]);checks.push('正式版保留两笔真实供应商付款流水和部分付款核销');}
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#workflowRows .workflow-project-group')].map(n=>n.dataset.projectId)`), ['making']);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#workflowSummary')).display`), 'none');
  await screenshot('03-single-project');
  await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=progress]').click();`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#mergedMoneyPanel')).display`),'none');
  await screenshot('10-delivery-page');
  checks.push('逐项目处理只显示所选项目');
  for (const [selector, field] of [['#workflow-item-shipped-making-item-making', 'shipped'], ['#workflow-item-accepted-making-item-making', 'accepted']]) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).value='yes'; document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change'));`);
    await waitUntil(() => { const p = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8')).find(p=>p.id==='making'); return p.supplierItems[0][field] === true; }, field);
    await waitUntil(() => evaluate(`workflowSaving === false`), '保存完成');
  }
  await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=money]').click();document.querySelector('#workflow-invoiced-making').value='yes'; document.querySelector('#workflow-invoiced-making').dispatchEvent(new Event('change'));`);
  await waitUntil(() => JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8')).find(p=>p.id==='making').invoiced === true, '开票保存');
  await waitUntil(() => evaluate(`workflowSaving === false`), '开票刷新完成');
  await evaluate(`document.querySelector('#workflow-paid-making').value='yes'; document.querySelector('#workflow-paid-making').dispatchEvent(new Event('change'));`);
  await waitUntil(() => JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8')).find(p=>p.id==='making').paid === true, '回款保存');
  await waitUntil(() => evaluate(`workflowSaving === false`), '回款刷新完成');
  const final = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8'));
  const changed = final.find(p=>p.id==='making');
  assert.ok(changed.invoiceDate && changed.paymentDate && changed.supplierItems[0].shippingDate && changed.supplierItems[0].acceptanceDate);
  for (const p of fixture.filter(p=>p.id!=='making')) assert.deepEqual(final.find(x=>x.id===p.id), p);
  if(productionTest){
    await evaluate(`supplierPayments=[];document.querySelector('#mergedProjectTabs [data-tab=progress]').click();document.querySelector('#mergedProjectTabs [data-tab=money]').click();`);
    await waitUntil(()=>evaluate(`supplierPayments.length===2 && document.querySelector('#paymentList').textContent.includes('125.00')`),'项目收付款页独立读取历史流水');
    await evaluate(`document.querySelector('#mergedProjectTabs [data-tab=order]').click();document.querySelector('#remark').value='交付付款后编辑保留测试';document.querySelector('#projectForm').requestSubmit();`);
    await waitUntil(()=>JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).find(p=>p.id==='making').remark==='交付付款后编辑保留测试','交付付款后编辑订单');
    const item=JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).find(p=>p.id==='making').supplierItems[0];
    assert.equal(item.shipped,true);assert.equal(item.accepted,true);assert.equal(item.paidAmount,300);assert.ok(item.shippingDate&&item.acceptanceDate&&item.lastPaymentDate);
    assert.equal(JSON.parse(readFileSync(join(dataDir,'supplier-payments.json'),'utf8')).length,2);
    checks.push('已交付、已付款后编辑订单保留明细进度、日期、付款金额及原流水');
  }
  checks.push('真实界面完成单项目发货、确认、开票、回款，其他四个项目不变');
  await evaluate(`document.querySelector('#mergedBackBtn').click();`);
  await evaluate(`window.__savedApi=apiJson;window.__folderRequest=null;apiJson=async(url,options)=>{if(url.startsWith('/api/files/open-folder')){window.__folderRequest=new URL(url,location.origin).searchParams.get('projectId');return {ok:true,openedOnHost:true};}return window.__savedApi(url,options);};document.querySelector('#projectRows .row-actions button:not(.primary)').click();`);
  await waitUntil(()=>evaluate(`window.__folderRequest==='making'`),'列表文件夹请求');
  await evaluate(`apiJson=window.__savedApi;delete window.__savedApi;`);
  assert.deepEqual(await evaluate(`({search:document.querySelector('#search').value,stage:document.querySelector('#stageFilter').value,supplier:document.querySelector('#projectSupplierFilter').value})`),await evaluate(`window.__listFilters`));
  assert.equal(await evaluate(`document.querySelector('#projectForm').closest('.order-only')!==null`),true);
  assert.equal(await evaluate(`document.querySelector('#fileUploadForm').closest('#fileDialog')!==null`),true);
  assert.equal(await evaluate(`document.querySelector('#paymentList').closest('#paymentDialog')!==null`),true);
  await evaluate(`document.querySelector('#orderPageBtn').click();`);
  assert.equal(await evaluate(`document.querySelector('#projectId').value`),'');
  await evaluate(`document.querySelector('#projectsPageBtn').click(); document.querySelector('#stageFilter').value='已结单'; document.querySelector('#stageFilter').dispatchEvent(new Event('change'));`);
  assert.ok(await evaluate(`document.querySelector('#projectRows').innerText.includes('名片制作')`));
  checks.push('返回列表保留筛选，原订单与文件控件归位；新增项目不继承旧ID；结单阶段即时更新');
  assert.equal(await evaluate(`document.querySelector('#taxPageBtn').hidden`),true);
  await evaluate(`document.querySelector('.layout-primary [data-module=settings]').click();document.querySelector('#featureSettingsBtn').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#taxFeatureStatus').textContent.includes('默认关闭')`),'可选功能设置');
  await evaluate(`document.querySelector('#taxFeatureEnabled').checked=true;document.querySelector('#taxFeatureForm').requestSubmit();`);
  await waitUntil(()=>evaluate(`companyFeatures.taxAssistant===true`),'启用税务助手');
  await evaluate(`document.querySelector('.layout-primary [data-module=reports]').click();document.querySelector('#taxPageBtn').click();`);
  await waitUntil(()=>evaluate(`document.querySelectorAll('[data-tax-review]').length>0`),'税务提醒读取');
  assert.equal(await evaluate(`document.querySelector('#layoutPageTitle').textContent`),'税务助手');
  const issue=await evaluate(`document.querySelector('[data-tax-project="invoice"]')?.dataset.taxAction`);assert.equal(issue,'money');
  await evaluate(`document.querySelector('[data-tax-project="invoice"]').click();`);
  await waitUntil(()=>evaluate(`window.projectWorkspace.id==='invoice'&&!document.querySelector('#mergedMoneyPanel').classList.contains('hidden')`),'提醒跳到对应项目收付款');
  await evaluate(`document.querySelector('.layout-primary [data-module=reports]').click();document.querySelector('#taxPageBtn').click();`);
  await waitUntil(()=>evaluate(`document.querySelectorAll('[data-tax-review]').length>0`),'返回助手');
  await evaluate(`document.querySelector('[data-tax-tab="ledger"]').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#taxInvoiceProject option[value=invoice]')!==null`),'复用发票登记');
  assert.equal(await evaluate(`document.querySelector('#taxInvoiceForm').closest('#assistantLedgerPanel')!==null`),true);
  await evaluate(`document.querySelector('#taxInvoiceNumber').value='SMOKE-20261014';document.querySelector('#taxInvoiceDate').value=${JSON.stringify(today)};document.querySelector('#taxInvoiceAmount').value='1000';document.querySelector('#taxInvoiceParty').value='测试客户';document.querySelector('#taxInvoiceProject').value='invoice';document.querySelector('#taxInvoiceForm').requestSubmit();`);
  await waitUntil(()=>evaluate(`document.querySelector('#taxInvoiceList').textContent.includes('SMOKE-20261014')`),'真实登记发票并关联现有项目');
  await screenshot('14-tax-ledger');
  await evaluate(`document.querySelector('#assistantRefresh').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#assistantStatus').textContent!=='正在读取公司主机资料…'`),'登记后刷新提醒');
  const reportAfterInvoice=await evaluate(`apiJson('/api/tax-assistant/report?period='+document.querySelector('#assistantPeriod').value)`);
  assert.equal(reportAfterInvoice.tasks.some(t=>t.id==='issue:invoice'),false);
  assert.ok(reportAfterInvoice.tasks.some(t=>t.id.startsWith('original:')&&t.projectId==='invoice'));
  checks.push('复用已有票据登记表真实保存并关联项目；已登记发票不重复提醒开票，缺原件单独提示');
  await evaluate(`document.querySelector('[data-tax-tab="accountant"]').click();document.querySelector('[data-tax-evidence="accountant:period"]').value='已对照会计逐笔确认';document.querySelector('[data-tax-evidence="accountant:period"]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-tax-tab="invoice"]').click();document.querySelector('[data-tax-tab="accountant"]').click();`);
  assert.equal(await evaluate(`document.querySelector('[data-tax-evidence="accountant:period"]').value`),'已对照会计逐笔确认');
  await evaluate(`document.querySelector('#assistantRefresh').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#assistantStatus').textContent!=='正在读取公司主机资料…'`),'刷新后保留核对草稿');
  assert.equal(await evaluate(`document.querySelector('[data-tax-evidence="accountant:period"]').value`),'已对照会计逐笔确认');
  await evaluate(`document.querySelector('[data-tax-review="accountant:period"]').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('[data-tax-review="accountant:period"]').textContent==='撤销核对记录'`),'保存人工核对记录');
  await screenshot('12-tax-assistant');
  checks.push('税务助手默认关闭；主账号可选启用；提醒直达项目收付款；切换与刷新保留草稿，人工核对写入本地');
  await evaluate(`document.querySelector('[data-tax-tab="export"]').click();`);
  assert.equal(await evaluate(`document.querySelector('#assistantDownloadExport').disabled`),true);
  assert.equal(await evaluate(`document.querySelector('#assistantIncludeFiles').checked`),false);
  await evaluate(`document.querySelector('#assistantPreviewExport').click();`);
  await waitUntil(()=>evaluate(`!document.querySelector('#assistantDownloadExport').disabled`),'资料包先预览');
  await screenshot('13-tax-export-preview');
  const downloads=join(output,'downloads');mkdirSync(downloads);
  await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await evaluate(`document.querySelector('#assistantDownloadExport').click();`);
  const zipName='会计资料-'+today.slice(0,7)+'.zip';
  await waitUntil(()=>existsSync(join(downloads,zipName)),'真实下载月度ZIP');
  assert.equal(readFileSync(join(downloads,zipName)).readUInt32LE(),0x04034b50);
  await evaluate(`document.querySelector('[data-tax-tab="reference"]').click();`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-tax-source]').length`),3);
  assert.equal(await evaluate(`window.desktopBridge.openTaxReference('unknown-source').then(()=>false,()=>true)`),true);
  assert.equal(foreignRequests,0);
  checks.push('资料包默认不含原件、先预览后真实下载ZIP；官方参考离线显示且不自动联网，非法官网入口被拒绝');
  await call('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.querySelector('[data-tax-tab="ledger"]').click();document.querySelector('.assistant-invoice-editor').open=true;`);
  await waitUntil(()=>evaluate(`document.querySelector('#taxInvoiceList').textContent.includes('SMOKE-20261014')`),'窄窗口票据登记');
  assert.equal(await evaluate(`(()=>{const panel=document.querySelector('#assistantLedgerPanel');return panel.scrollWidth<=panel.clientWidth+2&&document.documentElement.scrollWidth<=innerWidth+2;})()`),true);
  await screenshot('15-tax-ledger-1024');
  await call('Emulation.clearDeviceMetricsOverride');
  checks.push('1024宽度税务助手票据与登记表不水平裁切');
  await evaluate(`document.querySelector('.layout-primary [data-module=settings]').click();document.querySelector('#featureSettingsBtn').click();`);
  await waitUntil(()=>evaluate(`document.querySelector('#taxFeatureEnabled').checked&&document.querySelector('#taxFeatureStatus').textContent.includes('默认关闭')`),'重新读取可选功能');
  await evaluate(`document.querySelector('#taxFeatureEnabled').checked=false;document.querySelector('#taxFeatureForm').requestSubmit();`);
  await waitUntil(()=>evaluate(`companyFeatures.taxAssistant===false&&document.querySelector('#taxPageBtn').hidden`),'停用助手入口');
  assert.ok(JSON.parse(readFileSync(join(dataDir,'tax-assistant-reviews.json'),'utf8')).some(r=>r.taskId==='accountant:period'&&r.done));
  checks.push('停用税务助手隐藏入口并保留本地核对记录');
  if(productionTest){
    const lateQuote={...fixture[1],id:'quote-later',name:'后补供应商报价测试',supplierItems:[{...fixture[1].supplierItems[0],id:'quote-zero',supplier:'',purchaseTotal:0,payable:0,shipped:true,shippingDate:today,accepted:true,acceptanceDate:today},{id:'quote-paid',itemName:'另一已付款工艺',supplier:'已付供应商',quantity:1,saleUnitPrice:0,purchaseTotal:200,payable:200,paid:false}]};
    await evaluate(`apiJson('/api/projects',{method:'POST',body:JSON.stringify(${JSON.stringify(lateQuote)})})`);
    await evaluate(`apiJson('/api/supplier-payments',{method:'POST',body:JSON.stringify({projectId:'quote-later',supplierItemId:'quote-paid',amount:75,paymentDate:${JSON.stringify(today)}})})`);
    await evaluate(`Promise.all([loadProjects(),loadSupplierPayments()]).then(()=>window.projectWorkspace.open('quote-later','money'))`);
    await evaluate(`document.querySelector('#mergedSupplierPaymentDetails').open=true;`);
    assert.ok(await evaluate(`document.querySelector('#paymentList').textContent.includes('待补报价 / 零金额明细')`));
    assert.equal(await evaluate(`document.querySelector('[data-supplier-quote="quote-zero"]').closest('.payment-group').textContent.includes('已付清')`),false);
    await evaluate(`window.__quoteUser=currentUser;currentUser={role:'sub',permissions:['payments']};renderPayments();`);
    assert.equal(await evaluate(`document.querySelectorAll('[data-supplier-quote]').length`),0);
    await evaluate(`currentUser=window.__quoteUser;delete window.__quoteUser;renderPayments();document.querySelector('[data-supplier-quote="quote-zero"]').scrollIntoView({block:'center'});`);
    await screenshot('16-quote-missing');
    await evaluate(`document.querySelector('[data-supplier-quote="quote-zero"]').click();`);
    assert.equal(await evaluate(`window.projectWorkspace.tab`),'order');
    assert.equal(await evaluate(`document.activeElement.closest('.supplier-item')?.dataset.id`),'quote-zero');
    await evaluate(`(()=>{const row=document.activeElement.closest('.supplier-item');row.querySelector('[data-field="supplier"]').value='后补供应商';const price=row.querySelector('[data-field="purchaseTotal"]');price.value='350';price.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#projectForm').requestSubmit();})()`);
    await waitUntil(()=>JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).find(p=>p.id==='quote-later')?.supplierItems.find(i=>i.id==='quote-zero')?.payable===350,'真实保存首次漏填后的供应商报价');
    await waitUntil(()=>evaluate(`!document.querySelector('#saveProjectBtn').disabled`),'后补保存完成');
    await evaluate(`window.projectWorkspace.open('quote-later','money')`);
    assert.equal(await evaluate(`document.querySelector('#payment-amount-quote-later-quote-zero').value`),'350.00');
    assert.equal(await evaluate(`document.querySelector('#payment-amount-quote-later-quote-paid').value`),'125.00');
    const quoteSaved=JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).find(p=>p.id==='quote-later'),zero=quoteSaved.supplierItems.find(i=>i.id==='quote-zero');
    assert.equal(zero.shipped,true);assert.equal(zero.accepted,true);assert.equal(zero.shippingDate,today);assert.equal(zero.acceptanceDate,today);
    assert.equal(quoteSaved.supplierItems.find(i=>i.id==='quote-paid').paidAmount,75);
    assert.equal(JSON.parse(readFileSync(join(dataDir,'supplier-payments.json'),'utf8')).filter(p=>p.projectId==='quote-later').length,1);
    await evaluate(`document.querySelector('#mergedSupplierPaymentDetails').open=true;document.querySelector('[data-supplier-quote="quote-zero"]').scrollIntoView({block:'center'});`);await screenshot('17-quote-filled');
    checks.push('首次漏填报价不显示已付清；补填按钮直达原明细，真实保存后应付更新，另一明细部分付款与交付日期保留');
  }
  const idsUnique = await evaluate(`(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return ids.length===new Set(ids).size;})()`);
  assert.ok(idsUnique);
  assert.equal(errors.length, 0);
  assert.equal(hash(originalExe), originalHash);
  checks.push('真实 DOM ID 唯一，无页面异常，验收参考源码摘要保持不变');
  await screenshot('04-completed');
  writeFileSync(join(output, 'report.json'), JSON.stringify({ ok: true, output, executable: exe, checks, errors, originalHash }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, output, checks }, null, 2));
} catch (error) {
  if (socket?.readyState === 1) await screenshot('failure').catch(()=>{});
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors, stderr: stderr.slice(-20) }, null, 2), 'utf8');
  console.error(error); process.exitCode = 1;
} finally {
  foreignServer.close();
  if (socket?.readyState === 1) { await call('Page.close').catch(()=>{}); socket.close(); }
  for (let i=0; i<30 && child.exitCode===null; i++) await pause(100);
  if (child.exitCode===null) child.kill();
}
