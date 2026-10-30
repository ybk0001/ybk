const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");

const script = join(__dirname, "..", "scripts", "preflight-nas.ps1");
const clearLockScript = join(__dirname, "..", "scripts", "clear-stale-server-lock.ps1");
const listFiles = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? listFiles(join(root, entry.name)).map(name => `${entry.name}/${name}`) : [entry.name]).sort();
const fingerprint = root => Object.fromEntries(listFiles(root).map(name => [name, createHash("sha256").update(readFileSync(join(root, ...name.split("/")))).digest("hex")]));

function fixture({ includeProjects = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "epm4-preflight-"));
  const data = join(root, "data"), archive = join(root, "archive");
  mkdirSync(data); mkdirSync(archive);
  const files = [
    "customers.json", "suppliers.json", "users.json", "inventory.json", "expenses.json", "processes.json", "todos.json",
    "product-templates.json", "settlement-batches.json", "invoices.json", "supplier-statements.json", "tax-reconciliations.json",
    "supplier-payments.json", "bank-transactions.json", "customer-receipts.json", "audit-log.json", "sessions.json"
  ];
  if (includeProjects) files.push("projects.json");
  for (const name of files) writeFileSync(join(data, name), "[]", "utf8");
  writeFileSync(join(data, "settings.json"), JSON.stringify({ archiveRoot: archive, archiveRootAliases: [] }), "utf8");
  return { root, data };
}

test("NAS预检默认只读且完整基线可通过", () => {
  const sample = fixture();
  const before = fingerprint(sample.root);
  const result = spawnSync("pwsh", ["-NoProfile", "-File", script, "-NasDataRoot", sample.data], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /阻断 0 项/);
  assert.match(result.stdout, /未执行写入探测/);
  assert.deepEqual(fingerprint(sample.root), before);
});

test("NAS预检在缺少3.0项目基线时阻断部署", () => {
  const sample = fixture({ includeProjects: false });
  const result = spawnSync("pwsh", ["-NoProfile", "-File", script, "-NasDataRoot", sample.data], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /缺少 3\.0 基线文件：projects\.json/);
});

test("NAS预检阻断活动锁且遗留锁必须完整确认后才能清理", () => {
  const sample = fixture();
  const lockDir = join(sample.data, ".epm4-server-lock"); mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ id: "test-lock", hostname: "OLD-HOST", pid: 1234, startedAt: "2026-09-23T12:00:00.000Z" }), "utf8");
  const preflight = spawnSync("pwsh", ["-NoProfile", "-File", script, "-NasDataRoot", sample.data], { encoding: "utf8" });
  assert.equal(preflight.status, 2);
  assert.match(preflight.stdout, /SINGLE_HOST_LOCK/);

  const refused = spawnSync("pwsh", ["-NoProfile", "-File", clearLockScript, "-NasDataRoot", sample.data], { encoding: "utf8" });
  assert.equal(refused.status, 2);
  assert.equal(existsSync(lockDir), true);

  const cleared = spawnSync("pwsh", ["-NoProfile", "-File", clearLockScript, "-NasDataRoot", sample.data, "-Confirmation", "我确认所有4.0服务均已停止并清理遗留锁"], { encoding: "utf8" });
  assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
  assert.equal(existsSync(lockDir), false);
  assert.match(cleared.stdout, /未修改任何业务 JSON 或附件/);
});
