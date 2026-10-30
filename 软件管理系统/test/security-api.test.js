const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
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

test("子账号财务权限按项目隔离且敏感总账仅主账号可见", async () => {
  const root = mkdtempSync(join(tmpdir(), "epm4-security-api-")); const data = join(root, "data"); const files = join(root, "files");
  mkdirSync(data); mkdirSync(files); writeFileSync(join(data, "settings.json"), JSON.stringify({ archiveRoot: files, archiveRootAliases: [] }), "utf8"); writeFileSync(join(data, "projects.json"), "[]", "utf8");
  const port = await freePort(); const child = spawn(process.execPath, [join(__dirname, "..", "bundled-server", "server.js")], { env: { ...process.env, PORT: String(port), BIND_HOST: "127.0.0.1", PROJECT_DATA_DIR: data, PROJECT_ARCHIVE_DIR: files }, stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}`; await waitFor(`${base}/api/status`, child);
    const publicStatus = await (await fetch(`${base}/api/status`)).json(); assert.equal(publicStatus.ok, true); assert.equal("dataFile" in publicStatus, false); assert.equal("archiveDir" in publicStatus, false);
    const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", displayName: "主账号", password: "123456" }) });
    const mainCookie = setup.headers.get("set-cookie").split(";")[0];
    const mainRequest = (path, options = {}) => fetch(base + path, { ...options, headers: { "Content-Type": "application/json", Cookie: mainCookie, ...(options.headers || {}) } });
    const subUser = await (await mainRequest("/api/users", { method: "POST", body: JSON.stringify({ username: "cashier", displayName: "财务员", password: "123456", permissions: ["payments", "settlement", "files"] }) })).json();
    writeFileSync(join(data, "projects.json"), JSON.stringify([
      { id: "owned", name: "本人项目", customer: "甲公司", receivable: 100, ownerUserId: subUser.id, supplierItems: [{ id: "owned-item", supplier: "乙供应商", payable: 60, paid: false }] },
      { id: "other", name: "他人项目", customer: "丙公司", receivable: 200, ownerUserId: "another-user", supplierItems: [{ id: "other-item", supplier: "丁供应商", payable: 80, paid: false }] }
    ]), "utf8");
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "cashier", password: "123456" }) });
    const subCookie = login.headers.get("set-cookie").split(";")[0];
    const subRequest = (path, options = {}) => fetch(base + path, { ...options, headers: { "Content-Type": "application/json", Cookie: subCookie, ...(options.headers || {}) } });

    for (const path of ["/api/invoices", "/api/bank-transactions", "/api/legacy-migration", "/api/audit", "/api/audit/integrity", "/api/backup/export", "/api/backups", "/api/settings/archive"]) assert.equal((await subRequest(path)).status, 403, path);
    assert.equal((await subRequest("/api/finance-report?period=2026-09")).status, 403);
    assert.equal((await fetch(`${base}/api/finance-report?period=2026-09`)).status, 401);
    assert.equal((await mainRequest("/api/finance-report?period=2026-13")).status, 400);
    assert.equal((await subRequest("/api/supplier-payments", { method: "POST", body: JSON.stringify({ projectId: "other", supplierItemId: "other-item", amount: 20, paymentDate: "2026-09-23" }) })).status, 403);
    assert.equal((await subRequest("/api/customer-receipts", { method: "POST", body: JSON.stringify({ projectId: "other", amount: 20, receiptDate: "2026-09-23" }) })).status, 403);
    assert.equal((await subRequest("/api/supplier-payments", { method: "POST", body: JSON.stringify({ projectId: "owned", supplierItemId: "owned-item", amount: 20, paymentDate: "2026-09-23" }) })).status, 200);
    assert.equal((await subRequest("/api/customer-receipts", { method: "POST", body: JSON.stringify({ projectId: "owned", amount: 30, receiptDate: "2026-09-23" }) })).status, 200);
    const visiblePayments = await (await subRequest("/api/supplier-payments")).json(); const visibleReceipts = await (await subRequest("/api/customer-receipts")).json();
    assert.deepEqual(visiblePayments.map(row => row.projectId), ["owned"]); assert.deepEqual(visibleReceipts.map(row => row.projectId), ["owned"]);
    const finance = await (await mainRequest("/api/finance-report?period=2026-09")).json();
    assert.equal(finance.totals.receivable, 300);
    assert.equal(finance.totals.outstandingReceivable, 270);
    assert.equal(finance.totals.outstandingPayable, 120);
    assert.equal(finance.activity.ledgerNetCash, 10);
    const reportScript = await mainRequest("/finance-report.js");
    assert.equal(reportScript.status, 200);
    assert.doesNotThrow(() => new Function(require('node:fs').readFileSync(join(__dirname, '..', 'bundled-server', 'public', 'finance-report.js'), 'utf8')));
    const integrity = await (await mainRequest("/api/audit/integrity")).json();
    assert.equal(integrity.ok, true); assert.equal(integrity.sealedCount >= 3, true);
    const auditFile = join(data, "audit-log.json"), auditRows = JSON.parse(readFileSync(auditFile, "utf8"));
    auditRows[1].detail = "离线篡改"; writeFileSync(auditFile, JSON.stringify(auditRows), "utf8");
    const compromised = await (await mainRequest("/api/audit/integrity")).json();
    assert.equal(compromised.ok, false); assert.equal(compromised.status, "compromised");
  } finally { child.kill(); }
});
