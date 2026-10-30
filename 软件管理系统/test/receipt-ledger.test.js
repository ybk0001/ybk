const assert = require("node:assert/strict");
const test = require("node:test");
const { createCustomerReceipt, projectSettlement, voidCustomerReceipt } = require("../bundled-server/receipt-ledger");

const project = { id: "p1", customer: "甲公司", receivable: 1000, paid: false };
const invoice = { id: "f1", direction: "customer", projectId: "p1", matchStatus: "confirmed", partyName: "甲公司", amount: 1000 };
const user = { id: "u1", displayName: "测试员" };

test("客户回款支持部分回款、客户发票核销和冲销", () => {
  const first = createCustomerReceipt({ projectId: "p1", invoiceId: "f1", amount: 400, receiptDate: "2026-09-23" }, { projects: [project], invoices: [invoice], receipts: [], user });
  assert.equal(projectSettlement(project, [first]).outstanding, 600);
  assert.throws(() => createCustomerReceipt({ projectId: "p1", invoiceId: "f1", amount: 601, receiptDate: "2026-09-24" }, { projects: [project], invoices: [invoice], receipts: [first], user }), /未收余额|未核销余额/);
  const voided = voidCustomerReceipt(first, { reason: "客户退款" }, user);
  assert.equal(projectSettlement({ ...project, paid: true, receivedAmount: 1000 }, [voided]).outstanding, 1000);
  assert.equal(voided.status, "voided");
});

test("多项目客户发票按项目分配额限制回款核销", () => {
  const splitInvoice = { ...invoice, projectId: "", allocations: [{ projectId: "p1", amount: 350 }, { projectId: "p2", amount: 650 }] };
  assert.throws(() => createCustomerReceipt({ projectId: "p1", invoiceId: "f1", amount: 351, receiptDate: "2026-09-23" }, { projects: [project], invoices: [splitInvoice], receipts: [], user }), /发票未核销余额/);
  assert.equal(createCustomerReceipt({ projectId: "p1", invoiceId: "f1", amount: 350, receiptDate: "2026-09-23" }, { projects: [project], invoices: [splitInvoice], receipts: [], user }).amount, 350);
});
