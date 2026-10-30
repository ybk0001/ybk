const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFinanceReport } = require('../bundled-server/finance-report');

test('财务报表使用流水余额，冲销不复活历史已付，费用不冒充现金支出', () => {
  const input = { projects: [{ id: 'p', receivable: 1000, paid: true, supplierItems: [{ id: 'i', payable: 600, shippingFee: 20, paid: true }] }], receipts: [{ projectId: 'p', amount: 200, receiptDate: '2026-10-01' }, { projectId: 'p', amount: 800, receiptDate: '2026-10-01', status: 'voided' }, { projectId: 'p', amount: 100, receiptDate: '2026-09-01' }], payments: [{ projectId: 'p', supplierItemId: 'i', amount: 620, paymentDate: '2026-10-01', status: 'voided' }], expenses: [{ amount: 50, date: '2026-10-02', paid: true }, { amount: 30, date: '2026-10-03', paid: false }] };
  const before = JSON.stringify(input);
  const report = buildFinanceReport(input, '2026-10');
  assert.equal(report.totals.received, 300);
  assert.equal(report.totals.outstandingReceivable, 700);
  assert.equal(report.totals.paid, 0);
  assert.equal(report.totals.outstandingPayable, 620);
  assert.equal(report.totals.procurementMargin, 380);
  assert.deepEqual(report.activity, { income: 200, supplierOutflow: 0, ledgerNetCash: 200, expensesIncurred: 80, unpaidExpenses: 30 });
  assert.equal(JSON.stringify(input), before);
});

test('兼容历史应付字段且无流水不计入期间现金', () => {
  const report = buildFinanceReport({ projects: [{ id: 'old', receivable: 100, paid: true, payable: 40, shippingFee: 5, supplierPaid: true }] }, '2026-10');
  assert.equal(report.totals.received, 100);
  assert.equal(report.totals.paid, 45);
  assert.equal(report.projects[0].legacySettlement, true);
  assert.equal(report.activity.income, 0);
  assert.throws(() => buildFinanceReport({}, '2026-13'), /期间/);
});
