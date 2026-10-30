const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");

const dataSets = {
  projects: "projects.json",
  customers: "customers.json",
  suppliers: "suppliers.json",
  inventory: "inventory.json",
  expenses: "expenses.json",
  processes: "processes.json",
  todos: "todos.json",
  productTemplates: "product-templates.json",
  settlementBatches: "settlement-batches.json",
  invoices: "invoices.json",
  supplierStatements: "supplier-statements.json",
  taxReconciliations: "tax-reconciliations.json",
  supplierPayments: "supplier-payments.json",
  bankTransactions: "bank-transactions.json",
  customerReceipts: "customer-receipts.json",
  taxAssistantReviews: "tax-assistant-reviews.json"
};

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

async function startInstance(root, seed = {}) {
  const data = join(root, "data"), files = join(root, "files");
  mkdirSync(data); mkdirSync(files);
  writeFileSync(join(data, "settings.json"), JSON.stringify({ archiveRoot: files, archiveRootAliases: [] }), "utf8");
  for (const [key, file] of Object.entries(dataSets)) writeFileSync(join(data, file), JSON.stringify(seed[key] || []), "utf8");
  const port = await freePort();
  const child = spawn(process.execPath, [join(__dirname, "..", "bundled-server", "server.js")], { env: { ...process.env, PORT: String(port), BIND_HOST: "127.0.0.1", PROJECT_DATA_DIR: data, PROJECT_ARCHIVE_DIR: files }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`; await waitFor(`${base}/api/status`, child);
  const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", displayName: "主账号", password: "123456" }) });
  assert.equal(setup.status, 200);
  return { root, data, files, child, base, cookie: setup.headers.get("set-cookie").split(";")[0] };
}

const request = (instance, path, options = {}) => fetch(instance.base + path, { ...options, headers: { Cookie: instance.cookie, ...(options.headers || {}) } });
const rows = (instance, key) => JSON.parse(readFileSync(join(instance.data, dataSets[key]), "utf8"));

test("完整备份可异机合并恢复全部4.0账本和附件且不覆盖目标机内容", async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "epm4-backup-source-"));
  const targetRoot = mkdtempSync(join(tmpdir(), "epm4-backup-target-"));
  const sourceSeed = Object.fromEntries(Object.keys(dataSets).map(key => [key, [{ id: `source-${key}`, name: `${key}源记录` }]]));
  sourceSeed.projects.push({ id: "shared", name: "来源项目" });
  const targetSeed = { projects: [{ id: "shared", name: "目标机保留项目" }, { id: "local", name: "目标机本地项目" }] };
  const source = await startInstance(sourceRoot, sourceSeed);
  const target = await startInstance(targetRoot, targetSeed);
  try {
    const sourceSettingsFile = join(source.data, 'settings.json');
    writeFileSync(sourceSettingsFile, JSON.stringify({ ...JSON.parse(readFileSync(sourceSettingsFile, 'utf8')), features: { taxAssistant: true } }), 'utf8');
    mkdirSync(join(source.files, "项目甲"));
    writeFileSync(join(source.files, "项目甲", "新增附件.txt"), "source attachment", "utf8");
    writeFileSync(join(source.files, "同名附件.txt"), "source must not overwrite", "utf8");
    writeFileSync(join(target.files, "同名附件.txt"), "target stays", "utf8");

    const exported = await request(source, "/api/backup/full");
    assert.equal(exported.status, 200);
    const backup = Buffer.from(await exported.arrayBuffer());
    assert.ok(backup.length > 100);

    const restored = await request(target, "/api/backup/full", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: backup });
    const result = await restored.json();
    assert.equal(restored.status, 200, JSON.stringify(result));
    for (const key of Object.keys(dataSets)) assert.equal(rows(target, key).some(row => row.id === `source-${key}`), true, key);
    assert.equal(rows(target, "projects").find(row => row.id === "shared").name, "目标机保留项目");
    assert.equal(rows(target, "projects").some(row => row.id === "local"), true);
    assert.equal(readFileSync(join(target.files, "项目甲", "新增附件.txt"), "utf8"), "source attachment");
    assert.equal(readFileSync(join(target.files, "同名附件.txt"), "utf8"), "target stays");
    assert.equal(result.conflicts.some(row => row.type === "projects" && row.name === "来源项目"), true);
    assert.equal(result.conflicts.some(row => row.type === "attachment" && row.name === "同名附件.txt"), true);
    assert.ok(result.snapshot);
    assert.equal((await (await request(target, '/api/features')).json()).taxAssistant, false, '恢复核对记录不自动启用目标公司的税务助手');
  } finally { source.child.kill(); target.child.kill(); }
});

test("校验损坏的完整备份时不修改目标数据并清理暂存目录", async () => {
  const source = await startInstance(mkdtempSync(join(tmpdir(), "epm4-backup-bad-source-")), { projects: [{ id: "source", name: "来源" }] });
  const target = await startInstance(mkdtempSync(join(tmpdir(), "epm4-backup-bad-target-")), { projects: [{ id: "target", name: "目标" }] });
  try {
    writeFileSync(join(source.files, "proof.bin"), "original attachment bytes", "utf8");
    const exported = await request(source, "/api/backup/full");
    const backup = Buffer.from(await exported.arrayBuffer());
    const marker = Buffer.from("original attachment bytes");
    const offset = backup.indexOf(marker);
    assert.ok(offset > 0);
    backup[offset] ^= 1;
    const before = createHash("sha256").update(readFileSync(join(target.data, "projects.json"))).digest("hex");
    const restored = await request(target, "/api/backup/full", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: backup });
    assert.equal(restored.status, 400);
    assert.match((await restored.json()).error, /校验失败/);
    const after = createHash("sha256").update(readFileSync(join(target.data, "projects.json"))).digest("hex");
    assert.equal(after, before);
    assert.equal(existsSync(join(target.files, "proof.bin")), false);
    assert.deepEqual(readdirSync(join(target.data, "backups")).filter(name => name.startsWith("restore-")), []);
  } finally { source.child.kill(); target.child.kill(); }
});

test("JSON业务备份与每日快照覆盖全部4.0账本并兼容3.0旧备份", async () => {
  const sourceSeed = Object.fromEntries(Object.keys(dataSets).map(key => [key, [{ id: `json-${key}`, name: `${key}记录` }]]));
  const source = await startInstance(mkdtempSync(join(tmpdir(), "epm4-json-source-")), sourceSeed);
  const target = await startInstance(mkdtempSync(join(tmpdir(), "epm4-json-target-")), { projects: [{ id: "local", name: "本地项目" }] });
  try {
    const exportedResponse = await request(source, "/api/backup/export");
    assert.equal(exportedResponse.status, 200);
    const exported = await exportedResponse.json();
    for (const key of Object.keys(dataSets)) assert.equal(exported.data[key].some(row => row.id === `json-${key}`), true, key);

    const restored = await request(target, "/api/backup/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(exported) });
    assert.equal(restored.status, 200);
    for (const key of Object.keys(dataSets)) assert.equal(rows(target, key).some(row => row.id === `json-${key}`), true, key);
    assert.equal(rows(target, "projects").some(row => row.id === "local"), true);

    const legacy = { format: "enterprise-project-manager-backup", version: 1, data: { projects: [{ id: "legacy-project", name: "3.0项目" }] } };
    const legacyRestore = await request(target, "/api/backup/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(legacy) });
    assert.equal(legacyRestore.status, 200);
    assert.equal(rows(target, "projects").some(row => row.id === "legacy-project"), true);
    assert.equal(rows(target, "invoices").some(row => row.id === "json-invoices"), true);

    const backupsBeforeInvalid = readdirSync(join(target.data, "backups")).length;
    const invalidRestore = await request(target, "/api/backup/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "enterprise-project-manager-backup", version: 1, data: { invoices: {} } }) });
    assert.equal(invalidRestore.status, 400);
    assert.match((await invalidRestore.json()).error, /invoices数据无效/);
    assert.equal(readdirSync(join(target.data, "backups")).length, backupsBeforeInvalid);

    const dailyFolder = readdirSync(join(source.data, "backups")).find(name => name.endsWith("-complete-v4"));
    assert.ok(dailyFolder);
    const dailyFiles = new Set(readdirSync(join(source.data, "backups", dailyFolder)));
    for (const file of ["settings.json", "users.json", "audit-log.json", ...Object.values(dataSets)]) assert.equal(dailyFiles.has(file), true, file);
  } finally { source.child.kill(); target.child.kill(); }
});
