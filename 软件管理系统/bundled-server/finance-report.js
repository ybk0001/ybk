const { projectSettlement } = require('./receipt-ledger');
const { itemSettlement } = require('./payment-ledger');
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const sum = (rows, field) => round(rows.reduce((total, row) => total + Number(row[field] || 0), 0));

function buildFinanceReport({ projects = [], receipts = [], payments = [], expenses = [] }, period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) throw new Error('期间格式必须为 YYYY-MM');
  const rows = projects.map(project => {
    const settlement = projectSettlement(project, receipts);
    const items = Array.isArray(project.supplierItems) && project.supplierItems.length ? project.supplierItems : [{ id: `${project.id}-legacy`, payable: project.payable, shippingFee: project.shippingFee, paid: project.supplierPaid }];
    const costs = items.map(item => itemSettlement(project, item, payments));
    const payable = sum(costs, 'total');
    const paid = sum(costs, 'paidAmount');
    return { projectId: project.id, name: project.name || '', customer: project.customer || '', receivable: settlement.total, received: settlement.receivedAmount, outstandingReceivable: settlement.outstanding, payable, paid, outstandingPayable: sum(costs, 'outstanding'), procurementMargin: round(settlement.total - payable), legacySettlement: settlement.source === 'legacy' || costs.some(item => item.source === 'legacy') };
  });
  const periodReceipts = receipts.filter(row => row.status !== 'voided' && String(row.receiptDate || '').startsWith(period));
  const periodPayments = payments.filter(row => row.status !== 'voided' && String(row.paymentDate || '').startsWith(period));
  const periodExpenses = expenses.filter(row => String(row.date || '').startsWith(period));
  const income = sum(periodReceipts, 'amount');
  const supplierOutflow = sum(periodPayments, 'amount');
  // 旧费用只有发生日期，不能据此推断实际付款所在期间。
  return { period, projects: rows, totals: Object.fromEntries(['receivable', 'received', 'outstandingReceivable', 'payable', 'paid', 'outstandingPayable', 'procurementMargin'].map(field => [field, sum(rows, field)])), activity: { income, supplierOutflow, ledgerNetCash: round(income - supplierOutflow), expensesIncurred: sum(periodExpenses, 'amount'), unpaidExpenses: sum(periodExpenses.filter(row => !row.paid), 'amount') }, notes: ['项目余额为当前累计口径，不是所选月末余额。', '采购毛利仅扣供应商采购与运费，未扣费用和税费，不是净利润。', '期间现金收支仅统计有效收付款流水；历史状态无流水的金额不计入。', '费用按发生日期统计，未计入现金净额，避免将发生日期当作付款日期。'] };
}

module.exports = { buildFinanceReport };
