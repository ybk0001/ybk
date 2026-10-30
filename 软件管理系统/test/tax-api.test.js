const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { worksheetFixture } = require("../test-support/xlsx-fixture");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error("测试服务启动超时");
}

test("发票、项目确认、供应商对账和月末快照形成完整接口闭环", async () => {
  const root = mkdtempSync(join(tmpdir(), "epm4-tax-api-"));
  const data = join(root, "data");
  const files = join(root, "files");
  mkdirSync(data); mkdirSync(files);
  writeFileSync(join(data, "settings.json"), JSON.stringify({ archiveRoot: files, archiveRootAliases: [] }), "utf8");
  writeFileSync(join(data, "projects.json"), JSON.stringify([
    { id: "p1", name: "测试项目", customer: "甲公司", receivable: 1000, invoiced: false, supplierItems: [{ id: "i1", supplier: "乙供应商", payable: 600, shippingFee: 0, paid: false }] },
    { id: "p2", name: "3.0旧项目", customer: "甲公司", content: "旧采购", supplier: "丙供应商", payable: 100, supplierPaid: false },
    { id: "p3", name: "无明细ID旧项目", customer: "甲公司", supplierItems: [{ supplier: "丁供应商", itemName: "旧明细", payable: 80, paid: false }] },
    { id: "p4", name: "历史迁移项目", customer: "戊公司", receivable: 900, invoiced: true, invoiceDate: "2026-10-01", paid: true, paymentDate: "2026-10-20", supplierItems: [{ id: "i4", supplier: "己供应商", payable: 500, paid: true, paymentDate: "2026-10-15" }] },
    { id: "p5", name: "同票子项目", customer: "甲公司", receivable: 300, invoiced: false, supplierItems: [] }
  ]), "utf8");
  const port = await freePort();
  const child = spawn(process.execPath, [join(__dirname, "..", "bundled-server", "server.js")], { env: { ...process.env, PORT: String(port), BIND_HOST: "127.0.0.1", PROJECT_DATA_DIR: data, PROJECT_ARCHIVE_DIR: files }, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/api/status`, child);
    const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", displayName: "测试", password: "123456" }) });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    const request = (path, options = {}) => fetch(base + path, { ...options, headers: { "Content-Type": "application/json", Cookie: cookie, ...(options.headers || {}) } });
    const pendingDynamicInvoice = await (await request("/api/invoices", { method: "POST", body: JSON.stringify({ direction: "supplier", invoiceNumber: "S-DYNAMIC", invoiceDate: "2027-01-08", amount: 120, partyName: "动态供应商" }) })).json();
    const pendingDynamicStatement = await (await request("/api/supplier-statements", { method: "POST", body: JSON.stringify({ supplierName: "动态供应商", period: "2027-01", lines: [{ occurredOn: "2027-01-08", itemName: "新增采购", amount: 120 }] }) })).json();
    assert.equal(pendingDynamicInvoice.matchStatus, "unmatched");
    assert.equal(pendingDynamicStatement.lines[0].matchStatus, "unmatched");
    const refreshedProjects = JSON.parse(readFileSync(join(data, "projects.json"), "utf8"));
    refreshedProjects.find(project => project.id === "p5").supplierItems = [{ id: "dynamic-item", supplier: "动态供应商", itemName: "新增采购", payable: 120 }];
    writeFileSync(join(data, "projects.json"), JSON.stringify(refreshedProjects), "utf8");
    const rescoredInvoice = (await (await request("/api/invoices")).json()).find(row => row.id === pendingDynamicInvoice.id);
    const rescoredStatement = (await (await request("/api/supplier-statements")).json()).find(row => row.id === pendingDynamicStatement.id);
    assert.equal(rescoredInvoice.candidates[0].projectId, "p5");
    assert.equal(rescoredStatement.lines[0].candidates[0].projectId, "p5");
    const invoiceResponse = await request("/api/invoices", { method: "POST", body: JSON.stringify({ direction: "customer", invoiceNumber: "C-100", invoiceCode: "1100 1234", invoiceKind: "digital_normal", invoiceDate: "2026-09-05", amount: 1000, taxRate: 13, taxAmount: 115.04, sellerTaxId: "91110108MA01ABCD12", buyerTaxId: "91110108MA02EFGH34", partyName: "甲公司" }) });
    const invoice = await invoiceResponse.json();
    assert.equal(invoice.matchStatus, "suggested");
    assert.equal(invoice.invoiceCode, "11001234");
    assert.equal(invoice.invoiceKind, "digital_normal");
    assert.equal(invoice.taxAmount, 115.04);
    assert.equal((await request("/api/invoices", { method: "POST", body: JSON.stringify({ direction: "customer", invoiceNumber: "C-100", invoiceDate: "2026-09-05", amount: 1000, partyName: "甲公司" }) })).status, 409);
    assert.equal((await request(`/api/invoices/${invoice.id}`, { method: "PUT", headers: { "If-Match": `"${invoice._version}"` }, body: JSON.stringify({ allocations: [{ projectId: "p1", amount: 700 }, { projectId: "p5", amount: 200 }] }) })).status, 400);
    const allocatedInvoice = await (await request(`/api/invoices/${invoice.id}`, { method: "PUT", headers: { "If-Match": `"${invoice._version}"` }, body: JSON.stringify({ allocations: [{ projectId: "p1", amount: 700 }, { projectId: "p5", amount: 300 }] }) })).json();
    assert.equal(allocatedInvoice.allocations.length, 2);
    assert.equal(allocatedInvoice.projectId, "");
    assert.equal((await request(`/api/invoices/${invoice.id}/attachments?projectId=p1&fileName=${encodeURIComponent("无版本发票.pdf")}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("%PDF-1.4 test") })).status, 428);
    const attachment = await (await request(`/api/invoices/${invoice.id}/attachments?projectId=p1&fileName=${encodeURIComponent("销项发票.pdf")}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "If-Match": `"${allocatedInvoice._version}"` }, body: Buffer.from("%PDF-1.4 test") })).json();
    assert.equal(attachment.projectId, "p1");
    assert.equal(existsSync(join(files, attachment.relativePath)), true);
    const invoiceAfterAttachment = (await (await request("/api/invoices")).json()).find(row => row.id === invoice.id);
    assert.equal((await request(`/api/invoices/${invoice.id}/attachments?projectId=p1&fileName=${encodeURIComponent("伪装发票.pdf")}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "If-Match": `"${invoiceAfterAttachment._version}"` }, body: Buffer.from("not a pdf") })).status, 400);
    assert.equal((await request(`/api/invoices/${invoice.id}/attachments?projectId=p1&fileName=${encodeURIComponent("脚本.exe")}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "If-Match": `"${invoiceAfterAttachment._version}"` }, body: Buffer.from("MZ") })).status, 400);
    assert.equal((await request(`/api/invoices/${invoice.id}`, { method: "PUT", headers: { "If-Match": `"${invoiceAfterAttachment._version}"` }, body: JSON.stringify({ action: "update-tax-fields", invoiceKind: "digital_special", taxRate: 13, taxAmount: 1001, sellerTaxId: "91110108MA01ABCD12", buyerTaxId: "91110108MA02EFGH34" }) })).status, 400);
    const updatedTaxFields = await (await request(`/api/invoices/${invoice.id}`, { method: "PUT", headers: { "If-Match": `"${invoiceAfterAttachment._version}"` }, body: JSON.stringify({ action: "update-tax-fields", invoiceCode: "11009999", invoiceKind: "digital_special", taxRate: 13, taxAmount: 115.04, sellerTaxId: "91110108MA01ABCD12", buyerTaxId: "91110108MA02EFGH34" }) })).json();
    assert.equal(updatedTaxFields.invoiceKind, "digital_special");
    assert.equal(updatedTaxFields.taxFieldsUpdatedBy, "测试");
    assert.equal((await request(`/api/invoices/${invoice.id}`, { method: "PUT", body: JSON.stringify({ action: "update-tax-fields", invoiceKind: "digital_normal" }) })).status, 428);
    assert.equal((await request(`/api/invoices/${invoice.id}`, { method: "PUT", headers: { "If-Match": `"${allocatedInvoice._version}"` }, body: JSON.stringify({ action: "update-tax-fields", invoiceKind: "digital_normal" }) })).status, 409);
    const imported = await (await request("/api/invoices/import", { method: "POST", body: JSON.stringify({
      sourceName: "发票测试.csv",
      content: "发票类型,发票号码,开票日期,价税合计,客户/供应商名称,项目提示\n销项,C-100,2026-09-05,1000,甲公司,测试项目\n进项,S-100,2026-09-06,600,乙供应商,测试项目"
    }) })).json();
    assert.equal(imported.imported, 1);
    assert.equal(imported.duplicateCount, 1);
    const afterImport = await (await request("/api/invoices")).json();
    assert.deepEqual(new Set(afterImport.map(item => item.invoiceNumber)), new Set(["S-DYNAMIC", "C-100", "S-100"]));
    const importedInvoice = afterImport.find(item => item.invoiceNumber === "S-100");
    assert.equal(importedInvoice.candidates[0].projectId, "p1");
    const invoiceXlsx = worksheetFixture({
      sheetName: "发票明细",
      sharedStrings: ["发票号码", "开票日期", "价税合计（小写）", "购买方名称", "销售方名称", "项目名称", "C-100", "甲公司", "本公司", "测试项目", "X-C-API"],
      rows: [
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>',
        '<row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2"><v>46300</v></c><c r="C2"><v>1000</v></c><c r="D2" t="s"><v>7</v></c><c r="E2" t="s"><v>8</v></c><c r="F2" t="s"><v>9</v></c></row>',
        '<row r="3"><c r="A3" t="s"><v>10</v></c><c r="B3"><v>46300</v></c><c r="C3"><v>1000</v></c><c r="D3" t="s"><v>7</v></c><c r="E3" t="s"><v>8</v></c><c r="F3" t="s"><v>9</v></c></row>'
      ]
    });
    const xlsxImportResponse = await request("/api/invoices/import", { method: "POST", body: JSON.stringify({ sourceName: "电子税务局发票.xlsx", contentBase64: invoiceXlsx.toString("base64"), defaultDirection: "customer" }) });
    assert.equal(xlsxImportResponse.status, 200);
    const xlsxImport = await xlsxImportResponse.json();
    assert.equal(xlsxImport.imported, 1); assert.equal(xlsxImport.duplicateCount, 1);
    const importedXlsxInvoice = (await (await request("/api/invoices")).json()).find(item => item.invoiceNumber === "X-C-API");
    assert.equal(importedXlsxInvoice.source, "xlsx");
    assert.equal(importedXlsxInvoice.invoiceDate, "2026-10-05");
    assert.equal(importedXlsxInvoice.candidates[0].projectId, "p1");
    assert.equal((await request("/api/invoices/import", { method: "POST", body: JSON.stringify({ sourceName: "损坏发票.xlsx", contentBase64: Buffer.from("not-xlsx").toString("base64"), defaultDirection: "customer" }) })).status, 400);
    assert.equal((await request(`/api/invoices/${importedInvoice.id}`, { method: "PUT", headers: { "If-Match": `"${importedInvoice._version}"` }, body: JSON.stringify({ projectId: "p1" }) })).status, 200);
    const firstPayment = await (await request("/api/supplier-payments", { method: "POST", body: JSON.stringify({ projectId: "p1", supplierItemId: "i1", invoiceId: importedInvoice.id, amount: 250, paymentDate: "2026-09-07", bankReference: "BANK-001" }) })).json();
    assert.equal(firstPayment.settlement.outstanding, 350);
    assert.equal((await request("/api/supplier-payments", { method: "POST", body: JSON.stringify({ projectId: "p1", supplierItemId: "i1", invoiceId: importedInvoice.id, amount: 351, paymentDate: "2026-09-08" }) })).status, 400);
    const secondPayment = await (await request("/api/supplier-payments", { method: "POST", body: JSON.stringify({ projectId: "p1", supplierItemId: "i1", invoiceId: importedInvoice.id, amount: 350, paymentDate: "2026-09-08" }) })).json();
    assert.equal(secondPayment.settlement.outstanding, 0);
    assert.equal((await request(`/api/supplier-payments/${secondPayment.id}`, { method: "PUT", headers: { "If-Match": `"${secondPayment._version}"` }, body: JSON.stringify({ action: "void", reason: "测试冲销" }) })).status, 200);
    const paymentRows = await (await request("/api/supplier-payments")).json();
    assert.equal(paymentRows.length, 2);
    assert.equal(paymentRows.find(item => item.id === secondPayment.id).status, "voided");
    assert.equal((await request("/api/supplier-payments", { method: "POST", body: JSON.stringify({ projectId: "p2", supplierItemId: "legacy-i1", amount: 40, paymentDate: "2026-09-08" }) })).status, 200);
    const migratedLegacy = (await (await request("/api/projects")).json()).find(project => project.id === "p2");
    assert.equal(migratedLegacy.supplierItems[0].id, "legacy-i1");
    assert.equal(migratedLegacy.supplierItems[0].paidAmount, 40);
    assert.equal((await request("/api/supplier-payments", { method: "POST", body: JSON.stringify({ projectId: "p3", supplierItemId: "legacy-p3-0", amount: 10, paymentDate: "2026-10-08" }) })).status, 200);
    const migratedItemId = (await (await request("/api/projects")).json()).find(project => project.id === "p3").supplierItems[0].id;
    assert.equal(migratedItemId, "legacy-p3-0");
    const bankCsv = Buffer.from("交易日期,对方户名,收支方向,交易金额,流水号,摘要\n2026-10-09,丁供应商,支出,70,BANK-70,无明细ID旧项目", "utf8").toString("base64");
    assert.equal((await request("/api/bank-transactions/import", { method: "POST", body: JSON.stringify({ sourceName: "银行流水.csv", contentBase64: bankCsv }) })).status, 200);
    const bankRows = await (await request("/api/bank-transactions")).json();
    assert.equal(bankRows[0].candidates[0].supplierItemId, "legacy-p3-0");
    const bankPaymentMatch = await (await request(`/api/bank-transactions/${bankRows[0].id}`, { method: "PUT", headers: { "If-Match": `"${bankRows[0]._version}"` }, body: JSON.stringify({ projectId: "p3", supplierItemId: "legacy-p3-0" }) })).json();
    assert.equal((await request(`/api/supplier-payments/${bankPaymentMatch.payment.id}`, { method: "PUT", headers: { "If-Match": `"${bankPaymentMatch.payment._version}"` }, body: JSON.stringify({ action: "void", reason: "银行退回重配" }) })).status, 200);
    const reopenedPaymentBank = (await (await request("/api/bank-transactions")).json()).find(row => row.id === bankRows[0].id);
    assert.equal(reopenedPaymentBank.status, "suggested");
    assert.equal(reopenedPaymentBank.matchHistory[0].priorMatch.paymentId, bankPaymentMatch.payment.id);
    assert.equal((await request(`/api/bank-transactions/${reopenedPaymentBank.id}`, { method: "PUT", headers: { "If-Match": `"${reopenedPaymentBank._version}"` }, body: JSON.stringify({ projectId: "p3", supplierItemId: "legacy-p3-0" }) })).status, 200);
    const duplicateBankImport = await (await request("/api/bank-transactions/import", { method: "POST", body: JSON.stringify({ sourceName: "银行流水.csv", contentBase64: bankCsv }) })).json();
    assert.equal(duplicateBankImport.duplicateCount, 1);
    const receiptCsv = Buffer.from("交易日期,对方户名,收支方向,交易金额,流水号,摘要\n2026-09-10,甲公司,收入,1000,RECEIPT-1000,测试项目回款", "utf8").toString("base64");
    assert.equal((await request("/api/bank-transactions/import", { method: "POST", body: JSON.stringify({ sourceName: "客户回款.csv", contentBase64: receiptCsv }) })).status, 200);
    const receiptBankRow = (await (await request("/api/bank-transactions")).json()).find(row => row.direction === "in");
    assert.equal(receiptBankRow.candidates[0].projectId, "p1");
    const receiptResult = await (await request(`/api/bank-transactions/${receiptBankRow.id}`, { method: "PUT", headers: { "If-Match": `"${receiptBankRow._version}"` }, body: JSON.stringify({ projectId: "p1" }) })).json();
    assert.equal(receiptResult.settlement.outstanding, 0);
    assert.equal((await (await request("/api/customer-receipts")).json()).length, 1);
    assert.equal((await request(`/api/customer-receipts/${receiptResult.receipt.id}`, { method: "PUT", headers: { "If-Match": `"${receiptResult.receipt._version}"` }, body: JSON.stringify({ action: "void", reason: "测试退款" }) })).status, 200);
    const reopenedReceiptBank = (await (await request("/api/bank-transactions")).json()).find(row => row.id === receiptBankRow.id);
    assert.equal(reopenedReceiptBank.status, "suggested");
    assert.equal(reopenedReceiptBank.matchHistory[0].priorMatch.receiptId, receiptResult.receipt.id);
    assert.equal((await request(`/api/bank-transactions/${reopenedReceiptBank.id}`, { method: "PUT", headers: { "If-Match": `"${reopenedReceiptBank._version}"` }, body: JSON.stringify({ projectId: "p1" }) })).status, 200);
    const statement = await (await request("/api/supplier-statements", { method: "POST", body: JSON.stringify({ supplierName: "乙供应商", period: "2026-09", lines: [{ occurredOn: "2026-09-06", itemName: "制作费", amount: 600 }] }) })).json();
    const confirmedStatement = await (await request(`/api/supplier-statements/${statement.id}`, { method: "PUT", headers: { "If-Match": `"${statement._version}"` }, body: JSON.stringify({ action: "confirm-line", lineId: statement.lines[0].id, projectId: "p1" }) })).json();
    assert.equal(confirmedStatement.lines[0].matchStatus, "confirmed");
    const completedStatementResponse = await request(`/api/supplier-statements/${statement.id}`, { method: "PUT", headers: { "If-Match": `"${confirmedStatement._version}"` }, body: JSON.stringify({ action: "complete", basis: "purchases" }) });
    assert.equal(completedStatementResponse.status, 200);
    const completedStatement = await completedStatementResponse.json();
    assert.deepEqual({ systemPayable: completedStatement.reconciliation.systemPayable, paidAmount: completedStatement.reconciliation.paidAmount, outstanding: completedStatement.reconciliation.outstanding, difference: completedStatement.reconciliation.difference }, { systemPayable: 600, paidAmount: 250, outstanding: 350, difference: 0 });
    assert.equal((await request(`/api/supplier-statements/${statement.id}`, { method: "PUT", headers: { "If-Match": `"${completedStatement._version}"` }, body: JSON.stringify({ action: "confirm-line", lineId: statement.lines[0].id, projectId: "p1" }) })).status, 409);
    const statementCsv = Buffer.from("日期,项目名称,事项,金额\n2026-10-08,测试项目,追加制作,600", "utf8").toString("base64");
    const importedStatementResponse = await request("/api/supplier-statements/import", { method: "POST", body: JSON.stringify({ supplierName: "乙供应商", period: "2026-10", sourceName: "十月对账.csv", contentBase64: statementCsv }) });
    assert.equal(importedStatementResponse.status, 200);
    const importedStatement = await importedStatementResponse.json();
    assert.equal(importedStatement.lines[0].candidates[0].projectId, "p1");
    const linkedImportedStatement = await (await request(`/api/supplier-statements/${importedStatement.id}`, { method: "PUT", headers: { "If-Match": `"${importedStatement._version}"` }, body: JSON.stringify({ action: "confirm-line", lineId: importedStatement.lines[0].id, projectId: "p1" }) })).json();
    const differenceRejected = await request(`/api/supplier-statements/${importedStatement.id}`, { method: "PUT", headers: { "If-Match": `"${linkedImportedStatement._version}"` }, body: JSON.stringify({ action: "complete", basis: "outstanding" }) });
    assert.equal(differenceRejected.status, 409);
    assert.match((await differenceRejected.json()).error, /差额 250\.00/);
    const acceptedDifference = await (await request(`/api/supplier-statements/${importedStatement.id}`, { method: "PUT", headers: { "If-Match": `"${linkedImportedStatement._version}"` }, body: JSON.stringify({ action: "complete", basis: "outstanding", acceptDifference: true, differenceReason: "含上月结转" }) })).json();
    assert.equal(acceptedDifference.differenceAccepted, true);
    assert.equal(acceptedDifference.reconciliation.difference, 250);
    assert.equal((await request("/api/supplier-statements/import", { method: "POST", body: JSON.stringify({ supplierName: "乙供应商", period: "2026-10", sourceName: "十月对账.csv", contentBase64: statementCsv }) })).status, 409);
    const preview = await (await request("/api/tax-reconciliation?period=2026-09&mode=month_end")).json();
    assert.equal(preview.ready, true);
    assert.equal(preview.summary.supplierPaymentAmount, 290);
    const snapshot = await (await request("/api/tax-reconciliation", { method: "POST", body: JSON.stringify({ period: "2026-09" }) })).json();
    assert.equal(snapshot.version, 1);
    assert.match(snapshot.evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.evidenceManifest.invoices.some(row => row.invoiceNumber === "C-100"), true);
    assert.equal(snapshot.evidenceManifest.statements.some(row => row.id === statement.id), true);
    const migrationPlan = await (await request("/api/legacy-migration")).json();
    assert.equal(migrationPlan.paymentCandidates.some(row => row.projectId === "p4"), true);
    assert.equal(migrationPlan.receiptCandidates.some(row => row.projectId === "p4"), true);
    assert.equal(migrationPlan.invoiceTasks.some(row => row.projectId === "p4"), true);
    assert.equal((await request("/api/legacy-migration", { method: "POST", body: JSON.stringify({ confirmText: "错误确认" }) })).status, 400);
    const backfilledInvoice = await (await request("/api/invoices", { method: "POST", body: JSON.stringify({ direction: "customer", invoiceNumber: "LEGACY-C-4", invoiceDate: "2026-10-01", amount: 900, partyName: "戊公司", projectId: "p4", source: "legacy_backfill" }) })).json();
    assert.equal(backfilledInvoice.source, "legacy_backfill");
    assert.equal(backfilledInvoice.allocations[0].projectId, "p4");
    const planAfterInvoiceBackfill = await (await request("/api/legacy-migration")).json();
    assert.equal(planAfterInvoiceBackfill.invoiceTasks.some(row => row.projectId === "p4"), false);
    assert.equal((await request("/api/legacy-migration", { method: "POST", body: JSON.stringify({ confirmText: "确认迁移3.0历史收付款流水" }) })).status, 428);
    assert.equal((await request("/api/legacy-migration", { method: "POST", body: JSON.stringify({ confirmText: "确认迁移3.0历史收付款流水", planToken: migrationPlan.planToken }) })).status, 409);
    const migrationResult = await (await request("/api/legacy-migration", { method: "POST", body: JSON.stringify({ confirmText: "确认迁移3.0历史收付款流水", planToken: planAfterInvoiceBackfill.planToken }) })).json();
    assert.equal(migrationResult.migratedPayments, 1);
    assert.equal(migrationResult.migratedReceipts, 1);
    assert.equal(migrationResult.verified, true);
    const completedMigrationPlan = await (await request("/api/legacy-migration")).json();
    const secondMigration = await (await request("/api/legacy-migration", { method: "POST", body: JSON.stringify({ confirmText: "确认迁移3.0历史收付款流水", planToken: completedMigrationPlan.planToken }) })).json();
    assert.equal(secondMigration.migratedPayments, 0);
    assert.equal(secondMigration.migratedReceipts, 0);
  } finally {
    child.kill();
  }
});
