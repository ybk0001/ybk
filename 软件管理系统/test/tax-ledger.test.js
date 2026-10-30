const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { createInvoice, createStatement, invoiceAllocations, invoiceCandidates, invoiceKey, invoiceTaxFields, parseInvoiceCsv, parseInvoiceRows, reconciliationView, statementReconciliation, validateInvoiceAllocations } = require("../bundled-server/tax-ledger");

const projects = [{
  id: "p1", name: "展板项目", customer: "甲公司", receivable: 1000, invoiced: false,
  supplierItems: [{ id: "i1", supplier: "乙供应商", payable: 600, shippingFee: 0 }]
}];

test("客户和供应商发票按往来单位与金额生成可解释候选", () => {
  const customer = createInvoice({ direction: "customer", invoiceNumber: "C-1", invoiceDate: "2026-09-01", amount: 1000, partyName: "甲公司" }, projects);
  const supplier = createInvoice({ direction: "supplier", invoiceNumber: "S-1", invoiceDate: "2026-09-02", amount: 600, partyName: "乙供应商" }, projects);
  assert.equal(customer.matchStatus, "suggested");
  assert.equal(customer.candidates[0].projectId, "p1");
  assert.equal(supplier.candidates[0].projectId, "p1");
  assert.match(supplier.candidates[0].reason, /往来单位一致.*金额一致/);
});

test("供应商发票按采购明细金额匹配并用业务日期破除同供应商并列", () => {
  const supplierProjects = [
    { id: "old", name: "旧项目", contractDate: "2025-01-01", supplierItems: [{ id: "old-item", supplier: "乙供应商", itemName: "展板", payable: 600 }, { id: "old-extra", supplier: "乙供应商", itemName: "安装", payable: 200 }] },
    { id: "current", name: "当前项目", contractDate: "2026-09-01", supplierItems: [{ id: "current-item", supplier: "乙供应商", itemName: "展板", payable: 600 }, { id: "current-extra", supplier: "乙供应商", itemName: "安装", payable: 300 }] }
  ];
  const candidates = invoiceCandidates({ direction: "supplier", partyName: "乙供应商", amount: 600, invoiceDate: "2026-09-05" }, supplierProjects);

  assert.equal(candidates[0].projectId, "current");
  assert.equal(candidates[0].confidence, "high");
  assert.match(candidates[0].reason, /采购明细金额一致.*业务日期相近4天/);
  assert.equal(invoiceCandidates({ direction: "supplier", partyName: "陌生供应商", amount: 999, invoiceDate: "2026-09-05" }, supplierProjects).length, 0);
});

test("发票可按金额分配到多个项目且兼容旧版单项目关联", () => {
  const invoice = createInvoice({ direction: "customer", invoiceNumber: "C-MULTI", invoiceDate: "2026-09-01", amount: 1000, partyName: "甲公司" }, projects);
  const splitProjects = [...projects, { id: "p2", name: "折页项目", customer: "甲公司", receivable: 400 }];
  const allocations = validateInvoiceAllocations(invoice, [{ projectId: "p1", amount: 600 }, { projectId: "p2", amount: 400 }], splitProjects);
  assert.equal(allocations.length, 2);
  assert.throws(() => validateInvoiceAllocations(invoice, [{ projectId: "p1", amount: 999 }], splitProjects), /必须等于发票金额/);
  assert.deepEqual(invoiceAllocations({ ...invoice, projectId: "p1", matchStatus: "confirmed" }), [{ projectId: "p1", amount: 1000 }]);
});

test("供应商对账单逐行生成项目候选且保留人工确认状态", () => {
  const statement = createStatement({ supplierName: "乙供应商", period: "2026-09", lines: [{ occurredOn: "2026-09-03", itemName: "制作费", amount: 600 }] }, projects);
  assert.equal(statement.status, "reviewing");
  assert.equal(statement.lines[0].matchStatus, "suggested");
  assert.equal(statement.lines[0].projectId, "");
});

test("月末对账在发票或对账明细未确认时阻断，全部确认后就绪", () => {
  const invoice = { ...createInvoice({ direction: "customer", invoiceNumber: "C-2", invoiceDate: "2026-09-05", amount: 1000, partyName: "甲公司" }, projects), projectId: "p1", matchStatus: "confirmed" };
  const statement = createStatement({ supplierName: "乙供应商", period: "2026-09", lines: [{ occurredOn: "2026-09-03", itemName: "制作费", amount: 600 }] }, projects);
  const blocked = reconciliationView({ period: "2026-09", mode: "month_end", projects, invoices: [invoice], statements: [statement], snapshots: [] });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.some(item => item.code === "unconfirmed_supplier_statements"), true);
  statement.lines[0].projectId = "p1";
  statement.lines[0].matchStatus = "confirmed";
  const linkedButUnfinished = reconciliationView({ period: "2026-09", mode: "month_end", projects, invoices: [invoice], statements: [statement], snapshots: [] });
  assert.equal(linkedButUnfinished.blockers.some(item => item.code === "unconfirmed_supplier_statements"), true);
  statement.status = "confirmed";
  const ready = reconciliationView({ period: "2026-09", mode: "month_end", projects, invoices: [invoice], statements: [statement], snapshots: [], payments: [{ paymentDate: "2026-09-08", amount: 250, status: "posted" }, { paymentDate: "2026-09-09", amount: 100, status: "voided" }], receipts: [{ receiptDate: "2026-09-10", amount: 400, status: "posted" }] });
  assert.equal(ready.ready, true);
  assert.equal(ready.summary.statementAmount, 600);
  assert.equal(ready.summary.supplierPaymentAmount, 250);
  assert.equal(ready.summary.customerReceiptAmount, 400);
  assert.equal(ready.warnings[0].code, "incomplete_invoice_tax_fields");
  assert.match(ready.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(ready.evidenceManifest.invoices[0].invoiceNumber, "C-2");
  const unchanged = reconciliationView({ period: "2026-09", mode: "month_end", projects, invoices: [invoice], statements: [statement], snapshots: [{ period: "2026-09", version: 1, evidenceHash: ready.evidenceHash }], payments: [{ paymentDate: "2026-09-08", amount: 250, status: "posted" }], receipts: [{ receiptDate: "2026-09-10", amount: 400, status: "posted" }] });
  assert.equal(unchanged.changedSinceSnapshot, false);
  const changed = reconciliationView({ period: "2026-09", mode: "month_end", projects, invoices: [invoice], statements: [statement], snapshots: [{ period: "2026-09", version: 1, evidenceHash: ready.evidenceHash }], payments: [{ paymentDate: "2026-09-08", amount: 250, status: "posted" }], receipts: [{ receiptDate: "2026-09-10", amount: 401, status: "posted" }] });
  assert.equal(changed.changedSinceSnapshot, true);
  assert.equal(changed.warnings.some(item => item.code === "month_end_data_changed_after_snapshot"), true);
  const legacySnapshot = reconciliationView({ period: "2026-09", mode: "month_end", projects, invoices: [invoice], statements: [statement], snapshots: [{ period: "2026-09", version: 1 }], payments: [], receipts: [] });
  assert.equal(legacySnapshot.warnings.some(item => item.code === "legacy_month_end_without_evidence"), true);
});

test("供应商对账同时核对采购应付、已付款和未付余额", () => {
  const statement = createStatement({ supplierName: "乙供应商", period: "2026-09", lines: [{ occurredOn: "2026-09-03", itemName: "制作费", amount: 600 }] }, projects);
  Object.assign(statement.lines[0], { projectId: "p1", matchStatus: "confirmed" });
  const purchases = statementReconciliation(statement, { projects, payments: [{ projectId: "p1", supplierItemId: "i1", supplierName: "乙供应商", amount: 250, status: "posted" }] });
  assert.deepEqual({ statementAmount: purchases.statementAmount, systemPayable: purchases.systemPayable, paidAmount: purchases.paidAmount, outstanding: purchases.outstanding, difference: purchases.difference }, { statementAmount: 600, systemPayable: 600, paidAmount: 250, outstanding: 350, difference: 0 });
  const balance = statementReconciliation(statement, { projects, payments: [{ projectId: "p1", supplierItemId: "i1", supplierName: "乙供应商", amount: 250, status: "posted" }], basis: "outstanding" });
  assert.equal(balance.difference, 250);
});

test("服务器把新增税务账簿纳入备份并阻止重复发票", () => {
  const server = readFileSync(join(__dirname, "..", "bundled-server", "server.js"), "utf8");
  assert.match(server, /\[INVOICES_FILE, 'invoices'\]/);
  assert.match(server, /\[SUPPLIER_STATEMENTS_FILE, 'supplierStatements'\]/);
  assert.match(server, /\[TAX_RECONCILIATIONS_FILE, 'taxReconciliations'\]/);
  assert.match(server, /\[SUPPLIER_PAYMENTS_FILE, 'supplierPayments'\]/);
  assert.match(server, /\[BANK_TRANSACTIONS_FILE, 'bankTransactions'\]/);
  assert.match(server, /\[CUSTOMER_RECEIPTS_FILE, 'customerReceipts'\]/);
  assert.match(server, /已阻止重复登记/);
  assert.match(server, /server\.listen\(PORT, BIND_HOST/);
});

test("CSV 发票批量导入支持中文税务表头、引号逗号和制表符", () => {
  const csv = "发票类型,发票号码,开票日期,价税合计,客户/供应商名称,票种,销方税号,购方税号,税率,税额,项目提示,备注\n销项,C-200,2026-09-10,1000,甲公司,数电普票,91110108MA01ABCD12,91110108MA02EFGH34,13%,115.04,展板,\"含逗号,备注\"";
  const [row] = parseInvoiceCsv(csv);
  assert.equal(row.direction, "customer");
  assert.equal(row.note, "含逗号,备注");
  const created = createInvoice(row, projects);
  assert.equal(created.candidates[0].projectId, "p1");
  assert.equal(created.invoiceKind, "digital_normal");
  assert.equal(created.taxRate, 13);
  assert.equal(created.taxAmount, 115.04);

  const [tabRow] = parseInvoiceCsv("发票号码\t开票日期\t价税合计\t客户/供应商名称\nS-200\t2026-09-11\t600\t乙供应商", { defaultDirection: "supplier" });
  assert.equal(tabRow.direction, "supplier");
  assert.equal(invoiceKey("supplier", " S-200 "), invoiceKey(tabRow.direction, tabRow.invoiceNumber));
});

test("Excel发票行支持序列日期、购销方独立名称和项目候选", () => {
  const [customer] = parseInvoiceRows([
    ["发票类型", "发票号码", "开票日期", "价税合计（小写）", "购买方名称", "销售方名称", "项目名称"],
    ["销项", "X-C-1", "46300", "1000", "甲公司", "本公司", "展板项目"]
  ], { source: "xlsx" });
  assert.equal(customer.invoiceDate, "2026-10-05");
  assert.equal(customer.partyName, "甲公司");
  assert.equal(customer.source, "xlsx");
  assert.equal(createInvoice(customer, projects).candidates[0].projectId, "p1");

  const [supplier] = parseInvoiceRows([
    ["发票号码", "开票日期", "价税合计", "购买方名称", "销售方名称"],
    ["X-S-1", "2026/10/06", "600", "本公司", "乙供应商"]
  ], { defaultDirection: "supplier", source: "xlsx" });
  assert.equal(supplier.partyName, "乙供应商");
});

test("税务字段限制税额、税率和税号格式且允许旧记录留空", () => {
  assert.deepEqual(invoiceTaxFields({}, 100), { invoiceCode: "", invoiceKind: "unspecified", sellerTaxId: "", buyerTaxId: "", taxRate: null, taxAmount: null });
  assert.throws(() => invoiceTaxFields({ taxAmount: 101 }, 100), /税额/);
  assert.throws(() => invoiceTaxFields({ taxRate: 101 }, 100), /税率/);
  assert.throws(() => invoiceTaxFields({ sellerTaxId: "税号?" }, 100), /销方税号/);
});
