(() => {
  const period = document.querySelector('#financeReportPeriod');
  const status = document.querySelector('#financeReportStatus');
  const exportButton = document.querySelector('#financeReportExport');
  const date = new Date();
  period.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  let report = null;
  let sequence = 0;
  const format = value => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fields = ['receivable', 'received', 'outstandingReceivable', 'payable', 'paid', 'outstandingPayable', 'procurementMargin'];
  window.loadFinanceReport = async () => {
    const request = ++sequence;
    report = null; exportButton.disabled = true;
    document.querySelector('#financeReportRows').replaceChildren();
    document.querySelector('#financeReportSummary').replaceChildren();
    document.querySelector('#financeReportNotes').replaceChildren();
    status.textContent = '正在读取财务报表…';
    try {
      const response = await fetch(`/api/finance-report?period=${encodeURIComponent(period.value)}`, { credentials: 'same-origin' });
      const data = await response.json();
      if (request !== sequence) return;
      if (!response.ok) throw new Error(data.error || '读取失败');
      report = data;
      status.textContent = `${data.period} 流水与费用 · ${data.projects.length} 个项目当前余额`;
      const summary = document.querySelector('#financeReportSummary');
      for (const [label, value] of [['当前未收', data.totals.outstandingReceivable], ['当前未付采购', data.totals.outstandingPayable], ['本期回款流水', data.activity.income], ['本期付款流水', data.activity.supplierOutflow], ['收付款流水净额', data.activity.ledgerNetCash], ['本期发生费用', data.activity.expensesIncurred], ['本期费用未付', data.activity.unpaidExpenses]]) {
        const card = document.createElement('div'); card.className = 'stat';
        const title = document.createElement('div'); title.textContent = label;
        const amount = document.createElement('strong'); amount.textContent = format(value);
        card.append(title, amount); summary.append(card);
      }
      const body = document.querySelector('#financeReportRows');
      for (const row of data.projects) {
        const tr = document.createElement('tr');
        for (const value of [`${row.name} / ${row.customer}${row.legacySettlement ? '（含历史状态）' : ''}`, ...fields.map(field => format(row[field]))]) {
          const td = document.createElement('td'); td.textContent = value; tr.append(td);
        }
        body.append(tr);
      }
      const notes = document.querySelector('#financeReportNotes');
      for (const note of data.notes) { const li = document.createElement('li'); li.textContent = note; notes.append(li); }
      exportButton.disabled = false;
    } catch (error) { if (request === sequence) status.textContent = `财务报表读取失败：${error.message}`; }
  };
  document.querySelector('#financeReportRefresh').addEventListener('click', window.loadFinanceReport);
  period.addEventListener('change', window.loadFinanceReport);
  exportButton.addEventListener('click', () => {
    if (!report) return;
    const cell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
    const rows = [['项目ID', '项目', '客户', '应收', '已收', '未收', '采购应付', '已付', '未付', '采购毛利', '含历史状态'], ...report.projects.map(row => [row.projectId, row.name, row.customer, ...fields.map(field => row[field]), row.legacySettlement ? '是' : '否'])];
    const url = URL.createObjectURL(new Blob(['\uFEFF', rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `项目当前余额-${report.period}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
