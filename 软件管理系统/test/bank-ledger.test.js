const assert = require("node:assert/strict");
const test = require("node:test");
const { importTransactions, parseBankRows, reopenTransaction } = require("../bundled-server/bank-ledger");

test("银行流水中文表头解析、供应商候选和重复识别", () => {
  const rows = parseBankRows([["交易日期", "对方户名", "收支方向", "交易金额", "流水号", "摘要"], ["2026/09/23", "乙供应商", "支出", "600.00", "B001", "展板项目制作费"], ["2026-09-24", "甲公司", "收入", "1000", "B002", "展板项目回款"]]);
  const projects = [{ id: "p1", name: "展板项目", customer: "甲公司", receivable: 1000, supplierItems: [{ id: "i1", supplier: "乙供应商", itemName: "制作费", payable: 600, shippingFee: 0 }] }];
  const first = importTransactions(rows, { projects, payments: [], existing: [], sourceName: "银行.xlsx" });
  assert.equal(first.imported[0].candidates[0].supplierItemId, "i1");
  assert.match(first.imported[0].candidates[0].reason, /供应商一致.*金额一致/);
  assert.match(first.imported[1].candidates[0].reason, /客户一致.*金额一致/);
  const second = importTransactions(rows, { projects, payments: [], existing: first.imported, sourceName: "再次导入.xlsx" });
  assert.equal(second.imported.length, 0);
  assert.deepEqual(second.duplicates, [2, 3]);
});

test("冲销银行来源账本时流水回到待确认并保留原匹配历史", () => {
  const transaction = { id: "b1", status: "matched", projectId: "p1", supplierItemId: "i1", paymentId: "pay1", matchedBy: "管理员", matchedAt: "2026-09-24T00:00:00.000Z", candidates: [{ projectId: "p1" }] };
  const reopened = reopenTransaction(transaction, { ledgerType: "payment", ledgerId: "pay1", reason: "付款退回", user: { id: "u1", displayName: "管理员" } }, "2026-09-24T01:00:00.000Z");

  assert.equal(reopened.status, "suggested");
  assert.equal(reopened.paymentId, "");
  assert.equal(reopened.projectId, "");
  assert.equal(reopened.matchHistory[0].priorMatch.paymentId, "pay1");
  assert.equal(reopened.matchHistory[0].reason, "付款退回");
  assert.throws(() => reopenTransaction(transaction, { ledgerType: "payment", ledgerId: "other", reason: "错误", user: {} }), /不一致/);
});
