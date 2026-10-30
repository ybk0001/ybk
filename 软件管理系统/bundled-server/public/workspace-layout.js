/* Navigation adapts existing views; business forms and handlers remain canonical. */
(() => {
  const $ = id => document.getElementById(id);
  const production = document.body.dataset.production === 'true';
  const localEdition = document.body.dataset.edition === 'local';
  const groups = [
    { id: 'home', label: '工作台', icon: '◫', routes: [['dashboardPageBtn', '今日待办', 'dashboard'], ['deliveryBoardPageBtn', '交付跟进', 'deliveryBoardDialog'], ['collectionBoardPageBtn', '开票与回款', 'collectionBoardDialog']] },
    { id: 'projects', label: '项目管理', icon: '▤', routes: [['projectsPageBtn', '项目台账', 'projects'], ['fileCenterBtn', '文件中心', 'fileDialog'], ['operationsBtn', '批量分配', 'operationsDialog']] },
    { id: 'money', label: '收付款', icon: '↔', routes: [['paymentsBtn', '供应商付款', 'paymentDialog'], ['settlementBatchBtn', '客户结算', 'settlementBatchDialog'], ['expenseBtn', '日常费用', 'expenseDialog']] },
    { id: 'contacts', label: '往来资料', icon: '▦', routes: [['customerManagerBtn', '客户', 'customerDialog'], ['supplierManagerBtn', '供应商', 'supplierDialog'], ['inventoryBtn', '库存', 'inventoryDialog'], ['processBtn', '常用工艺', 'processDialog']] },
    { id: 'reports', label: '经营报表', icon: '▥', routes: [['financePageBtn', '资金总览', 'finance'], ['annualSalesBtn', '客户年度销售', 'annualSalesDialog'], ['taxPageBtn', '税务助手', 'taxAssistantDialog']] },
    { id: 'settings', label: '系统设置', icon: '⚙', routes: [['accountManagerBtn', '账号与权限', 'accountDialog'], ['archiveSettingsBtn', '文件存放', 'archiveSettingsDialog'], ['themeBtn', '界面颜色', 'themeDialog'], ['featureSettingsBtn', '可选功能', 'featureSettingsDialog'], ['layoutBackupBtn', '备份与恢复', 'layoutBackupDialog']] }
  ];
  let active = 'projects', route = 'projectsPageBtn', switching = false;
  const header = document.querySelector('.app > header');
  header.classList.add('layout-sidebar');
  const legacyNav = document.querySelector('.nav-row');
  legacyNav.classList.add('layout-legacy-nav');
  const brand = header.firstElementChild;
  brand.querySelector('h1').textContent = '项目收付款';
  const edition = document.createElement('small'); edition.textContent = '企业工作空间'; brand.append(edition);
  const nav = document.createElement('nav'); nav.className = 'layout-primary'; nav.setAttribute('aria-label', '一级导航');
  header.insertBefore(nav, header.querySelector('.header-actions'));
  for (const group of groups) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.module = group.id;
    const icon = document.createElement('span'); icon.textContent = group.icon; icon.setAttribute('aria-hidden','true');
    button.append(icon, document.createTextNode(group.label));
    button.addEventListener('click', () => { const first = available(group)[0]; if(first) $(first[0]).click(); });
    nav.append(button);
  }
  const footer = document.createElement('div'); footer.className='layout-edition'; footer.textContent=localEdition?'3.1 候选 · 本地部署':production?'3.0 · 项目收付款':'3.0 · 布局试用'; header.append(footer);
  const top = document.createElement('div'); top.className='layout-top';
  top.innerHTML='<div id="layoutBreadcrumb"></div><span class="layout-local">独立本机试用</span>';
  if(production) top.querySelector('.layout-local').textContent=localEdition?'本地部署 · 公司自有账本':'NAS 共享账本';
  const secondary = document.createElement('nav'); secondary.className='layout-secondary'; secondary.setAttribute('aria-label','二级导航');
  const heading = document.createElement('div'); heading.className='layout-heading';
  heading.innerHTML='<div><h2 id="layoutPageTitle">项目台账</h2><p id="layoutPageDescription"></p></div><button class="btn primary" id="layoutNewProjectBtn" type="button">＋ 新建项目</button>';
  header.after(top, secondary, heading);
  $('layoutNewProjectBtn').addEventListener('click',()=> $('orderPageBtn').click());
  const backup = document.createElement('dialog'); backup.id='layoutBackupDialog';
  backup.innerHTML='<div class="section-head"><h2>备份与恢复</h2><button class="btn" type="button">返回项目台账</button></div><div class="dialog-body"><p class="mini">完整备份包含业务数据和附件。请妥善保存备份文件。</p></div>';
  backup.querySelector('button').addEventListener('click',()=>backup.close());
  backup.querySelector('.dialog-body').append(document.querySelector('.data-tools-panel'));
  document.body.append(backup);
  const backupButton = document.createElement('button'); backupButton.id='layoutBackupBtn'; backupButton.type='button'; backupButton.hidden=true;
  legacyNav.append(backupButton); backupButton.addEventListener('click',()=>backup.showModal());
  const boards = {};
  for (const [name, summaryId, buttonId, dialogId, label] of [
    ['delivery', 'deliverySummary', 'deliveryBoardPageBtn', 'deliveryBoardDialog', '交付跟进'],
    ['collection', 'collectionSummary', 'collectionBoardPageBtn', 'collectionBoardDialog', '开票与回款']
  ]) {
    const section=$(summaryId).closest('section'), dialog=document.createElement('dialog');
    dialog.id=dialogId; dialog.classList.add('layout-followup-board');
    // Reuse the original lists and handlers; no second project or finance form.
    section.querySelector('.section-head button')?.remove();
    dialog.append(section); document.body.append(dialog); boards[name]=dialog;
    const button=document.createElement('button'); button.id=buttonId; button.type='button'; button.textContent=label;
    legacyNav.append(button); button.addEventListener('click',()=>{
      if(name==='delivery') renderDeliveryBoard(); else renderCollectionBoard();
      dialog.showModal();
    });
  }
  document.querySelector('.minimal-overview').hidden=true;
  $('collectionList').addEventListener('click',event=>{
    const button=event.target.closest('button[onclick^="openDeliveryProject("]');
    if(!button) return;
    const id=button.getAttribute('onclick').match(/^openDeliveryProject\('([^']+)'\)$/)?.[1];
    if(!id) return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.openDeliveryProject(id,'money');
  },true);
  for(const [barId,buttonId] of [['deliveryAlertBar','deliveryAlertAction'],['cashflowAlertBar','cashflowAlertAction'],['fileRequiredAlertBar','fileRequiredAlertAction']]) {
    $(barId).classList.add('layout-action-card');
    $(barId).addEventListener('click',event=>{ if(!event.target.closest('button')) $(buttonId).click(); });
  }
  const available = group => group.routes.filter(([id]) => { const el=$(id); return el && (id==='layoutBackupBtn' ? !document.querySelector('.data-tools').classList.contains('hidden') : (!el.hidden && !el.classList.contains('hidden'))); });
  const allRoutes = groups.flatMap(g=>g.routes.map(r=>({group:g, entry:r})));
  const pageDialogs = allRoutes.filter(r=>r.entry[2].endsWith('Dialog')).map(r=>$(r.entry[2]));
  function closePages(except) {
    switching=true;
    for (const d of pageDialogs) if(d!==except && d.open) d.close();
    switching=false;
  }
  function paint(group, entry, title=entry[1]) {
    active=group.id; route=entry[0];
    for(const button of nav.children) {
      const g=groups.find(item=>item.id===button.dataset.module);
      button.hidden=!available(g).length;
      button.setAttribute('aria-current',g.id===active?'page':'false');
    }
    $('layoutBreadcrumb').textContent=`工作空间 / ${group.label} / ${title}`;
    $('layoutPageTitle').textContent=title;
    $('layoutPageDescription').textContent=entry[2]==='deliveryBoardDialog' ? '先选择逾期、临期或待发货项目，再进入项目确认制作与交付进度。' : entry[2]==='collectionBoardDialog' ? '先选择待开票或待回款项目；每条记录说明下一步，点击按钮进入该项目的收付款。' : group.id==='projects' && entry[2]==='projects' ? '查找项目、查看进度，从一条记录进入全部资料。' : '';
    $('layoutNewProjectBtn').hidden=group.id!=='projects' || entry[2]!=='projects' || $('orderPageBtn').classList.contains('hidden');
    secondary.replaceChildren(...available(group).map(item=>{
      const b=document.createElement('button'); b.type='button'; b.textContent=item[1]; b.dataset.route=item[0]; b.setAttribute('aria-current',item[0]===route?'page':'false');
      b.addEventListener('click',()=>$(item[0]).click()); return b;
    }));
  }
  for(const {group,entry} of allRoutes) {
    if(!entry[2].endsWith('Dialog')) continue;
    const dialog=$(entry[2]);
    dialog.classList.add('layout-module-page');
    // Only long-lived module pages are non-modal; task dialogs retain native modality.
    dialog.showModal=function() {
      closePages(dialog);
      showMainPage('projects');
      document.body.classList.add('layout-module-open');
      paint(group,entry);
      if(!dialog.open) HTMLDialogElement.prototype.show.call(dialog);
    };
    dialog.addEventListener('close',()=>{
      if(!switching && !pageDialogs.some(d=>d.open)) {
        document.body.classList.remove('layout-module-open');
        window.workspaceLayout.onPage(document.body.classList.contains('view-settlement')?'settlement':'projects');
      }
    });
  }
  const editors={};
  for(const [name,formId] of [['customer','customerForm'],['supplier','supplierMasterForm']]) {
    const form=$(formId), editor=document.createElement('details'); editor.className='layout-editor';
    const summary=document.createElement('summary'); summary.textContent=name==='customer'?'＋ 新增 / 编辑客户':'＋ 新增 / 编辑供应商';
    form.before(editor); editor.append(summary,form); editors[name]=editor;
  }
  window.workspaceLayout={
    openBoard(name){ const dialog=boards[name]; if(dialog&&!dialog.open) dialog.showModal(); },
    openEditor(name){ const editor=editors[name]; if(editor){editor.open=true;editor.scrollIntoView({block:'nearest'});} },
    onWorkflow(){
      const target=$('layoutCustomerMoney'); target.replaceChildren();
      if(window.projectWorkspace?.id) {
        const head=document.querySelector('#workflowRows .workflow-project-head');
        if(head) target.append(head);
      }
    },
    onPage(page){
    closePages(); document.body.classList.remove('layout-module-open');
    const match=allRoutes.find(r=>r.entry[2]===page) || allRoutes.find(r=>r.entry[0]==='projectsPageBtn');
    paint(match.group,match.entry,page==='order'?'新建项目':page==='settlement'?'项目详情':match.entry[1]);
    heading.hidden=page==='settlement';
    $('layoutNewProjectBtn').hidden ||= page==='order';
  }};
  new MutationObserver(()=>{for(const button of nav.children){button.hidden=!available(groups.find(g=>g.id===button.dataset.module)).length;}})
    .observe(legacyNav,{subtree:true,attributes:true,attributeFilter:['class','hidden']});
  window.workspaceLayout.onPage('projects');
})();
