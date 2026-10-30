const assert = require("node:assert/strict");
const test = require("node:test");
const { createSupplierPayment, itemSettlement, paidForInvoice, voidSupplierPayment } = require("../bundled-server/payment-ledger");

const project = { id: "p1", name: "展板项目", supplierItems: [{ id: "i1", supplier: "乙供应商", payable: 600, shippingFee: 20, paid: false }] };
const invoice = { id: "f1", direction: "supplier", projectId: "p1", matchStatus: "confirmed", amount: 600 };
const user = { id: "u1", displayName: "测试员" };

test("供应商付款支持部分付款、发票核销和余额限制", () => {
  const first = createSupplierPayment({ projectId: "p1", supplierItemId: "i1", invoiceId: "f1", amount: 250, paymentDate: "2026-09-23", bankReference: "流水001" }, { projects: [project], invoices: [invoice], payments: [], user });
  assert.equal(first.amount, 250);
  assert.equal(itemSettlement(project, project.supplierItems[0], [first]).outstanding, 370);
  assert.equal(paidForInvoice([first], "f1"), 250);
  assert.throws(() => createSupplierPayment({ projectId: "p1", supplierItemId: "i1", invoiceId: "f1", amount: 351, paymentDate: "2026-09-24" }, { projects: [project], invoices: [invoice], payments: [first], user }), /发票未核销余额/);
  const second = createSupplierPayment({ projectId: "p1", supplierItemId: "i1", amount: 370, paymentDate: "2026-09-24" }, { projects: [project], invoices: [invoice], payments: [first], user });
  assert.equal(itemSettlement(project, project.supplierItems[0], [first, second]).outstanding, 0);
});

test("冲销流水恢复未付余额且保留冲销审计信息", () => {
  const payment = createSupplierPayment({ projectId: "p1", supplierItemId: "i1", amount: 620, paymentDate: "2026-09-23" }, { projects: [project], invoices: [], payments: [], user });
  const voided = voidSupplierPayment(payment, { reason: "银行退回" }, user);
  assert.equal(voided.status, "voided");
  assert.equal(itemSettlement({ ...project, supplierItems: [{ ...project.supplierItems[0], paid: true, paidAmount: 620 }] }, { ...project.supplierItems[0], paid: true, paidAmount: 620 }, [voided]).outstanding, 620);
  assert.equal(voided.voidedBy, "测试员");
});

test("多项目发票按当前项目分配额限制核销", () => {
  const splitInvoice = { ...invoice, projectId: "", allocations: [{ projectId: "p1", amount: 300 }, { projectId: "p2", amount: 300 }] };
  assert.throws(() => createSupplierPayment({ projectId: "p1", supplierItemId: "i1", invoiceId: "f1", amount: 301, paymentDate: "2026-09-23" }, { projects: [project], invoices: [splitInvoice], payments: [], user }), /发票未核销余额/);
  assert.equal(createSupplierPayment({ projectId: "p1", supplierItemId: "i1", invoiceId: "f1", amount: 300, paymentDate: "2026-09-23" }, { projects: [project], invoices: [splitInvoice], payments: [], user }).amount, 300);
});
