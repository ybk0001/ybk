(() => {
  const form = document.getElementById('projectForm');
  const formHome = document.createComment('project-form-home');
  form.before(formHome);
  const fileBody = document.querySelector('#fileDialog > .dialog-body');
  const fileHome = document.createComment('project-files-home');
  fileBody.before(fileHome);
  const paymentBody = document.querySelector('#paymentDialog > .dialog-body');
  const paymentHome = document.createComment('supplier-payments-home');
  paymentBody.before(paymentHome);
  let paymentVersion = '';
  const nativeOpenFiles = window.openProjectFiles;
  let currentId = '';
  let currentTab = 'progress';
  let formProjectId = '';
  let formVersion = '';
  let loadedFormFingerprint = '';
  const fingerprint = () => JSON.stringify([...form.elements].map(el=>[el.id,el.name,el.value,el.checked]));
  function onFormLoaded() {
    formVersion = document.getElementById('projectId').dataset.version || '';
    loadedFormFingerprint = fingerprint();
  }
  let loadedFilesId = '';
  let generation = 0;
  const ids = { progress: 'mergedProgressPanel', money: 'mergedMoneyPanel', order: 'mergedOrderPanel', files: 'mergedFilesPanel' };

  function restore() {
    formHome.after(form);
    fileHome.after(fileBody);
    paymentHome.after(paymentBody);
    paymentVersion = '';
    document.getElementById('mergedSupplierPaymentDetails').open = false;
    document.querySelector('#fileProjectSelect').disabled = false;
    currentId = '';
    formProjectId = '';
    formVersion = ''; loadedFormFingerprint = '';
    loadedFilesId = '';
    generation += 1;
  }

  async function tab(name) {
    if (!currentId || !ids[name]) return;
    const project = getCurrentProject(currentId);
    if (!project) return;
    currentTab = name;
    for (const [key, id] of Object.entries(ids)) document.getElementById(id).classList.toggle('hidden', key !== name);
    for (const button of document.querySelectorAll('#mergedProjectTabs button')) {
      const active = button.dataset.tab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    }
    if (name === 'order') {
      document.getElementById(ids.order).append(form);
      if (formProjectId !== currentId || (fingerprint() === loadedFormFingerprint && formVersion !== (project._version || ''))) {
        fillForm(project); formProjectId = currentId; onFormLoaded();
      }
    }
    if (name === 'progress' || name === 'money') {
      renderWorkflow();
      document.getElementById('mergedSupplierPayments').append(paymentBody);
      if (name === 'money' && typeof loadSupplierPayments === 'function') {
        const requestedId=currentId, requestedGeneration=generation;
        try { await loadSupplierPayments(); }
        catch(error) { showToast('付款流水读取失败：'+error.message,true); }
        if(currentId!==requestedId || generation!==requestedGeneration)return;
      }
      if (paymentVersion !== project._version) { renderPayments(); paymentVersion = project._version; }
    }
    if (name === 'files') {
      document.getElementById(ids.files).append(fileBody);
      const requestedId = currentId;
      const requestedGeneration = generation;
      if (loadedFilesId !== requestedId) {
        try {
          await nativeOpenFiles(requestedId);
          if (requestedId !== currentId || requestedGeneration !== generation) return;
          loadedFilesId = requestedId;
        } catch (error) { showToast('项目文件读取失败：' + error.message, true); }
      } else {
        try { await loadProjectFiles(requestedId); }
        catch (error) { showToast('项目文件刷新失败：' + error.message, true); }
      }
      document.querySelector('#fileProjectSelect').disabled = true;
    }
  }

  function refreshFilters() {
    const owner = document.getElementById('projectOwnerFilter');
    const canonical = document.getElementById('workbenchOwnerFilter');
    owner.innerHTML = canonical.innerHTML;
    owner.value = canonical.value;
    if (owner.options[0]?.value === 'all') owner.options[0].textContent = '全部负责人';
    const supplier = document.getElementById('projectSupplierFilter');
    const selected = supplier.value || 'all';
    const names = [...new Set(projects.flatMap(p=>normalizedSupplierItems(p).map(i=>i.supplier)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
    supplier.replaceChildren(new Option('全部供应商', 'all'), ...names.map(name=>new Option(name,name)));
    supplier.value = names.includes(selected) ? selected : 'all';
  }

  function refresh(count = filteredProjects().length) {
    document.getElementById('projectFilterCount').textContent = `筛选结果 ${count} 个 / 当前可查看 ${projects.length} 个项目`;
    const advancedCount = Number(document.getElementById('projectSupplierFilter').value !== 'all') + Number(document.getElementById('projectOwnerFilter').value !== 'all');
    document.querySelector('#projectAdvancedFilters > summary').textContent = advancedCount ? `更多筛选 · 已选 ${advancedCount} 项` : '更多筛选（负责人、供应商、排序）';
    if (!currentId) return;
    const project = getCurrentProject(currentId);
    if (!project) { showMainPage('projects'); return; }
    const money = calc(project);
    const state = executionState(project);
    document.getElementById('mergedProjectTitle').textContent = project.name || '项目详情';
    const summary = document.getElementById('mergedProjectSummary');
    summary.replaceChildren(...[
      ['客户', customerName(project)], ['当前阶段', state.stage], ['应收', moneyFmt.format(money.receivable)],
      ['成本', moneyFmt.format(money.totalCost)], ['毛利', moneyFmt.format(money.grossProfit)]
    ].map(([label, value])=>{const card=document.createElement('div');const caption=document.createElement('span');caption.textContent=label;const body=document.createElement('strong');body.textContent=value;card.append(caption,body);return card;}));
  }

  function open(id, initialTab = 'progress') {
    const project = getCurrentProject(id);
    if (!project) return showToast('未找到该项目，请刷新后重试。', true);
    for (const dialogId of ['operationsDialog', 'projectDrilldownDialog', 'annualSalesDialog', 'fileDialog']) {
      const dialog = document.getElementById(dialogId);
      if (dialog.open) dialog.close();
    }
    if (currentId !== id) restore();
    currentId = id;
    showMainPage('settlement', id);
    refresh();
    return tab(initialTab);
  }

  window.projectWorkspace = {
    get id() { return currentId; },
    get generation() { return generation; },
    get tab() { return currentTab; },
    open, refresh, refreshFilters, onFormLoaded,
    onPageChange(page, id) { if (page !== 'settlement' || id !== currentId) restore(); }
  };
  window.openProjectFiles = async (id = '') => {
    if (id && getCurrentProject(id)) return open(id, 'files');
    if (currentId) showMainPage('projects');
    fileHome.after(fileBody);
    return nativeOpenFiles(id);
  };
  document.getElementById('mergedProjectTabs').addEventListener('click', event=>{
    const button=event.target.closest('[data-tab]'); if(button) void tab(button.dataset.tab);
  });
  document.getElementById('mergedOpenFolderBtn').addEventListener('click',()=>{if(currentId) void openProjectFolder(currentId);});
  document.getElementById('mergedDeleteProjectBtn').addEventListener('click',()=>{if(currentId) void window.deleteProject(currentId);});
  document.getElementById('paymentsBtn').addEventListener('click',()=>{if(currentId)showMainPage('projects');paymentHome.after(paymentBody);},true);
  document.getElementById('orderPageBtn').addEventListener('click',()=>{restore();resetForm();});
  document.getElementById('confirmAndNewProjectBtn').addEventListener('click',()=>{showMainPage('order');resetForm();});
  document.getElementById('projectOwnerFilter').addEventListener('change',event=>{
    document.getElementById('workbenchOwnerFilter').value=event.target.value;renderRows();
  });
  document.getElementById('projectSupplierFilter').addEventListener('change',renderRows);
  document.getElementById('clearProjectFiltersBtn').addEventListener('click',()=>{
    els.search.value='';els.monthFilter.value='all';els.customerFilter.value='all';
    document.getElementById('stageFilter').value='all';document.getElementById('projectSupplierFilter').value='all';
    const owner=document.getElementById('workbenchOwnerFilter');owner.value=currentUser?.role==='main'?'all':currentUser?.id||owner.value;
    renderRows();
  });
  refreshFilters();refresh();
})();
