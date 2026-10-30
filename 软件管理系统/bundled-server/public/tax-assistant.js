(() => {
 const $=id=>document.getElementById(id), escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let report=null, tab='invoice', preview=null, generation=0, previewGeneration=0;
 const drafts=new Map();
 const ledgerTab=document.createElement('button');ledgerTab.className='btn';ledgerTab.type='button';ledgerTab.dataset.taxTab='ledger';ledgerTab.textContent='票据登记';
 document.querySelector('.assistant-tabs').append(ledgerTab);
 // Move the existing canonical ledger, including its handlers, rather than create another form.
 const ledgerCard=$('taxInvoiceForm').closest('.tax-card'),ledgerForm=$('taxInvoiceForm');
 $('assistantLedgerPanel').append(ledgerCard);
 const optional=document.createElement('details');optional.className='wide assistant-invoice-extra';optional.innerHTML='<summary>票种、税号和税额（可选）</summary><div class="tax-entry-form"></div>';
 for(const id of ['taxInvoiceKind','taxInvoiceCode','taxInvoiceRate','taxInvoiceTaxAmount','taxInvoiceSellerTaxId','taxInvoiceBuyerTaxId'])optional.lastElementChild.append($(id).closest('.field'));
 ledgerForm.insertBefore(optional,ledgerForm.lastElementChild);
 const entry=document.createElement('details');entry.className='assistant-invoice-editor';entry.innerHTML='<summary>＋ 新增发票登记</summary>';
 ledgerForm.before(entry);entry.append(ledgerForm);
 entry.before($('taxInvoiceList'));
 const imports=ledgerCard.querySelector('.tax-import-box'),importDetails=document.createElement('details');importDetails.className='assistant-invoice-editor';importDetails.innerHTML='<summary>批量导入已有票据清单</summary>';imports.before(importDetails);importDetails.append(imports);
 async function loadLedger(){
  const selectedPeriod=period();$('taxPeriod').value=selectedPeriod;
  try{const rows=await apiJson('/api/invoices');if(period()!==selectedPeriod)return;taxInvoices=rows;
   const select=$('taxInvoiceProject'),chosen=select.value;select.innerHTML='<option value="">让系统生成候选，稍后人工确认</option>'+projectOptions(chosen);renderTaxInvoices();
   if(!$('taxInvoiceDate').value)$('taxInvoiceDate').value=todayInputValue();
  }catch(error){fail(error);}
 }
 const period=()=>$('assistantPeriod').value;
 const key=id=>period()+':'+id;
 const fail=error=>{$('assistantStatus').textContent=error.message;showToast(error.message,true);};
 function render(){
  if(!report)return;
  $('assistantScope').textContent=report.scope;
  $('assistantStatus').textContent=report.fileWarnings.join('；');
  for(const button of document.querySelectorAll('[data-tax-tab]')){
   const type=button.dataset.taxTab;button.classList.toggle('primary',type===tab);button.setAttribute('aria-current',type===tab?'page':'false');
   const labels={invoice:'开票提醒',supplier:'供应商票据',accountant:'会计确认',export:'月度资料包',reference:'官方参考',ledger:'票据登记'};
   button.textContent=labels[type]+(['invoice','supplier','accountant'].includes(type)?` ${report.tasks.filter(t=>t.group===type&&!t.done).length}`:'');
  }
  $('assistantTaskList').hidden=['export','reference','ledger'].includes(tab);
  $('assistantLedgerPanel').hidden=tab!=='ledger';
  $('assistantExportPanel').hidden=tab!=='export';$('assistantReferencePanel').hidden=tab!=='reference';
  const tasks=report.tasks.filter(task=>task.group===tab);
  $('assistantTaskList').innerHTML=tasks.map(task=>`<article class="assistant-task ${task.done?'is-reviewed':''}"><div class="assistant-task-head"><h3>${escape(task.title)}</h3><span class="tag ${task.stale?'warn':task.done?'ok':'neutral'}">${task.stale?'资料变化，需重核':task.done?'已记录核对':'待核对'}</span></div>${task.projectName?`<strong>${escape(task.projectName)}</strong>`:''}<p>${escape(task.detail)}</p><label>核对说明（标记已核对时必填）<input maxlength="500" data-tax-evidence="${escape(task.id)}" value="${escape(drafts.get(key(task.id))??task.evidence)}" placeholder="例如：已与会计核对，原件在项目文件中；不适用时填写原因"></label><div class="assistant-task-actions">${task.projectId?`<button class="btn" type="button" data-tax-project="${escape(task.projectId)}" data-tax-action="${escape(task.action)}">${task.action==='money'?'打开项目收付款':'打开项目文件'}</button>`:''}<button class="btn" type="button" data-tax-review="${escape(task.id)}">${task.done?'撤销核对记录':'记录已核对'}</button><span class="mini">${task.reviewedAt?`${escape(task.reviewedBy)} · ${escape(task.reviewedAt.slice(0,16).replace('T',' '))}`:'核对记录只保存在公司主机'}</span></div></article>`).join('')||'<div class="empty">这个分类暂未发现待核对事项。请结合实际业务核对，空清单不代表已完成申报。</div>';
  $('assistantReferencePanel').innerHTML='<p>以下是随安装包保存的参考摘要，不是实时政策更新。联网时主动打开官网，不携带公司账本或查询内容。</p>'+report.sources.map(source=>`<article class="assistant-task"><h3>${escape(source.title)}</h3><p>${escape(source.guidance)}</p><p class="mini">${escape(source.scope)}</p><p class="mini">来源：${escape(source.publisher)} · 发布：${escape(source.publishedOn)} · 入口核对：${escape(source.checkedOn)}</p><a class="btn" href="${escape(source.url)}" rel="noreferrer noopener" target="_blank" data-tax-source="${escape(source.id)}">主动打开官方页面</a></article>`).join('');
 }
 function invalidatePreview(){previewGeneration++;preview=null;$('assistantDownloadExport').disabled=true;$('assistantExportPreview').replaceChildren();}
 async function refresh(){
  const request=++generation, selectedPeriod=period();invalidatePreview();$('assistantScope').textContent='';$('assistantStatus').textContent='正在读取公司主机资料…';
  try{const data=await apiJson('/api/tax-assistant/report?period='+encodeURIComponent(selectedPeriod));if(request!==generation||period()!==selectedPeriod)return;report=data;render();if(tab==='ledger')await loadLedger();}
  catch(error){if(request===generation){report=null;$('assistantTaskList').replaceChildren();fail(error);}}
 }
 window.taxAssistant={async open(){
  if(currentUser?.role!=='main'||!companyFeatures.taxAssistant)return showToast('请先在系统设置的可选功能中启用税务助手',true);
  if(!$('assistantPeriod').value)$('assistantPeriod').value=todayInputValue().slice(0,7);
  $('taxAssistantDialog').showModal();await refresh();
 }};
 $('featureSettingsBtn').addEventListener('click',async()=>{
  $('featureSettingsDialog').showModal();$('taxFeatureStatus').textContent='正在读取公司设置…';
  await loadFeatureSettings();$('taxFeatureEnabled').checked=companyFeatures.taxAssistant;
  $('taxFeatureStatus').textContent=companyFeatures.available?'默认关闭，开关对本公司的主机生效。':'当前公司主机尚不支持此功能，请先更新主机程序。';
 });
 $('taxFeatureForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter||$('taxFeatureForm').querySelector('button');button.disabled=true;
  try{const state=await apiJson('/api/features',{method:'PUT',headers:{'If-Match':companyFeatures.version},body:JSON.stringify({taxAssistant:$('taxFeatureEnabled').checked})});companyFeatures={...state,available:true};applyAccountUi();$('taxFeatureStatus').textContent=state.taxAssistant?'已启用。进入“经营报表 → 税务助手”使用。':'已停用，历史核对记录仍保留。';}
  catch(error){$('taxFeatureStatus').textContent=error.message;}finally{button.disabled=false;}
 });
 $('assistantPeriod').addEventListener('change',refresh);$('assistantRefresh').addEventListener('click',refresh);
 $('taxAssistantDialog').addEventListener('input',event=>{if(event.target.dataset.taxEvidence)drafts.set(key(event.target.dataset.taxEvidence),event.target.value);});
 $('taxAssistantDialog').addEventListener('click',async event=>{
  const button=event.target.closest('button,a');if(!button)return;
  if(button.dataset.taxTab){tab=button.dataset.taxTab;render();if(tab==='ledger')await loadLedger();return;}
  if(button.dataset.taxProject){await window.projectWorkspace.open(button.dataset.taxProject,button.dataset.taxAction==='money'?'money':'files');return;}
  if(button.dataset.taxSource&&window.desktopBridge?.openTaxReference){event.preventDefault();try{await window.desktopBridge.openTaxReference(button.dataset.taxSource);}catch(error){fail(error);}return;}
  if(button.dataset.taxReview){
   const task=report?.tasks.find(t=>t.id===button.dataset.taxReview);if(!task)return;
   const selectedPeriod=period(),draftKey=key(task.id),evidence=drafts.get(draftKey)??task.evidence;
   if(!task.done&&!evidence.trim())return showToast('请先填写核对说明；不适用时也请写明原因',true);
   button.disabled=true;
   try{await apiJson('/api/tax-assistant/review?period='+encodeURIComponent(selectedPeriod),{method:'POST',body:JSON.stringify({taskId:task.id,fingerprint:task.fingerprint,reviewVersion:task.reviewVersion,done:!task.done,evidence})});drafts.delete(draftKey);if(period()===selectedPeriod)await refresh();}
   catch(error){fail(error);}finally{button.disabled=false;}
  }
 });
 $('assistantIncludeFiles').addEventListener('change',invalidatePreview);
 $('assistantPreviewExport').addEventListener('click',async()=>{
  const selectedPeriod=period(), attachments=$('assistantIncludeFiles').checked?'1':'0';invalidatePreview();const request=previewGeneration;
  try{const data=await apiJson('/api/tax-assistant/export-preview?'+new URLSearchParams({period:selectedPeriod,attachments}));if(request!==previewGeneration||period()!==selectedPeriod||($('assistantIncludeFiles').checked?'1':'0')!==attachments)return;preview=data;$('assistantStatus').textContent=data.fileWarnings.join('；');$('assistantDownloadExport').disabled=false;$('assistantExportPreview').innerHTML=`<p><strong>${escape(data.period)}</strong> · 项目 ${data.records.projects} · 发票 ${data.records.invoices} · 付款 ${data.records.payments} · 回款 ${data.records.receipts} · 费用 ${data.records.expenses}</p><p>${data.includeAttachments?`包含 ${data.files.length} 个原件，共 ${(data.attachmentBytes/1024/1024).toFixed(2)} MB`:'仅导出资料清单和业务摘要，不包含原件'}</p><p class="mini">${escape(data.scope)}</p><ul class="assistant-file-list">${data.files.map(file=>`<li>${escape(file.projectName)} / ${escape(file.name)}</li>`).join('')}</ul>`;}
  catch(error){fail(error);}
 });
 $('assistantDownloadExport').addEventListener('click',async()=>{
  if(!preview)return;const selected=preview,button=$('assistantDownloadExport');button.disabled=true;
  try{const response=await fetch('/api/tax-assistant/export?'+new URLSearchParams({period:selected.period,attachments:selected.includeAttachments?'1':'0',fingerprint:selected.fingerprint}),{credentials:'same-origin'});if(!response.ok){const error=await response.json();throw new Error(error.error||'导出失败');}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='会计资料-'+selected.period+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);$('assistantStatus').textContent=selected.period+'资料包已生成，请核对本机下载结果；软件没有自动发送。';}
  catch(error){invalidatePreview();fail(error);}finally{button.disabled=!preview;}
 });
})();
