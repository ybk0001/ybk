const assert = require("node:assert/strict");
const test = require("node:test");
const { buildLegacyLedgers, migrationPlan } = require("../bundled-server/legacy-migration");

test("3.0历史迁移只补建可确定的收付款流水，不伪造发票", () => {
  const sourceProjects = [{ id: "p1", name: "旧项目", customer: "甲公司", receivable: 1000, invoiced: true, invoiceDate: "2026-08-01", paid: true, paymentDate: "2026-09-01", supplierItems: [{ id: "i1", supplier: "乙供应商", payable: 600, paid: true, paymentDate: "2026-08-20" }] }];
  const plan = migrationPlan({ projects: sourceProjects, invoices: [], payments: [], receipts: [] });
  assert.deepEqual(plan.counts, { invoiceTasks: 1, paymentsReady: 1, receiptsReady: 1, blocked: 0 });
  const result = buildLegacyLedgers(plan, { id: "u1", displayName: "管理员" }, "2026-09-23T00:00:00.000Z");
  assert.equal(result.payments[0].source, "legacy_migration");
  assert.equal(result.receipts[0].amount, 1000);
  assert.equal(plan.invoiceTasks[0].reason.includes("人工补录"), true);
});

test("缺少日期的历史状态进入阻断清单且幂等计划跳过已有流水", () => {
  const project = { id: "p1", name: "旧项目", receivable: 1000, paid: true, supplierItems: [{ id: "i1", payable: 600, paid: true }] };
  const blocked = migrationPlan({ projects: [project], invoices: [], payments: [], receipts: [] });
  assert.equal(blocked.counts.blocked, 2);
  const skipped = migrationPlan({ projects: [{ ...project, paymentDate: "2026-09-01", supplierItems: [{ ...project.supplierItems[0], paymentDate: "2026-09-01" }] }], invoices: [], payments: [{ projectId: "p1", supplierItemId: "i1" }], receipts: [{ projectId: "p1" }] });
  assert.equal(skipped.counts.paymentsReady, 0);
  assert.equal(skipped.counts.receiptsReady, 0);
});

test("最早期3.0项目级供应商付款字段也能生成迁移候选", () => {
  const project = { id: "p-old", name: "3.0项目", supplier: "老供应商", payable: 380, supplierPaid: true, supplierPaymentDate: "2026-07-18" };
  const plan = migrationPlan({ projects: [project], invoices: [], payments: [], receipts: [] });
  assert.equal(plan.counts.paymentsReady, 1);
  assert.equal(plan.paymentCandidates[0].supplierItemId, "legacy-p-old-0");
  assert.equal(plan.paymentCandidates[0].supplierName, "老供应商");
});

test("已通过多项目分配关联的发票不再生成历史补录任务", () => {
  const project = { id: "p1", name: "已开票项目", invoiced: true, invoiceDate: "2026-09-01" };
  const invoices = [{ id: "f1", direction: "customer", projectId: "", allocations: [{ projectId: "p1", amount: 500 }, { projectId: "p2", amount: 500 }] }];
  assert.equal(migrationPlan({ projects: [project], invoices, payments: [], receipts: [] }).counts.invoiceTasks, 0);
});

const projects = [{
  id: "legacy-1",
  name: "3.0历史项目",
  customer: "甲公司",
  receivable: 900,
  invoiced: true,
  invoiceDate: "2026-08-01",
  paid: true,
  paymentDate: "2026-08-31",
  supplierItems: [{ id: "legacy-item-1", supplier: "乙供应商", payable: 500, paid: true, paymentDate: "2026-08-20" }]
}];

test("历史迁移计划指纹固定绑定刚刚预览的数据", () => {
  const first = migrationPlan({ projects, invoices: [], payments: [], receipts: [] });
  const repeated = migrationPlan({ projects: JSON.parse(JSON.stringify(projects)), invoices: [], payments: [], receipts: [] });
  const changed = migrationPlan({ projects: [{ ...projects[0], paymentDate: "2026-09-01" }], invoices: [], payments: [], receipts: [] });

  assert.match(first.planToken, /^[a-f0-9]{64}$/);
  assert.equal(repeated.planToken, first.planToken);
  assert.notEqual(changed.planToken, first.planToken);
});

test("历史流水写入后复核不再产生相同迁移候选", () => {
  const plan = migrationPlan({ projects, invoices: [], payments: [], receipts: [] });
  const created = buildLegacyLedgers(plan, { id: "main", displayName: "管理员" }, "2026-09-24T00:00:00.000Z");
  const verified = migrationPlan({ projects, invoices: [], payments: created.payments, receipts: created.receipts });

  assert.equal(created.payments.length, 1);
  assert.equal(created.receipts.length, 1);
  assert.equal(verified.paymentCandidates.length, 0);
  assert.equal(verified.receiptCandidates.length, 0);
  assert.notEqual(verified.planToken, plan.planToken);
});
